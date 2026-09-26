// Pushes wait while the user is looking at Uatu (quiet-notifications-while-
// present). A real hub observes its children's notification feeds and
// records every push it would send; presence comes from the session pages'
// own live streams, so a visible page quiets the push and hiding it — the
// page's real visibility path, which releases its stream — lets a question
// still waiting follow the user out. The grace period is shortened to 1.5 s
// (hub-server.ts, UATU_E2E_HUB_PRESENCE_GRACE_MS).

import { createECDH, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { childChatControl, expect, openSessionTab, test, type HubE2EInfo, type HubE2EWorkspace } from "./hub-fixtures";

test.use({ hubWorkspaces: ["alpha", "beta"], hubPush: true });

const GRACE_MS = 1_500;
type Push = { endpoint: string; payload: { kind: string; url: string } };

async function enroll(hub: HubE2EInfo, context: BrowserContext): Promise<void> {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const response = await context.request.put(`${hub.origin}/api/hub/notifications`, {
    headers: { origin: hub.origin },
    data: {
      subscription: { endpoint: "https://web.push.apple.com/e2e-device", keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } },
      allWorkspaces: true, workspaceIds: [], needsAnswer: true, completed: true,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function pushes(hub: HubE2EInfo, conversationId: string): Promise<Push[]> {
  const text = await fs.readFile(hub.pushLog!, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Push)
    .filter(push => push.payload.url.includes(encodeURIComponent(conversationId)));
}

function workspace(hub: HubE2EInfo, id: string): HubE2EWorkspace {
  return hub.workspaces.find(entry => entry.id === id)!;
}

async function ask(hub: HubE2EInfo, title: string, itemId: string): Promise<{ conversationId: string; answer: () => Promise<unknown> }> {
  const beta = workspace(hub, "beta");
  const seeded = (await childChatControl(beta, { action: "seed", title, items: [] })) as { conversation: { id: string } };
  const item = { id: itemId, type: "permission", createdAt: 10, requestId: itemId, action: "bash", resources: ["make release"], status: "pending" };
  await childChatControl(beta, { action: "item", conversationId: seeded.conversation.id, item });
  return {
    conversationId: seeded.conversation.id,
    answer: () => childChatControl(beta, { action: "item", conversationId: seeded.conversation.id, item: { ...item, status: "resolved", outcome: "approved-once" } }),
  };
}

// The page's real hide path: the lifecycle recovery sees `visibilitychange`
// with the document hidden and releases the page's live stream.
async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

// Whatever page a previous test left has closed with its context; wait out
// the grace period so this test starts with the user away.
async function away(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, GRACE_MS + 500));
}

test("a question while a session page is visible is held, then pushed once the page is hidden", async ({ hub, hubContext }) => {
  await away();
  await enroll(hub, hubContext);
  const page = await openSessionTab(hubContext, workspace(hub, "alpha"));
  const question = await ask(hub, "Held while looking", "permission:held");
  try {
    await page.waitForTimeout(3_000);
    expect(await pushes(hub, question.conversationId)).toEqual([]);
    await setVisibility(page, "hidden");
    await expect.poll(() => pushes(hub, question.conversationId), { timeout: 10_000 }).toHaveLength(1);
    expect((await pushes(hub, question.conversationId))[0]!.payload.kind).toBe("permission-pending");
    await page.waitForTimeout(1_500);
    expect(await pushes(hub, question.conversationId)).toHaveLength(1);
  } finally { await question.answer(); }
});

test("a question answered before the page is hidden is never pushed", async ({ hub, hubContext }) => {
  await away();
  await enroll(hub, hubContext);
  const page = await openSessionTab(hubContext, workspace(hub, "alpha"));
  const question = await ask(hub, "Answered while looking", "permission:answered");
  await page.waitForTimeout(1_000);
  await question.answer();
  await page.waitForTimeout(500);
  await setVisibility(page, "hidden");
  await page.waitForTimeout(GRACE_MS + 2_500);
  expect(await pushes(hub, question.conversationId)).toEqual([]);
});

test("a turn that finishes while a session page is visible is not pushed", async ({ hub, hubContext }) => {
  await away();
  await enroll(hub, hubContext);
  const page = await openSessionTab(hubContext, workspace(hub, "alpha"));
  const beta = workspace(hub, "beta");
  const seeded = (await childChatControl(beta, { action: "seed", title: "Finishing while looking", items: [] })) as { conversation: { id: string } };
  await childChatControl(beta, { action: "status", conversationId: seeded.conversation.id, status: "running" });
  await childChatControl(beta, { action: "status", conversationId: seeded.conversation.id, status: "completed" });
  await page.waitForTimeout(1_000);
  await setVisibility(page, "hidden");
  await page.waitForTimeout(GRACE_MS + 2_500);
  expect(await pushes(hub, seeded.conversation.id)).toEqual([]);
});

test("with no session page open, a question and a finished turn are pushed without waiting", async ({ hub, hubContext }) => {
  await away();
  await enroll(hub, hubContext);
  const question = await ask(hub, "Nobody looking", "permission:away");
  try {
    await expect.poll(() => pushes(hub, question.conversationId), { timeout: 5_000 }).toHaveLength(1);
  } finally { await question.answer(); }
  const beta = workspace(hub, "beta");
  const seeded = (await childChatControl(beta, { action: "seed", title: "Finishing unwatched", items: [] })) as { conversation: { id: string } };
  await childChatControl(beta, { action: "status", conversationId: seeded.conversation.id, status: "running" });
  await childChatControl(beta, { action: "status", conversationId: seeded.conversation.id, status: "completed" });
  await expect.poll(() => pushes(hub, seeded.conversation.id), { timeout: 5_000 }).toHaveLength(1);
  expect((await pushes(hub, seeded.conversation.id))[0]!.payload.kind).toBe("turn-completed");
});
