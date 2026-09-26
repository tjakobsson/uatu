// A session page whose workspace is stopped while it is open — from the
// dashboard, another device, a hub restart — reads `Stopped` and offers the
// start in place, instead of sitting on `Reconnecting` until a reload lands
// on the hub's session-unavailable page (GitHub issue #396, change
// stopped-workspace-in-place-start). Through a real hub: the stop and the
// start are the hub's own session routes, the fact reaches the page over the
// brokered stream's activity topic, and the page proves it never reloaded by
// a marker set on `window` before the stop.
//
// Three ways back: the indicator's own start, a start from elsewhere (the
// hub API, standing in for the dashboard or another device), and the
// switcher menu's current row. Each is captured at desktop and phone sizes.

import type { BrowserContext, Page, TestInfo } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { childChatControl, expect, openHubMenu, test, type HubE2EInfo, type HubE2EWorkspace } from "./hub-fixtures";
import { treeRow } from "./tree-helpers";

test.use({ hubWorkspaces: ["alpha", "beta"] });

const DRAFT = "a draft that must survive the stop";
const STOPPED_TITLE = "The workspace session is stopped";

const indicator = (page: Page) => page.locator("#connection-state");
const indicatorLabel = (page: Page) => page.locator("#connection-state .connection-label");
const chipDot = (page: Page) => page.locator("#hub-toggle .indicator-dot");

async function stopSession(hub: HubE2EInfo, page: Page, id: string): Promise<void> {
  const stop = await page.context().request.post(`${hub.origin}/api/hub/sessions/${id}/stop`);
  expect(stop.ok()).toBe(true);
}

async function startSession(hub: HubE2EInfo, page: Page, id: string): Promise<void> {
  const start = await page.context().request.post(`${hub.origin}/api/hub/sessions/${id}/start`);
  expect(start.ok()).toBe(true);
}

// Marks the document so a reload — which would lose the marker — is
// detectable afterwards, whatever else the page looks like.
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __uatuNoReload?: boolean }).__uatuNoReload = true; });
}

async function expectNotReloaded(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __uatuNoReload?: boolean }).__uatuNoReload === true)).toBe(true);
}

async function expectStopped(page: Page): Promise<void> {
  await expect(indicatorLabel(page)).toHaveText("Stopped");
  await expect(indicator(page)).toHaveAttribute("title", STOPPED_TITLE);
  await expect(indicator(page)).toHaveAttribute("aria-label", "Start the workspace session");
  await expect(indicator(page)).toHaveClass(/is-stopped/);
  await expect(indicator(page)).not.toHaveClass(/is-reconnecting/);
  await expect(chipDot(page)).not.toHaveClass(/is-live/);
}

async function expectRecovered(page: Page): Promise<void> {
  await expect(indicatorLabel(page)).toHaveText("Connected");
  await expect(indicator(page)).toHaveAttribute("title", "Connected to the uatu backend");
  await expect(chipDot(page)).toHaveClass(/is-live/);
  await expect(page.locator("#connection-error")).toBeHidden();
  await expectNotReloaded(page);
}

// Opens the session and waits for the shell to be live. The previewed
// document is not asserted here: the selection is personal state the hub
// keeps per user and workspace, so a tab opens on whatever the previous
// test left — `stageWork` chooses, and `leaveTidy` puts the default back.
async function openTab(context: BrowserContext, workspace: HubE2EWorkspace): Promise<Page> {
  const page = await context.newPage();
  await page.goto(workspace.sessionUrl);
  await expect(indicatorLabel(page)).toHaveText("Connected");
  await expect(page.locator("#preview-path")).not.toHaveText("Waiting for viewable files");
  return page;
}

async function preview(page: Page, name: string, touch: boolean): Promise<void> {
  if (touch) {
    await page.locator('#touch-tab-bar [data-tab="files"]').click();
  }
  await treeRow(page, name).click();
  if (touch) {
    await page.locator('#touch-tab-bar [data-tab="preview"]').click();
  }
  await expect(page.locator("#preview-path")).toHaveText(name);
}

async function leaveTidy(page: Page, touch: boolean): Promise<void> {
  await preview(page, "README.md", touch);
}

