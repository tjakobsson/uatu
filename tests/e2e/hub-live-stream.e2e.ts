// Hub-brokered live stream, end to end through a real hub (tasks 8.1 and 9.1
// of hub-brokered-live-stream). The fact under test: a browser caps HTTP/1.1
// at six connections per host, shared across tabs, and the hub is HTTP/1.1.
// Before the change every session tab held three long-lived SSE streams
// through the hub, so two tabs with a conversation open saturated the
// browser. One brokered stream per tab moves the wall to six tabs; a page in
// the background releasing its stream removes it: however many tabs are
// open, only the visible ones hold a connection.
//
// Visibility is driven by overriding `document.visibilityState` and firing
// `visibilitychange`. Headless pages all report "visible", and the code
// under test reads exactly that property and that event.
//
// The same run asserts what the per-tab connection is (one EventSource, to
// /api/hub/live, nothing else), that a tab shown again resumes its
// conversation as the user left it, and that a watched-file change reaches
// the visible tab through the hub and a hidden one once it is shown. Live
// reload through a base path is covered here and nowhere else.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { childChatControl, expect, openEventSources, openSessionTab, test } from "./hub-fixtures";
import { openChatPanel } from "./chat-helpers";
import { treeRow } from "./tree-helpers";
import type { ConversationItem } from "../../src/chat/types";
import { saveEvidence } from "./evidence";

const TAB_COUNT = 6;
// The pass criterion is deterministic: hidden tabs hold no stream, the
// visible tab holds exactly the hub's one, and a document load completes. A
// saturated browser never completes it, which the ceiling proves. The
// measured load time is evidence against the 1 s budget, annotated when over
// it; only a load past the looser guard fails, since a loaded runner
// inflates the wall clock without saturating anything.
const DOCUMENT_LOAD_BUDGET_MS = 1_000;
const DOCUMENT_LOAD_GUARD_MS = 2 * DOCUMENT_LOAD_BUDGET_MS;
// Long enough for a saturated browser to prove itself stuck rather than
// merely slow.
const DOCUMENT_LOAD_CEILING_MS = 20_000;

test.use({ hubWorkspaces: ["alpha"] });

