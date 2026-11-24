import { expect, test } from "bun:test";

import { catalogFromSession } from "./catalog";

const legacyOnly = (ids: string[], current = ids[0]) => ({ models: { currentModelId: current, availableModels: ids.map(modelId => ({ modelId, name: modelId })) } });

test("legacy ids that share a family fold into one model with thinking levels", () => {
  const catalog = catalogFromSession(legacyOnly(["gemini-4-neon-low", "gemini-4-neon-high"]), false);
  expect(catalog.models.map(model => [model.selection.modelId, model.variants])).toEqual([["gemini-4-neon", ["low", "high"]]]);
  expect(catalog.current).toEqual(expect.objectContaining({ model: { providerId: "antigravity", modelId: "gemini-4-neon" }, variant: "low" }));
});

test("an id that only looks level-suffixed stays itself, and so does a known or priced one", () => {
  const alone = catalogFromSession(legacyOnly(["gemini-4-neon-low", "gemini-4-neon-high", "gpt-oss-120b-medium"], "gpt-oss-120b-medium"), false);
  expect(alone.models.map(model => model.selection.modelId)).toEqual(["gemini-4-neon", "gpt-oss-120b-medium"]);
  expect(alone.current.model?.modelId).toBe("gpt-oss-120b-medium");
  expect(alone.current.variant).toBeUndefined();
  // Even with a sibling, a known id is a model of its own.
  const known = catalogFromSession(legacyOnly(["gpt-oss-120b-medium", "gpt-oss-120b-high"]), false, id => id === "gpt-oss-120b-medium");
  expect(known.models.map(model => model.selection.modelId)).toEqual(["gpt-oss-120b-medium", "gpt-oss-120b-high"]);
});

test("without legacy ids, the levels config options advertise belong to the current model", () => {
  const catalog = catalogFromSession({ configOptions: [
    { id: "model", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Neon" }, { value: "gemini-4-argon", name: "Argon" }] },
    { id: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
  ] }, false);
  expect(catalog.models.map(model => [model.selection.modelId, model.variants])).toEqual([["gemini-4-neon", ["low", "high"]], ["gemini-4-argon", undefined]]);
});
