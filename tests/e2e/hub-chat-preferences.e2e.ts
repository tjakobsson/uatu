import { test, expect, signIn } from "./hub-fixtures";
import { chromium, webkit } from "@playwright/test";
import { captureScreenshot } from "./evidence";

for (const browserName of ["chromium", "webkit"] as const) test.describe(`${browserName} personal preference drafts`, () => {
test("unsaved personal preference survives refresh and competing saves until explicitly saved", async ({ hub }, info) => {
  const browser = await ({ chromium, webkit })[browserName].launch();
  try {
  const hubContext = await browser.newContext();
  const a = await hubContext.newPage();
  await signIn(a, hub);
  const b = await hubContext.newPage();
  await Promise.all([a.goto(`${hub.origin}/settings`), b.goto(`${hub.origin}/settings`)]);
  const toggleA = a.getByRole("switch", { name: "Keep workers running when I steer" });
  const toggleB = b.getByRole("switch", { name: "Keep workers running when I steer" });
  const status = a.locator("#personal-chat-preferences-form").getByRole("status");
  const saveA = a.locator("#personal-chat-preferences-form").getByRole("button", { name: "Save", exact: true });
  const saveB = b.locator("#personal-chat-preferences-form").getByRole("button", { name: "Save", exact: true });
  const persisted = async () => (await hubContext.request.get(`${hub.origin}/api/hub/settings/chat-preferences`)).json();
  await expect(toggleA).toBeEnabled();
  await expect(toggleB).toBeEnabled();
  const initial = await persisted();
  expect(initial).toMatchObject({ version: 1, autoBackgroundOnSteer: true });
  await toggleA.uncheck();
  await expect(status).toHaveText("Unsaved changes — Save to apply.");
  const refreshed = a.waitForResponse(response => response.url().endsWith("/api/hub/settings/chat-preferences") && response.request().method() === "GET");
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await expect(toggleA).not.toBeChecked();
  await expect(status).toHaveText("Unsaved changes — Save to apply.");
  expect(await persisted()).toEqual(initial);
  await captureScreenshot(a, info, "personal-chat-unsaved-desktop");
  await saveA.click();
  await expect(status).toHaveText("Saved");
  expect(await persisted()).toEqual({ version: 1, revision: initial.revision + 1, autoBackgroundOnSteer: false });

  // Keep B intentionally stale. Its own ON selection must survive the conflict.
  await b.evaluate(() => (document.querySelector("#personal-chat-preferences-form") as HTMLFormElement).requestSubmit());
  await expect(b.locator("#personal-chat-preferences-error")).toContainText("another device");
  await expect(toggleB).toBeChecked();
  await expect(b.locator("#personal-chat-preferences-form").getByRole("status")).toHaveText("Unsaved changes — Save to apply.");
  expect(await persisted()).toEqual({ version: 1, revision: initial.revision + 1, autoBackgroundOnSteer: false });
  const conflict = b.locator("#personal-chat-preferences-form").getByRole("alert");
  await toggleB.uncheck();
  await expect(b.locator("#personal-chat-preferences-form").getByRole("status")).toHaveText("Saved");
  await expect(conflict).toContainText("Changed on another device.");
  await expect(conflict).toContainText("The saved setting is OFF.");
  await expect(conflict).toContainText("Your choice already matches the saved setting.");
  await expect(conflict).not.toContainText("unsaved");
  await expect(conflict).not.toContainText("Save ");
  await toggleB.check();
  await expect(b.locator("#personal-chat-preferences-form").getByRole("status")).toHaveText("Unsaved changes — Save to apply.");
  await expect(conflict).toContainText("The saved setting is OFF.");
  await expect(conflict).toContainText("Your unsaved choice is kept");
  await expect(conflict).toContainText("Save");
  await expect(conflict).not.toContainText("already matches");
  expect(await persisted()).toEqual({ version: 1, revision: initial.revision + 1, autoBackgroundOnSteer: false });
  await saveB.click();
  await expect(b.locator("#personal-chat-preferences-form").getByRole("status")).toHaveText("Saved");
  expect(await persisted()).toEqual({ version: 1, revision: initial.revision + 2, autoBackgroundOnSteer: true });
  } finally { await browser.close(); }
});
});

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
  await expect(b.getByLabel("Keep workers running when I steer")).toBeChecked();
  await expect(b.locator("#personal-chat-preferences-status")).toHaveText("Unsaved changes — Save to apply.");
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
    const initial = await (await context.request.get(`${hub.origin}/api/hub/settings/chat-preferences`)).json();
    expect(initial).toMatchObject({ version: 1, autoBackgroundOnSteer: true });
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
    await expect(page.locator("#personal-chat-preferences-status")).toHaveText("Unsaved changes — Save to apply.");
    await expect(input).not.toBeChecked();
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/hub/settings/chat-preferences") && response.request().method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await expect(input).not.toBeChecked();
    await expect(page.locator("#personal-chat-preferences-status")).toHaveText("Unsaved changes — Save to apply.");
    expect(await (await context.request.get(`${hub.origin}/api/hub/settings/chat-preferences`)).json()).toEqual(initial);
    await captureScreenshot(page, info, `personal-chat-${browserName}-touch-unsaved`);
    await save.tap();
    await expect(input).toBeEnabled();
    await expect(page.locator("#personal-chat-preferences-status")).toHaveText("Saved");
    await expect(input).not.toBeChecked();
    expect(await (await context.request.get(`${hub.origin}/api/hub/settings/chat-preferences`)).json()).toEqual({ version: 1, revision: initial.revision + 1, autoBackgroundOnSteer: false });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await captureScreenshot(page, info, `personal-chat-${browserName}-touch-${theme}`);
    }
    } finally { await browser.close(); }
  });
});
