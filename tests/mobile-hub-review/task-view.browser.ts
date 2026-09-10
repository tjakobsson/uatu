import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Locator } from "@playwright/test";
import { startReviewServer } from "./server";

let server: Awaited<ReturnType<typeof startReviewServer>>;
beforeAll(async () => { server = await startReviewServer({ port: 0 }); }, 30000);
afterAll(() => server?.stop());

// Narrow computed-color regression checks on these opaque task surfaces, not
// a general accessibility or platform-conventions certification.
async function colors(button: Locator) {
  return button.evaluate(element => {
    const style = getComputedStyle(element);
    let background = style.backgroundColor, parent = element.parentElement;
    while (background === "rgba(0, 0, 0, 0)" && parent) { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i]!, 0);
    const a = luminance(style.color), b = luminance(background);
    return { color: style.color, background: style.backgroundColor, radius: style.borderRadius, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
}

test("editor owns the full page; Back cancels and Forward restores only safe context", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", colorScheme: "light" });
    await context.addInitScript(() => localStorage.setItem("uatu:ui-mode", "touch"));
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const activate = (locator: Locator) => locator.evaluate(element => (element as HTMLButtonElement).click());
    const traverse = (delta: number) => page.evaluate(delta => new Promise<void>(resolve => { window.addEventListener("popstate", () => resolve(), { once: true, capture: true }); history.go(delta); }), delta);
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForFunction(() => !!window.__mobileHubCoordinator);
    await page.evaluate(() => window.__mobileHubCoordinator!.ready);
    await activate(page.locator('[data-action="settings"]'));
    await activate(page.locator('[data-action="preview-side"]'));
    const editor = page.locator('.mh-editor');
    await browserExpect(editor).toBeVisible();
    await browserExpect(editor.locator('header [data-action="cancel-sheet"]')).toHaveCount(1);
    await browserExpect(editor.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
    await browserExpect(page.locator('.mh-root').locator('[aria-modal="true"], .mh-backdrop, .mh-grabber')).toHaveCount(0);
    await browserExpect(page.locator('.mh-dock')).toBeHidden();
    expect(await editor.evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(844);
    const saveStyle = await colors(editor.getByRole("button", { name: "Save", exact: true }));
    expect(saveStyle.background).toBe("rgba(0, 0, 0, 0)"); expect(saveStyle.radius).toBe("0px"); expect(saveStyle.contrast).toBeGreaterThanOrEqual(4.5);
    const saved = page.evaluate(() => new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true, capture: true })));
    await activate(editor.getByRole("button", { name: "Save", exact: true })); await saved;
    await traverse(-1); expect(new URL(page.url()).pathname).toBe("/");
    await traverse(1); await activate(page.locator('[data-action="preview-side"]'));
    await editor.locator('input[value="right"]').focus(); await page.keyboard.press("Space");
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain("previewSide");
    await traverse(-1); await browserExpect(editor).toHaveCount(0);
    await browserExpect(page.locator('[data-action="preview-side"] .mh-value')).toHaveText("Left");
    await traverse(1); await browserExpect(editor).toHaveCount(0);
    await browserExpect(page.locator('.mh-dock')).toBeVisible();
    await activate(page.locator('[data-action="preview-side"]'));
    await editor.getByRole("button", { name: "Save", exact: true }).focus();
    await page.keyboard.press("Tab");
    await browserExpect(editor.locator('input[value="left"]')).toBeFocused();
    const cancelled = page.evaluate(() => new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true, capture: true })));
    await activate(editor.getByRole("button", { name: "Cancel", exact: true })); await cancelled;
    await browserExpect(page.locator('[data-action="preview-side"]')).toBeFocused();
    await activate(page.locator('[data-action="hub"]'));
    await activate(page.locator('[data-action="start:notes"]'));
    const start = page.getByRole("alertdialog").getByRole("button", { name: "Start", exact: true });
    await browserExpect(start).not.toHaveClass(/mh-destructive/);
    const startStyle = await colors(start); expect(startStyle.background).toBe("rgb(0, 100, 213)"); expect(startStyle.contrast).toBeGreaterThanOrEqual(4.5);
    await traverse(-1);
    await activate(page.locator('[data-action="info:atlas"]'));
    await activate(page.locator('[data-flow="stop"]'));
    const confirmation = page.getByRole("alertdialog");
    await browserExpect(confirmation).toBeVisible();
    await browserExpect(confirmation).toHaveAttribute("aria-modal", "true");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const style = await colors(confirmation.getByRole("button", { name: "Stop", exact: true }));
      expect(style.contrast).toBeGreaterThanOrEqual(4.5);
      expect(style.background).toBe(colorScheme === "light" ? "rgb(255, 255, 255)" : "rgb(39, 39, 46)");
    }
    await confirmation.getByRole("button", { name: "Stop", exact: true }).focus();
    await page.keyboard.press("Tab");
    await browserExpect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    const bounds = await confirmation.boundingBox();
    expect(bounds!.height).toBeLessThan(500);
    expect(Math.abs(bounds!.y + bounds!.height / 2 - 422)).toBeLessThan(2);
    await traverse(-1); await browserExpect(confirmation).toHaveCount(0);
    // A safe past workspace entry isolates traversal cleanup from the native
    // workspace import. The status read is deliberately held: secrets must be
    // revoked at history intent, not only when that later read completes.
    await page.evaluate(() => {
      history.replaceState({ mobileHub: { workspaceId: "atlas" } }, "", "/s/atlas/");
      window.__mobileHubBootGate = new Promise<void>(() => {});
      window.__mobileHubCoordinator!.showHub("settings");
    });
    await activate(page.locator('[data-action="add-credential"]'));
    await activate(page.locator('[data-flow="token"]'));
    await page.locator('.mh-editor input[type="password"]').evaluate(input => {
      (input as HTMLInputElement).value = "SECRET-UNSUBMITTED";
      (window as any).__historySecretInput = input;
    });
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain("SECRET-UNSUBMITTED");
    server.synthetic.hold("readWorkspace");
    await traverse(-3);
    expect(new URL(page.url()).pathname).toBe("/s/atlas/");
    expect(await page.evaluate(() => { const input = (window as any).__historySecretInput as HTMLInputElement; return { connected: input.isConnected, value: input.value }; })).toEqual({ connected: false, value: "" });
    server.synthetic.settle("readWorkspace");
    await browserExpect(page.locator(".mh-coordinator-loading")).toBeVisible();
    await page.evaluate(() => window.__mobileHubCoordinator!.showHub("settings"));
    await activate(page.locator('[data-action="preview-side"]'));
    await activate(editor.getByRole("button", { name: "Cancel", exact: true }));
    // A new route during owned Back must survive the late pop even while the
    // cold workspace import has not installed its history listener yet.
    await browserExpect(editor).toHaveCount(0);
    await page.evaluate(() => window.__mobileHubCoordinator!.showHub("hub"));
    await browserExpect.poll(() => new URL(page.url()).pathname).toBe("/");
  } finally { await browser.close(); }
}, 60000);
