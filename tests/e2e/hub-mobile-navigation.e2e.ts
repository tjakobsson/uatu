import { test, expect, loginHub, hubPost } from "./hub-mobile-fixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("real visits, copied context, management identity, stopped Return and sign-out navigation", async ({ page, context, hub }) => {
  test.setTimeout(180_000);
  await loginHub(page, hub);
  await expect(page.locator("#hub-return")).toBeHidden();
  const ids: string[] = [];
  for (const folder of Object.values(hub.workspaces)) {
    const result = await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: folder, displayName: "Shared", start: false });
    ids.push(result.workspace.id);
  }
  const [a, b] = ids as [string, string];
  await page.reload();
  const row = page.locator("#workspaces .row").filter({ hasText: hub.workspaces.a });
  page.once("dialog", dialog => dialog.dismiss());
  await row.getByRole("button", { name: "Start Shared", exact: true }).click();
  expect((await (await page.request.get(`${hub.origin}/api/hub/state`)).json()).workspaces.every((w: { running: boolean }) => !w.running)).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await row.getByRole("button", { name: "Start Shared", exact: true }).click();
  await expect(page).toHaveURL(`${hub.origin}/s/${a}/`);
  await expect(page.locator("#hub-control")).not.toHaveAttribute("hidden");
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("uatu.hub.return.v1") || "null")?.workspaceId)).toBe(a);
  await page.goto(hub.origin);
  await expect(page.locator("#hub-return")).toContainText(hub.workspaces.a);
  // A new tab without an opener shares authentication, not sessionStorage.
  const fresh = await context.newPage();
  await fresh.goto(hub.origin);
  await expect(fresh.locator("#hub-return")).toBeHidden();
  await fresh.close();
  const popupPromise = page.waitForEvent("popup");
  await page.evaluate(() => window.open("/settings", "_blank"));
  const inherited = await popupPromise;
  await expect(inherited.locator("#hub-return")).toContainText(hub.workspaces.a);
  await inherited.close();
  const managed = page.locator("#workspaces .row").filter({ hasText: hub.workspaces.b });
  await managed.getByText("More actions", { exact: true }).click();
  page.once("dialog", dialog => dialog.accept("Managed B"));
  await managed.getByRole("button", { name: "Rename workspace Shared" }).click();
  await expect(managed).toContainText("Managed B");
  await page.getByRole("navigation", { name: "Mobile Hub", exact: true }).getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.locator("#hub-return")).toContainText("Return to Shared");
  await hubPost(page.request, hub, `/api/hub/workspaces/${a}/display-name`, { displayName: "Renamed A" });
  await expect(page.locator("#hub-return")).toContainText("Renamed A");
  await hubPost(page.request, hub, `/api/hub/sessions/${a}/stop`);
  await expect(page.locator("#hub-return")).toContainText("stopped", { timeout: 20_000 });
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#hub-return").click();
  await expect(page).toHaveURL(`${hub.origin}/settings`);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#hub-return").click();
  await expect(page).toHaveURL(`${hub.origin}/s/${a}/`);
  await page.goBack();
  await expect(page).toHaveURL(`${hub.origin}/settings`);
  await expect(page.locator(".nav-overlay")).toHaveCount(0);
  await expect(page.locator("#hub-return")).toContainText("Renamed A");
  await expect(page.locator("#hub-return")).toBeEnabled();
  await hubPost(page.request, hub, `/api/hub/sessions/${a}/stop`);
  await hubPost(page.request, hub, `/api/hub/workspaces/${a}/forget`);
  await expect(page.locator("#hub-return")).toBeHidden();
  await page.locator("#devices summary").click();
  const logout = page.waitForRequest(request => request.isNavigationRequest() && request.method() === "POST" && request.url() === `${hub.origin}/logout`);
  await page.locator("#devices").getByRole("button", { name: "Sign out" }).click();
  await logout;
  await expect(page).toHaveURL(`${hub.origin}/login`);
  expect(await page.evaluate(() => sessionStorage.getItem("uatu.hub.return.v1"))).toBeNull();
});

