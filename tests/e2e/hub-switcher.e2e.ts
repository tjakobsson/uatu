// The workspace switcher's live activity through a real hub (task 4.5 of
// hub-brokered-live-stream, extended by task 6.1 of
// fix-workspace-activity-states): the collapsed chip badges when another
// workspace awaits the user, the open menu names each workspace's state
// (working / awaiting you / finished / stopped), answering the question
// clears the awaiting badge, work ending elsewhere leaves a finished badge
// until the user opens that workspace's chat, and a workspace holding only
// a backgrounded task still reads working — all from the brokered stream's
// activity topic, no reload. Each state is captured as a screenshot under
// the change's screenshots folder at desktop and phone sizes; the phone run
// is touch mode, where the switcher lives in the Files tab.


import { QUIET_BEFORE_NOTICE_MS } from "../../src/shell/attention-notice";
import { openChatPanel } from "./chat-helpers";
import { evidencePath, recordEvidence } from "./evidence";
import { childChatControl, expect, openHubMenu, openSessionTab, test, type HubE2EInfo, type HubE2EWorkspace } from "./hub-fixtures";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";


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

// The turn is over but the agent still holds a backgrounded task: the
// conversation's status is `background`, which the child's activity counts
// as working (design D1).
async function backgroundWork(staged: Staged): Promise<void> {
  await childChatControl(staged.gamma, { action: "status", conversationId: staged.gammaConversation, status: "background" });
}

// A clip-aware capture: the chip and its menu are small, and the review
// wants them close up. Same evidence path as captureScreenshot otherwise.
async function shot(page: Page, testInfo: TestInfo, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const target = evidencePath(testInfo, `${name}.png`);
  await page.screenshot({ path: target, animations: "disabled", caret: "hide", ...(clip ? { clip } : {}) });
  await recordEvidence(testInfo, target);
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

async function openMenu(page: Page): Promise<void> {
  await openHubMenu(page);
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator("#hub-menu")).toBeHidden();
}

// A menu row's state word and its tone class — the two are asserted
// together so a state can never be named in one and coloured as another.
function menuState(page: Page, id: string) {
  return page.locator(`#hub-menu .hub-menu-item[href="/s/${id}/"] .hub-menu-state`);
}

async function expectMenuState(page: Page, id: string, text: string, tone: string): Promise<void> {
  await expect(menuState(page, id)).toHaveText(text);
  await expect(menuState(page, id)).toHaveClass(new RegExp(`is-${tone}`));
}