for (const surface of ["main", "child"] as const) test(surface === "main"
  ? "oversized recovery refreshes only the conversation, retaining completed content, draft and reading position on one EventSource"
  : "oversized child recovery retains the loaded drill-down range, draft and reading position on one EventSource", async ({ hub, hubContext }) => {
  const workspace = hub.workspaces[0]!;
  const items: ConversationItem[] = Array.from({ length: 60 }, (_, index) => ({
    id: `completed:${index}`, type: "assistant_message", createdAt: index + 1, completedAt: index + 2,
    markdown: `Completed answer ${index}\n\n${"Retained reading material. ".repeat(12)}`,
  }));
  const seeded = await childChatControl(workspace, { action: "seed", title: "Bulk recovery", items, ...(surface === "child" ? { child: true } : {}) }) as { conversation: { id: string } };
  const selected = surface === "main" ? seeded : await childChatControl(workspace, { action: "seed", title: "Parent reader", items: [{ id: "tool:child", type: "tool", createdAt: 1, name: "task", status: "completed", childConversationId: seeded.conversation.id, input: JSON.stringify({ description: "Child bulk reader", subagent_type: "explore", prompt: "go" }) }] }) as { conversation: { id: string } };
  const itemsSelector = surface === "main" ? "#chat-items" : "#chat-drilldown-items";
  const olderSelector = surface === "main" ? "#chat-load-older" : "#chat-drilldown-older";
  const page = await hubContext.newPage();
  let liveOpens = 0;
  const mutations: string[] = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/hub/live") liveOpens += 1;
    if (pathname.includes("/api/chat/") && request.method() !== "GET") mutations.push(pathname);
  });
  let reads = 0;
  let recovering = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const snapshotPath = `/s/${encodeURIComponent(workspace.id)}/api/chat/conversations/${encodeURIComponent(seeded.conversation.id)}`;
  // The harness owns a complete snapshot. Model the provider's capped
  // transcript pages here, retaining workers as first-page metadata. The
  // browser still traverses the actual resync/read/client/install path.
  await page.route(url => url.pathname === snapshotPath, async route => {
    if (recovering) { reads += 1; await held; }
    const response = await route.fetch();
    const snapshot = await response.json();
    const end = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 60);
    const start = Math.max(0, end - (recovering ? 20 : 50));
    const history = (snapshot.items as ConversationItem[]).filter(item => item.id.startsWith("completed:"));
    const metadata = end === 60 ? (snapshot.items as ConversationItem[]).filter(item => !item.id.startsWith("completed:")) : [];
    await route.fulfill({ response, json: { ...snapshot, items: [...history.slice(start, end), ...metadata], olderCursor: start ? String(start) : undefined } });
  });
  await page.goto(workspace.sessionUrl);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await page.locator("#chat-conversation-select").selectOption(selected.conversation.id);
  await page.locator("#chat-input").fill("a draft that recovery must never submit");
  if (surface === "child") {
    await page.locator("#chat-compact-workers > summary").click();
    await page.locator(".chat-worker-inspect").filter({ has: page.locator(".chat-worker-name", { hasText: /^Child bulk reader$/ }) }).click();
  }
  await expect(page.locator(itemsSelector)).toContainText("Completed answer 59");
  const scroller = page.locator(surface === "main" ? "#chat-timeline" : "#chat-drilldown-timeline");
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
  await page.locator(olderSelector).click();
  await expect(page.locator(`${itemsSelector} [data-chat-item-id="completed:5"]`)).toBeVisible();
  // Establish real reader intent after the initial bottom-follow settles.
  // A script assignment during that pending follow can be overwritten by it.
  const readingAnswer = page.locator(`${itemsSelector} [data-chat-item-id="completed:5"]`);
  await readingAnswer.scrollIntoViewIfNeeded();
  await scroller.hover();
  await page.mouse.wheel(0, -80);
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(600);
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const top = await scroller.evaluate(el => el.scrollTop);
  expect(top).toBeGreaterThan(100);
  const sourceUrls = await openEventSources(page);
  expect(sourceUrls).toHaveLength(1);
  const opensBefore = liveOpens;
  const readingTop = await readingAnswer.evaluate(el => el.getBoundingClientRect().top);
  recovering = true;
  const updates: ConversationItem[] = Array.from({ length: 318 }, (_, index) => ({
    type: "background_task", id: `worker:${index}`, taskId: `worker:${index}`, createdAt: 100 + index,
    description: `Recovered worker ${index}`, status: "completed", summary: "x".repeat(4096),
  }));
  await childChatControl(workspace, { action: "recoverItems", conversationId: seeded.conversation.id, items: updates });
  await expect.poll(() => reads).toBe(1);
  // The authoritative read is intentionally pending: retained presentation
  // must not be replaced by an empty/loading transcript in the meantime.
  await expect(page.locator(itemsSelector)).toContainText("Completed answer 59");
  await expect(page.locator("#chat-input")).toHaveValue("a draft that recovery must never submit");
  expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - top)).toBeLessThan(2);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === snapshotPath);
  release();
  const snapshot = await (await refreshed).json() as { items: ConversationItem[] };
  expect(snapshot.items.filter(item => item.type === "background_task")).toHaveLength(318);
  await expect.poll(() => reads).toBe(3);
  await expect(page.locator(olderSelector)).toBeHidden();
  // A later native event proves fresh cursor attachment completed; no sleeps
  // or socket-open heuristics stand in for topic readiness.
  await childChatControl(workspace, { action: "item", conversationId: seeded.conversation.id, item: {
    id: "native:after", type: "assistant_message", createdAt: 1000, completedAt: 1001, markdown: "Native follow-up after recovery",
  } });
  await expect(page.locator(itemsSelector)).toContainText("Native follow-up after recovery");
  await expect(page.locator('[data-chat-item-id="native:after"]')).toHaveCount(1);
  await expect(page.locator(itemsSelector)).toContainText("Completed answer 59");
  await expect(readingAnswer).toBeVisible();
  await expect(page.locator(`${itemsSelector} [data-chat-item-id^="completed:"]`)).toHaveCount(60);
  await expect(page.locator("#chat-input")).toHaveValue("a draft that recovery must never submit");
  await expect.poll(async () => Math.abs(await scroller.evaluate(el => el.scrollTop) - top)).toBeLessThan(2);
  await expect.poll(async () => Math.abs(await readingAnswer.evaluate(el => el.getBoundingClientRect().top) - readingTop)).toBeLessThan(2);
  expect(reads).toBe(3);
  expect(mutations).toEqual([]);
  expect(liveOpens).toBe(opensBefore);
  expect(await openEventSources(page)).toEqual(sourceUrls);
  await fs.writeFile(path.join(workspace.path, "bulk-recovery.md"), "# Unrelated topic still live\n");
  await expect(page.locator("#document-count")).toHaveAttribute("aria-label", "19 files", { timeout: 15_000 });
  await expect(page.locator("#chat-state")).not.toContainText("interrupted");
  await saveEvidence(test.info(), "bulk-recovery.json", JSON.stringify({ recoveredWorkers: 318, snapshotReads: reads, liveOpensBefore: opensBefore, liveOpensAfter: liveOpens, readingTopBefore: top, readingTopAfter: await scroller.evaluate(el => el.scrollTop), chatMutations: mutations }, null, 2));
});

