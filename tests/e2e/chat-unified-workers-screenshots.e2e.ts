// Opt-in REAL frontend captures, not a standalone HTML approximation.
// Prototype-only Scheduled markup is described in the companion fixture.
// Existing worker controls/Pending UI and all product files remain unchanged.
import { test, expect } from "./fixtures";
import { captureScreenshot } from "./evidence";
import { actualSteerCard, augmentScheduledRow, seedUnifiedState, unifiedStates } from "./unified-workers-screenshot-fixture";

test.skip(process.env.UATU_CAPTURE_UNIFIED_WORKERS !== "1", "Opt-in actual frontend Scheduled-row concepts");

for (const device of ["desktop", "mobile"] as const) {
  test(`${device} unified Workers actual frontend concepts`, async ({ browser, request, baseURL }, info) => {
    test.setTimeout(180_000);
    const mobile = device === "mobile";
    const page = await browser.newPage({ baseURL, viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile, colorScheme: "light", reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        // Use the existing presentation preference, never remove app chrome.
        localStorage.clear();
        localStorage.setItem("uatu:presentation:v1:%2F:uatu:chat-panel", JSON.stringify({ open: true, fraction: 0.8 }));
      });
      const steerHtml = await actualSteerCard(page, request);
      let workerHtml = "";
      for (const [index, state] of unifiedStates.entries()) {
        await page.emulateMedia({ colorScheme: state === "cancelling" || state === "unconfirmed" ? "dark" : "light" });
        await seedUnifiedState(page, request, state);
        if (state !== "scheduled-only") workerHtml = await page.locator("#chat-compact-workers-items .chat-worker-row").first().evaluate(node => node.outerHTML);
        expect(workerHtml).not.toBe("");
        await augmentScheduledRow(page, state, steerHtml, workerHtml);
        const workers = page.locator("#chat-compact-workers");
        await expect(workers).toBeVisible();
        await expect(page.locator("#chat-compact-workers-items > ul")).toHaveCount(1);
        await expect(page.locator("[data-unified-schedule]")).toHaveCount(state === "cancelled" ? 0 : 1);
        await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(0);
        await expect(page.locator("#chat-queue")).toBeHidden();
        await expect(page.locator("#chat-scheduled-wakeups")).toBeHidden();
        await expect(page.locator("#chat-compact-workers-label")).toHaveText(state === "cancelled" ? "2 working" : state === "scheduled-only" ? "1 scheduled" : "2 working · 1 scheduled");
        if (state !== "compact" && state !== "cancelled") {
          await expect(page.locator("[data-unified-schedule] .chat-worker-inspect")).toBeVisible();
          if (state !== "list") await expect(page.locator("#sample-schedule-card")).toBeVisible();
          else await expect(page.locator("#sample-schedule-card")).toBeHidden();
        }
        if (state === "fired") {
          await expect(page.locator('[data-chat-item-id="sample:wakeup"]')).toContainText("Wakeup");
          await expect(page.locator("#sample-schedule-card")).toContainText("Wed 11 Nov");
        }
        const theme = state === "cancelling" || state === "unconfirmed" ? "dark" : "light";
        const ordinal = String(index * 2 + (mobile ? 2 : 1)).padStart(2, "0");
        // captureScreenshot uses info.outputPath + recordEvidence. The lead
        // assembles a NEW gallery afterward; this test names no docs directory.
        await captureScreenshot(page, info, `${ordinal}-${state}-${device}-${theme}`);
        await expect(page.locator("#chat-compact-workers-label")).toContainText(state === "cancelled" ? "2 working" : "1 scheduled");
        if (["expanded", "cancelling", "unconfirmed", "fired", "scheduled-only"].includes(state)) {
          const card = page.locator("#sample-schedule-card");
          const cancel = page.locator("[data-unified-cancel]");
          await expect(card).toBeVisible();
          await expect(cancel).toBeVisible();
          await expect(card).toContainText(state === "fired" ? "Wed 11 Nov" : "Tue 10 Nov");
          await expect(card).toContainText("Europe/Stockholm");
          const geometry = await cancel.evaluate(button => {
            const panel = button.closest("#chat-compact-workers")!;
            const composer = document.querySelector("#chat-input")!.closest("form")!;
            const rect = button.getBoundingClientRect();
            const bounds = panel.getBoundingClientRect();
            return { height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, panelLeft: bounds.left, panelRight: bounds.right, panelTop: bounds.top, panelBottom: bounds.bottom, composerTop: composer.getBoundingClientRect().top };
          });
          // One CSS pixel tolerance permits subpixel layout/rounding, not clipping.
          expect(geometry.left).toBeGreaterThanOrEqual(geometry.panelLeft - 1);
          expect(geometry.right).toBeLessThanOrEqual(geometry.panelRight + 1);
          expect(geometry.top).toBeGreaterThanOrEqual(geometry.panelTop - 1);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.panelBottom + 1);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.composerTop + 1);
          if (mobile) expect(geometry.height).toBeGreaterThanOrEqual(44);
        }
        await expect(page.locator("#chat-queue")).toBeHidden();
        await expect(page.locator("#chat-scheduled-wakeups")).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
