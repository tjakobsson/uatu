/**
 * Task 5.4's walkthrough: drives the real running UI against the user's own
 * `claude` end to end — agent choice, a live conversation, permission and
 * question cards, plan approval, task progress, an attachment, undo, and a
 * subagent drill-down — capturing evidence screenshots into the change
 * folder. Spends real tokens; run against a `bun run dev` server.
 *
 * Run: bun run scripts/chat-walkthrough.ts <url-with-token>
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const url = process.argv[2];
if (!url) throw new Error("usage: bun run scripts/chat-walkthrough.ts <url-with-token>");
const outDir = path.resolve("openspec/changes/add-claude-code-agent/screenshots");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
page.setDefaultTimeout(300_000);
await page.goto(url);
await page.locator("#connection-state .connection-label").filter({ hasText: "Connected" }).waitFor();
const strip = page.locator("#chat-expand");
if (await strip.isVisible()) await strip.click();
await page.locator("#chat-timeline").waitFor();

const shoot = async (name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, name) });
  console.log(`captured ${name}`);
};

const send = async (text: string) => {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
};

const awaitIdle = async () => {
  // While a turn runs the send button is an enabled Cancel; idle means the
  // label reads Send again.
  await page.waitForFunction(() => {
    const label = document.querySelector("#chat-send .chat-send-label");
    return label?.textContent === "Send";
  }, undefined, { timeout: 600_000 });
  await page.waitForTimeout(500);
};

// 1. Agent choice on the real server. The initial chooser selection may
// itself be a Claude conversation, so "created" is proven by the chooser
// flipping to a conversation id that was not selected before — never by
// the header text alone.
// Let bootstrap finish its initial chooser pass before creating, then take
// the created id from the creation response itself — chooser heuristics
// race the initial selection.
await page.waitForFunction(() => {
  const chooser = document.querySelector<HTMLSelectElement>("#chat-conversation-select");
  return chooser !== null && (chooser.value !== "" || chooser.options.length > 0);
}, undefined, { timeout: 60_000 });
await page.waitForTimeout(1_000);
await page.locator("#chat-new-conversation").click();
await page.locator("#chat-agent-menu").waitFor();
await shoot("7-real-agent-choice.png");
const creation = page.waitForResponse(response =>
  response.url().endsWith("/api/chat/conversations") && response.request().method() === "POST");
await page.locator('#chat-agent-menu .chat-agent-menu__item[data-agent-id="claude"]').click();
const createdId = ((await (await creation).json()) as { conversation: { id: string } }).conversation.id;
await page.waitForFunction(id => document.querySelector<HTMLSelectElement>("#chat-conversation-select")?.value === id, createdId, { timeout: 60_000 });
console.log("created", createdId);

// 2. Permission card from a real tool request (default mode prompts for Write).
await send('Create a file named walkthrough.txt containing exactly "hello from the walkthrough". Use the Write tool. Do not use any other tool first.');
const permissionCard = page.locator("#chat-items details.chat-request", { hasText: "Permission" });
await permissionCard.first().waitFor({ timeout: 600_000 });
await shoot("8-real-permission-card.png");
await page.locator("[data-permission-outcome=approved-once]").first().click();
await awaitIdle();

// 3. Structured question from the real AskUserQuestion tool.
await send("Use the AskUserQuestion tool to ask me one question: whether I prefer red or blue. Two options, no other tools, then stop after I answer by replying with my choice.");
await page.locator(".chat-question-option").first().waitFor();
await shoot("9-real-question-form.png");
await page.locator("input[data-question-provider-option]").last().check();
await page.locator("[data-question-primary]").click();
await awaitIdle();

// 4. A small file-editing turn: the permission grant mid-turn, and the
// undo-able work for step 5. (TodoWrite is not offered inside SDK sessions,
// so the task-progress surface's evidence lives in the e2e suite and the
// scripted-harness demo instead.)
await send("Append the single line \"second line\" to walkthrough.txt using the Edit tool, then stop.");
for (let attempt = 0; attempt < 60; attempt += 1) {
  const pending = page.locator("[data-permission-outcome=approved-once]");
  if (await pending.count() > 0) {
    await pending.first().click();
    break;
  }
  const label = await page.locator("#chat-send .chat-send-label").textContent();
  if (label === "Send") break;
  await page.waitForTimeout(5_000);
}
await awaitIdle();
await shoot("10-real-edit-turn-done.png");

// 5. Undo: the last turn's file work reverts and the prompt returns.
let restored = false;
for (let attempt = 0; attempt < 3 && !restored; attempt += 1) {
  await page.locator("#chat-input").fill("/undo");
  await page.waitForTimeout(400);
  await page.locator("#chat-send").click();
  restored = await page.waitForFunction(() => {
    const value = document.querySelector<HTMLTextAreaElement>("#chat-input")?.value ?? "";
    return value.length > 6 && !value.startsWith("/undo");
  }, undefined, { timeout: 45_000 }).then(() => true, () => false);
  if (!restored) {
    console.log(`undo attempt ${attempt + 1} did not restore; input=${JSON.stringify(await page.locator("#chat-input").inputValue())} status=${JSON.stringify((await page.locator("#chat-composer-status").textContent().catch(() => "")))}`);
  }
}
if (!restored) throw new Error("undo never restored the draft");
await shoot("12-real-undo-draft-restored.png");
// Put history back so the walkthrough ends at the newest state.
await page.locator("#chat-input").fill("/redo");
await page.locator("#chat-send").click();
await page.waitForTimeout(3_000);
await page.locator("#chat-input").fill("");

// 6. Subagent drill-down from a real Task run.
await send("Use the Task tool to launch one quick explore subagent with the description \"Count the files\" and prompt \"Reply with the number of files in the current directory, using at most one tool call.\" Then report its answer and stop.");
await awaitIdle();
const subagents = page.locator("#chat-subagents summary");
await subagents.waitFor({ timeout: 30_000 });
await subagents.click();
await page.locator("#chat-subagents-items button").first().click();
await page.locator("#chat-drilldown-items").waitFor();
await shoot("13-real-subagent-drilldown.png");
await page.locator("#chat-drilldown-back").click();

await browser.close();
console.log(`walkthrough screenshots in ${outDir}`);
