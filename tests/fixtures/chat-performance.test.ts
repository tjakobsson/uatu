import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeTranscriptEntries } from "../../src/chat/claude/normalization";
import { readSessionTranscript } from "../../src/chat/claude/transcript";
import { normalizeProviderMessage } from "../../src/chat/opencode/normalization";
import { CHAT_WORKLOAD_SIZES, chatWorkload, claudeHistoryWorkload, opencodeHistoryWorkload, workloadBytes } from "./chat-performance";

for (const count of CHAT_WORKLOAD_SIZES) test(`chat workload ${count} exercises shared and native history`, async () => {
  const items = chatWorkload(count);
  expect(items).toHaveLength(count);
  expect(new Set(items.map(item => item.id)).size).toBe(count);
  expect(items.some(item => item.type === "assistant_message" && item.markdown.includes("```ts"))).toBe(true);
  expect(items.some(item => item.type === "tool" && (item.output?.length ?? 0) > 10_000)).toBe(true);
  expect(items.some(item => item.type === "user_message" && item.attachments?.length)).toBe(true);
  expect(items.at(-1)).toMatchObject({ type: "question", status: "pending" });
  const root = await mkdtemp(path.join(tmpdir(), "uatu-chat-workload-"));
  try {
    const file = path.join(root, "fixture.jsonl");
    await writeFile(file, claudeHistoryWorkload(count));
    const transcript = await readSessionTranscript(file);
    expect(transcript.entries).toHaveLength(count);
    expect(transcript.skipped).toEqual({});
    const claude = normalizeTranscriptEntries(transcript.entries, "fixture").items;
    expect(claude.some(item => item.type === "tool" && (item.output?.length ?? 0) > 10_000)).toBe(true);
    const stores = opencodeHistoryWorkload(count);
    expect(stores.v2.length + stores.legacy.length).toBe(count);
    const opencode = [...stores.v2, ...stores.legacy].flatMap(normalizeProviderMessage);
    expect(opencode.some(item => item.type === "tool" && (item.output?.length ?? 0) > 10_000)).toBe(true);
    expect(workloadBytes(count).uiBytes).toBeGreaterThan(count * 1_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
