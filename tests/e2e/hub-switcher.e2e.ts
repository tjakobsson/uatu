// The workspace switcher's live activity through a real hub (task 4.5 of
// hub-brokered-live-stream): the collapsed chip badges when another
// workspace awaits the user, the open menu names each workspace's state
// (working / awaiting you / stopped), and answering the question clears the
// badge — all from the brokered stream's activity topic, no reload. Each
// state is captured as a screenshot under the change's screenshots folder
// at desktop and phone sizes; the phone run is touch mode, where the
// switcher lives in the Files tab.

import path from "node:path";

import { changeScreenshotsDir } from "./chat-helpers";
import { childChatControl, expect, openSessionTab, test, type HubE2EInfo, type HubE2EWorkspace } from "./hub-fixtures";
import type { BrowserContext, Page } from "@playwright/test";

const SCREENSHOTS = changeScreenshotsDir("hub-brokered-live-stream");

// alpha: the session on screen. beta: a permission request pending
// (awaiting). gamma: a turn in flight (working). delta: stopped.
test.use({ hubWorkspaces: ["alpha", "beta", "gamma", "delta"] });

type Staged = { beta: HubE2EWorkspace; betaConversation: string; gamma: HubE2EWorkspace; gammaConversation: string };

async function stageActivity(hub: HubE2EInfo, context: BrowserContext): Promise<Staged> {
  const byId = (id: string) => hub.workspaces.find(workspace => workspace.id === id)!;
  const beta = byId("beta");
  const gamma = byId("gamma");

  const stop = await context.request.post(`${hub.origin}/api/hub/sessions/delta/stop`);
  expect(stop.ok()).toBe(true);

  const seededBeta = (await childChatControl(beta, { action: "seed", title: "Needs an answer", items: [] })) as { conversation: { id: string } };
  await childChatControl(beta, {
    action: "item",
    conversationId: seededBeta.conversation.id,
    item: { id: "permission:p1", type: "permission", createdAt: 10, requestId: "p1", action: "bash", resources: ["rm -rf build"], status: "pending" },
  });

  const seededGamma = (await childChatControl(gamma, { action: "seed", title: "Busy", items: [] })) as { conversation: { id: string } };
  await childChatControl(gamma, { action: "status", conversationId: seededGamma.conversation.id, status: "running" });

  return { beta, betaConversation: seededBeta.conversation.id, gamma, gammaConversation: seededGamma.conversation.id };
}

async function answerQuestion(staged: Staged): Promise<void> {
  await childChatControl(staged.beta, {
    action: "item",
    conversationId: staged.betaConversation,
    item: { id: "permission:p1", type: "permission", createdAt: 10, requestId: "p1", action: "bash", resources: ["rm -rf build"], status: "resolved", outcome: "approved-once" },
  });
}

async function finishWork(staged: Staged): Promise<void> {
  await childChatControl(staged.gamma, { action: "status", conversationId: staged.gammaConversation, status: "completed" });
}

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), animations: "disabled", caret: "hide", ...(clip ? { clip } : {}) });
}

// A close-up of the chip and, when open, its menu — the review needs the
// badge legible, not a 1400 px canvas with a 20 px dot in it.
async function switcherClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const control = await page.locator("#hub-control").boundingBox();
  const menu = await page.locator("#hub-menu").boundingBox();
  const box = menu && control
    ? { x: Math.min(control.x, menu.x), y: control.y, width: Math.max(control.width, menu.x + menu.width - control.x), height: menu.y + menu.height - control.y }
    : control!;
  const pad = 16;
  return { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 };
}

async function expectStaged(page: Page): Promise<void> {
  await expect(page.locator("#hub-control")).toBeVisible();
  const badge = page.locator("#hub-activity-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/is-awaiting/);
  await expect(badge).toHaveText("1");
  await expect(page.locator("#hub-toggle")).toHaveAttribute("title", /1 workspace awaiting your reply/);
}

// The badge must not resize the chip: a pill taller than the label's line
// box would shift every sidebar row below it each time a question arrives
// or is answered.
async function chipHeight(page: Page): Promise<number> {
  const box = await page.locator("#hub-toggle").boundingBox();
  return box?.height ?? 0;
}

async function openMenuAndExpectStates(page: Page): Promise<void> {
  await page.locator("#hub-toggle").click();
  const menu = page.locator("#hub-menu");
  await expect(menu).toBeVisible();
  const item = (id: string) => menu.locator(`.hub-menu-item[href="/s/${id}/"]`);
  await expect(item("alpha")).toHaveAttribute("aria-current", "true");
  await expect(item("beta").locator(".hub-menu-state")).toHaveText("awaiting you");
  await expect(item("beta").locator(".hub-menu-state")).toHaveClass(/is-awaiting/);
  await expect(item("gamma").locator(".hub-menu-state")).toHaveText("working");
  await expect(item("delta").locator(".hub-menu-state")).toHaveText("stopped");
}

async function expectAnswered(page: Page, staged: Staged): Promise<void> {
  await answerQuestion(staged);
  const badge = page.locator("#hub-activity-badge");
  // Awaiting cleared; gamma still works, so the badge is the working dot.
  await expect(badge).toHaveClass(/is-working/);
  await expect(badge).toHaveText("");
  await expect(page.locator("#hub-toggle")).toHaveAttribute("title", /Agents working in 1 workspace/);
}

async function expectIdle(page: Page, staged: Staged): Promise<void> {
  await finishWork(staged);
  await expect(page.locator("#hub-activity-badge")).toBeHidden();
  await expect(page.locator("#hub-toggle")).not.toHaveAttribute("title", /awaiting|working/);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1400, height: 1000 } });

  test("badges the chip for a question elsewhere, names states in the menu, clears when answered", async ({ hub, hubContext }) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);

    await expectStaged(page);
    const badgedHeight = await chipHeight(page);
    await shot(page, "after-switcher-desktop-chip-awaiting");
    await shot(page, "after-switcher-desktop-chip-awaiting-closeup", await switcherClip(page));

    await openMenuAndExpectStates(page);
    await shot(page, "after-switcher-desktop-menu");
    await shot(page, "after-switcher-desktop-menu-closeup", await switcherClip(page));
    await page.keyboard.press("Escape");
    await expect(page.locator("#hub-menu")).toBeHidden();

    await expectAnswered(page, staged);
    await shot(page, "after-switcher-desktop-chip-answered");
    await shot(page, "after-switcher-desktop-chip-answered-closeup", await switcherClip(page));

    await expectIdle(page, staged);
    await shot(page, "after-switcher-desktop-chip-idle-closeup", await switcherClip(page));
    expect(Math.abs((await chipHeight(page)) - badgedHeight)).toBeLessThan(0.5);
  });
});

test.describe("phone", () => {
  // iPhone 13 Pro portrait; hasTouch + isMobile give a coarse pointer, which
  // boots the UI into touch mode with the bottom tab bar.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the same switcher states in touch mode's Files tab", async ({ hub, hubContext }) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-files").click();
    await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "true");

    await expectStaged(page);
    await shot(page, "after-switcher-phone-chip-awaiting");

    await openMenuAndExpectStates(page);
    await shot(page, "after-switcher-phone-menu");
    await page.keyboard.press("Escape");
    await expect(page.locator("#hub-menu")).toBeHidden();

    await expectAnswered(page, staged);
    await shot(page, "after-switcher-phone-chip-answered");

    await expectIdle(page, staged);
  });
});
