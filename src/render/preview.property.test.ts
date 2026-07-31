import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fromHtml } from "hast-util-from-html";

import { renderMarkdownToHtml } from "./markdown";
import { replaceMermaidCodeBlocks } from "./preview";

// Property-based: mermaid fences carry untrusted diagram source that is
// later written via `innerHTML` and parsed client-side. The invariant is
// that the escaping applied by the Markdown pipeline survives the
// code-block → div rewrite: whatever the author wrote, a `div.mermaid`
// may contain only text — never elements smuggled in by the rewrite.

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function mermaidDivViolations(html: string): string[] {
  const violations: string[] = [];
  const walk = (node: HastNode): void => {
    if (node.type === "element") {
      if (node.tagName === "script") {
        violations.push("script element");
      }
      const className = node.properties?.className;
      const isMermaidDiv =
        node.tagName === "div" && Array.isArray(className) && className.includes("mermaid");
      if (isMermaidDiv) {
        for (const child of node.children ?? []) {
          if (child.type !== "text") {
            violations.push(`non-text node <${child.tagName ?? child.type}> inside div.mermaid`);
          }
        }
        return;
      }
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(fromHtml(html, { fragment: true }) as unknown as HastNode);
  return violations;
}

const arbitraryDiagramSource = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc
    .array(
      fc.oneof(
        fc.string(),
        fc.constantFrom(
          "</code></pre>",
          "<script>alert(1)</script>",
          '<div class="mermaid">',
          "<img src=x onerror=alert(1)>",
          "graph TD; A-->B;",
        ),
      ),
      { maxLength: 6 },
    )
    .map(parts => parts.join("")),
);

describe("replaceMermaidCodeBlocks properties", () => {
  test("arbitrary mermaid source cannot smuggle elements into the hydration div", () => {
    fc.assert(
      fc.property(arbitraryDiagramSource, source => {
        const { html } = renderMarkdownToHtml("```mermaid\n" + source + "\n```");
        expect(mermaidDivViolations(replaceMermaidCodeBlocks(html))).toEqual([]);
      }),
    );
  });
});