for (const touch of [true, false]) {
test.describe(touch ? "touch history recovery" : "desktop history recovery", () => {
test.use({ hasTouch: touch, isMobile: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
for (const outcome of ["stopped", "removed", "signed out"] as const) {
test(`Forward after interrupted workspace boot recovers a ${outcome} target`, async ({ page, hub }) => {
  test.setTimeout(60_000);
  await loginHub(page, hub);
  const a = (await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A", start: true })).workspace.id;
  const mutations: string[] = [];
  page.on("request", request => { if (request.method() === "POST") mutations.push(new URL(request.url()).pathname); });
  // Do not install Playwright routing: that disables HTTP caching and would
  // hide the original regression. Leave before waiting for workspace boot.
  const entry = await page.goto(`${hub.origin}/s/${a}/docs/guide.md`, { waitUntil: "commit" });
  expect(entry!.headers()["cache-control"]).toBe("no-store");
  await page.goBack();
  await expect(page).toHaveURL(`${hub.origin}/`);
  if (outcome === "signed out") {
    const logout = await page.request.post(`${hub.origin}/logout`, { headers: { origin: hub.origin } });
    expect(logout.ok()).toBe(true);
  } else {
    await hubPost(page.request, hub, `/api/hub/sessions/${a}/stop`);
    if (outcome === "removed") await hubPost(page.request, hub, `/api/hub/workspaces/${a}/forget`);
  }
  await page.goForward();
  if (outcome === "signed out") {
    await expect(page).toHaveURL(new RegExp(`/login\\?next=`));
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Guide A");
  } else {
    await expect(page).toHaveURL(`${hub.origin}/s/${a}/docs/guide.md`);
    await expect(page.getByText(outcome === "stopped" ? /not running/ : /No workspace/)).toBeVisible();
    const state = (await (await page.request.get(`${hub.origin}/api/hub/state`)).json()).workspaces;
    expect(outcome === "stopped" ? state[0].running : state.length).toBe(outcome === "stopped" ? false : 0);
  }
  expect(mutations).toEqual([]);
});
}
});
}

test.describe("bundle-independent recovery", () => {
  test.use({ javaScriptEnabled: false });
  test("history consults the authenticated Hub even if workspace scripts never execute", async ({ page, hub }) => {
    await loginHub(page, hub);
    const a = (await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A", start: true })).workspace.id;
    await page.goto(`${hub.origin}/s/${a}/`);
    await page.goBack();
    await hubPost(page.request, hub, `/api/hub/sessions/${a}/stop`);
    await page.goForward();
    await expect(page.getByText(/not running/)).toBeVisible();
  });
});

test("Hub page restoration clears obsolete opening UI and restores scroll without changing the visit", async ({ page, hub }) => {
  test.setTimeout(60_000);
  await loginHub(page, hub);
  const a = (await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A", start: true })).workspace.id;
  await page.goto(`${hub.origin}/s/${a}/docs/guide.md`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("uatu.hub.return.v1"))).not.toBeNull();
  await page.goto(`${hub.origin}/settings`);
  await expect(page.locator("#hub-return")).toBeVisible();
  await expect(page.locator("#devices")).toContainText("this device");
  // Explicitly exercise the persisted-pageshow handler as well as actual
  // document navigation; browser BFCache eligibility varies by engine.
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.className = "nav-overlay";
    document.body.appendChild(overlay);
    (document.getElementById("hub-return") as HTMLButtonElement).disabled = true;
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.locator(".nav-overlay")).toHaveCount(0);
  await expect(page.locator("#hub-return")).toBeEnabled();
  await page.evaluate(() => scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
  await page.locator('.hub-mobile-nav a[href="/"]').click();
  await expect(page).toHaveURL(`${hub.origin}/`);
  await page.locator('.hub-mobile-nav a[href="/settings"]').click();
  await expect(page).toHaveURL(`${hub.origin}/settings`);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("uatu.hub.return.v1")!).workspaceId)).toBe(a);
});

test("hanging Return reads are bounded and cannot disable Hub actions or restore an old login", async ({ page, hub }) => {
  test.setTimeout(120_000);
  await loginHub(page, hub);
  const result = await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A", start: true });
  await page.goto(`${hub.origin}/s/${result.workspace.id}/`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("uatu.hub.return.v1"))).not.toBeNull();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route("**/api/hub/sessions", async route => {
    reads++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.goto(`${hub.origin}/s/${result.workspace.id}/docs/guide.md`);
  await expect(page.locator("#preview")).toContainText("Guide A");
  await expect(page.locator("#hub-control")).not.toHaveAttribute("hidden");
  await expect(page.getByRole("navigation", { name: "Workspace navigation", exact: true })).toBeVisible();
  await page.goto(hub.origin);
  await expect(page.locator("#sessions")).toContainText("A");
  await expect(page.getByRole("link", { name: /Add Workspace/ })).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await page.waitForTimeout(3200);
  await expect(page.locator("#hub-return")).toBeHidden();
  await page.getByRole("navigation", { name: "Mobile Hub", exact: true }).getByRole("link", { name: "Settings" }).click();
  await page.locator("form.sign-out.hub-mobile-only button").click();
  await expect(page).toHaveURL(`${hub.origin}/login`);
  release();
  await page.unroute("**/api/hub/sessions");
  await loginHub(page, hub);
  await expect(page.locator("#hub-return")).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem("uatu.hub.return.v1"))).toBeNull();
});

