import { describe, expect, test } from "bun:test";

import {
  isCodeHighlighterReady,
  preloadCodeHighlighter,
  requireCodeHighlighter,
} from "./highlighter";

describe("preloadCodeHighlighter", () => {
  test("resolves and leaves the highlighter in the ready state", async () => {
    await preloadCodeHighlighter();
    expect(isCodeHighlighterReady()).toBe(true);
  });

  test("subsequent calls share the same in-flight promise (idempotent)", async () => {
    const a = preloadCodeHighlighter();
    const b = preloadCodeHighlighter();
    expect(a).toBe(b);
    await Promise.all([a, b]);
  });

  test("requireCodeHighlighter returns a Shiki highlighter once preload resolves", async () => {
    await preloadCodeHighlighter();
    const h = requireCodeHighlighter();
    // Smoke: the configured light theme renders a TypeScript snippet
    // synchronously. Confirms the language and theme were attached during the
    // preload, so request-time rendering pays no grammar-load cost.
    const html = h.codeToHtml("const x: number = 1;", {
      lang: "typescript",
      theme: "github-light-default",
    });
    expect(html).toContain("<pre");
    expect(html).toContain("</pre>");
  });
});
