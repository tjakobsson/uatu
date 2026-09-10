import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, webkit, expect as browserExpect } from "@playwright/test";
import { startReviewServer } from "./server";

let server: Awaited<ReturnType<typeof startReviewServer>>;
beforeAll(async () => { server = await startReviewServer({ port: 0 }); server.synthetic.reset("all-running"); }, 30000);
afterAll(() => server?.stop());

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: actual cold workspace import, Back during load, retained Files and complete Hub navigation`, async () => {
    const started = Date.now();
    const stage = (label: string) => console.info(`${name} cold boot: ${label} (${Date.now() - started}ms)`);
    const browser = await engine.launch({ headless: true, timeout: 10000 });
    stage("browser launched");
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
      await context.addInitScript(() => {
        localStorage.setItem("uatu:ui-mode", "touch");
        const base = /^\/s\/[^/]+\//.exec(location.pathname)?.[0] ?? "/s/atlas/";
        localStorage.setItem(`uatu:presentation:v1:${encodeURIComponent(base)}:uatu:active-tab`, "files");
        localStorage.setItem("uatu:navigation:v1:hub", JSON.stringify({ side: "right", position: .65, autoHide: false, previewSide: "left" }));
        (window as any).__mobileHubBootGate = new Promise<void>((resolve, reject) => {
          (window as any).__releaseBoot = resolve;
          (window as any).__rejectBoot = () => reject(new Error("Test-held workspace import failed"));
        });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      // A delayed legacy probe must not produce a selector missing its known Hub.
      let releaseProbe!: () => void;
      const probe = new Promise<void>(resolve => { releaseProbe = resolve; });
      await page.route("**/api/hub/state", async route => { await probe; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workspaces: [{ id: "atlas", running: true }] }) }); });
      let releaseState!: () => void;
      const stateGate = new Promise<void>(resolve => { releaseState = resolve; });
      const stateRequested = page.waitForRequest(request => request.url().endsWith("/api/state"), { timeout: 20000 });
      await page.route("**/s/atlas/api/state", async route => { await stateGate; await route.continue(); });
      await page.goto(`${server.url}/s/atlas/README.md#saved`, { waitUntil: "domcontentloaded", timeout: 10000 });
      stage("document parsed");
      const loading = page.locator(".mh-coordinator-loading");
      await browserExpect(loading).toBeVisible({ timeout: 5000 });
      await browserExpect(loading.getByRole("button", { name: "Back to Hub" })).toHaveCount(1);
      expect(await page.locator("#mobile-workspace-root").evaluate(element => {
        if (!(element instanceof HTMLElement)) throw new Error("Expected HTML workspace root");
        return element.inert;
      })).toBe(true);
      expect(await page.locator("#mobile-workspace-root").evaluate(element => getComputedStyle(element).opacity)).toBe("0");
      await browserExpect(page.locator("#touch-tab-bar")).toBeHidden();
      await browserExpect(page.locator("#navigation-handle")).toBeHidden();
      stage("cold loader and withheld chrome verified");
      await page.evaluate(() => (window as any).__releaseBoot());
      await stateRequested;
      await browserExpect(page.locator("html")).toHaveAttribute("data-workspace-foreground", "false");
      await loading.getByRole("button", { name: "Back to Hub" }).focus();
      const terminalHidden = await page.locator("#terminal-panel").getAttribute("hidden");
      await page.keyboard.press("Meta+f");
      await page.keyboard.press("Control+Backquote");
      await page.keyboard.press("Control+Shift+Backquote");
      await browserExpect(loading.getByRole("button", { name: "Back to Hub" })).toBeFocused();
      expect(await page.locator("#find-bar").getAttribute("hidden")).not.toBeNull();
      expect(await page.locator("#terminal-panel").getAttribute("hidden")).toBe(terminalHidden);
      await browserExpect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
      stage("registered workspace hotkeys withheld while state is pending");
      await loading.getByRole("button", { name: "Back to Hub" }).click();
      await page.evaluate(() => (window as any).__mobileHubCoordinator.showHub("settings"));
      releaseState();
      stage("Back to Settings; state released");
      await browserExpect(page.locator("#touch-tab-bar")).toHaveAttribute("data-navigation-ready", "", { timeout: 5000 });
      expect(new URL(page.url()).pathname).toBe("/settings");
      expect(await page.locator("#mobile-workspace-root").evaluate(element => {
        if (!(element instanceof HTMLElement)) throw new Error("Expected HTML workspace root");
        return element.inert;
      })).toBe(true);
      stage("background state ready; Settings retained");
      await page.evaluate(() => (window as any).__mobileHubCoordinator.openWorkspace("atlas"));
      stage("returned to same workspace");
      await browserExpect(loading).toBeHidden();
      await browserExpect(page.locator("#touch-tab-bar")).toBeVisible();
      await browserExpect(page.locator("#navigation-hub")).toBeVisible();
      await browserExpect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
      const box = await page.locator("#touch-tab-bar").boundingBox();
      expect(box!.width).toBeGreaterThan(350);
      expect(new URL(page.url()).hash).toBe("#saved");
      await page.locator("#navigation-close").click();
      await browserExpect(page.locator("#touch-tab-bar")).toBeHidden();
      await browserExpect(page.locator("#navigation-handle")).toBeVisible();
      const handle = await page.locator("#navigation-handle").boundingBox();
      expect(handle!.x).toBeGreaterThan(300);
      expect(handle!.y).toBeGreaterThan(450);
      expect(handle!.y).toBeLessThan(650);
      expect(await page.evaluate(() => (window as any).__mobileHubReview.bootCount)).toBe(1);
      releaseProbe();
      expect(errors).toEqual([]);
      stage("all cold-boot assertions passed");
    } finally { await browser.close(); }
  }, 30000);
}

