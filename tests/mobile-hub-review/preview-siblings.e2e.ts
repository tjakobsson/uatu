import { expect, test, type Page, type TestInfo } from "@playwright/test";

const capture = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: new URL(`./results/artifacts/navigation-recovery/${info.project.name}-${name}.png`, import.meta.url).pathname });

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const pill = (page: Page) => page.locator("#preview-file-navigation");
const next = (page: Page) => pill(page).getByRole("button", { name: "Next file", exact: true });
const previous = (page: Page) => pill(page).getByRole("button", { name: "Previous file", exact: true });
const names = ["brief.md", "config.ts", "map.svg", "notes.txt", "reference.adoc", "runbook.adoc", "sample.bin"];

test.beforeEach(async ({ request, baseURL }) => {
  // Never reset the published reviewer. This suite is for the disposable 4732.
  expect(new URL(baseURL!).port).toBe("4732");
  expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true);
});

async function selected(page: Page, name: string) {
  await expect(page.locator("#preview-path")).toHaveText(`examples/operations/${name}`);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/atlas/examples/operations/${name}`);
  await expect(pill(page)).toHaveAttribute("aria-busy", "false");
  await expect(pill(page)).not.toContainText("unavailable");
}

test("screenshot destination recovers on resume and traverses all same-directory formats in place", async ({ page }, info) => {
  const workspaceRequests: string[] = [];
  let documentRequests = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/api/") && !path.includes("/api/hub/")) workspaceRequests.push(path);
    if (request.resourceType() === "document") documentRequests++;
  });
  await page.goto("/s/atlas/examples/operations/reference.adoc");
  await selected(page, "reference.adoc");
  await expect(page.locator("#preview h1")).toHaveText("Observation reference");
  // Actual lifecycle owner refetches HTTP state and replaces its SSE generation.
  // With the old frozen synthetic timestamp this leaves the warning showing.
  const resumed = page.waitForResponse(response => response.url().includes("/api/state?") && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await resumed;
  await expect(previous(page)).toBeEnabled();
  await expect(next(page)).toBeEnabled();
  await capture(page, info, "preview-resumed");
  for (let i = 3; i >= 0; i--) {
    await previous(page).click();
    await selected(page, names[i]!);
  }
  await expect(pill(page).getByRole("button", { name: "Previous file (first file)", exact: true })).toBeDisabled();
  for (const name of names.slice(1)) {
    await next(page).click();
    await selected(page, name);
    if (name === "config.ts") await expect(page.locator("#preview pre")).toContainText("expedition");
    if (name === "map.svg") {
      const image = page.locator("#preview .image-preview img");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    }
    if (name === "notes.txt") await expect(page.locator("#preview pre")).toContainText("Synthetic observation notes");
    if (name === "sample.bin") await expect(page.locator("#preview")).toContainText("isn't viewable");
    if (["map.svg", "sample.bin"].includes(name)) await capture(page, info, `preview-${name}`);
  }
  await expect(pill(page).getByRole("button", { name: "Next file (last file)", exact: true })).toBeDisabled();
  expect(documentRequests).toBe(1); // no workspace remount/reload on sibling selection
  expect(workspaceRequests.length).toBeGreaterThan(0);
  for (const path of workspaceRequests) expect(path).toMatch(/^\/s\/atlas\//);
});

test("index failure disables both arrows truthfully; Retry restores the same document without reload", async ({ page }, info) => {
  await page.goto("/s/atlas/examples/operations/reference.adoc");
  await selected(page, "reference.adoc");
  let reloads = 0;
  page.on("request", request => { if (request.resourceType() === "document") reloads++; });
  // Test-owned transport fault only; never replace UI, skip index or inject state.
  await page.route("**/s/atlas/api/state?**", route => route.fulfill({ status: 503, body: "Synthetic index failure" }));
  await page.route("**/s/atlas/api/events?**", route => route.abort());
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(pill(page)).toContainText("File index unavailable. Retry to refresh.");
  await expect(previous(page)).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await expect(pill(page).getByRole("button", { name: "Back to Files" })).toBeEnabled();
  await capture(page, info, "preview-index-error");
  await page.unroute("**/s/atlas/api/state?**");
  await page.unroute("**/s/atlas/api/events?**");
  await pill(page).getByRole("button", { name: "Retry", exact: true }).click();
  await selected(page, "reference.adoc");
  await expect(previous(page)).toBeEnabled();
  await expect(next(page)).toBeEnabled();
  await capture(page, info, "preview-index-recovered");
  expect(reloads).toBe(0);
});

for (const relativePath of ["examples/media/coast.svg", "examples/operations/map.svg", "examples/operations/sample.bin"]) {
test(`coast remains indexed; canonical binary direct navigation and reload: ${relativePath}`, async ({ page }, info) => {
  const path = `/s/atlas/${relativePath}`;
  const indexResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/s/atlas/api/state");
  await page.goto(path);
  const response = await indexResponse;
  expect(response.status()).toBe(200);
  const index = await response.json();
  const destination = index.roots.flatMap((root: { docs: Array<{ id: string; relativePath: string; kind: string }> }) => root.docs).find((doc: { relativePath: string }) => doc.relativePath === relativePath);
  expect(destination).toMatchObject({ id: relativePath, relativePath, kind: "binary" });
  await info.attach("browser-boot-index-destination", { body: JSON.stringify({ url: response.url(), status: response.status(), destination }), contentType: "application/json" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(page.locator("#preview-path")).toHaveText(relativePath);
    await expect(pill(page)).toBeVisible();
    if (relativePath.endsWith(".svg")) {
      const image = page.locator("#preview .image-preview img");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      expect(new URL(await image.evaluate((element: HTMLImageElement) => element.currentSrc)).pathname).toBe("/s/atlas/api/document/resource");
    } else {
      await expect(page.locator("#preview")).toContainText("isn't viewable");
    }
    expect(await page.evaluate(() => history.state.documentId)).toBe(relativePath);
    if (attempt === 0) await page.reload();
  }
  await page.goto("/s/atlas/examples/START-HERE.md");
  const embedded = page.locator('#preview img[src$="coast.svg"]');
  await embedded.scrollIntoViewIfNeeded();
  await expect(embedded).toBeVisible();
  await expect.poll(() => embedded.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  expect(new URL(await embedded.evaluate((element: HTMLImageElement) => element.currentSrc)).pathname).toBe("/s/atlas/examples/media/coast.svg");
});
}
