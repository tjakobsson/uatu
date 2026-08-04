import { describe, expect, test } from "bun:test";

import { isCompressibleType, sendableCloseCode } from "./proxy";

describe("isCompressibleType", () => {
  test("compresses text, JS, JSON, and SVG", () => {
    expect(isCompressibleType("text/javascript;charset=utf-8")).toBe(true);
    expect(isCompressibleType("text/css")).toBe(true);
    expect(isCompressibleType("text/html; charset=utf-8")).toBe(true);
    expect(isCompressibleType("application/json")).toBe(true);
    expect(isCompressibleType("application/manifest+json")).toBe(true);
    expect(isCompressibleType("image/svg+xml")).toBe(true);
  });

  test("never buffers incremental feeds or binary media", () => {
    expect(isCompressibleType("text/event-stream")).toBe(false);
    expect(isCompressibleType("application/x-ndjson; charset=utf-8")).toBe(false);
    expect(isCompressibleType("font/woff2")).toBe(false);
    expect(isCompressibleType("image/png")).toBe(false);
    expect(isCompressibleType("")).toBe(false);
  });
});

describe("sendableCloseCode", () => {
  test("passes app codes through and maps report-only codes to 1000", () => {
    expect(sendableCloseCode(4001)).toBe(4001);
    expect(sendableCloseCode(4410)).toBe(4410);
    expect(sendableCloseCode(1005)).toBe(1000);
    expect(sendableCloseCode(1006)).toBe(1000);
  });
});
