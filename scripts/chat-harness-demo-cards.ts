/**
 * Captures review screenshots of the plan-approval card (4.7) and the live
 * task-progress surface (4.8) against a running chat harness.
 *
 * Run: bun run scripts/chat-harness-demo-cards.ts <harness-url-with-token>
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const url = process.argv[2];
if (!url) throw new Error("usage: bun run scripts/chat-harness-demo-cards.ts <harness-url-with-token>");
const outDir = path.resolve("openspec/changes/add-claude-code-agent/screenshots");
await mkdir(outDir, { recursive: true });
const origin = new URL(url).origin;

const control = async (body: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(`${origin}/__e2e/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${JSON.stringify(body.action)} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.json();
};

// A Claude-owned conversation carrying a short exchange.
const seeded = await control({
  action: "seed",
  agent: "claude",
  title: "Fix the diff-view regression",
  items: [
    { id: "message:u1", type: "user_message", createdAt: 1, text: "Plan a fix for the diff-view scroll regression, then implement it." },
  ],
}) as { conversation: { id: string } };
const conversationId = seeded.conversation.id;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
await page.goto(url);
await page.locator("#connection-state .connection-label").filter({ hasText: "Connected" }).waitFor();
const strip = page.locator("#chat-expand");
if (await strip.isVisible()) await strip.click();
await page.locator("#chat-timeline").waitFor();
await page.locator("#chat-conversation-select").selectOption(conversationId);
await page.locator("#chat-items").getByText("scroll regression").waitFor();

const shoot = async (name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(outDir, name) });
  console.log(`captured ${name}`);
};

// 5. The plan-approval card with intents.
await control({ action: "item", conversationId, item: {
  id: "permission:plan-1", type: "permission", createdAt: 2, requestId: "plan-1",
  action: "Review the plan", resources: [], status: "pending",
  plan: "## Fix the diff-view scroll regression\n\n1. Reproduce with a long unified diff in `diff-view.ts`\n2. Pin the scroll container to `overflow-x: auto` on the hunk table\n3. Add a regression test in `diff-view.e2e.ts`\n4. Verify with `bun test:e2e tests/e2e/diff-view.e2e.ts`",
  choices: [
    { id: "implement", label: "Approve and implement" },
    { id: "implement-and-restore", label: "Approve, then return to acceptEdits", description: "Implement the plan, then go back to the mode this conversation used before planning." },
  ],
} });
await page.locator(".chat-request-plan").waitFor();
await shoot("5-plan-approval-card.png");

// 6. The task-progress surface mid-flight (one block, updated in place).
await control({ action: "item", conversationId, item: {
  id: "permission:plan-1", type: "permission", createdAt: 2, requestId: "plan-1",
  action: "Review the plan", resources: [], status: "resolved", outcome: "approved-once",
  plan: "## Fix the diff-view scroll regression",
  choices: [{ id: "implement", label: "Approve and implement" }], choiceId: "implement",
} });
await control({ action: "item", conversationId, item: {
  id: "task-progress", type: "task_progress", createdAt: 3, entries: [
    { text: "Reproduce with a long unified diff", status: "completed" },
    { text: "Pin the scroll container", status: "in_progress", activeText: "Pinning the scroll container" },
    { text: "Add a regression test", status: "pending" },
    { text: "Run the e2e suite", status: "pending" },
  ],
} });
await page.locator(".chat-task-progress").waitFor();
await shoot("6-task-progress-live.png");

await browser.close();
console.log(`screenshots in ${outDir}`);
