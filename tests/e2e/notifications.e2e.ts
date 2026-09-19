import { createECDH, randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureScreenshot } from "./evidence";
import { childChatControl, expect, test } from "./hub-fixtures";

test.use({ hubWorkspaces: ["alpha", "beta"] });

test("enrollment preserves an unrelated root worker and explains the conflict", async ({ hub, hubContext }) => {
  await hubContext.addInitScript(() => Object.defineProperty(Notification, "permission", { configurable: true, value: "granted" }));
  await hubContext.route("**/other-worker.js", route => route.fulfill({ contentType: "application/javascript", body: 'self.addEventListener("install", e => e.waitUntil(self.skipWaiting())); self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));' }));
  const page = await hubContext.newPage();
  await page.goto(hub.origin);
  await page.evaluate(async () => { await navigator.serviceWorker.register("/other-worker.js", { scope: "/" }); await navigator.serviceWorker.ready; });
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Another application's service worker");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(reg => new URL(reg.active!.scriptURL).pathname))).toEqual(["/other-worker.js"]);
});

test("unsupported and denied notification states explain the prerequisite without prompting", async ({ hub, hubContext }) => {
  await hubContext.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { configurable: true, value: "denied" });
    Notification.requestPermission = async () => { throw new Error("permission must not be requested"); };
  });
  const page = await hubContext.newPage();
  await page.goto(hub.origin);
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("blocked");
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => Object.defineProperty(window, "isSecureContext", { configurable: true, value: false }));
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("HTTPS");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test("device enrollment uses a user gesture and survives workspace navigation and reload", async ({ hub, hubContext }) => {
  const key = createECDH("prime256v1"); key.generateKeys();
  const subscription = { endpoint: "https://web.push.apple.com/browser-fixture", keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  // Real worker registration and hub API, simulated platform enrollment.
  test.info().annotations.push({ type: "simulation", description: "PushManager and permission response are simulated; no OS delivery claimed." });
  await hubContext.addInitScript(value => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => localStorage.getItem("test:permission") || "default" });
    Notification.requestPermission = async () => {
      localStorage.setItem("test:gesture", String(navigator.userActivation.isActive));
      localStorage.setItem("test:permission", "granted");
      return "granted";
    };
    const existing = () => localStorage.getItem("test:subscription") ? {
      toJSON: () => value,
      unsubscribe: async () => { localStorage.removeItem("test:subscription"); return true; },
    } as PushSubscription : null;
    PushManager.prototype.getSubscription = async () => existing();
    PushManager.prototype.subscribe = async () => { localStorage.setItem("test:subscription", "yes"); return existing()!; };
  }, subscription);
  const page = await hubContext.newPage();
  await page.goto(hub.origin);
  expect(await page.evaluate(() => localStorage.getItem("test:gesture"))).toBeNull();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Notifications", exact: true });
  await expect(dialog.getByRole("button", { name: "Enable notifications", exact: true })).toBeEnabled();
  await expect(dialog.locator('fieldset input:checked')).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "alpha", exact: true }).check();
  await dialog.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("saved");
  expect(await page.evaluate(() => localStorage.getItem("test:gesture"))).toBe("true");
  await page.goto(hub.workspaces[0]!.sessionUrl);
  await expect(page.locator('meta[name="uatu-hub"]')).toHaveAttribute("content", "true");
  await page.getByRole("button", { name: "Notifications", exact: true }).first().click();
  await expect(dialog.getByRole("button", { name: "Save preferences" })).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: "alpha", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "beta", exact: true })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Successful turn completion" }).uncheck();
  await dialog.getByRole("button", { name: "Save preferences" }).click();
  await expect(dialog.getByRole("status")).toContainText("saved");
  await page.reload();
  await page.getByRole("button", { name: "Notifications", exact: true }).first().click();
  await expect(dialog.getByRole("button", { name: "Save preferences" })).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: "Successful turn completion" })).not.toBeChecked();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(reg => new URL(reg.active!.scriptURL).pathname))).toEqual(["/push-worker.js"]);
  // An older page's cleanup removed the registration. A current page must
  // recover the worker and offer explicit subscription renewal.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    localStorage.removeItem("test:subscription");
  });
  await page.reload();
  await page.getByRole("button", { name: "Notifications", exact: true }).first().click();
  await expect(dialog.getByRole("button", { name: "Enable notifications", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("saved");
  await dialog.getByRole("button", { name: "Disable on this device" }).click();
  await expect(dialog.getByRole("status")).toContainText("disabled");
  expect(await page.evaluate(() => localStorage.getItem("test:subscription"))).toBeNull();
});

for (const mode of ["desktop", "touch", "narrow-desktop"] as const) {
  test(`notification destination opens the named conversation in ${mode}`, async ({ hub, hubContext }) => {
    const workspace = hub.workspaces[0]!;
    const seeded = await childChatControl(workspace, { action: "seed", title: "Notification target", items: [{ id: "notice-user", type: "user_message", createdAt: 1, text: "This is the notification target" }] }) as { conversation: { id: string } };
    await childChatControl(workspace, { action: "seed", title: "Newer unrelated conversation", items: [] });
    const page = await hubContext.newPage();
    if (mode !== "desktop") await page.setViewportSize({ width: 600, height: 800 });
    await page.addInitScript(({ mode, basePath }) => localStorage.setItem(`uatu:presentation:v1:${encodeURIComponent(basePath)}:uatu:ui-mode`, mode), {
      mode: mode === "touch" ? "touch" : "desktop", basePath: new URL(workspace.sessionUrl).pathname,
    });
    await page.goto(`${workspace.sessionUrl}?conversation=${encodeURIComponent(seeded.conversation.id)}`);
    await expect(page.locator("#chat-items")).toContainText("This is the notification target");
    await expect(page.locator("#chat-input")).toBeVisible();
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
    if (mode === "touch") await expect(page.locator("html")).toHaveAttribute("data-active-tab", "chat");
    if (mode === "narrow-desktop") await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    if (mode === "narrow-desktop") {
      await page.locator("#chat-collapse").click();
      await expect(page.locator("#chat-input")).toBeHidden();
    }
  });
}

test("opening a notification preserves the other conversation's draft", async ({ hub, hubContext }) => {
  const workspace = hub.workspaces[0]!;
  const previous = await childChatControl(workspace, { action: "seed", title: "Draft conversation", items: [] }) as { conversation: { id: string } };
  const target = await childChatControl(workspace, { action: "seed", title: "Answer here", items: [] }) as { conversation: { id: string } };
  const page = await hubContext.newPage();
  await page.goto(`${workspace.sessionUrl}?conversation=${encodeURIComponent(previous.conversation.id)}`);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(previous.conversation.id);
  await page.locator("#chat-input").fill("Keep this unsent draft");
  await page.goto(`${workspace.sessionUrl}?conversation=${encodeURIComponent(target.conversation.id)}`);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(target.conversation.id);
  await expect(page.locator("#chat-input")).toHaveValue("");
  await page.locator("#chat-conversation-select").selectOption(previous.conversation.id);
  await expect(page.locator("#chat-input")).toHaveValue("Keep this unsent draft");
});

test("notification destination survives login and an unavailable target never falls back", async ({ hub, browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const target = `${hub.workspaces[0]!.sessionUrl}?conversation=opencode%3Amissing-notification-target`;
    await page.goto(target);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.locator('input[name="name"]').fill(hub.user.name);
    await page.locator('input[name="password"]').fill(hub.user.password);
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/conversation=opencode%3Amissing-notification-target/);
    await expect(page.locator("#chat-surface > .chat-read-error")).toBeVisible();
    await expect(page.locator("#chat-items")).not.toContainText("This is the notification target");
  } finally { await context.close(); }
});

