import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { startReviewServer } from "./server";

let server: Awaited<ReturnType<typeof startReviewServer>>;
beforeAll(async () => { server = await startReviewServer({ port: 0 }); server.synthetic.setOnboardingFault("register-failed"); }, 30000);
afterAll(() => server?.stop());

test("Back during dispatched Create keeps the exact pending owner and delivers its retained-path result once", async () => {
  const browser = await chromium.launch({ headless: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("uatu:ui-mode", "touch"));
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    let effect!: () => void, calls = 0;
    const effected = new Promise<void>(resolve => { effect = resolve; });
    await page.route("**/review/backend/createWorkspace", async route => {
      calls++; const response = await route.fetch(); effect(); await gate; await route.fulfill({ response });
    });
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForFunction(() => !!window.__mobileHubCoordinator); await page.evaluate(() => window.__mobileHubCoordinator!.ready);
    const activate = (selector: string) => page.locator(selector).evaluate(element => (element as HTMLButtonElement).click());
    await activate('[data-action="add-workspace"]'); await activate('[data-flow="create"]');
    const task = page.locator(".mh-task"); await browserExpect(task.locator('[name="folderName"]')).toBeVisible();
    await task.evaluate(root => {
      for (const [name, value] of Object.entries({ parent: "/synthetic", folderName: "back-pending-create", displayName: "One pending create" })) root.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
      root.querySelector<HTMLInputElement>('[name="init"]')!.checked = true;
    });
    await activate('[data-action="commit-sheet"]'); await activate('[data-action="commit-sheet"]'); await effected;
    await task.evaluate(root => { (window as any).__pendingTaskOwner = root; });
    const length = await page.evaluate(() => history.length);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.evaluate(() => new Promise<void>(resolve => { window.addEventListener("popstate", () => resolve(), { capture: true, once: true }); history.back(); }));
      expect(await task.evaluate(root => root === (window as any).__pendingTaskOwner)).toBe(true);
      await browserExpect(task).toHaveAttribute("aria-busy", "true");
      await browserExpect(task.locator('[data-action="cancel-sheet"]')).toBeDisabled();
      await browserExpect(task.locator('[data-action="commit-sheet"]')).toBeDisabled();
      await browserExpect(task.locator('[name="folderName"]')).toHaveCount(0);
      await browserExpect(task.locator('[data-task-pending]')).toContainText("Wait for its result");
      expect(await page.evaluate(() => history.length)).toBe(length);
      expect(await page.evaluate(() => history.state.mobileHub.task)).toBe(true);
    }
    await activate('[data-action="commit-sheet"]'); expect(calls).toBe(1);
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain("back-pending-create");
    const closed = page.evaluate(() => new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { capture: true, once: true })));
    release(); await closed;
    await browserExpect(page.locator(".mh-flow-page h1")).toHaveText("Configuration needs attention");
    await browserExpect(page.locator(".mh-flow-page")).toContainText("Folder retained: /synthetic/back-pending-create");
    await browserExpect(task).toHaveCount(0); expect(calls).toBe(1);
    await page.evaluate(() => new Promise<void>(resolve => { window.addEventListener("popstate", () => resolve(), { capture: true, once: true }); history.forward(); }));
    await browserExpect(page.locator(".mh-flow-page h1")).toHaveText("Add Workspace");
    expect(calls).toBe(1); await browserExpect(task).toHaveCount(0);
  } finally { release(); await browser.close(); }
}, 60000);