async function openMenuAndExpectStates(page: Page): Promise<void> {
  await openMenu(page);
  const menu = page.locator("#hub-menu");
  // These workspaces are plain folders: no `.git` directory, no parent, so no
  // repository family. They stay flat rows with no group header, and there is
  // no repository title line anywhere — the chip is the only place a
  // repository is ever named.
  await expect(menu.locator(".hub-menu-group")).toHaveCount(0);
  await expect(menu.locator(".hub-menu-divider.is-group")).toHaveCount(0);
  await expect(page.locator("#hub-repository")).toHaveCount(0);
  // F1's boundary: with no repository family there is no repository and no
  // branch to name, so the chip carries the display name alone.
  await expect(page.locator("#hub-current")).toHaveText("alpha");
  await expect(page.locator("#hub-current .hub-toggle-branch")).toHaveCount(0);
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

// gamma's turn ends while the user is looking at alpha. The work is done
// but unseen, so the chip does NOT go quiet: the working dot is replaced by
// the finished pill, and it stays until the user opens gamma's chat. (Before
// fix-workspace-activity-states this step expected the badge to disappear —
// the very state the change exists to stop losing.)
async function expectFinished(page: Page, staged: Staged): Promise<void> {
  await finishWork(staged);
  await expectFinishedBadge(page);
}

async function expectFinishedBadge(page: Page): Promise<void> {
  const badge = page.locator("#hub-activity-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/is-finished/);
  await expect(badge).toHaveText("1");
  // Never colour alone: the chip's own name and tooltip say it too.
  await expect(page.locator("#hub-toggle")).toHaveAttribute("title", /Work finished in 1 workspace/);
  await expect(page.locator("#hub-toggle")).toHaveAttribute("aria-label", /Work finished in 1 workspace/);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1400, height: 1000 } });

  test("badges the chip for a question elsewhere, names states in the menu, clears when answered, then reads finished", async ({ hub, hubContext }, testInfo) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);

    await expectStaged(page);
    const badgedHeight = await chipHeight(page);
    await shot(page, testInfo, "after-switcher-desktop-chip-awaiting");
    await shot(page, testInfo, "after-switcher-desktop-chip-awaiting-closeup", await switcherClip(page));

    await openMenuAndExpectStates(page);
    await shot(page, testInfo, "after-switcher-desktop-menu");
    await shot(page, testInfo, "after-switcher-desktop-menu-closeup", await switcherClip(page));
    await closeMenu(page);

    await expectAnswered(page, staged);
    await shot(page, testInfo, "after-switcher-desktop-chip-answered");
    await shot(page, testInfo, "after-switcher-desktop-chip-answered-closeup", await switcherClip(page));

    await expectFinished(page, staged);
    await shot(page, testInfo, "after-switcher-desktop-chip-finished");
    await shot(page, testInfo, "after-switcher-desktop-chip-finished-closeup", await switcherClip(page));
    await openMenu(page);
    await expectMenuState(page, "gamma", "finished", "finished");
    await shot(page, testInfo, "after-switcher-desktop-menu-finished-closeup", await switcherClip(page));
    await closeMenu(page);
    // Both count pills must sit inside the label's line box: a taller badge
    // would shift every sidebar row below the chip each time a state changes.
    expect(Math.abs((await chipHeight(page)) - badgedHeight)).toBeLessThan(0.5);
  });

  test("a workspace holding only a backgrounded task still reads working, and reads finished once it is gone", async ({ hub, hubContext }, testInfo) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    // beta's question out of the way: the chip then speaks for gamma alone.
    await expectAnswered(page, staged);

    // The turn ends but a backgrounded task lives on. Work is still going on
    // there, so the workspace must not read finished — and the user must not
    // be told to go look at something that is not done.
    await backgroundWork(staged);
    const badge = page.locator("#hub-activity-badge");
    await expect(badge).toHaveClass(/is-working/);
    await expect(badge).toHaveText("");
    await expect(page.locator("#hub-toggle")).toHaveAttribute("title", /Agents working in 1 workspace/);
    await openMenu(page);
    await expectMenuState(page, "gamma", "working", "working");
    await shot(page, testInfo, "after-switcher-desktop-menu-background-closeup", await switcherClip(page));
    await closeMenu(page);

    // The background work is gone and no turn runs: now it is finished.
    await expectFinished(page, staged);
    await openMenu(page);
    await expectMenuState(page, "gamma", "finished", "finished");
    await closeMenu(page);
  });

  test("awaiting outranks finished on the chip while the menu names each state", async ({ hub, hubContext }, testInfo) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    await expectStaged(page);

    // gamma finishes while beta still waits for an answer: two other
    // workspaces, two different states, one chip.
    await finishWork(staged);
    const badge = page.locator("#hub-activity-badge");
    await expect(badge).toHaveClass(/is-awaiting/);
    await expect(badge).toHaveText("1");
    await expect(page.locator("#hub-toggle")).toHaveAttribute("title", /1 workspace awaiting your reply/);
    await openMenu(page);
    await expectMenuState(page, "beta", "awaiting you", "awaiting");
    await expectMenuState(page, "gamma", "finished", "finished");
    await shot(page, testInfo, "after-switcher-desktop-menu-awaiting-over-finished-closeup", await switcherClip(page));
    await closeMenu(page);

    // With the question answered the finished workspace is what is left to
    // say, so the chip demotes to the finished pill.
    await answerQuestion(staged);
    await expectFinishedBadge(page);
  });

  test("opening the finished workspace's chat clears its entry and the badge on another open page", async ({ hub, hubContext }, testInfo) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    // Only gamma's finish is left to report, so the badge clearing below can
    // be nothing but the acknowledgement.
    await expectAnswered(page, staged);
    await expectFinished(page, staged);
    const badgedHeight = await chipHeight(page);

    // The user opens gamma on another device — here, another page of the
    // same session — and its chat is in view. That page posts the viewed
    // acknowledgement; the hub clears the mark for this user everywhere.
    const acknowledgements: string[] = [];
    hubContext.on("request", request => {
      if (request.url().includes("/s/gamma/api/activity-viewed")) acknowledgements.push(request.url());
    });
    const gammaPage = await openSessionTab(hubContext, staged.gamma);
    // A fresh context boots with the chat panel collapsed: the page is on
    // gamma, but its chat is not in view, so nothing is acknowledged yet.
    await expect(gammaPage.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");
    // The page has heard that gamma finished (its own row says so), which is
    // the moment it would acknowledge if it were going to: it posts in the
    // same activity update that renders the row.
    await openMenu(gammaPage);
    await expectMenuState(gammaPage, "gamma", "finished", "finished");
    await closeMenu(gammaPage);
    expect(acknowledgements).toEqual([]);
    await expect(page.locator("#hub-activity-badge")).toHaveClass(/is-finished/);

    await openChatPanel(gammaPage);

    // No reload on the page left open: the brokered stream carries the
    // cleared fact to it.
    const badge = page.locator("#hub-activity-badge");
    await expect(badge).toBeHidden();
    await expect(page.locator("#hub-toggle")).not.toHaveAttribute("title", /awaiting|working|finished/);
    await openMenu(page);
    // Running and idle needs no word: the row's state column is gone.
    await expect(menuState(page, "gamma")).toHaveCount(0);
    await shot(page, testInfo, "after-switcher-desktop-menu-viewed-closeup", await switcherClip(page));
    await closeMenu(page);
    // The chip without a badge is the same height as the chip with one.
    expect(Math.abs((await chipHeight(page)) - badgedHeight)).toBeLessThan(0.5);
    await gammaPage.close();
  });
});

