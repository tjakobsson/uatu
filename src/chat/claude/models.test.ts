import { describe, expect, test } from "bun:test";

import { CLAUDE_MODELS, CLAUDE_MORE_MODELS, MORE_MODELS_GROUP, versionedModelName, withMoreModels } from "./models";
import type { ChatModel } from "../types";

describe("More models (D3)", () => {
  test("the app-only set sits after the catalog rows under its own group", () => {
    const catalog: ChatModel[] = [
      { selection: { providerId: "anthropic", modelId: "default" }, provider: "Anthropic", name: "Default (recommended)", default: true, resolvesTo: { providerId: "anthropic", modelId: "opus[1m]" } },
      { selection: { providerId: "anthropic", modelId: "opus[1m]" }, provider: "Anthropic", name: "Opus 5 (1M context)", resolvesTo: { providerId: "anthropic", modelId: "claude-opus-5[1m]" } },
      { selection: { providerId: "anthropic", modelId: "fable[1m]" }, provider: "Anthropic", name: "Fable 5.1", resolvesTo: { providerId: "anthropic", modelId: "claude-fable-5-1" } },
    ];
    const offered = withMoreModels(catalog);
    expect(offered.slice(0, 3)).toEqual(catalog);
    expect(offered.slice(3).map(model => model.selection.modelId)).toEqual(["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(offered.slice(3).every(model => model.provider === MORE_MODELS_GROUP)).toBe(true);
    // Windows and effort tiers travel with the entries.
    expect(offered.find(model => model.selection.modelId === "claude-opus-4-8")).toEqual(expect.objectContaining({ name: "Opus 4.8", contextLimit: 1_000_000, variants: ["low", "medium", "high", "xhigh", "max"] }));
    expect(offered.find(model => model.selection.modelId === "claude-sonnet-4-6")).toEqual(expect.objectContaining({ name: "Sonnet 4.6", contextLimit: 200_000, variants: ["low", "medium", "high"] }));
  });

  test("never shadows a catalog id, by alias or by resolved id with or without the window marker", () => {
    const catalog: ChatModel[] = [
      { selection: { providerId: "anthropic", modelId: "claude-opus-4-8" }, provider: "Anthropic", name: "Opus 4.8" },
      { selection: { providerId: "anthropic", modelId: "sonnet-legacy" }, provider: "Anthropic", name: "Sonnet 4.6", resolvesTo: { providerId: "anthropic", modelId: "claude-sonnet-4-6[1m]" } },
      { selection: { providerId: "anthropic", modelId: "fable" }, provider: "Anthropic", name: "Fable 5", resolvesTo: { providerId: "anthropic", modelId: "claude-fable-5" } },
    ];
    const ids = withMoreModels(catalog).map(model => model.selection.modelId);
    expect(ids).toEqual(["claude-opus-4-8", "sonnet-legacy", "fable", "claude-opus-4-7", "claude-opus-4-6"]);
    expect(ids.filter(id => id === "claude-opus-4-8")).toHaveLength(1);
  });

  test("the static fallback offers the set too, minus the ids it already lists", () => {
    const ids = withMoreModels(CLAUDE_MODELS).map(model => model.selection.modelId);
    expect(ids).toContain("claude-opus-4-8");
    expect(ids.filter(id => id === "claude-fable-5")).toHaveLength(1);
    expect(CLAUDE_MORE_MODELS.every(model => model.detail?.includes(model.selection.modelId))).toBe(true);
  });
});

describe("versioned model names (D2)", () => {
  test("derives the version from the description's leading segment and keeps the window marker", () => {
    expect(versionedModelName("Opus (1M context)", "Opus 5 with 1M context · Best for everyday, complex tasks", "claude-opus-5[1m]")).toBe("Opus 5 (1M context)");
    expect(versionedModelName("Fable", "Fable 5.1 · Most capable for your hardest and longest-running tasks", "claude-fable-5-1")).toBe("Fable 5.1");
    expect(versionedModelName("Sonnet", "Sonnet 5 · Efficient for routine tasks", "claude-sonnet-5")).toBe("Sonnet 5");
    expect(versionedModelName("Haiku", "Haiku 4.5 · Fastest for quick answers", "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  test("falls back to the resolved wire id, and keeps a name that already carries a version", () => {
    expect(versionedModelName("Haiku", undefined, "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(versionedModelName("Fable", "Most capable", "claude-fable-5-1")).toBe("Fable 5.1");
    expect(versionedModelName("Opus (1M context)", undefined, "claude-opus-5[1m]")).toBe("Opus 5 (1M context)");
    expect(versionedModelName("Sonnet 4.6", "Sonnet 4.6 · older", "claude-sonnet-4-6")).toBe("Sonnet 4.6");
    // Nothing states a version: the display name stands rather than a guess.
    expect(versionedModelName("Mystery", "Mystery · no version anywhere", "mystery-model")).toBe("Mystery");
  });
});
