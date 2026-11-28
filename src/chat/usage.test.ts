import { describe, expect, test } from "bun:test";
import { contextTokens, formatTokens, formatUsd, hasPrice, mergeAssistantMessage, sameUsage, totalTokens } from "./usage";
import type { TokenUsage } from "./types";

describe("formatTokens", () => {
  test("counts below a thousand stay bare", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(840)).toBe("840");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands shorten to k, one decimal only where it carries weight", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(9_999)).toBe("10.0k");
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(1_240)).toBe("1.2k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(999_999)).toBe("1000k");
  });

  test("millions shorten to M at one decimal", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  // GitHub #464: a billion-scale readout rendered as "1023.7M" — thousands of
  // millions, harder to read at a glance than the B scale a person expects.
  test("billions shorten to B at one decimal", () => {
    expect(formatTokens(1_023_700_000)).toBe("1.0B");
    expect(formatTokens(1_234_567_890)).toBe("1.2B");
  });

  test("the thousand/million and million/billion boundaries stay on the lower scale", () => {
    // A value rounds up across its own boundary only by purity of arithmetic:
    // the suffix switches at the value itself, not at the rounded figure.
    expect(formatTokens(999_999)).toBe("1000k");
    expect(formatTokens(999_999_999)).toBe("1000.0M");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_000_000_000)).toBe("1.0B");
  });

  test("rounding lands on displayed figures, never overflow into a new scale", () => {
    // 999,950 rounds to 1000 but stays k; the scale never doubles up ("1000.0kM").
    expect(formatTokens(999_950_000)).toBe("1000.0M");
    expect(formatTokens(1_049_999_999)).toBe("1.0B");
    expect(formatTokens(1_050_000_000)).toBe("1.1B");
    expect(formatTokens(1_949_999_999)).toBe("1.9B");
  });
});

describe("formatUsd", () => {
  test("budgetable figures read as cents, cheap turns keep their four places", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0.004)).toBe("$0.004");
  });
});

describe("hasPrice", () => {
  test("only a positive cost is a price: absent is unreported and zero is OpenCode's unpriced model", () => {
    for (const value of [undefined, null, 0]) expect(hasPrice(value)).toBe(false);
    expect(hasPrice(0.000001)).toBe(true);
    expect(hasPrice(12.5)).toBe(true);
  });
});

describe("totalTokens and contextTokens", () => {
  test("the spend total sums every component; the context total only what occupies the window", () => {
    const usage: TokenUsage = { input: 10, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50, costUsd: 1 };
    expect(totalTokens(usage)).toBe(150);
    expect(contextTokens(usage)).toBe(100);
    expect(totalTokens({})).toBe(0);
  });
});

describe("sameUsage", () => {
  test("absent components match absent, cost rides along", () => {
    expect(sameUsage(undefined, undefined)).toBe(true);
    expect(sameUsage({ input: 1 }, { input: 1 })).toBe(true);
    expect(sameUsage({ input: 1 }, {})).toBe(false);
    expect(sameUsage({ input: 1, costUsd: 0.5 }, { input: 1, costUsd: 0.6 })).toBe(false);
  });
});

describe("mergeAssistantMessage", () => {
  test("a restated usage carrier keeps the list-price marker only while the incoming figure carries it", () => {
    const carrier = (usage: TokenUsage) => ({ id: "usage:m", type: "assistant_message" as const, createdAt: 1, markdown: "", usage });
    expect(mergeAssistantMessage(carrier({ input: 5, costUsd: 0.01, listPriced: true }), carrier({ input: 5, costUsd: 0.02 })).usage).toEqual({ input: 5, costUsd: 0.02 });
    expect(mergeAssistantMessage(carrier({ input: 5, costUsd: 0 }), carrier({ input: 5, costUsd: 0.01, listPriced: true })).usage).toEqual({ input: 5, costUsd: 0.01, listPriced: true });
  });
});
