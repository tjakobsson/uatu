import { describe, expect, test } from "bun:test";

import { contextReadout } from "./context-readout";
import type { ChatModel, ConversationItem } from "./types";

const models: ChatModel[] = [
  { selection: { providerId: "anthropic", modelId: "opus[1m]" }, provider: "Anthropic", name: "Opus 5 (1M context)", contextLimit: 1_000_000 },
  { selection: { providerId: "anthropic", modelId: "sonnet" }, provider: "Anthropic", name: "Sonnet 5", contextLimit: 200_000 },
];
const carrier = (id: string, createdAt: number, input: number, cacheRead: number, modelId = "sonnet"): ConversationItem => ({
  id, type: "assistant_message", createdAt, markdown: "", usage: { input, cacheRead, output: 20 }, model: { providerId: "anthropic", modelId },
});

describe("context readout source selection", () => {
  test("a report of 300k against 1M paints 30% and lists the agent's used categories", () => {
    const report: ConversationItem = {
      id: "context:report:1", type: "context_report", createdAt: 10, total: 300_000, max: 1_000_000,
      model: { providerId: "anthropic", modelId: "opus[1m]" },
      categories: [
        { name: "System prompt", tokens: 20_000, kind: "used" },
        { name: "Tools (deferred)", tokens: 13_000, kind: "deferred" },
        { name: "Messages", tokens: 280_000, kind: "used" },
        { name: "Autocompact buffer", tokens: 45_000, kind: "buffer" },
        { name: "Free space", tokens: 655_000, kind: "free" },
      ],
    };
    const readout = contextReadout([carrier("usage:a1", 1, 100, 150_000), report], models, undefined)!;
    expect(readout.source).toBe(report);
    expect(readout.used).toBe(300_000);
    expect(readout.limit).toBe(1_000_000);
    expect(readout.fraction).toBeCloseTo(0.3);
    expect(readout.rows).toEqual([["In context", 300_000], ["Limit", 1_000_000], ["System prompt", 20_000], ["Messages", 280_000]]);
    // The listed categories add up to the presented fill.
    expect(readout.rows.slice(2).reduce((sum, [, tokens]) => sum + tokens, 0)).toBe(readout.used);
  });

  test("a report without its own window measures against the reporting model's limit", () => {
    const report: ConversationItem = { id: "context:cb", type: "context_report", createdAt: 5, total: 40_000, model: { providerId: "anthropic", modelId: "sonnet" } };
    const readout = contextReadout([report], models, undefined)!;
    expect(readout.limit).toBe(200_000);
    expect(readout.fraction).toBeCloseTo(0.2);
  });

  test("a carrier newer than the last report wins, and a later report wins again", () => {
    const report: ConversationItem = { id: "context:report:1", type: "context_report", createdAt: 2, total: 40_000, max: 200_000 };
    const later = carrier("usage:a2", 3, 100, 59_900);
    expect(contextReadout([report, later], models, undefined)!.source).toBe(later);
    const settled: ConversationItem = { id: "context:report:2", type: "context_report", createdAt: 4, total: 61_000, max: 200_000 };
    const readout = contextReadout([report, later, settled], models, undefined)!;
    expect(readout.source).toBe(settled);
    expect(readout.used).toBe(61_000);
  });

  test("a carrier reads one call's occupancy and skips a zero placeholder when an earlier figure is known", () => {
    const real = carrier("usage:a1", 1, 100, 29_900);
    const zero = carrier("usage:a2", 2, 0, 0);
    const readout = contextReadout([real, zero], models, undefined)!;
    expect(readout.source).toBe(real);
    expect(readout.used).toBe(30_000);
    expect(readout.fraction).toBeCloseTo(0.15);
    expect(readout.rows).toEqual([["In context", 30_000], ["Limit", 200_000], ["Input", 100], ["Cache read", 29_900], ["Output", 20]]);
  });

  test("a typed id keeps the window its own report stated once a newer carrier arrives", () => {
    const report: ConversationItem = { id: "context:report:1", type: "context_report", createdAt: 2, total: 40_000, max: 1_000_000, model: { providerId: "anthropic", modelId: "claude-opus-4-9" } };
    const later = carrier("usage:a2", 3, 100, 59_900, "claude-opus-4-9");
    const readout = contextReadout([report, later], models, undefined)!;
    expect(readout.source).toBe(later);
    expect(readout.limit).toBe(1_000_000);
    expect(readout.fraction).toBeCloseTo(0.06);
    // A later compaction report (total only) keeps the window that the
    // control-channel report established.
    const compaction: ConversationItem = { id: "context:cb", type: "context_report", createdAt: 4, total: 20_000, model: { providerId: "anthropic", modelId: "claude-opus-4-9" } };
    const afterCompaction = contextReadout([report, later, compaction], models, undefined)!;
    expect(afterCompaction.limit).toBe(1_000_000);
    expect(afterCompaction.fraction).toBeCloseTo(0.02);
    // Another model's report says nothing about this one.
    const other: ConversationItem = { id: "context:report:2", type: "context_report", createdAt: 1, total: 1, max: 200_000, model: { providerId: "anthropic", modelId: "sonnet" } };
    expect(contextReadout([other, later], models, undefined)!.limit).toBeUndefined();
  });

  test("the session's own window beats the catalog's figure for the same model (#347)", () => {
    // The catalog guessed 200k for the plain id; the session reported 1M.
    // A carrier at 212k then reads as ~21%, not a red 100%.
    const report: ConversationItem = { id: "context:report:1", type: "context_report", createdAt: 2, total: 40_000, max: 1_000_000, model: { providerId: "anthropic", modelId: "sonnet" } };
    const later = carrier("usage:a2", 3, 2, 212_895);
    const readout = contextReadout([report, later], models, undefined)!;
    expect(readout.source).toBe(later);
    expect(readout.limit).toBe(1_000_000);
    expect(readout.fraction).toBeCloseTo(0.2129, 3);
    expect(readout.rows.slice(0, 2)).toEqual([["In context", 212_897], ["Limit", 1_000_000]]);
    // A compaction report without a window of its own measures against the
    // session's stated window too, not the catalog's.
    const compaction: ConversationItem = { id: "context:cb", type: "context_report", createdAt: 4, total: 20_000, model: { providerId: "anthropic", modelId: "sonnet" } };
    expect(contextReadout([report, later, compaction], models, undefined)!.limit).toBe(1_000_000);
  });

  test("a catalog figure the occupancy exceeds is dropped rather than painted as full", () => {
    // Nothing has reported a window yet and the carrier already exceeds
    // the catalog's 200k: the figure is wrong for this session, so the
    // readout states the occupancy alone (a "?" badge, no alert state).
    const over = carrier("usage:a1", 1, 2, 212_895);
    const readout = contextReadout([over], models, undefined)!;
    expect(readout.used).toBe(212_897);
    expect(readout.limit).toBeUndefined();
    expect(readout.fraction).toBeUndefined();
    expect(readout.rows).toEqual([["In context", 212_897], ["Input", 2], ["Cache read", 212_895], ["Output", 20]]);
    // Within the figure, the catalog still measures.
    expect(contextReadout([carrier("usage:a0", 0, 100, 99_900)], models, undefined)!.fraction).toBeCloseTo(0.5);
    // The session's own statement of an over-full window is its word, and
    // reads as full — a compaction boundary it has run past.
    const overReport: ConversationItem = { id: "context:report:1", type: "context_report", createdAt: 2, total: 210_000, max: 200_000, model: { providerId: "anthropic", modelId: "sonnet" } };
    expect(contextReadout([overReport], models, undefined)!.fraction).toBe(1);
    // A carrier that exceeds a window the session stated is measured against
    // it all the same, capped at full.
    expect(contextReadout([overReport, carrier("usage:a3", 3, 2, 219_998)], models, undefined)!.fraction).toBe(1);
  });

  test("an unknown model leaves the limit and fraction absent; nothing reported yields nothing", () => {
    const typed = carrier("usage:a1", 1, 100, 900, "claude-nope-1");
    const readout = contextReadout([typed], models, undefined)!;
    expect(readout.limit).toBeUndefined();
    expect(readout.fraction).toBeUndefined();
    expect(readout.used).toBe(1_000);
    expect(contextReadout([{ id: "m", type: "user_message", createdAt: 1, text: "hi" }], models, undefined)).toBeUndefined();
  });
});
