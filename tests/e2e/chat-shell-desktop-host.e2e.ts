import type { Page, Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { attachPageDiagnosticsOnFailure, launchBrowser } from "./page-diagnostics";
import { bootShell, drag } from "./chat-shell-helpers";

const outputWindow = (page: Page) => page.getByRole("region", { name: "Shell output window" });
const top = async (element: Locator) => (await element.boundingBox())!.y;

async function titlebar(page: Page, inset: number, hosted = true) {
  await page.evaluate(({ inset, hosted }) => {
    document.documentElement.classList.toggle("uatu-desktop-host", hosted);
    document.documentElement.style.setProperty("--titlebar-inset", `${inset}px`);
  }, { inset, hosted });
}

attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  for (const touch of [false, true]) test(`${engine} ${touch ? "touch" : "desktop"} stale-build recovery stays clickable above full-area output`, async ({ request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    try {
      const { outputView } = await bootShell(page, request, { touch });
      // Use the recovery overlay's real DOM/CSS contract; count activation
      // instead of navigating away so both pointer and keyboard can be checked.
      await page.evaluate(() => {
        const notice = document.createElement("div");
        notice.className = "stale-client-notice"; notice.setAttribute("role", "alert");
        const message = document.createElement("span"); message.className = "stale-client-notice-message";
        message.textContent = "This page is running a different build than the server. Reload to update.";
        const reload = document.createElement("button"); reload.type = "button";
        reload.className = "stale-client-notice-action"; reload.textContent = "Reload";
        reload.addEventListener("click", () => { notice.dataset.activations = String(Number(notice.dataset.activations ?? 0) + 1); });
        notice.append(message, reload); document.body.append(notice);
      });
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = outputWindow(page);
      if (!touch) await window.getByRole("button", { name: "Maximize", exact: true }).click();
      const notice = page.locator(".stale-client-notice");
      const reload = notice.getByRole("button", { name: "Reload", exact: true });
      expect(await reload.evaluate(el => !!el.closest("[inert]"))).toBe(false);
      await reload.click(); await expect(notice).toHaveAttribute("data-activations", "1");
      await window.getByRole("button", { name: "Return to chat" }).focus();
      // macOS WebKit's default keyboard policy uses Option-Tab to include buttons.
      const tab = engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
      for (let i = 0; i < 20 && !await reload.evaluate(el => el === document.activeElement); i++) await page.keyboard.press(tab);
      await expect(reload).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(notice).toHaveAttribute("data-activations", "2");
      await window.getByRole("button", { name: "Return to chat" }).click();
      expect(await reload.evaluate(el => !!el.closest("[inert]"))).toBe(false);
    } finally { await browser.close(); }
  });

  test(`${engine} shell window respects native titlebar bounds and live inset changes`, async ({ request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { outputView } = await bootShell(page, request);
      await titlebar(page, 52, false);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = outputWindow(page);
      await window.getByRole("button", { name: "Maximize", exact: true }).click();
      await expect.poll(() => top(window)).toBe(0);
      await titlebar(page, 52);
      await expect.poll(() => top(window)).toBe(52);
      await expect.poll(async () => (await window.boundingBox())!.height).toBe(948);
      for (const label of ["Restore size", "Return to chat"]) {
        expect(await top(window.getByRole("button", { name: label }))).toBeGreaterThanOrEqual(52);
      }
      await titlebar(page, 76);
      await expect.poll(() => top(window)).toBe(76);
      await expect.poll(async () => (await window.boundingBox())!.height).toBe(924);
      await window.getByRole("button", { name: "Restore size" }).click();
      await drag(page, window.getByRole("group", { name: /^Move output/ }), 0, -2000);
      await expect.poll(() => top(window)).toBe(76);
      await window.getByRole("group", { name: /^Move output/ }).press("ArrowUp");
      expect(await top(window)).toBe(76);
      await titlebar(page, 100);
      await expect.poll(() => top(window)).toBe(100);
      await window.getByRole("button", { name: "Maximize", exact: true }).click();
      await expect.poll(async () => (await window.boundingBox())!.height).toBe(900);
      await titlebar(page, 0);
      await expect.poll(() => top(window)).toBe(0);
      await expect.poll(async () => (await window.boundingBox())!.height).toBe(1000);
      await window.getByRole("button", { name: "Return to chat" }).click();
      await expect(window).toHaveCount(0);
    } finally { await browser.close(); }
  });

  test(`${engine} floating shell controls stack above desktop chrome and below modals`, async ({ request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { outputView } = await bootShell(page, request);
      await titlebar(page, 52);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = outputWindow(page);
      const stack = await page.evaluate(() => ({
        output: Number(getComputedStyle(document.querySelector(".chat-shell-window")!).zIndex),
        frost: Number(getComputedStyle(document.body, "::before").zIndex),
        preview: Number(getComputedStyle(document.querySelector(".preview-header")!).zIndex),
        chat: Number(getComputedStyle(document.querySelector(".chat-header")!).zIndex),
        modal: Number(getComputedStyle(document.querySelector(".modal-backdrop")!).zIndex),
      }));
      expect(stack.output).toBeGreaterThan(Math.max(stack.frost, stack.preview, stack.chat));
      expect(stack.output).toBeLessThan(stack.modal);
      await drag(page, window.getByRole("group", { name: /^Move output/ }), 450, -2000);
      const maximize = window.getByRole("button", { name: "Maximize", exact: true });
      expect(await maximize.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
      await maximize.click();
      await expect(window).toHaveClass(/is-full-area/);
      await page.evaluate(() => {
        const modal = document.createElement("div"); modal.id = "shell-test-modal";
        modal.className = "modal-backdrop"; modal.setAttribute("role", "dialog");
        document.body.append(modal);
      });
      expect(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id)).toBe("shell-test-modal");
      await page.locator("#shell-test-modal").evaluate(el => el.remove());
      await window.getByRole("button", { name: "Return to chat" }).click();
      await expect(window).toHaveCount(0);
    } finally { await browser.close(); }
  });
}
