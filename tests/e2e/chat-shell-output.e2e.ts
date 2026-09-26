// Shell output rendered as terminal text, the activity chrome's contrast,
// and an OpenCode conversation's cost — fixture-driven, with the evidence
// screenshots the changes' tasks called for (see evidence.ts).
// `UATU_SHOT_PREFIX=before` names the shots as the baseline and skips the
// assertions a change introduces, so the same scenario can be shot against
// the pre-change build.

import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";
import { bootShell, log, openSeeded, seed, shell } from "./chat-shell-helpers";
import { focusTerminal, openTerminal } from "./terminal-helpers";

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
  // OpenCode's own shell step arrives as a `command` item rather than a tool.
  { id: "tool:oc", type: "command", createdAt: 3.5, command: "git status --short", status: "completed", output: `${ESC}[31m M${ESC}[0m src/chat/ansi.ts\n${ESC}[32m??${ESC}[0m tests/e2e/chat-shell-output.e2e.ts`, exitCode: 0 },
  { id: "tool:rd", type: "tool", createdAt: 4, name: "read", status: "completed", input: JSON.stringify({ filePath: "docs/README.md" }), output: "# Docs\n\nStart here." },
  { id: "tool:gr", type: "tool", createdAt: 5, name: "grep", status: "completed", input: JSON.stringify({ pattern: "ansi", path: "src/chat" }), output: "src/chat/ansi.ts\nsrc/chat/ansi.test.ts" },
  { id: "message:a2", type: "assistant_message", createdAt: 6, markdown: "Two tests pass and one fails in the renderer — the running tail assertion. The docs folder has two files.", completedAt: 6 },
];

const shellOutput = "pre.chat-tool-terminal";

async function shellScenario(page: Page, request: APIRequestContext, testInfo: TestInfo, theme: "light" | "dark", touch: boolean): Promise<void> {
  const suffix = `${theme}${touch ? "-phone" : ""}`;
  await openSeeded(page, await seed(request, "Shell output", shellItems), touch);
  const group = page.locator(".chat-activity-group");
  await expect(group).toHaveCount(1);
  // The finished group's summary between the two answers, then its rows.
  await group.locator("> summary").click();
  await expect(page.locator('[data-chat-item-id="tool:sh"]')).toBeVisible();
  await captureScreenshot(page, testInfo, `${PREFIX}-activity-chrome-${suffix}`);

  const row = page.locator('[data-chat-item-id="tool:sh"]');
  await row.locator("> summary").click();
  await expect(row).toHaveAttribute("open", "");
  const block = BASELINE ? row.locator("pre").nth(1) : row.locator(shellOutput).first();
  await expect(block).toBeVisible();
  await block.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, `${PREFIX}-shell-output-${suffix}`);
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

  // The OpenCode-shaped command row gets the same look.
  const commandRow = page.locator('[data-chat-item-id="tool:oc"]');
  await commandRow.locator("> summary").click();
  const commandBlock = commandRow.locator(shellOutput).first();
  await expect(commandBlock).toBeVisible();
  await expect(commandBlock.locator(".ansi-fg-1").first()).toHaveText(" M");
  expect(await commandBlock.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("pre");
}

test.describe("shell output reads as the terminal renders it", () => {
  for (const shape of ["command", "bash"] as const) test(`${shape} completed-only scrollback keeps every line and non-shell previews`, async ({ page, request }) => {
    const output = log(80);
    const { viewport, outputView } = await bootShell(page, request, { shape, output, status: "completed", extra: [{
      id: "read:long", type: "tool", createdAt: 102, name: "read", status: "completed", output,
      input: JSON.stringify({ filePath: "long.txt" }),
    }] });
    await expect(viewport.locator(".chat-shell-line")).toHaveCount(80);
    await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    await expect(outputView.getByText(/Show .*lines|omitted/i)).toHaveCount(0);
    await viewport.focus(); await page.keyboard.press("Home");
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(0);
    await expect(viewport.locator(".chat-shell-line").first()).toBeInViewport();
    const read = page.locator('[data-chat-item-id="read:long"]');
    await read.locator("> summary").click();
    await expect(read.locator(".chat-shell-viewport")).toHaveCount(0);
    await expect(read.locator("pre").first()).not.toContainText("line-00079");
    await expect(read.locator(".chat-output-more")).not.toHaveAttribute("open", "");
    await read.getByText(/Show .*lines/).click();
    await expect(read).toContainText("line-00079");
  });

  test("streamed ANSI progress, split escapes and corrected snapshots remain inert", async ({ page, request }) => {
    const { update, viewport } = await bootShell(page, request, { output: "first\n\x1b[3" });
    const output = "first\n\x1b[32mprogress 10%\r\x1b[2Kprogress 100%\x1b[0m\n<script>window.shellPwned=1</script>\x1b]0;hidden title\x07";
    await update(shell("command", output));
    await expect(viewport.locator(".chat-shell-line")).toHaveCount(3);
    await expect(viewport.locator(".ansi-fg-2")).toHaveText("progress 100%");
    await expect(viewport).not.toContainText("10%");
    await expect(viewport).not.toContainText("hidden title");
    await expect(viewport.locator("script, a")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).shellPwned)).toBeUndefined();
    await update(shell("command", "corrected\nshort", "failed"));
    await expect(viewport.locator(".chat-shell-line")).toHaveCount(2);
    await expect(viewport).toHaveText("corrected\nshort\n");
  });

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
    await openTerminal(page);
    const rows = page.locator(".terminal-pane-host .xterm-rows > div");
    await focusTerminal(page);
    // printf the same bytes the fixture seeded, escapes as octal.
    const script = TEST_OUTPUT.replaceAll("%", "%%").replaceAll("\x1b", "\\033").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("'", "'\\''");
    await page.keyboard.type(`printf '${script}\\n'`, { delay: 2 });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await rows.allTextContents()).some(line => line.includes("Downloading 100%")), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(300);
    await captureScreenshot(page, testInfo, `${PREFIX}-shell-output-vs-terminal`);
  });
});