test("Return uses masked credential recovery and reports real startup rejection before retry", async ({ page, hub }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await loginHub(page, hub);
  const post = <T>(route: string, data?: unknown) => hubPost<T>(page.request, hub, route, data);
  const a = (await post<{ workspace: { id: string } }>("/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A", start: true })).workspace.id;
  await page.goto(`${hub.origin}/s/${a}/`);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("uatu.hub.return.v1"))).not.toBeNull();
  await post(`/api/hub/sessions/${a}/stop`);
  const key = (await post<{ credential: { id: string } }>("/api/hub/credentials/ssh/generate", { name: "Return identity", capabilities: ["ssh-authentication"], passphrase: "test-passphrase" })).credential;
  await post(`/api/hub/workspaces/${a}/credential-assignments`, { authentication: { credentialId: key.id, host: "github.com" } });
  await page.goto(`${hub.origin}/settings`);
  await expect(page.locator("#hub-return")).toContainText("stopped");
  let starts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`/${a}/start`)) starts++; });
  await page.locator("#hub-return").click();
  const unlock = page.getByRole("dialog");
  await expect(unlock).toContainText("Unlock credentials");
  await unlock.getByLabel("Return identity passphrase").fill("wrong-passphrase");
  await unlock.getByRole("button", { name: "Unlock and resume" }).click();
  await expect(unlock.locator("[role=alert]")).toBeVisible({ timeout: 30_000 });
  await expect(unlock.getByLabel("Return identity passphrase")).toHaveValue("");
  await unlock.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(starts).toBe(0);
  await post(`/api/hub/credentials/${key.id}/disable`);
  await page.locator("#hub-return").click();
  await expect(page.locator("#return-error")).toContainText(/disabled|unavailable/);
  await expect(page).toHaveURL(`${hub.origin}/settings`);
  await post(`/api/hub/credentials/${key.id}/enable`);
  await page.locator("#hub-return").click();
  await unlock.getByLabel("Return identity passphrase").fill("test-passphrase");
  await unlock.getByRole("button", { name: "Unlock and resume" }).click();
  await expect(page).toHaveURL(`${hub.origin}/s/${a}/`);
  expect(starts).toBe(2);
});

