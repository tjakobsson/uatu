import { describe, expect, test } from "bun:test";

import { joinBasePath, normalizeBasePath, stripBasePath } from "./base-path";

describe("normalizeBasePath", () => {
  test("keeps / as the identity prefix", () => {
    expect(normalizeBasePath("/")).toBe("/");
  });

  test("appends the trailing slash", () => {
    expect(normalizeBasePath("/s/uatu")).toBe("/s/uatu/");
    expect(normalizeBasePath("/s/uatu/")).toBe("/s/uatu/");
  });

  test("rejects relocatable or malformed prefixes", () => {
    expect(() => normalizeBasePath("relative")).toThrow(/must start with '\/'/);
    expect(() => normalizeBasePath("/a b/")).toThrow(/whitespace or reserved/);
    expect(() => normalizeBasePath("/a?b/")).toThrow(/whitespace or reserved/);
    expect(() => normalizeBasePath("/a#b/")).toThrow(/whitespace or reserved/);
    expect(() => normalizeBasePath("/a/../b")).toThrow(/dot segments/);
    expect(() => normalizeBasePath("/a/./b")).toThrow(/dot segments/);
    expect(() => normalizeBasePath("/a//b")).toThrow(/empty path segment/);
    // URL parsers canonicalize encoded sequences (%2e%2e → dot segments),
    // so literal-encoded prefixes can never match their routes.
    expect(() => normalizeBasePath("/s/%2e%2e/")).toThrow(/percent-encoding/);
    expect(() => normalizeBasePath("/s/%61/")).toThrow(/percent-encoding/);
  });
});

describe("joinBasePath", () => {
  test("is the identity at /", () => {
    expect(joinBasePath("/", "/api/state")).toBe("/api/state");
  });

  test("prefixes without doubling the separator", () => {
    expect(joinBasePath("/s/uatu/", "/api/state")).toBe("/s/uatu/api/state");
  });
});

describe("stripBasePath", () => {
  test("is the identity at /", () => {
    expect(stripBasePath("/api/state", "/")).toBe("/api/state");
    expect(stripBasePath("/", "/")).toBe("/");
  });

  test("strips the prefix to a root-relative path", () => {
    expect(stripBasePath("/s/uatu/api/state", "/s/uatu/")).toBe("/api/state");
    expect(stripBasePath("/s/uatu/guides/setup.md", "/s/uatu/")).toBe("/guides/setup.md");
  });

  test("resolves the prefix root with and without the trailing slash", () => {
    expect(stripBasePath("/s/uatu/", "/s/uatu/")).toBe("/");
    expect(stripBasePath("/s/uatu", "/s/uatu/")).toBe("/");
  });

  test("returns null outside the prefix", () => {
    expect(stripBasePath("/api/state", "/s/uatu/")).toBeNull();
    expect(stripBasePath("/s/other/api/state", "/s/uatu/")).toBeNull();
    // A sibling id sharing the prefix as a string is still outside.
    expect(stripBasePath("/s/uatu2/api/state", "/s/uatu/")).toBeNull();
  });
});
