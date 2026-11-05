import { describe, expect, test } from "bun:test";

import { applyWatchContext, parseWatchContext } from "./watch-context";

describe("watch request context", () => {
  test("showIgnored serializes as an explicit boolean and rejects other spellings", () => {
    for (const showIgnored of [true, false]) {
      const context = { scope: { kind: "folder" as const }, compareTarget: "base" as const, showIgnored };
      const url = applyWatchContext(new URL("https://example.test/api/state"), context);
      expect(url.searchParams.get("showIgnored")).toBe(showIgnored ? "1" : "0");
      expect(parseWatchContext(url.searchParams)).toEqual({ context });
    }
    expect(parseWatchContext(new URLSearchParams("showIgnored=false"))).toEqual({ error: "invalid showIgnored" });
  });
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
    expect(parseWatchContext(url.searchParams)).toEqual({ context: { ...context, showIgnored: true } });
  });

  test("rejects invalid or incomplete context", () => {
    expect(parseWatchContext(new URLSearchParams("compareTarget=other"))).toEqual({ error: "invalid compare target" });
    expect(parseWatchContext(new URLSearchParams("scope=other"))).toEqual({ error: "invalid scope" });
    expect(parseWatchContext(new URLSearchParams("scope=file"))).toEqual({ error: "missing documentId" });
  });
});
