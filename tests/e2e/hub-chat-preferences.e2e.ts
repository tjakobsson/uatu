import { test, expect, signIn } from "./hub-fixtures";
import { chromium, webkit } from "@playwright/test";
import { captureScreenshot } from "./evidence";

test("personal chat preference saves across device pages and refreshes on focus", async ({ hubContext, hub }, testInfo) => {
  const a = await hubContext.newPage();
  const b = await hubContext.newPage();
  await Promise.all([a.goto(`${hub.origin}/settings`), b.goto(`${hub.origin}/settings`)]);
  const toggleA = a.getByLabel("Keep workers running when I steer");
  const toggleB = b.getByLabel("Keep workers running when I steer");
  await expect(toggleA).toBeEnabled();
  await expect(toggleB).toBeChecked();
  await toggleA.uncheck();
  await a.locator("#personal-chat-preferences-form").getByRole("button", { name: "Save", exact: true }).click();
  await expect(toggleA).toBeEnabled();
  await expect(a.locator("#personal-chat-preferences-status")).toHaveText("Saved");
  await expect(toggleA).not.toBeChecked();
  await b.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(toggleB).not.toBeChecked();
  await b.reload();
  await expect(toggleB).not.toBeChecked();
  await expect(b.locator("#personal-chat-preferences-pane")).toContainText("including shell commands");
  await captureScreenshot(b, testInfo, "personal-chat-preferences-off");
});

test("stale personal save reports current own-account state and unavailable does not claim saved", async ({ hubContext, hub }) => {
  const a = await hubContext.newPage();
  const b = await hubContext.newPage();
  await Promise.all([a.goto(`${hub.origin}/settings`), b.goto(`${hub.origin}/settings`)]);
  await expect(a.getByLabel("Keep workers running when I steer")).toBeEnabled();
  await expect(b.getByLabel("Keep workers running when I steer")).toBeEnabled();
  await a.getByLabel("Keep workers running when I steer").uncheck();
  await a.locator("#personal-chat-preferences-form").getByRole("button", { name: "Save", exact: true }).click();
  await expect(a.getByLabel("Keep workers running when I steer")).toBeEnabled();
  await expect(a.locator("#personal-chat-preferences-status")).toHaveText("Saved");
  await expect(a.getByLabel("Keep workers running when I steer")).not.toBeChecked();
  // No focus invalidation: the second device is intentionally stale.
  await b.evaluate(() => (document.querySelector("#personal-chat-preferences-form") as HTMLFormElement).requestSubmit());
  await expect(b.locator("#personal-chat-preferences-error")).toContainText("another device");
  await expect(b.getByLabel("Keep workers running when I steer")).not.toBeChecked();
  await b.route("**/api/hub/settings/chat-preferences", route => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await b.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(b.getByLabel("Keep workers running when I steer")).toBeDisabled();
  await expect(b.locator("#personal-chat-preferences-error")).toContainText("unavailable");
});

for (const browserName of ["chromium", "webkit"] as const) test.describe(`${browserName} personal chat touch navigation`, () => {
  test("workspace Settings link survives menu dismissal and offers keyboard and 44px touch controls", async ({ hub }, info) => {
    const browser = await ({ chromium, webkit })[browserName].launch();
    try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await signIn(page, hub);
    await page.goto(`${hub.origin}/s/${hub.workspaces[0].id}/`);
    await page.getByRole("tab", { name: "Files", exact: true }).tap();
    const toggle = page.locator("#hub-toggle");
    await toggle.tap();
    const settings = page.locator('#hub-menu a[href="/settings#personal-chat-preferences-pane"]');
    await expect(settings).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await toggle.tap();
    await settings.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${hub.origin}/settings#personal-chat-preferences-pane`);
    const input = page.getByLabel("Keep workers running when I steer");
    await expect(input).toBeEnabled();
    const pane = page.locator("#personal-chat-preferences-pane");
    const save = pane.getByRole("button", { name: "Save", exact: true });
    await expect(input).toHaveAttribute("role", "switch");
    await expect(pane.locator("details")).not.toHaveAttribute("open");
    await expect(pane.locator("#personal-chat-preferences-help")).toHaveText("Applies to your account on this Hub.");
    expect((await pane.boundingBox())!.height).toBeLessThan(340);
    await expect(input).toBeChecked();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await captureScreenshot(page, info, `personal-chat-${browserName}-touch-on-${theme}`);
    }
    for (const control of [input, save]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await input.tap();
    await expect(page.locator("#personal-chat-preferences-status")).toHaveText("Saved");
    await expect(input).not.toBeChecked();
    await save.tap();
    await expect(input).toBeEnabled();
    await expect(page.locator("#personal-chat-preferences-status")).toHaveText("Saved");
    await expect(input).not.toBeChecked();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await captureScreenshot(page, info, `personal-chat-${browserName}-touch-${theme}`);
    }
    } finally { await browser.close(); }
  });
});