// An OpenCode conversation: priced usage carriers, one per message, on two
// models, plus a subagent whose child session reported its own price.
const carrier = (id: string, createdAt: number, modelId: string, input: number, output: number, costUsd: number): ConversationItem => ({
  id: `usage:${id}`, type: "assistant_message", createdAt, markdown: "", usage: { input, output, cacheRead: 2_000, cacheWrite: 0, costUsd }, model: { providerId: "openai", modelId }, agent: "build",
});
const costItems: ConversationItem[] = [
  { id: "message:u1", type: "user_message", createdAt: 1, text: "Review the renderer for double counting." },
  { id: "message:a1", type: "assistant_message", createdAt: 2, markdown: "I'll have a subagent read the renderer while I check the tests.", completedAt: 2 },
  carrier("msg_a", 2, "gpt-5", 12_000, 400, 0.75),
  { id: "tool:agent", type: "tool", createdAt: 3, name: "task", status: "completed", input: JSON.stringify({ description: "Review renderer", subagent_type: "explore" }), output: "No double counting found.", childConversationId: "CHILD", model: "gpt-5", usage: { input: 6_000, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 } },
  { id: "message:a2", type: "assistant_message", createdAt: 4, markdown: "The subagent found nothing; the carrier is keyed per message, so a restatement replaces rather than adds.", completedAt: 4 },
  carrier("msg_b", 4, "gpt-5", 15_000, 600, 0.375),
  { id: "message:u2", type: "user_message", createdAt: 5, text: "Summarise with the small model." },
  { id: "message:a3", type: "assistant_message", createdAt: 6, markdown: "One carrier per message, latest figure wins, summed once.", completedAt: 6 },
  carrier("msg_c", 6, "claude-sonnet", 3_000, 100, 0.125),
];

/** The subagent's child conversation is seeded first so the parent can point at it. */
async function seedCost(request: APIRequestContext): Promise<string> {
  await request.post("/__e2e/reset");
  const child = await request.post("/__e2e/chat", { data: { action: "seed", title: "Review renderer", items: [
    { id: "message:c1", type: "user_message", createdAt: 1, text: "Review the renderer for double counting." },
    { id: "message:c2", type: "assistant_message", createdAt: 2, markdown: "No double counting found.", completedAt: 2 },
  ] } });
  expect(child.ok()).toBe(true);
  const childId = ((await child.json()) as { conversation: { id: string } }).conversation.id;
  const items = costItems.map(item => (item.type === "tool" && item.childConversationId === "CHILD" ? { ...item, childConversationId: childId } : item));
  const response = await request.post("/__e2e/chat", { data: { action: "seed", title: "Conversation cost", items } });
  expect(response.ok()).toBe(true);
  const seeded = await response.json() as { conversation: { id: string } };
  const token = await request.get("/__e2e/terminal-token").then(reply => reply.json()) as { token: string };
  return `${seeded.conversation.id}\u0001${token.token}\u0001${childId}`;
}

