import { promises as fs } from "node:fs";
import { expect, test } from "./fixtures";
import { workspacePath } from "./config";
import { recordDocumentFrames, waitForAppliedDocumentFrame } from "./sync-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";
import { openTreeFile, revealTreeRow } from "./tree-helpers";

test.afterEach(async ({ page, request }) => { await page.close(); await request.post("/__e2e/reset"); });

test("direct navigation and fresh preview work while discovery and Git are held", async ({ page, request }, info) => {
  await request.post("/__e2e/reset", { data: { holdDiscovery: true, holdRepositories: true, nativeWatch: true } });
  await recordDocumentFrames(page);
  await page.goto("/guides/setup.md");
  await expect(page.locator("#index-status")).toHaveText("Indexing…");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  const status = await request.get("/api/state").then(r => r.json());
  expect(status.discovery.status).toBe("indexing");
  expect(status.repositoryState.status).toBe("pending");
  await fs.writeFile(workspacePath("guides/setup.md"), "# Setup\n\nFresh while indexing and Git are held.\n");
  await expect(page.locator("#preview")).toContainText("Fresh while indexing and Git are held.");
  await captureScreenshot(page, info, "preview-during-discovery");
  await request.post("/__e2e/reset", { data: { releaseDiscovery: true, releaseRepositories: true } });
  await expect(page.locator("#index-status")).toBeHidden();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});

test("a multi-file batch refreshes the selected file and all its representations", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nativeWatch: true } });
  await recordDocumentFrames(page);
  await page.goto("/README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  const original = await fs.stat(workspacePath("README.md"));
  await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nFresh pinned bytes after a multi-file save.\n");
  await fs.utimes(workspacePath("README.md"), original.atime, original.mtime);
  await fs.writeFile(workspacePath("guides/setup.md"), "# Setup\n\nAnother file saved last.\n");
  await expect(page.locator("#preview")).toContainText("Fresh pinned bytes after a multi-file save.");
  await expect(page).toHaveURL(/\/README\.md$/);
  await page.locator("#view-source").click();
  await expect(page.locator("#preview")).toContainText("Fresh pinned bytes after a multi-file save.");
  await page.locator("#view-rendered").click();
  await expect(page.locator("#preview")).toContainText("Fresh pinned bytes after a multi-file save.");
});

test("Follow catch-up waits for discovery, without loading each discovered file", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { holdDiscovery: true, follow: false, nativeWatch: true } });
  const loads: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/document") loads.push(request.url()); });
  await page.goto("/");
  await expect(page.locator("#index-status")).toHaveText("Indexing…");
  expect(loads).toEqual([]);
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  expect(loads).toEqual([]);
  await request.post("/__e2e/reset", { data: { releaseDiscovery: true } });
  await expect(page.locator("#index-status")).toBeHidden();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  expect(loads).toHaveLength(1);
});

test("a real edit during discovery supersedes the pending startup default", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { holdDiscovery: true, nativeWatch: true } });
  await page.goto("/");
  await expect(page.locator("#index-status")).toHaveText("Indexing…");
  await fs.writeFile(workspacePath("guides/setup.md"), "# Live during discovery\n");
  await expect(page.locator("#preview")).toContainText("Live during discovery");
  await request.post("/__e2e/reset", { data: { releaseDiscovery: true } });
  await expect(page.locator("#index-status")).toBeHidden();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});

