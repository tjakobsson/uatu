import { describe, expect, test } from "bun:test";
import { newRequestId } from "./ids";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newRequestId", () => {
  test("returns a v4-shaped identity", () => {
    expect(newRequestId()).toMatch(UUID_PATTERN);
    expect(newRequestId()).not.toBe(newRequestId());
  });

  test("falls back to getRandomValues when randomUUID is missing", () => {
    const original = globalThis.crypto;
    const fallback = { getRandomValues: (bytes: Uint8Array) => original.getRandomValues(bytes) };
    Object.defineProperty(globalThis, "crypto", { value: fallback, configurable: true });
    try {
      expect(newRequestId()).toMatch(UUID_PATTERN);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});
