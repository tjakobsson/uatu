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

const TAB_COUNT = 6;
const DOCUMENT_LOAD_BUDGET_MS = 1_000;
// Long enough for a saturated browser to prove itself stuck rather than
// merely slow; the budget assertion is on the measured number.
const DOCUMENT_LOAD_CEILING_MS = 20_000;

test.use({ hubWorkspaces: ["alpha"] });

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

test("six session tabs with conversations open: background tabs release their stream and the visible tab stays responsive", async ({ hub, hubContext }) => {
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
  test.info().annotations.push({ type: "document-load-ms", description: String(elapsed) });
  console.log(`hub-live-stream: document load in the visible tab with ${TAB_COUNT} tabs open took ${elapsed} ms`);
  expect(elapsed).toBeLessThan(DOCUMENT_LOAD_BUDGET_MS);

  // Back to the first tab: it reconnects and its conversation is as it was left.
  const first = tabs[0]!;
  await setVisibility(visible, "hidden");
  await setVisibility(first, "visible");
  await expect.poll(() => openEventSources(first)).toHaveLength(1);
  await expect(first.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(first.locator("#chat-items")).toContainText("hello from tab 1");
  expect(await loadDocument(first, "diagram.md", "Diagram Fixture")).toBeLessThan(DOCUMENT_LOAD_BUDGET_MS);
  await expect.poll(() => openEventSources(visible)).toHaveLength(0);

  // A watched-file change reaches the visible tab through the hub, and a
  // hidden tab catches up when it is shown.
  await expect(first.locator("#document-count")).toHaveText("18 files");
  await fs.writeFile(path.join(workspace.path, "hub-live.md"), "# Hub live\n\nadded while one of six tabs watched\n");
  await expect(first.locator("#document-count")).toHaveText("19 files", { timeout: 15_000 });
  const second = tabs[1]!;
  await setVisibility(first, "hidden");
  await setVisibility(second, "visible");
  await expect(second.locator("#document-count")).toHaveText("19 files", { timeout: 15_000 });
  await expect.poll(() => openEventSources(first)).toHaveLength(0);
  expect(await openEventSources(second)).toHaveLength(1);
});
