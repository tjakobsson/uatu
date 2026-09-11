// Hub-brokered live stream, end to end through a real hub (task 8.1 of
// hub-brokered-live-stream). The fact under test: a browser caps HTTP/1.1
// at six connections per host, shared across tabs, and the hub is HTTP/1.1.
// Before the change every session tab held three long-lived SSE streams
// through the hub (document, inventory, conversation), so two tabs with a
// conversation open saturated the browser and a third tab's — or the first
// tab's — next request queued behind them: a document load in tab 1 took
// longer than a second or never completed. With one brokered stream per
// tab, three tabs hold three connections and the load is immediate.
//
// The same run asserts what the per-tab connection actually is (one
// EventSource, to /api/hub/live, nothing else) and that a watched-file
// change still reaches every tab through the hub — live reload through a
// base path is covered here and nowhere else.

import { promises as fs } from "node:fs";
import path from "node:path";

import { childChatControl, expect, openEventSources, openSessionTab, test } from "./hub-fixtures";
import { openChatPanel } from "./chat-helpers";
import { treeRow } from "./tree-helpers";
import type { ConversationItem } from "../../src/chat/types";

const TAB_COUNT = 3;
const DOCUMENT_LOAD_BUDGET_MS = 1_000;
// Long enough for a saturated browser to prove itself stuck rather than
// merely slow; the budget assertion is on the measured number.
const DOCUMENT_LOAD_CEILING_MS = 20_000;

test.use({ hubWorkspaces: ["alpha"] });

test("three session tabs with conversations open load a document in tab 1 within a second", async ({ hub, hubContext }) => {
  const workspace = hub.workspaces[0]!;

  const tabs = [];
  for (let index = 0; index < TAB_COUNT; index += 1) {
    const seeded = (await childChatControl(workspace, {
      action: "seed",
      title: `Tab ${index + 1} conversation`,
      items: [{ id: `user:${index}`, type: "user_message", createdAt: 10, text: `hello from tab ${index + 1}` }] satisfies ConversationItem[],
    })) as { conversation: { id: string } };

    const page = await openSessionTab(hubContext, workspace);
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    // The conversation's history rendered: its topic is subscribed on the
    // one stream and the tab is in the state a working user leaves it in.
    await expect(page.locator("#chat-items")).toContainText(`hello from tab ${index + 1}`);
    tabs.push(page);
  }

  // Every tab holds exactly one live connection, and it is the hub's.
  for (const page of tabs) {
    const sources = await openEventSources(page);
    expect(sources).toHaveLength(1);
    expect(new URL(sources[0]!, hub.origin).pathname).toBe("/api/hub/live");
  }

  // The measurement: select another document in the first tab and wait for
  // its rendered preview.
  const first = tabs[0]!;
  const started = Date.now();
  await treeRow(first, "diagram.md").click();
  await expect(first.locator("#preview-path")).toHaveText("diagram.md", { timeout: DOCUMENT_LOAD_CEILING_MS });
  await expect(first.locator("#preview")).toContainText("Diagram Fixture", { timeout: DOCUMENT_LOAD_CEILING_MS });
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "document-load-ms", description: String(elapsed) });
  console.log(`hub-live-stream: document load in tab 1 with ${TAB_COUNT} tabs open took ${elapsed} ms`);
  expect(elapsed).toBeLessThan(DOCUMENT_LOAD_BUDGET_MS);

  // A watched-file change reaches every tab through the hub.
  await expect(first.locator("#document-count")).toHaveText("18 files");
  await fs.writeFile(path.join(workspace.path, "hub-live.md"), "# Hub live\n\nadded while three tabs watched\n");
  for (const page of tabs) {
    await expect(page.locator("#document-count")).toHaveText("19 files", { timeout: 15_000 });
  }

  // Still one connection each after the load and the reload.
  for (const page of tabs) {
    expect(await openEventSources(page)).toHaveLength(1);
  }
});