// Last in the file: the workspace it registers stays in the worker's hub.
test("all workspaces is a standing rule that outlives reload and a later-registered workspace", async ({ hub, hubContext }, testInfo) => {
  const key = createECDH("prime256v1"); key.generateKeys();
  const subscription = { endpoint: "https://web.push.apple.com/all-workspaces-fixture", keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  test.info().annotations.push({ type: "simulation", description: "PushManager and permission response are simulated; no OS delivery claimed." });
  await hubContext.addInitScript(value => {
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => localStorage.getItem("test:permission") || "default" });
    Notification.requestPermission = async () => { localStorage.setItem("test:permission", "granted"); return "granted"; };
    const existing = () => localStorage.getItem("test:subscription") ? {
      toJSON: () => value,
      unsubscribe: async () => { localStorage.removeItem("test:subscription"); return true; },
    } as PushSubscription : null;
    PushManager.prototype.getSubscription = async () => existing();
    PushManager.prototype.subscribe = async () => { localStorage.setItem("test:subscription", "yes"); return existing()!; };
  }, subscription);
  const page = await hubContext.newPage();
  await page.goto(hub.workspaces[0]!.sessionUrl);
  const openDialog = async () => {
    await page.getByRole("button", { name: "Notifications", exact: true }).first().click();
    await expect(dialog.getByRole("button", { name: /Enable notifications|Save preferences/ })).toBeEnabled();
  };
  const dialog = page.getByRole("dialog", { name: "Notifications", exact: true });
  const all = dialog.getByRole("checkbox", { name: "All workspaces, including ones added later" });
  const alpha = dialog.getByRole("checkbox", { name: "alpha", exact: true });
  const beta = dialog.getByRole("checkbox", { name: "beta", exact: true });
  await openDialog();
  // Off by default; the current workspace is still the preselection.
  await expect(all).not.toBeChecked();
  await expect(alpha).toBeChecked();
  await expect(beta).not.toBeChecked();
  await captureScreenshot(page, testInfo, "notifications-selected-mode");
  // The rule stands in for the list without discarding the ticks.
  await all.check();
  await expect(alpha).toBeDisabled(); await expect(alpha).toBeChecked();
  await expect(beta).toBeDisabled(); await expect(beta).not.toBeChecked();
  await captureScreenshot(page, testInfo, "notifications-all-workspaces");
  await all.uncheck();
  await expect(alpha).toBeEnabled(); await expect(alpha).toBeChecked();
  await all.check();
  await dialog.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("all workspaces");
  await page.reload();
  await openDialog();
  await expect(dialog.getByRole("status")).toContainText("enabled for all workspaces");
  await expect(all).toBeChecked();
  await expect(alpha).toBeDisabled(); await expect(alpha).toBeChecked();
  // A workspace registered afterwards is covered by the rule, not appended to the selection.
  const folder = path.join(await mkdtemp(path.join(tmpdir(), "uatu-e2e-notify-")), "gamma");
  await mkdir(folder);
  const created = await page.evaluate(async target => {
    const response = await fetch("/api/hub/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target, init: true, start: false }) });
    return { status: response.status, body: await response.json() as { id?: string } };
  }, folder);
  expect(created).toMatchObject({ status: 200, body: { id: "gamma" } });
  const state = await page.evaluate(async () => {
    const response = await fetch(`/api/hub/notifications?device=${encodeURIComponent(localStorage.getItem("uatu:push-device")!)}`);
    return await response.json() as { device: { allWorkspaces: boolean; workspaceIds: string[]; active: boolean } };
  });
  expect(state.device).toMatchObject({ allWorkspaces: true, workspaceIds: ["alpha"], active: true });
  await page.reload();
  await openDialog();
  const gamma = dialog.getByRole("checkbox", { name: "gamma", exact: true });
  await expect(all).toBeChecked();
  await expect(gamma).toBeDisabled(); await expect(gamma).not.toBeChecked();
  // Turning the rule off returns to the stored selection, without the newcomer.
  await all.uncheck();
  await expect(alpha).toBeChecked(); await expect(beta).not.toBeChecked(); await expect(gamma).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save preferences" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Notification preferences saved for this device.");
  await page.reload();
  await openDialog();
  await expect(all).not.toBeChecked();
  await expect(alpha).toBeEnabled(); await expect(alpha).toBeChecked();
  await expect(gamma).not.toBeChecked();
  // The dashboard shares the dialog.
  await page.goto(hub.origin);
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save preferences" })).toBeEnabled();
  await expect(all).not.toBeChecked();
  await captureScreenshot(page, testInfo, "notifications-dashboard");
});