async function costScenario(page: Page, request: APIRequestContext, testInfo: TestInfo, touch: boolean): Promise<void> {
  const seeded = await seedCost(request);
  const childId = seeded.split("\u0001")[2]!;
  await openSeeded(page, seeded, touch);
  const summary = page.locator("#chat-plan-usage-summary");
  // Main agent $1.25 plus the subagent's $0.25: what the whole conversation cost.
  await expect(summary).toHaveText("$1.50 this conversation");
  await captureScreenshot(page, testInfo, `${PREFIX}-chip-${touch ? "phone" : "desktop"}`);
  if (touch) return;
  await summary.click();
  const readout = page.locator("#chat-plan-readout");
  await expect(readout).toBeVisible();
  // No plan to name: the readout is the conversation block alone, whole —
  // not "since" a time — with a row per model and the subagent priced.
  await expect(page.locator("#chat-plan-readout-head")).toBeHidden();
  await expect(page.locator("#chat-plan-session-title")).toHaveText("This conversation");
  await expect(page.locator("#chat-plan-session-cost")).toHaveText("$1.50");
  // A receipt: itemized by agent to begin with — the named main agent's own
  // spend, then the subagent's task with the model it ran — closed by a total.
  const views = page.locator("#chat-plan-session-views");
  await expect(views).toBeVisible();
  await expect(views.getByRole("radio", { name: "Agents" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#chat-plan-session-heading")).toHaveText("Agent");
  const rows = page.locator("#chat-plan-session-models tr");
  const agents = rows;
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td").first()).toContainText("build");
  await expect(rows.nth(0).locator(".chat-plan-session-agent-model")).toHaveText("GPT-5, Claude Sonnet · main agent");
  await expect(rows.nth(0).locator("td").last()).toHaveText("$1.25");
  await expect(rows.nth(1).locator("td").first()).toContainText("explore · Review renderer");
  await expect(rows.nth(1).locator(".chat-plan-session-agent-model")).toHaveText("GPT-5");
  await expect(rows.nth(1).locator("td").last()).toHaveText("$0.25");
  await expect(page.locator("#chat-plan-session-total td").last()).toHaveText("$1.50");
  // The same total by model. The subagent ran GPT-5 too: its $0.25 lands in that model's row.
  await views.getByRole("radio", { name: "Models" }).click();
  await expect(page.locator("#chat-plan-session-heading")).toHaveText("Model");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td").first()).toContainText("GPT-5");
  await expect(rows.nth(0).locator(".chat-plan-session-agent-model")).toHaveText("build · explore");
  await expect(rows.nth(0).locator("td").last()).toHaveText("$1.38");
  await expect(rows.nth(1).locator("td").first()).toContainText("Claude Sonnet");
  await expect(rows.nth(1).locator("td").last()).toHaveText("$0.13");
  await expect(page.locator("#chat-plan-session-total td").last()).toHaveText("$1.50");
  await views.getByRole("radio", { name: "Agents" }).click();
  await expect(page.locator("#chat-subagents-items")).toContainText("$0.25");
  await captureScreenshot(page, testInfo, `${PREFIX}-readout-desktop`);
  // A label-only correction to the subagent repaints the open table.
  const agentSeed = costItems.find(item => item.id === "tool:agent")!;
  const relabelled = await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.split("\u0001")[0], item: { ...agentSeed, childConversationId: childId, input: JSON.stringify({ description: "Review renderer again", subagent_type: "explore" }) } } });
  expect(relabelled.ok()).toBe(true);
  await expect(agents.nth(1).locator("td").first()).toContainText("explore · Review renderer again");
  await page.keyboard.press("Escape");

  // In context: the subagent's timeline row, and the transcript it opens.
  const agentRow = page.locator('[data-chat-item-id="tool:agent"]');
  await expect(agentRow.locator(".chat-activity-subject")).toHaveText("explore · Review renderer again · $0.25");
  await agentRow.locator("> summary").click();
  await agentRow.locator("[data-open-conversation]").click();
  await expect(page.locator("#chat-drilldown-title")).toHaveText("explore · Review renderer again · $0.25");
  await captureScreenshot(page, testInfo, `${PREFIX}-subagent-drilldown-desktop`);
  // The child reports more while its transcript is open: the title follows.
  const agentItem = costItems.find(item => item.id === "tool:agent")!;
  const restated = await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.split("\u0001")[0], item: { ...agentItem, childConversationId: childId, input: JSON.stringify({ description: "Review renderer again", subagent_type: "explore" }), usage: { input: 8_000, output: 400, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 } } } });
  expect(restated.ok()).toBe(true);
  await expect(page.locator("#chat-drilldown-title")).toHaveText("explore · Review renderer again · $0.50");
  await expect(agentRow.locator(".chat-activity-subject")).toHaveText("explore · Review renderer again · $0.50");
  await page.goBack();

  // Reopened: the cost is restored from history, still titled for the whole conversation.
  await page.reload();
  await openChatPanel(page);
  await page.locator("#chat-conversation-select").selectOption(seeded.split("\u0001")[0]!);
  // Main $1.25 plus the subagent's restated $0.50, from history alone.
  await expect(summary).toHaveText("$1.75 this conversation");
  await summary.click();
  await expect(page.locator("#chat-plan-session-title")).toHaveText("This conversation");
  await captureScreenshot(page, testInfo, `${PREFIX}-reopen-desktop`);
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