async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { value, configurable: true });
    Object.defineProperty(document, "hidden", { value: value === "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function loadDocument(page: Page, name: string, heading: string): Promise<number> {
  const started = Date.now();
  await treeRow(page, name).click();
  await expect(page.locator("#preview-path")).toHaveText(name, { timeout: DOCUMENT_LOAD_CEILING_MS });
  await expect(page.locator("#preview")).toContainText(heading, { timeout: DOCUMENT_LOAD_CEILING_MS });
  return Date.now() - started;
}

function expectResponsive(label: string, elapsed: number): void {
  test.info().annotations.push({ type: "document-load-ms", description: `${label}: ${elapsed}` });
  if (elapsed >= DOCUMENT_LOAD_BUDGET_MS) {
    test.info().annotations.push({ type: "over-budget", description: `${label}: ${elapsed} ms (budget ${DOCUMENT_LOAD_BUDGET_MS} ms)` });
  }
  expect(elapsed, `${label}: document load under the ${DOCUMENT_LOAD_GUARD_MS} ms guard`).toBeLessThan(DOCUMENT_LOAD_GUARD_MS);
}

test("six session tabs with conversations open: background tabs release their stream and the visible tab stays responsive", { tag: "@perf" }, async ({ hub, hubContext }) => {
  const workspace = hub.workspaces[0]!;

  const tabs: Page[] = [];
  for (let index = 0; index < TAB_COUNT; index += 1) {
    const seeded = (await childChatControl(workspace, {
      action: "seed",
      title: `Tab ${index + 1} conversation`,
      items: [{ id: `user:${index}`, type: "user_message", createdAt: 10, text: `hello from tab ${index + 1}` }] satisfies ConversationItem[],
    })) as { conversation: { id: string } };

    // The tab being left goes to the background, as it does when the user
    // opens another, and gives its connection back.
    const previous = tabs.at(-1);
    if (previous) {
      await setVisibility(previous, "hidden");
      await expect.poll(() => openEventSources(previous)).toHaveLength(0);
    }

    const page = await openSessionTab(hubContext, workspace);
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    // The conversation's history rendered: its topic is subscribed on the
    // one stream and the tab is in the state a working user leaves it in.
    await expect(page.locator("#chat-items")).toContainText(`hello from tab ${index + 1}`);
    tabs.push(page);
  }

  // Only the visible tab holds a live connection, and it is the hub's.
  const visible = tabs.at(-1)!;
  for (const page of tabs.slice(0, -1)) expect(await openEventSources(page)).toHaveLength(0);
  const sources = await openEventSources(visible);
  expect(sources).toHaveLength(1);
  expect(new URL(sources[0]!, hub.origin).pathname).toBe("/api/hub/live");

  // The measurement: a document load in the visible tab with six open.
  const elapsed = await loadDocument(visible, "diagram.md", "Diagram Fixture");
  console.log(`hub-live-stream: document load in the visible tab with ${TAB_COUNT} tabs open took ${elapsed} ms`);
  expectResponsive("visible tab", elapsed);

  // Back to the first tab: it reconnects and its conversation is as it was left.
  const first = tabs[0]!;
  await setVisibility(visible, "hidden");
  await setVisibility(first, "visible");
  await expect.poll(() => openEventSources(first)).toHaveLength(1);
  await expect(first.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(first.locator("#chat-items")).toContainText("hello from tab 1");
  expectResponsive("first tab shown again", await loadDocument(first, "diagram.md", "Diagram Fixture"));
  await expect.poll(() => openEventSources(visible)).toHaveLength(0);

  // A watched-file change reaches the visible tab through the hub, and a
  // hidden tab catches up when it is shown.
  await expect(first.locator("#document-count")).toHaveAttribute("aria-label", "18 files");
  await fs.writeFile(path.join(workspace.path, "hub-live.md"), "# Hub live\n\nadded while one of six tabs watched\n");
  await expect(first.locator("#document-count")).toHaveAttribute("aria-label", "19 files", { timeout: 15_000 });
  const second = tabs[1]!;
  await setVisibility(first, "hidden");
  await setVisibility(second, "visible");
  await expect(second.locator("#document-count")).toHaveAttribute("aria-label", "19 files", { timeout: 15_000 });
  await expect.poll(() => openEventSources(first)).toHaveLength(0);
  expect(await openEventSources(second)).toHaveLength(1);
});
