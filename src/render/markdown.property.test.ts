import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fromHtml } from "hast-util-from-html";

import { renderMarkdownToHtml } from "./markdown";

// Property-based: the render pipeline accepts untrusted documents, so its
// sanitizer contract must hold for arbitrary source — not just well-formed
// Markdown. Violations are checked on the parsed tree rather than with
// regexes so text content that merely *mentions* "onclick" or "javascript:"
// cannot false-positive.

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function collectUnsafeMarkup(html: string): string[] {
  const violations: string[] = [];
  const walk = (node: HastNode): void => {
    if (node.type === "element") {
      if (node.tagName === "script") {
        violations.push("script element");
      }
      for (const [name, value] of Object.entries(node.properties ?? {})) {
        if (/^on/i.test(name)) {
          violations.push(`event handler ${name}`);
        }
        if (
          (name === "href" || name === "src") &&
          typeof value === "string" &&
          /^\s*javascript:/i.test(value)
        ) {
          violations.push(`javascript: URL in ${name}`);
        }
      }
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(fromHtml(html, { fragment: true }) as unknown as HastNode);
  return violations;
}

const arbitraryText = fc.oneof(fc.string(), fc.string({ unit: "binary" }));

// Adversarial source: arbitrary text interleaved with fragments chosen to
// probe the sanitizer (raw HTML passthrough, event handlers, script URLs).
const adversarialSource = fc
  .array(
    fc.oneof(
      arbitraryText,
      fc.constantFrom(
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(1)">',
        "[click](javascript:alert(1))",
        '<a href="javascript:alert(1)">x</a>',
        "<svg onload=alert(1)>",
        "```",
        "---",
        '"><',
        "&lt;script&gt;",
      ),
    ),
    { maxLength: 8 },
  )
  .map(parts => parts.join(""));

describe("renderMarkdownToHtml properties", () => {
  test("rendering arbitrary source never throws", () => {
    fc.assert(
      fc.property(arbitraryText, source => {
        renderMarkdownToHtml(source);
      }),
    );
  });

  test("no script-capable markup survives sanitization of arbitrary source", () => {
    fc.assert(
      fc.property(adversarialSource, source => {
        const { html } = renderMarkdownToHtml(source);
        expect(collectUnsafeMarkup(html)).toEqual([]);
      }),
    );
  });
});