// A page with something to lose: a document other than the default
// previewed, and a chat draft typed into a conversation but not sent.
async function stageWork(page: Page, workspace: HubE2EWorkspace, touch: boolean): Promise<void> {
  await preview(page, "diagram.md", touch);
  if (!touch) {
    const seeded = (await childChatControl(workspace, {
      action: "seed",
      title: "Left mid-thought",
      items: [{ id: "user:1", type: "user_message", createdAt: 10, text: "hello before the stop" }],
    })) as { conversation: { id: string } };
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    await expect(page.locator("#chat-items")).toContainText("hello before the stop");
    await page.locator("#chat-input").fill(DRAFT);
  }
  await markDocument(page);
}

async function expectWorkKept(page: Page, touch: boolean): Promise<void> {
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  if (!touch) await expect(page.locator("#chat-input")).toHaveValue(DRAFT);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await captureScreenshot(page, testInfo, name);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1400, height: 1000 } });

  test("a stop elsewhere reads Stopped; the indicator's start brings the page back with its document and draft", async ({ hub, hubContext }, testInfo) => {
    const page = await openTab(hubContext, hub.workspaces[0]!);
    await stageWork(page, hub.workspaces[0]!, false);

    await stopSession(hub, page, "alpha");
    await expectStopped(page);
    await expectNotReloaded(page);
    await shot(page, testInfo, "stopped-session-desktop-stopped");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, testInfo, "stopped-session-desktop-stopped-dark");
    await page.emulateMedia({ colorScheme: "light" });

    await indicator(page).click();
    await expect(indicator(page)).toHaveAttribute("aria-busy", "true");
    await expectRecovered(page);
    await expectWorkKept(page, false);
    await expect(indicator(page)).not.toHaveAttribute("aria-busy", "true");
    await shot(page, testInfo, "stopped-session-desktop-recovered");
    await leaveTidy(page, false);
  });

  test("a start from elsewhere clears Stopped from the stream, with no click and no reload", async ({ hub, hubContext }) => {
    const page = await openTab(hubContext, hub.workspaces[0]!);
    await stageWork(page, hub.workspaces[0]!, false);

    await stopSession(hub, page, "alpha");
    await expectStopped(page);

    await startSession(hub, page, "alpha");
    await expectRecovered(page);
    await expectWorkKept(page, false);
    await leaveTidy(page, false);
  });

  test("the switcher menu's current row starts the stopped session and stays on the page", async ({ hub, hubContext }, testInfo) => {
    const page = await openTab(hubContext, hub.workspaces[0]!);
    await stageWork(page, hub.workspaces[0]!, false);

    await stopSession(hub, page, "alpha");
    await expectStopped(page);

    await openHubMenu(page);
    const menu = page.locator("#hub-menu");
    const current = menu.locator('.hub-menu-item[href="/s/alpha/"]');
    await expect(current).toHaveAttribute("aria-current", "true");
    await expect(current.locator(".hub-menu-state")).toHaveText("stopped");
    await shot(page, testInfo, "stopped-session-desktop-menu");

    await current.click();
    await expect(current.locator(".hub-menu-state")).toHaveText("starting…");
    await expectRecovered(page);
    await expectWorkKept(page, false);
    // Still this session's page (the previewed document rides the URL).
    expect(page.url().startsWith(hub.workspaces[0]!.sessionUrl)).toBe(true);
    await leaveTidy(page, false);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("touch mode: the Files tab's indicator reads Stopped and its tap starts the session", async ({ hub, hubContext }, testInfo) => {
    const page = await openTab(hubContext, hub.workspaces[0]!);
    await stageWork(page, hub.workspaces[0]!, true);

    await stopSession(hub, page, "alpha");
    await page.locator('#touch-tab-bar [data-tab="files"]').click();
    await expectStopped(page);
    await expectNotReloaded(page);
    await shot(page, testInfo, "stopped-session-phone-stopped");

    await indicator(page).tap();
    await expectRecovered(page);
    await shot(page, testInfo, "stopped-session-phone-recovered");
    await page.locator('#touch-tab-bar [data-tab="preview"]').click();
    await expectWorkKept(page, true);
    await leaveTidy(page, true);
  });
});
