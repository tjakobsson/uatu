import { describe, expect, test } from "bun:test";

import { conversationTotals } from "../conversation-totals";
import type { ConversationItem } from "../types";
import { ANTIGRAVITY_PRICES } from "./prices";
import { priceTurn, ratesFor, type AntigravityPriceTable } from "./pricing";

// Rates for the tests only, USD per million tokens.
const TABLE: AntigravityPriceTable = {
  source: "test", snapshot: "2026-11-24",
  models: {
    "gemini-4-neon": { input: 1, output: 10, cacheRead: 0.1, from: "test/neon" },
    "gemini-4-argon": { input: 2, output: 12, from: "test/argon" },
  },
  families: { "gemini-pro-orchestrator-neon": "gemini-4-neon" },
};

describe("priceTurn (D11)", () => {
  test("input, output and cached reads at their rates; thinking is inside output and not added again", () => {
    const usage = { input: 1_000_000, output: 100_000, reasoning: 40_000, cacheRead: 2_000_000 };
    expect(priceTurn(usage, "gemini-4-neon", TABLE)).toBeCloseTo(1 + 1 + 0.2, 10);
    expect(priceTurn({ ...usage, reasoning: 0 }, "gemini-4-neon", TABLE)).toBe(priceTurn(usage, "gemini-4-neon", TABLE)!);
  });

  test("cache writes are not priced, and a model without a cache-read rate prices cached reads as input", () => {
    expect(priceTurn({ input: 0, output: 0, cacheWrite: 5_000_000 }, "gemini-4-neon", TABLE)).toBe(0);
    expect(priceTurn({ cacheRead: 1_000_000 }, "gemini-4-argon", TABLE)).toBe(2);
  });

  test("a model without its own price borrows its family's", () => {
    expect(ratesFor("gemini-pro-orchestrator-neon", TABLE)).toEqual(TABLE.models["gemini-4-neon"]);
    expect(priceTurn({ input: 1_000_000 }, "gemini-pro-orchestrator-neon", TABLE)).toBe(1);
  });

  test("a lone legacy thinking-level id borrows its family's price, and an exact price still wins", () => {
    expect(ratesFor("gemini-4-neon-low", TABLE)).toEqual(TABLE.models["gemini-4-neon"]);
    expect(priceTurn({ input: 1_000_000 }, "gemini-4-neon-low", TABLE)).toBe(1);
    const exact: AntigravityPriceTable = { ...TABLE, models: { ...TABLE.models, "gemini-4-neon-medium": { input: 7, output: 7, from: "test" } } };
    expect(priceTurn({ input: 1_000_000 }, "gemini-4-neon-medium", exact)).toBe(7);
    expect(ratesFor("some-new-model-low", TABLE)).toBeUndefined();
  });

  test("an unknown model contributes no cost rather than zero", () => {
    expect(priceTurn({ input: 1_000_000 }, "some-new-model", TABLE)).toBeUndefined();
    expect(priceTurn({ input: 1_000_000 }, undefined, TABLE)).toBeUndefined();
  });

  test("the built-in table records its source and, until it is generated, prices nothing", () => {
    expect(ANTIGRAVITY_PRICES.source).toBe("https://models.dev/api.json");
    if (ANTIGRAVITY_PRICES.snapshot === null) expect(ANTIGRAVITY_PRICES.models).toEqual({});
    else expect(Object.keys(ANTIGRAVITY_PRICES.models).length).toBeGreaterThan(0);
  });

  test("the receipt's by-model total matches the conversation total", () => {
    const carrier = (id: string, modelId: string, usage: { input: number; output: number; cacheRead?: number }): ConversationItem => ({
      id: `usage:${id}`, type: "assistant_message", createdAt: 1, markdown: "",
      usage: { ...usage, ...(priceTurn(usage, modelId, TABLE) !== undefined ? { costUsd: priceTurn(usage, modelId, TABLE) } : {}) },
      model: { providerId: "antigravity", modelId },
    });
    const totals = conversationTotals([
      carrier("s.t1", "gemini-4-neon", { input: 200_000, output: 10_000, cacheRead: 50_000 }),
      carrier("s.t2", "gemini-4-argon", { input: 100_000, output: 5_000 }),
      carrier("s.t3", "gemini-4-neon", { input: 300_000, output: 20_000 }),
    ])!;
    const byModel = totals.models.reduce((sum, model) => sum + (model.costUsd ?? 0), 0);
    expect(totals.costUsd).toBeCloseTo(byModel, 10);
    expect(totals.receipt?.total.costUsd).toBeCloseTo(byModel, 10);
    expect(totals.models.map(model => model.id)).toEqual(["gemini-4-neon", "gemini-4-argon"]);
  });
});
