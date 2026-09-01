/**
 * Captures review screenshots of the multi-agent chat UX against a running
 * chat harness (scripts/chat-harness.ts) into the openspec change folder.
 *
 * Run: bun run scripts/chat-harness-screenshots.ts <harness-url-with-token>
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const url = process.argv[2];
if (!url) throw new Error("usage: bun run scripts/chat-harness-screenshots.ts <harness-url-with-token>");
const outDir = path.resolve("openspec/changes/add-claude-code-agent/screenshots");
await mkdir(outDir, { recursive: true });
const origin = new URL(url).origin;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
await page.goto(url);
await page.locator("#connection-state .connection-label").filter({ hasText: "Connected" }).waitFor();
const strip = page.locator("#chat-expand");
if (await strip.isVisible()) await strip.click();
await page.locator("#chat-timeline").waitFor();
const select = page.locator("#chat-conversation-select");
await page.waitForFunction(() => {
  const chooser = document.querySelector<HTMLSelectElement>("#chat-conversation-select");
  return (chooser?.options.length ?? 0) >= 2;
});

const shoot = async (name: string) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, name), fullPage: false });
  console.log(`captured ${name}`);
};

// 1. Claude Code conversation selected: header identity + attributed chooser.
const optionValues = await select.evaluate(chooser =>
  [...(chooser as HTMLSelectElement).options].map(option => option.value).filter(Boolean));
const claudeId = optionValues.find(value => value.startsWith("claude:"))!;
const opencodeId = optionValues.find(value => value.startsWith("opencode:"))!;
await select.selectOption(claudeId);
await page.locator("#chat-context").filter({ hasText: "Claude Code" }).waitFor();
await shoot("1-claude-conversation-selected.png");

// 2. OpenCode conversation selected: the header follows the selection.
await select.selectOption(opencodeId);
await page.locator("#chat-context").filter({ hasText: "OpenCode" }).waitFor();
await shoot("2-opencode-conversation-selected.png");

// 3. Agent choice at creation.
await page.locator("#chat-new-conversation").click();
await page.locator("#chat-agent-menu").waitFor();
await shoot("3-agent-choice-at-creation.png");
await page.keyboard.press("Escape");

// 4. The same menu with one agent unavailable — explained, not hidden.
await fetch(`${origin}/__e2e/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "failStartup", agent: "claude" }),
});
await page.reload();
if (await strip.isVisible()) await strip.click();
await page.locator("#chat-timeline").waitFor();
await page.locator("#chat-new-conversation").click();
await page.locator("#chat-agent-menu .chat-agent-menu__item.is-unavailable").waitFor();
await shoot("4-unavailable-agent-explained.png");

await browser.close();
console.log(`screenshots in ${outDir}`);
