import { describe, expect, test } from "bun:test";

import { applyWatchContext, parseWatchContext } from "./watch-context";

describe("watch request context", () => {
  test("defaults to folder/base", () => {
    expect(parseWatchContext(new URLSearchParams())).toEqual({
      context: { scope: { kind: "folder" }, compareTarget: "base" },
    });
  });

  test("round-trips file scope and compare target", () => {
    const context = {
      scope: { kind: "file" as const, documentId: "/workspace/README.md" },
      compareTarget: "last-commit" as const,
    };
    const url = applyWatchContext(new URL("https://example.test/api/state?x=1"), context);
    expect(url.searchParams.get("x")).toBe("1");
    expect(parseWatchContext(url.searchParams)).toEqual({ context });
  });

  test("rejects invalid or incomplete context", () => {
    expect(parseWatchContext(new URLSearchParams("compareTarget=other"))).toEqual({ error: "invalid compare target" });
    expect(parseWatchContext(new URLSearchParams("scope=other"))).toEqual({ error: "invalid scope" });
    expect(parseWatchContext(new URLSearchParams("scope=file"))).toEqual({ error: "missing documentId" });
  });
});