test.describe("phone", () => {
  // iPhone 13 Pro portrait; hasTouch + isMobile give a coarse pointer, which
  // boots the UI into touch mode with the bottom tab bar.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the same switcher states in touch mode's Files tab", async ({ hub, hubContext }, testInfo) => {
    const staged = await stageActivity(hub, hubContext);
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-files").click();
    await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "true");

    await expectStaged(page);
    await shot(page, testInfo, "after-switcher-phone-chip-awaiting");

    await openMenuAndExpectStates(page);
    await shot(page, testInfo, "after-switcher-phone-menu");
    await closeMenu(page);

    await expectAnswered(page, staged);
    await shot(page, testInfo, "after-switcher-phone-chip-answered");

    await expectFinished(page, staged);
    await shot(page, testInfo, "after-switcher-phone-chip-finished");
    await openMenu(page);
    await expectMenuState(page, "gamma", "finished", "finished");
    await shot(page, testInfo, "after-switcher-phone-menu-finished");
    await closeMenu(page);
  });
});

// Session pages announce questions waiting in other workspaces
// (quiet-notifications-while-present). While a page is visible the hub holds
// the user's pushes, so a question elsewhere raises an in-app notice naming
// the workspace; Open lands on that workspace's waiting conversation. Every
// test answers what it staged, so the next test's page starts from a quiet
// baseline.
test.describe("in-app notice for questions elsewhere", () => {
  type Question = { workspace: HubE2EWorkspace; conversationId: string; itemId: string };

  const permission = (itemId: string, status: "pending" | "resolved") => ({
    id: itemId, type: "permission", createdAt: 10, requestId: itemId, action: "bash", resources: ["rm -rf build"], status,
    ...(status === "resolved" ? { outcome: "approved-once" } : {}),
  });

  async function ask(hub: HubE2EInfo, id: string, title: string, itemId: string): Promise<Question> {
    const workspace = hub.workspaces.find(entry => entry.id === id)!;
    const seeded = (await childChatControl(workspace, { action: "seed", title, items: [] })) as { conversation: { id: string } };
    await childChatControl(workspace, { action: "item", conversationId: seeded.conversation.id, item: permission(itemId, "pending") });
    return { workspace, conversationId: seeded.conversation.id, itemId };
  }

  async function answer(question: Question): Promise<void> {
    await childChatControl(question.workspace, { action: "item", conversationId: question.conversationId, item: permission(question.itemId, "resolved") });
  }

  const notice = (page: Page, id: string) => page.locator(`.attention-notice[data-workspace-id="${id}"]`);

  // The page's first activity report is its baseline, and a question counts
  // as new only after the workspace has read quiet for a moment
  // (QUIET_BEFORE_NOTICE_MS): wait for both before staging.
  async function settled(page: Page): Promise<void> {
    await expect(page.locator("#hub-control")).toBeVisible();
    await expect(page.locator("#hub-toggle")).not.toHaveAttribute("title", /awaiting/);
    await page.waitForTimeout(QUIET_BEFORE_NOTICE_MS + 100);
  }

  test("a question elsewhere raises a notice whose Open lands on the waiting conversation", async ({ hub, hubContext }, testInfo) => {
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    await settled(page);
    const question = await ask(hub, "beta", "Needs an answer", "permission:notice-open");
    try {
      await expect(notice(page, "beta")).toBeVisible();
      await expect(notice(page, "beta")).toContainText("beta");
      await expect(notice(page, "beta")).toContainText("An agent needs your answer");
      await expect(notice(page, "beta")).not.toContainText("rm -rf");
      await expect(page.locator("#hub-activity-badge")).toHaveClass(/is-awaiting/);
      await expect(page.locator(".attention-notice")).toHaveCount(1);
      await shot(page, testInfo, "after-notice-desktop");
      await shot(page, testInfo, "after-notice-desktop-closeup", (await notice(page, "beta").boundingBox().then(box => ({ x: Math.max(0, box!.x - 16), y: Math.max(0, box!.y - 16), width: box!.width + 32, height: box!.height + 32 }))));

      await notice(page, "beta").getByRole("link", { name: "Open" }).click();
      await expect(page).toHaveURL(new RegExp(`/s/beta/.*conversation=${encodeURIComponent(question.conversationId)}`));
      await expect(page.locator("#chat-conversation-select")).toHaveValue(question.conversationId);
      await expect(page.locator("#chat-items")).toContainText("rm -rf build");
      await expect(page).not.toHaveURL(/awaiting=1/);
      await shot(page, testInfo, "after-notice-desktop-opened");
    } finally { await answer(question); }
  });

  test("the notice clears when the question is answered elsewhere, and Dismiss or opening it elsewhere removes it", async ({ hub, hubContext }) => {
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    await settled(page);
    const first = await ask(hub, "beta", "Answered elsewhere", "permission:notice-answered");
    await expect(notice(page, "beta")).toBeVisible();
    await answer(first);
    await expect(notice(page, "beta")).toHaveCount(0);
    await settled(page);

    const second = await ask(hub, "beta", "Dismissed", "permission:notice-dismissed");
    try {
      await expect(notice(page, "beta")).toBeVisible();
      await notice(page, "beta").getByRole("button", { name: /Dismiss/ }).click();
      await expect(notice(page, "beta")).toHaveCount(0);
      // Still awaiting: the badge carries it, the notice stays gone.
      await expect(page.locator("#hub-activity-badge")).toHaveClass(/is-awaiting/);
    } finally { await answer(second); }

    // Opening it elsewhere (a modified click) leaves this page where it is
    // and still clears the notice.
    await settled(page);
    const third = await ask(hub, "beta", "Opened in a new tab", "permission:notice-new-tab");
    try {
      await expect(notice(page, "beta")).toBeVisible();
      const opened = hubContext.waitForEvent("page");
      await notice(page, "beta").getByRole("link", { name: "Open" }).click({ modifiers: ["ControlOrMeta"] });
      const elsewhere = await opened;
      await expect(elsewhere).toHaveURL(/\/s\/beta\//);
      await expect(page).toHaveURL(/\/s\/alpha\//);
      await expect(notice(page, "beta")).toHaveCount(0);
      await elsewhere.close();
    } finally { await answer(third); }
  });

  test("a workspace already waiting on load, the served workspace, and a finished turn raise nothing", async ({ hub, hubContext }) => {
    const waiting = await ask(hub, "beta", "Already waiting", "permission:notice-baseline");
    const own = hub.workspaces[0]!;
    try {
      const page = await openSessionTab(hubContext, own);
      await expect(page.locator("#hub-activity-badge")).toHaveClass(/is-awaiting/);
      const mine = await ask(hub, own.id, "Mine", "permission:notice-own");
      const busy = (await childChatControl(hub.workspaces.find(entry => entry.id === "gamma")!, { action: "seed", title: "Finishing", items: [] })) as { conversation: { id: string } };
      const gamma = hub.workspaces.find(entry => entry.id === "gamma")!;
      await childChatControl(gamma, { action: "status", conversationId: busy.conversation.id, status: "running" });
      await openMenu(page);
      await expectMenuState(page, "gamma", "working", "working");
      await childChatControl(gamma, { action: "status", conversationId: busy.conversation.id, status: "completed" });
      await expectMenuState(page, "gamma", "finished", "finished");
      await closeMenu(page);
      await expect(page.locator(".attention-notice")).toHaveCount(0);
      await answer(mine);
    } finally { await answer(waiting); }
  });

  test("a question raised while the page was hidden is announced when it comes back", async ({ hub, hubContext }) => {
    const page = await openSessionTab(hubContext, hub.workspaces[0]!);
    await settled(page);
    const setVisibility = (state: "hidden" | "visible") => page.evaluate(value => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
    await setVisibility("hidden");
    const question = await ask(hub, "beta", "Asked while hidden", "permission:notice-hidden");
    try {
      await page.waitForTimeout(500);
      await expect(page.locator(".attention-notice")).toHaveCount(0);
      await setVisibility("visible");
      await expect(notice(page, "beta")).toBeVisible();
    } finally { await answer(question); }
  });

  test("Open after the answer shows the list with a note instead of another conversation", async ({ hub, hubContext }) => {
    const beta = hub.workspaces.find(entry => entry.id === "beta")!;
    await childChatControl(beta, { action: "seed", title: "Unrelated", items: [] });
    const page = await hubContext.newPage();
    await page.goto(`${hub.origin}/s/beta/?awaiting=1`);
    await expect(page.locator("#chat-state")).toHaveText("That request was already answered.");
    await expect(page.locator("#chat-conversation-select")).toHaveValue("");
    await expect(page).not.toHaveURL(/awaiting=1/);
  });

  test.describe("touch mode", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the notice sits above the tab bar and Open lands in Chat on the waiting conversation", async ({ hub, hubContext }, testInfo) => {
      // A conversation of its own, so the Chat tab shows its composer.
      await childChatControl(hub.workspaces[0]!, { action: "seed", title: "Working here", items: [{ id: "u1", type: "user_message", createdAt: 1, text: "Refactor the parser." }] });
      const page = await openSessionTab(hubContext, hub.workspaces[0]!);
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
      await page.locator("#touch-tab-files").click();
      await settled(page);
      const question = await ask(hub, "beta", "Needs an answer on the phone", "permission:notice-touch");
      try {
        await expect(notice(page, "beta")).toBeVisible();
        const box = (await notice(page, "beta").boundingBox())!;
        const bar = (await page.locator("#touch-tab-bar").boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
        await shot(page, testInfo, "after-notice-phone-files");
        // Every tab stays reachable with the notice up.
        await page.locator("#touch-tab-chat").click();
        await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#chat-input")).toBeVisible();
        const top = (await notice(page, "beta").boundingBox())!;
        const composer = (await page.locator("#chat-input").boundingBox())!;
        expect(top.y + top.height).toBeLessThanOrEqual(composer.y);
        await shot(page, testInfo, "after-notice-phone-chat");
        await notice(page, "beta").getByRole("link", { name: "Open" }).click();
        await expect(page).toHaveURL(/\/s\/beta\//);
        await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator("#chat-conversation-select")).toHaveValue(question.conversationId);
        await shot(page, testInfo, "after-notice-phone-opened");
      } finally { await answer(question); }
    });

    test("Open after the answer lands in Chat with the note", async ({ hub, hubContext }, testInfo) => {
      const page = await hubContext.newPage();
      await page.goto(`${hub.origin}/s/beta/?awaiting=1`);
      await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#chat-state")).toHaveText("That request was already answered.");
      await expect(page.locator("#chat-conversation-select")).toHaveValue("");
      await shot(page, testInfo, "after-notice-phone-already-answered");
    });
  });
});
