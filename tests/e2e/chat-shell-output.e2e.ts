// Shell output rendered as terminal text, the activity chrome's contrast,
// and an OpenCode conversation's cost — fixture-driven, with the evidence
// screenshots each change's tasks call for. `UATU_SHOT_PREFIX=before` names
// the shots as the baseline and skips the assertions the change introduces,
// so the same scenario can be shot against the pre-change build.

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { captureScreenshot, openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

const changeDir = (name: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../openspec/changes", name, "screenshots");
const SHELL_SHOTS = changeDir("render-shell-output-like-terminal");
const COST_SHOTS = changeDir("report-opencode-conversation-cost");
const PREFIX = process.env.UATU_SHOT_PREFIX ?? "after";
const BASELINE = PREFIX === "before";

const ESC = "\x1b";
// What `bun test` writes to a terminal: bold header, coloured ticks, dim
// timings, then a progress line redrawn in place and a wide aligned table.
const TEST_OUTPUT = [
  `${ESC}[1mbun test v1.4.0${ESC}[0m`,
  "",
  `${ESC}[32m✓${ESC}[0m ansi > styles runs by SGR ${ESC}[2m[0.42ms]${ESC}[0m`,
  `${ESC}[32m✓${ESC}[0m ansi > a carriage return rewrites the line ${ESC}[2m[0.11ms]${ESC}[0m`,
  `${ESC}[31m✗${ESC}[0m renderer > a running tool shows its tail ${ESC}[2m[1.20ms]${ESC}[0m`,
  `  ${ESC}[31merror${ESC}[0m: expect(received).toContain(expected)`,
  "",
  `${ESC}[32m 2 pass${ESC}[0m`,
  `${ESC}[31m 1 fail${ESC}[0m`,
  "Downloading  10%\rDownloading  55%\rDownloading 100%",
  `${ESC}[36mNAME                     SIZE      MODIFIED             OWNER        MODE${ESC}[0m`,
  "README.md                1.2 KB    2026-09-13 19:32     tobias       -rw-r--r--   docs/README.md",
  "ARCHITECTURE.md          38.4 KB   2026-09-12 08:05     tobias       -rw-r--r--   docs/ARCHITECTURE.md",
].join("\n");

const bash = (id: string, createdAt: number, command: string, status: "running" | "completed", output?: string): ConversationItem => ({
  id, type: "tool", createdAt, name: "bash", status, input: JSON.stringify({ command, description: `Run ${command.split(" ")[0]}` }), ...(output === undefined ? {} : { output }),
});

/** A finished turn: prose, a group of three steps, prose — the chrome between two answers. */
const shellItems: ConversationItem[] = [
  { id: "message:u1", type: "user_message", createdAt: 1, text: "Run the unit tests and list the docs folder." },
  { id: "message:a1", type: "assistant_message", createdAt: 2, markdown: "I'll run the suite first, then list the folder.", completedAt: 2 },
  bash("tool:sh", 3, "bun test src/chat/ansi.test.ts && ls -la docs", "completed", TEST_OUTPUT),
  { id: "tool:rd", type: "tool", createdAt: 4, name: "read", status: "completed", input: JSON.stringify({ filePath: "docs/README.md" }), output: "# Docs\n\nStart here." },
  { id: "tool:gr", type: "tool", createdAt: 5, name: "grep", status: "completed", input: JSON.stringify({ pattern: "ansi", path: "src/chat" }), output: "src/chat/ansi.ts\nsrc/chat/ansi.test.ts" },
  { id: "message:a2", type: "assistant_message", createdAt: 6, markdown: "Two tests pass and one fails in the renderer — the running tail assertion. The docs folder has two files.", completedAt: 6 },
];

const shellOutput = "pre.chat-tool-terminal";

async function seed(request: APIRequestContext, title: string, items: ConversationItem[]): Promise<string> {
  await request.post("/__e2e/reset");
  const response = await request.post("/__e2e/chat", { data: { action: "seed", title, items } });
  expect(response.ok()).toBe(true);
  const seeded = await response.json() as { conversation: { id: string } };
  const token = await request.get("/__e2e/terminal-token").then(reply => reply.json()) as { token: string };
  return `${seeded.conversation.id}\u0001${token.token}`;
}

async function openSeeded(page: Page, seededAndToken: string, touch: boolean): Promise<void> {
  const [conversationId, token] = seededAndToken.split("\u0001");
  await page.goto(`/?t=${encodeURIComponent(token!)}`);
  if (touch) {
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-surface")).toBeVisible();
  } else {
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await openChatPanel(page);
  }
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.locator("#chat-conversation-select").selectOption(conversationId!);
}

async function shellScenario(page: Page, request: APIRequestContext, testInfo: TestInfo, theme: "light" | "dark", touch: boolean): Promise<void> {
  const suffix = `${theme}${touch ? "-phone" : ""}`;
  await openSeeded(page, await seed(request, "Shell output", shellItems), touch);
  const group = page.locator(".chat-activity-group");
  await expect(group).toHaveCount(1);
  // The finished group's summary between the two answers, then its rows.
  await group.locator("> summary").click();
  await expect(page.locator('[data-chat-item-id="tool:sh"]')).toBeVisible();
  await captureScreenshot(page, testInfo, SHELL_SHOTS, `${PREFIX}-activity-chrome-${suffix}`);

  const row = page.locator('[data-chat-item-id="tool:sh"]');
  await row.locator("> summary").click();
  await expect(row).toHaveAttribute("open", "");
  const block = BASELINE ? row.locator("pre").nth(1) : row.locator(shellOutput).first();
  await expect(block).toBeVisible();
  await block.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, SHELL_SHOTS, `${PREFIX}-shell-output-${suffix}`);
  if (BASELINE) return;

  // Escapes are interpreted, not shown; the redrawn line shows once.
  const text = await block.textContent();
  expect(text).not.toContain("[32m");
  expect(text).not.toContain("[0m");
  expect(text).toContain("Downloading 100%");
  expect(text).not.toContain("55%");
  expect(text!.match(/Downloading/g)).toHaveLength(1);
  // Green is the terminal's green — the same variable xterm reads.
  const tick = block.locator(".ansi-fg-2").first();
  await expect(tick).toHaveText("✓");
  const [tickColor, terminalGreen, family, whiteSpace, background] = await block.evaluate((element, target) => {
    const root = getComputedStyle(document.documentElement);
    const computed = getComputedStyle(element);
    return [getComputedStyle(element.querySelector(target)!).color, root.getPropertyValue("--terminal-ansi-green").trim(), computed.fontFamily, computed.whiteSpace, computed.backgroundColor];
  }, ".ansi-fg-2");
  const hexToRgb = (hex: string) => `rgb(${[1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;
  expect(tickColor).toBe(hexToRgb(terminalGreen));
  expect(family).toContain("Hack Nerd Font Mono");
  expect(whiteSpace).toBe("pre");
  expect(background).toBe(hexToRgb("#0b1220"));
  // The wide table scrolls rather than wrapping.
  const overflows = await block.evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflows).toBe(true);
}

test.describe("shell output reads as the terminal renders it", () => {
  test("desktop, light", async ({ page, request }, testInfo) => {
    await shellScenario(page, request, testInfo, "light", false);
  });

  test.describe("dark", () => {
    test.use({ colorScheme: "dark" });
    test("desktop, dark", async ({ page, request }, testInfo) => {
      await shellScenario(page, request, testInfo, "dark", false);
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test("phone, light", async ({ page, request }, testInfo) => {
      await shellScenario(page, request, testInfo, "light", true);
    });
    test.describe("dark", () => {
      test.use({ colorScheme: "dark" });
      test("phone, dark", async ({ page, request }, testInfo) => {
        await shellScenario(page, request, testInfo, "dark", true);
      });
    });
  });

  test("the same bytes in the terminal pane, beside the chat block", async ({ page, request }, testInfo) => {
    test.skip(BASELINE, "a comparison of the change, not the baseline");
    await openSeeded(page, await seed(request, "Shell output", shellItems), false);
    await page.locator(".chat-activity-group > summary").click();
    const row = page.locator('[data-chat-item-id="tool:sh"]');
    await row.locator("> summary").click();
    await expect(row.locator(shellOutput).first()).toBeVisible();
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 5000 });
    const rows = page.locator(".terminal-pane-host .xterm-rows > div");
    await expect.poll(async () => (await rows.allTextContents()).some(line => line.trim().length > 0), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector<HTMLTextAreaElement>(".terminal-pane-host .xterm-helper-textarea")?.focus());
    // printf the same bytes the fixture seeded, escapes as octal.
    const script = TEST_OUTPUT.replaceAll("%", "%%").replaceAll("\x1b", "\\033").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("'", "'\\''");
    await page.keyboard.type(`printf '${script}\\n'`, { delay: 2 });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await rows.allTextContents()).some(line => line.includes("Downloading 100%")), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(300);
    await captureScreenshot(page, testInfo, SHELL_SHOTS, `${PREFIX}-shell-output-vs-terminal`);
  });
});

// An OpenCode conversation: priced usage carriers, one per message, on two
// models, plus a subagent whose child session reported its own price.
const carrier = (id: string, createdAt: number, modelId: string, input: number, output: number, costUsd: number): ConversationItem => ({
  id: `usage:${id}`, type: "assistant_message", createdAt, markdown: "", usage: { input, output, cacheRead: 2_000, cacheWrite: 0, costUsd }, model: { providerId: "openai", modelId },
});
const costItems: ConversationItem[] = [
  { id: "message:u1", type: "user_message", createdAt: 1, text: "Review the renderer for double counting." },
  { id: "message:a1", type: "assistant_message", createdAt: 2, markdown: "I'll have a subagent read the renderer while I check the tests.", completedAt: 2 },
  carrier("msg_a", 2, "gpt-5", 12_000, 400, 0.75),
  { id: "tool:agent", type: "tool", createdAt: 3, name: "task", status: "completed", input: JSON.stringify({ description: "Review renderer", subagent_type: "explore" }), output: "No double counting found.", childConversationId: "child-1", model: "gpt-5", usage: { input: 6_000, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.13 } },
  { id: "message:a2", type: "assistant_message", createdAt: 4, markdown: "The subagent found nothing; the carrier is keyed per message, so a restatement replaces rather than adds.", completedAt: 4 },
  carrier("msg_b", 4, "gpt-5", 15_000, 600, 0.375),
  { id: "message:u2", type: "user_message", createdAt: 5, text: "Summarise with the small model." },
  { id: "message:a3", type: "assistant_message", createdAt: 6, markdown: "One carrier per message, latest figure wins, summed once.", completedAt: 6 },
  carrier("msg_c", 6, "claude-sonnet", 3_000, 100, 0.125),
];

async function costScenario(page: Page, request: APIRequestContext, testInfo: TestInfo, touch: boolean): Promise<void> {
  const seeded = await seed(request, "Conversation cost", costItems);
  await openSeeded(page, seeded, touch);
  const summary = page.locator("#chat-plan-usage-summary");
  await expect(summary).toHaveText("$1.25 this conversation");
  await captureScreenshot(page, testInfo, COST_SHOTS, `${PREFIX}-chip-${touch ? "phone" : "desktop"}`);
  if (touch) return;
  await summary.click();
  const readout = page.locator("#chat-plan-readout");
  await expect(readout).toBeVisible();
  // No plan to name: the readout is the conversation block alone, whole —
  // not "since" a time — with a row per model and the subagent priced.
  await expect(page.locator("#chat-plan-readout-head")).toBeHidden();
  await expect(page.locator("#chat-plan-session-title")).toHaveText("This conversation");
  await expect(page.locator("#chat-plan-session-cost")).toHaveText("$1.25");
  const rows = page.locator("#chat-plan-session-models tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td").first()).toHaveText("GPT-5");
  await expect(rows.nth(0).locator("td").last()).toHaveText("$1.13");
  await expect(rows.nth(1).locator("td").first()).toHaveText("Claude Sonnet");
  await expect(rows.nth(1).locator("td").last()).toHaveText("$0.13");
  await expect(page.locator("#chat-subagents-items")).toContainText("$0.13");
  await captureScreenshot(page, testInfo, COST_SHOTS, `${PREFIX}-readout-desktop`);

  // Reopened: the cost is restored from history, still titled for the whole conversation.
  await page.reload();
  await openChatPanel(page);
  await page.locator("#chat-conversation-select").selectOption(seeded.split("\u0001")[0]!);
  await expect(summary).toHaveText("$1.25 this conversation");
  await summary.click();
  await expect(page.locator("#chat-plan-session-title")).toHaveText("This conversation");
  await captureScreenshot(page, testInfo, COST_SHOTS, `${PREFIX}-reopen-desktop`);
}

test.describe("an OpenCode conversation reports its cost", () => {
  test.skip(BASELINE, "the cost surface is the change");

  test("desktop chip, readout, and reopen", async ({ page, request }, testInfo) => {
    await costScenario(page, request, testInfo, false);
  });

  test("a free model shows no cost", async ({ page, request }) => {
    await openSeeded(page, await seed(request, "Free model", [
      costItems[0]!, costItems[1]!, carrier("msg_free", 2, "gpt-5", 12_000, 400, 0),
    ]), false);
    await expect(page.locator("#chat-context")).toContainText("Fixture Agent");
    await expect(page.locator("#chat-plan-usage")).toBeHidden();
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test("phone chip", async ({ page, request }, testInfo) => {
      await costScenario(page, request, testInfo, true);
    });
  });
});