test("manual navigation cancels a deferred Follow catch-up", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { holdDiscovery: true, follow: false, nativeWatch: true } });
  await page.goto("/");
  await expect(page.locator("#index-status")).toHaveText("Indexing…");
  await page.locator("#follow-toggle").click();
  await openTreeFile(page, "guides/setup.md");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await request.post("/__e2e/reset", { data: { releaseDiscovery: true } });
  await expect(page.locator("#index-status")).toBeHidden();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("failed discovery has an actionable recovery without restarting the workspace", async ({ page, request }, info) => {
  await request.post("/__e2e/reset", { data: { failDiscovery: true, nativeWatch: true } });
  await page.goto("/indexing-gate.unknown");
  await expect(page.locator("#index-status")).toContainText("Indexing failed");
  await expect(page.locator("#preview")).not.toContainText("Document not found");
  await expect(page.locator("#index-retry")).toBeVisible();
  // The direct-child harness has no Hub proxy to broker its workspace cookie.
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  expect(await page.evaluate(async token => (await fetch("/api/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  })).ok, token)).toBe(true);
  await captureScreenshot(page, info, "indexing-failure");
  await request.post("/__e2e/reset", { data: { releaseDiscovery: true } });
  await page.locator("#index-retry").click();
  await expect(page.locator("#index-status")).toBeHidden();
  await expect(page.locator("#preview-path")).toHaveText("indexing-gate.unknown");
});

test("held Git provenance does not block fresh content or overwrite a newer selection", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, nativeWatch: true } });
  const release = Promise.withResolvers<void>();
  let held = 0;
  await page.route("**/api/document/facts?**", async route => {
    if (!new URL(route.request().url()).searchParams.get("id")?.endsWith("/README.md")) { await route.continue(); return; }
    const response = await route.fetch();
    held++;
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.goto("/README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect.poll(() => held).toBeGreaterThan(0);
    const canceled = page.waitForEvent("requestfailed", request => request.url().includes("/api/document/facts?") && new URL(request.url()).searchParams.get("id")?.endsWith("/README.md") === true);
    await fs.writeFile(workspacePath("README.md"), "# Content arrives before Git\n");
    await expect(page.locator("#preview")).toContainText("Content arrives before Git");
    await canceled;
    await revealTreeRow(page, "guides/");
    await openTreeFile(page, "guides/setup.md");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(page.locator("#file-facts-strip")).toContainText("Uatu Test");
    await expect(page.locator("#file-facts-strip")).not.toContainText(/Git (pending|refreshing)/);
    const facts = await page.locator("#file-facts-strip").textContent();
    release.resolve();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(page.locator("#file-facts-strip")).toHaveText(facts!);
  } finally { release.resolve(); }
});

test("a late split-pane response cannot restore the previous file revision", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nativeWatch: true, extras: { "README.md": "# Before\n\nOLD-SPLIT-MARKER\n" } } });
  const release = Promise.withResolvers<void>();
  let held = false;
  let intercepted = false;
  await page.route("**/api/document?**", async route => {
    const url = new URL(route.request().url());
    if (intercepted || url.searchParams.get("view") !== "source") { await route.continue(); return; }
    intercepted = true;
    const response = await route.fetch();
    held = true;
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.goto("/README.md");
    await expect(page.locator("#preview")).toContainText("OLD-SPLIT-MARKER");
    await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
    await expect.poll(() => held).toBe(true);
    await fs.writeFile(workspacePath("README.md"), "# After\n\nNEW-SPLIT-MARKER\n");
    await expect.poll(() => page.locator("#preview").textContent().then(text => text?.split("NEW-SPLIT-MARKER").length)).toBe(3);
    const finished = page.waitForEvent("requestfinished", request => new URL(request.url()).pathname === "/api/document" && new URL(request.url()).searchParams.get("view") === "source");
    release.resolve(); await finished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#preview")).not.toContainText("OLD-SPLIT-MARKER");
    await expect.poll(() => page.locator("#preview").textContent().then(text => text?.split("NEW-SPLIT-MARKER").length)).toBe(3);
  } finally { release.resolve(); }
});