test("chromium: failed first import recovers to Hub; switching workspace opens a fresh loading document", async () => {
  const started = Date.now();
  const stage = (label: string) => console.info(`chromium failure/switch: ${label} (${Date.now() - started}ms)`);
  const browser = await chromium.launch({ headless: true, timeout: 10000 });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      const base = /^\/s\/[^/]+\//.exec(location.pathname)?.[0] ?? "/s/atlas/";
      localStorage.setItem(`uatu:presentation:v1:${encodeURIComponent(base)}:uatu:active-tab`, "files");
      (window as any).__mobileHubBootGate = new Promise<void>((resolve, reject) => {
        (window as any).__releaseBoot = resolve;
        (window as any).__rejectBoot = () => reject(new Error("Test-held import failure"));
      });
    });
    const page = await context.newPage();
    await page.goto(`${server.url}/s/atlas/`, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForFunction(() => (window as any).__mobileHubBootAttempts === 1, undefined, { timeout: 5000 });
    await page.evaluate(() => (window as any).__rejectBoot());
    await browserExpect(page.locator(".mh-coordinator-loading")).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.locator("#mobile-workspace-root").evaluate(element => {
      if (!(element instanceof HTMLElement)) throw new Error("Expected HTML workspace root");
      return element.inert;
    })).toBe(true);
    stage("failed import recovered to Hub");
    const other = server.synthetic.inspect().workspaces.find(row => row.id !== "atlas" && row.runtime.status === "running")!;
    expect(other).toBeDefined();
    await page.evaluate(id => { void (window as any).__mobileHubCoordinator.openWorkspace(id); }, other.id);
    await page.waitForURL(`**/s/${other.id}/`, { waitUntil: "domcontentloaded", timeout: 5000 });
    await browserExpect(page.locator(".mh-coordinator-loading")).toBeVisible();
    await browserExpect(page.locator("#navigation-handle")).toBeHidden();
    await browserExpect(page.locator("#touch-tab-bar")).toBeHidden();
    stage("new workspace document has safe loading presentation");
    await page.waitForFunction(() => (window as any).__mobileHubBootAttempts === 1, undefined, { timeout: 5000 });
    await page.evaluate(() => (window as any).__releaseBoot());
    await browserExpect(page.locator(".mh-coordinator-loading")).toBeHidden({ timeout: 5000 });
    await browserExpect(page.locator("#navigation-hub")).toBeVisible();
    await browserExpect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
    expect(await page.evaluate(() => (window as any).__mobileHubBootAttempts)).toBe(1);
    stage("all failure/switch assertions passed");
  } finally { await browser.close(); }
}, 30000);
