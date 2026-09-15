import { chromium, webkit, type Page, type Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { bootShell, drag } from "./chat-shell-helpers";

const outputWindow = (page: Page) => page.getByRole("region", { name: "Shell output window" });
const top = async (element: Locator) => (await element.boundingBox())!.y;

async function titlebar(page: Page, inset: number, hosted = true) {
  await page.evaluate(({ inset, hosted }) => {
    document.documentElement.classList.toggle("uatu-desktop-host", hosted);
    document.documentElement.style.setProperty("--titlebar-inset", `${inset}px`);
  }, { inset, hosted });
}

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} shell window respects native titlebar bounds and live inset changes`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
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
    const browser = await ({ chromium, webkit })[engine].launch();
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
