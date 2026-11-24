import { expect, test } from "bun:test";
import path from "node:path";

import { buildPriceTable, FAMILY_MAP, MODELS_DEV_SOURCES, renderPriceTable } from "./update-antigravity-prices";

// A hand-written sample in models.dev's shape; the script itself never runs here.
const sample = JSON.parse(await Bun.file(path.join(import.meta.dir, "../tests/fixtures/antigravity/models-dev-sample.json")).text());

test("each agy family takes Vertex's base input, output and cache-read rates, and nothing else", () => {
  const table = buildPriceTable(sample, "2026-11-24");
  expect(table.snapshot).toBe("2026-11-24");
  expect(table.source).toBe("https://models.dev/api.json");
  // Base rates only (no long-context tier), cache writes dropped, Vertex not the Gemini API.
  expect(table.models["gemini-4-neon"]).toEqual({ input: 1.25, output: 10, cacheRead: 0.31, from: "google-vertex/gemini-4-neon" });
  expect(table.models["gemini-4-hydrogen"]).toEqual({ input: 0.3, output: 2.5, from: "google-vertex/gemini-4-hydrogen" });
  // Partner models are priced from their Vertex entries too.
  expect(table.models["claude-opus-5-5"]).toEqual({ input: 5, output: 25, cacheRead: 0.5, from: "google-vertex/claude-opus-5-5" });
  expect(table.models["gpt-oss-120b-medium"]).toEqual({ input: 0.15, output: 0.6, from: "google-vertex/gpt-oss-120b" });
  expect(Object.keys(table.models).sort()).toEqual(Object.keys(MODELS_DEV_SOURCES).sort());
});

test("models without their own entry borrow their family's price", () => {
  expect(buildPriceTable(sample, "2026-11-24").families).toEqual({ "gemini-pro-orchestrator-neon": "gemini-4-neon", "gemini-pro-orchestrator-g1-pro": "gemini-4-argon" });
  expect(FAMILY_MAP["gemini-pro-orchestrator-g1-pro"]).toBe("gemini-4-argon");
});

test("a missing entry fails the run, naming it, instead of writing a thinner table", () => {
  const thinner = structuredClone(sample);
  delete thinner["google-vertex"].models["gemini-4-argon"];
  thinner["google-vertex"].models["gpt-oss-120b"].cost = { input: 0.15 };
  expect(() => buildPriceTable(thinner, "2026-11-24")).toThrow("gemini-4-argon (google-vertex/gemini-4-argon), gpt-oss-120b-medium (google-vertex/gpt-oss-120b)");
});

test("the rendered table records its source and snapshot date", () => {
  const rendered = renderPriceTable(buildPriceTable(sample, "2026-11-24"));
  expect(rendered).toContain("// Source: https://models.dev/api.json");
  expect(rendered).toContain("// Snapshot: 2026-11-24");
  expect(rendered).toContain('"gemini-4-neon": {');
});
