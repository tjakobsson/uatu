import { describe, expect, test } from "bun:test";
import { catalogContextWindow } from "./context-window";

describe("catalogContextWindow", () => {
  test("a stated prompt limit is the window, with the capacity beside it", () => {
    // OpenAI's GPT-5.5 as OpenCode 1.19.5 lists it under a ChatGPT login.
    expect(catalogContextWindow({ context: 400000, input: 272000, output: 128000 })).toEqual({
      contextLimit: 272000,
      contextWindow: { source: "catalog", freshness: "current", kind: "effective", capacity: 400000 },
    });
  });

  test("without a prompt limit the capacity is the window", () => {
    expect(catalogContextWindow({ context: 262144, output: 65536 })).toEqual({
      contextLimit: 262144,
      contextWindow: { source: "catalog", freshness: "current" },
    });
  });

  test("a prompt limit equal to the capacity adds nothing", () => {
    expect(catalogContextWindow({ context: 1048576, input: 1048576, output: 131072 })).toEqual({
      contextLimit: 1048576,
      contextWindow: { source: "catalog", freshness: "current" },
    });
  });

  test("absent, zero, or malformed limits state no window", () => {
    expect(catalogContextWindow(undefined)).toEqual({});
    expect(catalogContextWindow({ context: 0, output: 0 })).toEqual({});
    expect(catalogContextWindow({ context: 0, input: 0 })).toEqual({});
    expect(catalogContextWindow({ context: Number.NaN, input: -1 })).toEqual({});
  });

  test("a prompt limit alone is still the window", () => {
    expect(catalogContextWindow({ input: 100000 })).toEqual({
      contextLimit: 100000,
      contextWindow: { source: "catalog", freshness: "current", kind: "effective" },
    });
  });
});