test("an open image uses new bytes after a same-path replacement", async ({ page, request }) => {
  const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>`;
  await request.post("/__e2e/reset", { data: { nativeWatch: true, extras: { "live.svg": svg("red") } } });
  await page.goto("/");
  await openTreeFile(page, "live.svg");
  const image = page.locator("#preview img");
  const previous = await image.getAttribute("src");
  const updated = page.waitForResponse(response => response.url().includes("/live.svg?revision=") && response.request().url().split("revision=")[1] !== previous?.split("revision=")[1]);
  await fs.writeFile(workspacePath("live.svg"), svg("blue"));
  expect(await (await updated).text()).toContain('fill="blue"');
  await expect(image).not.toHaveAttribute("src", previous!);
  await expect(page.locator("#preview-path")).toHaveText("live.svg");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("Follow catches an unseen edit after a connection gap even if Git finishes afterward", async ({ page, context, request }) => {
  await request.post("/__e2e/reset", { data: { nativeWatch: true, holdRepositories: true } });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  if (await page.locator("#follow-toggle").getAttribute("aria-pressed") !== "true") await page.locator("#follow-toggle").click();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await context.setOffline(true);
  try {
    await fs.writeFile(workspacePath("guides/setup.md"), "# Unseen edit after disconnect\n");
    await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).latestChange?.id ?? "").toContain("guides/setup.md");
    await request.post("/__e2e/reset", { data: { releaseRepositories: true } });
    await expect.poll(async () => (await request.get("/api/state").then(r => r.json())).repositoryState.status).toBe("ready");
  } finally { await context.setOffline(false); }
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(page.locator("#preview")).toContainText("Unseen edit after disconnect");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

for (const count of [1000, 10000]) {
  test(`one edit in ${count} files has bounded transport and no path reset @perf`, async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const started = performance.now();
    const extras = Object.fromEntries(Array.from({ length: count }, (_, i) => [`many/file-${i}.md`, `# File ${i}\n`]));
    const reset = await request.post("/__e2e/reset", { data: { extras, holdRepositories: true, nativeWatch: true } });
    expect(reset.ok()).toBe(true);
    const baseline = await reset.json();
    expect(baseline.discovery.status).toBe("ready");
    expect(baseline.discovery.discovered).toBeGreaterThanOrEqual(count);
    const fixtureReadyMs = performance.now() - started;
    await recordDocumentFrames(page);
    await page.addInitScript(() => {
      const Native = window.EventSource;
      (window as any).__filePatches = [];
      window.EventSource = class extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener("live", event => {
            const envelope = JSON.parse((event as MessageEvent).data);
            const patch = envelope.event?.data;
            if (envelope.topic === "document" && patch?.kind === "patch" && patch.upserts.length) {
              (window as any).__filePatches.push({ entries: patch.upserts.length, bytes: new TextEncoder().encode(JSON.stringify(patch)).byteLength });
            }
          });
        }
      };
    });
    await page.goto("/README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator("#index-status")).toBeHidden();
    await page.locator("#tree").evaluate(host => {
      const tree = (host as any).__pierreFileTree;
      const counts = { resets: 0, adds: 0, removes: 0 };
      (window as any).__treeWork = counts;
      for (const method of ["resetPaths", "batch"] as const) {
        const original = tree[method].bind(tree);
        tree[method] = (...args: any[]) => {
          if (method === "resetPaths") counts.resets++;
          else for (const op of args[0]) { if (op.type === "add") counts.adds++; if (op.type === "remove") counts.removes++; }
          return original(...args);
        };
      }
      (window as any).__filePatches = [];
    });
    await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nOne fresh edit in a large workspace.\n");
    await waitForAppliedDocumentFrame(page, { changed: "README.md" });
    await expect(page.locator("#preview")).toContainText("One fresh edit in a large workspace.");
    const measured = await page.evaluate(() => ({ tree: (window as any).__treeWork, patches: (window as any).__filePatches }));
    expect(measured.tree).toEqual({ resets: 0, adds: 0, removes: 0 });
    expect(measured.patches.length).toBeGreaterThan(0);
    for (const patch of measured.patches) { expect(patch.entries).toBe(1); expect(patch.bytes).toBeLessThan(4096); }
    await saveEvidence(info, `incremental-${count}.json`, JSON.stringify({ files: count, fixtureReadyMs, totalMs: performance.now() - started, ...measured }, null, 2));
  });
}
