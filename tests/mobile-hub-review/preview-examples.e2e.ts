import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { clickTreeFile, treeRow } from "../e2e/tree-helpers";
import { showSurface } from "../e2e/navigation-helpers";

// Each test resets independently, so one failure must not skip its siblings.
// The disposable-server config uses workers: 1 (shared memory-only reviewer).
const browserAudits = new Map<Page, (request: APIRequestContext, testInfo: TestInfo) => Promise<void>>();

test.beforeEach(async ({ request }, testInfo) => {
  await test.step("fixture setup: reset synthetic model (not a user interaction)", async () => {
    const response = await request.post("/review/reset", { data: { scenario: "mixed" } });
    expect(response.ok()).toBe(true);
    await testInfo.attach("preview-examples-fixture-reset", {
      body: JSON.stringify({ transport: "APIRequestContext", operation: "/review/reset", scenario: "mixed", status: response.status() }),
      contentType: "application/json",
    });
  });
});

test.afterEach(async ({ page, request }, testInfo) => {
  const verify = browserAudits.get(page);
  browserAudits.delete(page);
  try { await verify?.(request, testInfo); }
  finally {
    if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
      await screenshot(page, testInfo, "preview-examples-failure");
    }
  }
});

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = process.env.UATU_REVIEW_PREVIEW_EVIDENCE
    ? `${process.env.UATU_REVIEW_PREVIEW_EVIDENCE}/${testInfo.project.name}-${name}.png`
    : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Observe actual browser traffic, not fixture requests. No route fulfillment,
 * injected UI, storage changes or display overrides are used in this suite. */
function observeBrowser(page: Page, workspace: "atlas" | "notes") {
  const errors: string[] = [];
  const failedResponses: string[] = [];
  const requests: Array<{ method: string; url: string; resource: string }> = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => requests.push({ method: request.method(), url: request.url(), resource: request.resourceType() }));
  page.on("response", response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  browserAudits.set(page, async (request: APIRequestContext, testInfo: TestInfo) => {
    // POSTs used for backend reads are recorded too, without mislabelling them
    // as interactive mutations. All non-GET browser requests are separate from
    // the APIRequestContext fixture setup attachments above/below.
    await testInfo.attach("preview-examples-browser-traffic", { body: JSON.stringify({ requests, errors, failedResponses }, null, 2), contentType: "application/json" });
    // Soft assertions keep a prior interaction timeout/error as the primary
    // failure while still reporting every transport/console regression.
    expect.soft(errors, "browser exceptions and console errors").toEqual([]);
    expect.soft(failedResponses, "HTTP failures from actual clients").toEqual([]);
    const origin = new URL(page.url()).origin;
    const scoped = requests.filter(row => {
      const path = new URL(row.url).pathname;
      return row.resource === "document" || row.resource === "image" || (path.includes("/api/") && !path.includes("/api/hub/"));
    });
    expect.soft(scoped.length).toBeGreaterThan(0);
    for (const row of requests) {
      const url = new URL(row.url);
      if (url.protocol === "http:" || url.protocol === "https:") expect.soft(url.origin, row.url).toBe(origin);
    }
    for (const row of scoped) {
      const url = new URL(row.url);
      // Local data/blob imagery (if introduced by the real viewer) has no HTTP
      // route. Every actual HTTP document/image/service request is scoped.
      if (url.protocol === "http:" || url.protocol === "https:") expect.soft(url.pathname, row.url).toMatch(new RegExp(`^/s/${workspace}/`));
    }
    expect.soft(requests.some(row => new URL(row.url).pathname === `/s/${workspace}/api/document`)).toBe(true);
    const stateResponse = await request.get(`/s/${workspace}/review/state`);
    expect.soft(stateResponse.ok()).toBe(true);
    expect.soft((await stateResponse.json()).missing, "missing mock contracts").toEqual([]);
  });
}

