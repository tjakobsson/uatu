import { expect, test } from "bun:test";
import { chromium, expect as visible } from "@playwright/test";
import { startReviewServer } from "./server";

test("current Chromium: explicit assignment selection, structured review, and canonical security navigation", async () => {
  const server = await startReviewServer({ port: 0 });
  const browser = await chromium.launch({ headless: true, timeout: 15000 });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark", reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("uatu:ui-mode", "touch"));
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.goto(`${server.url}/settings`);
    const notice = page.locator(".mh-advisory");
    await visible(notice).toBeVisible();
    await visible(notice.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(1);
    expect(await notice.evaluate(el => {
      const identity = document.querySelector(".mh-identity")!;
      const credentials = [...document.querySelectorAll("h2")].find(el => el.textContent === "Credentials")!;
      return !!(identity.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(el.compareDocumentPosition(credentials) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    expect(await notice.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(52, 44, 27)");
    await visible(page.getByRole("button", { name: /^Devices/ })).toHaveCount(1);
    await notice.getByRole("button", { name: "Dismiss", exact: true }).tap();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("uatu.hub.notice.shared-uid-v1:")).map(key => localStorage.getItem(key)))).toEqual(["dismissed"]);
    await page.goto(`${server.url}/settings?detail=security`);
    await visible(page.getByRole("button", { name: /Devices/ })).toHaveCount(0);
    await visible(page.getByRole("button", { name: "Sign out", exact: true })).not.toHaveClass(/mh-commit/);
    await page.goto(`${server.url}/settings?detail=assignments`);
    await page.locator('[data-flow="workspace-atlas"]').tap();
    await visible(page.locator('[data-flow="new-atlas"]')).toBeVisible();
    const calls: string[] = [];
    page.on("request", request => { if (request.url().includes("/review/backend/")) calls.push(request.url()); });
    await page.evaluate(() => { (window as any).__stage12Changes = 0; document.addEventListener("change", () => (window as any).__stage12Changes++); });
    await page.locator('[data-flow="new-atlas"]').tap();
    const auth = page.getByRole("combobox", { name: "Git authentication credential", exact: true });
    await visible(auth).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    expect(await page.evaluate(() => (window as any).__stage12Changes)).toBe(0);
    expect(calls).toEqual([]);
    await auth.tap(); // Native picker is opened only by this explicit gesture.
    await auth.selectOption("token-github");
    await page.getByLabel("Authentication host", { exact: true }).fill("GitHub.COM");
    expect(calls).toEqual([]);
    await page.getByRole("button", { name: "Review", exact: true }).tap();
    await visible(page.getByRole("heading", { name: "Review changes", exact: true })).toBeVisible();
    const review = page.locator(".mh-task");
    await visible(review.locator("dt", { hasText: /^Current$/ })).not.toHaveCount(0);
    await visible(review.locator("dt", { hasText: /^After applying$/ })).not.toHaveCount(0);
    await visible(review.locator("dd", { hasText: /^github.com$/ })).not.toHaveCount(0);
    expect(calls).toEqual([]);
    await page.getByRole("button", { name: "Back to edit", exact: true }).tap();
    await visible(auth).toHaveValue("token-github");
    // Review normalizes the intent, not the user's retained edit buffer.
    await visible(page.getByLabel("Authentication host", { exact: true })).toHaveValue("GitHub.COM");
    expect(calls).toEqual([]);
  } finally { server.stop(); await Promise.race([browser.close(), Bun.sleep(2000)]); }
}, 45000);
