import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { escapeHtml, escapeHtmlAttribute } from "./html";

// Property-based: the escaping contract must hold for ALL inputs, not just
// the characters we thought of. Output from these helpers is written via
// `innerHTML`, so a single unescaped metacharacter is an injection vector.

const arbitraryText = fc.oneof(fc.string(), fc.string({ unit: "binary" }));

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

describe("escapeHtml properties", () => {
  test("output never contains an active HTML metacharacter", () => {
    fc.assert(
      fc.property(arbitraryText, value => {
        expect(escapeHtml(value)).not.toMatch(/[<>"']/);
      }),
    );
  });

  test("every ampersand in the output starts a known entity", () => {
    fc.assert(
      fc.property(arbitraryText, value => {
        const stripped = escapeHtml(value).replaceAll(/&(?:amp|lt|gt|quot|#39);/g, "");
        expect(stripped).not.toContain("&");
      }),
    );
  });

  test("escaping is lossless: decoding the five entities restores the input", () => {
    fc.assert(
      fc.property(arbitraryText, value => {
        expect(decodeEntities(escapeHtml(value))).toBe(value);
      }),
    );
  });

  test("escapeHtmlAttribute upholds the same contract", () => {
    fc.assert(
      fc.property(arbitraryText, value => {
        expect(escapeHtmlAttribute(value)).not.toMatch(/[<>"']/);
      }),
    );
  });
});