async function expectDocument(page: Page, workspace: string, path: string, heading: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/${workspace}/${path}`);
  await expect(page.locator("#preview-path")).toHaveText(path);
  await expect(page.locator("#preview h1")).toHaveText(heading);
  await expect(page.locator("#preview")).toBeVisible();
}

async function expectCoast(page: Page, workspace: string) {
  const image = page.locator('#preview img[src$="coast.svg"]');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);
  const imageUrl = new URL(await image.evaluate((element: HTMLImageElement) => element.currentSrc));
  expect(imageUrl.origin).toBe(new URL(page.url()).origin);
  expect(imageUrl.pathname).toBe(`/s/${workspace}/examples/media/coast.svg`);
}

test("preview examples are discoverable in the actual Files tree and link from Markdown to AsciiDoc", async ({ page }, testInfo) => {
  observeBrowser(page, "atlas");
    await page.goto("/s/atlas/README.md");
    await expect(page.locator("#preview")).toContainText("No live workspace was read.");
    await showSurface(page, "files");
    await expect(treeRow(page, "examples/")).toBeVisible();
    await clickTreeFile(page, "examples/START-HERE.md");
    await showSurface(page, "preview");
    await expectDocument(page, "atlas", "examples/START-HERE.md", "Preview field guide");
    await expect(page.locator("#preview table")).toContainText("Runbook");
    await expectCoast(page, "atlas");
    await screenshot(page, testInfo, "preview-examples-guide-image");

    await page.locator("#preview").getByRole("link", { name: "Runbook", exact: true }).click();
    await expectDocument(page, "atlas", "examples/operations/runbook.adoc", "Synthetic expedition runbook");
    await expect(page.locator("#preview .admonitionblock.note")).toContainText("sample documentation");
    await expect(page.locator("#preview table").filter({ hasText: "Stage" })).toContainText("Recorder");
    await expectCoast(page, "atlas");
    await screenshot(page, testInfo, "preview-examples-asciidoc-image");

    await page.locator("#view-source").click();
    await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#preview .uatu-source-pre")).toContainText("= Synthetic expedition runbook");
    await expect(page.locator("#preview .uatu-source-pre")).toContainText("[source,json]");
    await screenshot(page, testInfo, "preview-examples-asciidoc-source");
    await page.locator("#view-rendered").click();
    await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#preview .uatu-source-pre")).toHaveCount(0);
    await expectDocument(page, "atlas", "examples/operations/runbook.adoc", "Synthetic expedition runbook");
    await page.locator("#preview").getByRole("link", { name: "Read the reference", exact: true }).click();
    await expectDocument(page, "atlas", "examples/operations/reference.adoc", "Observation reference");

    await showSurface(page, "files");
    await test.step("inspect and open the actual compacted release folder", async () => {
      await testInfo.attach("preview-examples-tree-rows", { body: JSON.stringify(await page.locator("#tree [data-item-path]").evaluateAll(rows => rows.map(row => ({ path: row.getAttribute("data-item-path"), expanded: row.getAttribute("aria-expanded") }))), null, 2), contentType: "application/json" });
      // Pierre compacts single-child directories into one visible row; it does
      // not expose a separate releases/ ancestor for clickTreeFile to expand.
      const release = treeRow(page, "examples/releases/2026/");
      await expect(release).toBeVisible();
      if (await release.getAttribute("aria-expanded") === "false") await release.click();
      await treeRow(page, "examples/releases/2026/checklist.md").click();
    });
    await showSurface(page, "preview");
    await expectDocument(page, "atlas", "examples/releases/2026/checklist.md", "Sample release checklist");
    await expect(page.locator('#preview input[type="checkbox"]')).toHaveCount(5);
    await showSurface(page, "files");
    await expect(treeRow(page, "examples/releases/2026/checklist.md")).toBeVisible();
    await screenshot(page, testInfo, "preview-examples-nested-files-tree");
});

test("preview examples render Mermaid and open the actual zoomable diagram viewer", async ({ page }, testInfo) => {
  observeBrowser(page, "atlas");
    await page.goto("/s/atlas/examples/guides/architecture.md");
    await expectDocument(page, "atlas", "examples/guides/architecture.md", "Expedition architecture");
    await expect(page.locator("#preview .mermaid")).toHaveCount(2);
    // Scroll real placeholders into the viewport to trigger the production
    // lazy renderer; no eager-render hook or replacement diagram is injected.
    for (let i = 0; i < 2; i++) {
      const diagram = page.locator("#preview .mermaid").nth(i);
      await diagram.scrollIntoViewIfNeeded();
      await expect(diagram.locator("svg")).toBeVisible();
    }
    await expect(page.locator("#preview .mermaid.mermaid-pending")).toHaveCount(0);
    const trigger = page.locator("#preview .mermaid-trigger").first();
    await trigger.click();
    const dialog = page.locator("dialog.mermaid-viewer");
    await expect(dialog).toHaveAttribute("open", "");
    await expect(dialog.locator(".mermaid-viewer-stage svg")).toBeVisible();
    await dialog.getByRole("button", { name: "Fit to screen", exact: true }).click();
    const scale = () => dialog.locator(".mermaid-viewer-stage").evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
    await expect.poll(scale).toBeGreaterThan(0);
    const fitted = await scale();
    await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(scale).toBeGreaterThan(fitted);
    const enlarged = await scale();
    await dialog.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect.poll(scale).toBeLessThan(enlarged);
    await dialog.getByRole("button", { name: "Fit to screen", exact: true }).click();
    await expect.poll(scale).toBeCloseTo(fitted, 3);
    await screenshot(page, testInfo, "preview-examples-mermaid-viewer");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toHaveAttribute("open", "");
    await expect(trigger).toBeFocused();

    await page.locator("#preview").getByRole("link", { name: "Read the runbook", exact: true }).click();
    await expectDocument(page, "atlas", "examples/operations/runbook.adoc", "Synthetic expedition runbook");
    const asciidocDiagram = page.locator("#preview .mermaid");
    await asciidocDiagram.scrollIntoViewIfNeeded();
    await expect(asciidocDiagram.locator("svg")).toBeVisible();
    await screenshot(page, testInfo, "preview-examples-asciidoc-mermaid");
});

test("preview examples survive a direct nested Notes document reload with workspace-scoped images and links", async ({ page, request }, testInfo) => {
  await test.step("fixture setup: start synthetic Notes (not an interactive Start assertion)", async () => {
    const response = await request.post("/review/backend/startWorkspace", { data: [{ workspaceId: "notes", unassigned: "confirmed-without-credentials" }] });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    await testInfo.attach("preview-examples-fixture-start-notes", { body: JSON.stringify({ transport: "APIRequestContext", operation: "startWorkspace", workspaceId: "notes", result }), contentType: "application/json" });
    const state = await request.get("/s/notes/api/state");
    expect(state.ok()).toBe(true);
  });
  observeBrowser(page, "notes");
    await page.goto("/s/notes/examples/guides/field-notes.md");
    await expectDocument(page, "notes", "examples/guides/field-notes.md", "Field notes");
    await expectCoast(page, "notes");
    await page.reload();
    await expectDocument(page, "notes", "examples/guides/field-notes.md", "Field notes");
    await expectCoast(page, "notes");
    await screenshot(page, testInfo, "preview-examples-notes-direct-reload");
    await page.locator("#view-source").click();
    await expect(page.locator("#preview .uatu-source-pre")).toContainText("# Field notes");
    await expect(page.locator("#preview .uatu-source-pre")).toContainText("../media/coast.svg");
    await page.locator("#view-rendered").click();
    await expect(page.locator("#preview h1")).toHaveText("Field notes");
    await page.locator("#preview").getByRole("link", { name: "Explore the architecture", exact: true }).click();
    await expectDocument(page, "notes", "examples/guides/architecture.md", "Expedition architecture");
    await page.locator("#preview").getByRole("link", { name: "Read the runbook", exact: true }).click();
    await expectDocument(page, "notes", "examples/operations/runbook.adoc", "Synthetic expedition runbook");
    await expectCoast(page, "notes");
    await screenshot(page, testInfo, "preview-examples-notes-linked-runbook");
});
