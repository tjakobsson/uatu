import { expect, test } from "bun:test";
import { claudeWindowAnswer } from "./context-window";
import { createClaudeEventMemory, normalizeClaudeMessage, normalizeContextUsage } from "./normalization";

test("summary counts describe an effective window and a separately named compaction threshold", () => {
  const answer = claudeWindowAnswer({ model: "claude-opus-5-5", maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: true });
  expect(answer).toEqual({ model: "claude-opus-5-5", limit: 1_000_000, details: { kind: "effective", compactionThreshold: 967_000 } });
  expect(answer).not.toHaveProperty("capacity");
  for (const maxTokens of [0, -1, Infinity, NaN, 1.5]) expect(claudeWindowAnswer({ maxTokens })).toBeUndefined();
});

test("a structured /context response preserves a reported policy boundary and its occupancy", () => {
  const context = { model: "claude-opus-5-5", total_tokens: 210_000, raw_max_tokens: 200_000, over_limit: { kind: "compaction_window", tokens_over: 10_000 }, categories: [{ name: "Messages", tokens: 210_000, kind: "used" }] };
  const normalized = normalizeClaudeMessage({ type: "assistant", uuid: "ctx", timestamp: "2026-10-05T10:00:00Z", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Context report" }] }, context_usage: context }, createClaudeEventMemory(), "live", "session");
  const report = normalized.updates.find(update => update.kind === "upsert" && update.item.type === "context_report");
  expect(report).toMatchObject({ item: { total: 210_000, max: 200_000, window: { source: "session", kind: "compaction" } } });
  expect(normalized.assistantUsage).toBeUndefined();
});

test("normalization respects explicit category kinds instead of English-name guesses", () => {
  const report = normalizeContextUsage({ totalTokens: 10, maxTokens: 1_000_000, categories: [{ name: "Reserv", tokens: 20, kind: "buffer" }, { name: "Messages", tokens: 10, kind: "used" }] }, 1);
  expect(report?.categories?.[0]?.kind).toBe("buffer");
});