test("real long-path rows retain loading, failure and slow-opening feedback", async ({ page, hub }) => {
  test.setTimeout(90_000);
  await loginHub(page, hub);
  await expect(page.locator("#sessions")).toContainText("No sessions running");
  await expect(page.locator("#workspaces")).toContainText("No stopped workspaces");
  const folderName = "long-workspace-path-".repeat(10);
  await hubPost(page.request, hub, "/api/hub/folders/create", { parent: hub.root, name: folderName });
  await hubPost(page.request, hub, "/api/hub/workspaces/configure", { path: `${hub.root}/${folderName}`, displayName: "Long path", init: true });
  const workspace = (await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "Opening target" })).workspace;
  let releaseState!: () => void;
  const stateGate = new Promise<void>(resolve => { releaseState = resolve; });
  let failState = false;
  await page.route("**/api/hub/state", async route => {
    if (failState) { await route.fulfill({ status: 503, json: { error: "Test refresh failure" } }); return; }
    const response = await route.fetch();
    await stateGate;
    await route.fulfill({ response });
  });
  await page.reload();
  await expect(page.locator("#workspaces")).toContainText("Loading");
  releaseState();
  await expect(page.locator("#workspaces")).toContainText(folderName);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const secondary = page.locator("#workspaces .row").filter({ hasText: folderName }).locator("summary");
  await secondary.click();
  await secondary.focus();
  const oldSummary = (await secondary.elementHandle())!;
  await expect.poll(() => oldSummary.evaluate(node => node.isConnected), { timeout: 10_000 }).toBe(false);
  await expect(secondary).toBeFocused();
  await expect(secondary.locator("..")).toHaveAttribute("open");
  failState = true;
  await expect(page.locator("#action-error")).toBeVisible();
  failState = false;
  await expect(page.locator("#action-error")).toBeHidden();
  let releaseStart!: () => void;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  let releaseDocument!: () => void;
  const documentGate = new Promise<void>(resolve => { releaseDocument = resolve; });
  await page.route(`**/api/hub/sessions/${workspace.id}/start`, async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await startGate;
    await route.fulfill({ response });
  });
  await page.route(`**/s/${workspace.id}/`, async route => { await documentGate; await route.continue(); });
  const openingLabels: string[] = [];
  await page.exposeFunction("recordOpening", (label: string) => { openingLabels.push(label); });
  await page.evaluate(() => {
    new MutationObserver(() => {
      const overlay = document.querySelector<HTMLElement>(".nav-overlay");
      if (overlay && overlay.getBoundingClientRect().height > 0) {
        (window as unknown as { recordOpening: (label: string) => void }).recordOpening(overlay.textContent || "");
      }
    }).observe(document.body, { childList: true });
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Start Opening target" }).click();
  await expect(page.getByRole("button", { name: "Start Opening target" })).toHaveText("Starting…");
  await expect(page.getByRole("button", { name: "Start Opening target" })).toBeDisabled();
  releaseStart();
  // Locator evaluation waits for an impending navigation; observe the actual
  // rendered indicator before its document is replaced instead.
  await expect.poll(() => openingLabels.join(" ")).toContain("Opening Opening target");
  releaseDocument();
  await expect(page).toHaveURL(`${hub.origin}/s/${workspace.id}/`);
});

for (const viewport of [{ width: 320, height: 640 }, { width: 740, height: 390 }, { width: 1024, height: 1366 }]) {
  test(`touch Hub fits ${viewport.width}x${viewport.height}, live themes, enlarged text and titlebar`, async ({ page, hub }) => {
    await page.setViewportSize(viewport);
    await loginHub(page, hub);
    await expect(page.locator(".hub-mobile-nav")).toBeVisible();
    await expect(page.locator(".hub-nav")).toBeHidden();
    const colors: string[] = [];
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      colors.push(await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
        document.documentElement.style.setProperty("--titlebar-inset", "60px");
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      expect((await page.locator(".hub-header").boundingBox())!.y).toBeGreaterThanOrEqual(60);
      const nav = page.locator(".hub-mobile-nav");
      const box = (await nav.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      for (const link of await nav.getByRole("link").all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(colors[0]).not.toBe(colors[1]);
  });
}

test("fine-pointer Hub preserves desktop chrome at narrow and wide sizes", async ({ browser, hub }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false });
  const page = await context.newPage();
  await loginHub(page, hub);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator(".hub-mobile-nav")).toBeHidden();
    await expect(page.locator(".hub-nav")).toBeVisible();
    expect(await page.locator(".hub-header").evaluate(node => getComputedStyle(node).flexDirection)).toBe("column");
    await expect(page.locator('.hub-nav a[href="/clone"]')).toBeVisible();
    await page.evaluate(() => document.documentElement.style.setProperty("--titlebar-inset", "60px"));
    expect((await page.locator(".hub-header").boundingBox())!.y).toBeGreaterThanOrEqual(60);
  }
  await context.close();
});
