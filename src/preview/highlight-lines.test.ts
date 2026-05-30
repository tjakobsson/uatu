import { describe, expect, test } from "bun:test";

import { closingTagFor, splitHighlightedLines } from "./highlight-lines";

// Strip tags to recover visible text — stands in for what the browser would
// expose as `.textContent` of a fragment.
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("closingTagFor", () => {
  test("derives the close tag from an opening tag", () => {
    expect(closingTagFor('<span class="hljs-comment">')).toBe("</span>");
    expect(closingTagFor("<span>")).toBe("</span>");
    expect(closingTagFor("<em>")).toBe("</em>");
  });
});

describe("splitHighlightedLines", () => {
  test("splits plain (un-spanned) text by line", () => {
    expect(splitHighlightedLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("a single line yields one fragment", () => {
    expect(splitHighlightedLines("just one line")).toEqual(["just one line"]);
  });

  test("a trailing newline yields a trailing empty fragment", () => {
    expect(splitHighlightedLines("a\nb\n")).toEqual(["a", "b", ""]);
  });

  test("reopens a span that crosses a newline (block comment)", () => {
    const html = '<span class="hljs-comment">/* line one\nline two */</span>';
    const lines = splitHighlightedLines(html);
    expect(lines).toEqual([
      '<span class="hljs-comment">/* line one</span>',
      '<span class="hljs-comment">line two */</span>',
    ]);
    // Each fragment is balanced (equal open/close span counts).
    for (const line of lines) {
      const opens = (line.match(/<span\b/g) ?? []).length;
      const closes = (line.match(/<\/span>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  test("handles a token spanning three lines", () => {
    const html = '<span class="hljs-string">`a\nb\nc`</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="hljs-string">`a</span>',
      '<span class="hljs-string">b</span>',
      '<span class="hljs-string">c`</span>',
    ]);
  });

  test("reopens nested spans across a newline", () => {
    const html = '<span class="a"><span class="b">x\ny</span>z</span>';
    const lines = splitHighlightedLines(html);
    expect(lines).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span>z</span>',
    ]);
  });

  test("does not split inside escaped entities", () => {
    // `&lt;` must not be mistaken for a tag, and contains no newline.
    const html = 'a &lt;tag&gt; b\nnext';
    expect(splitHighlightedLines(html)).toEqual(["a &lt;tag&gt; b", "next"]);
  });

  test("round-trips: stripping tags and joining by newline equals the source text", () => {
    const html =
      '<span class="hljs-keyword">const</span> x = <span class="hljs-comment">/* a\nb */</span> 1;\n' +
      '<span class="hljs-keyword">return</span> x;';
    const sourceText = "const x = /* a\nb */ 1;\nreturn x;";
    const reconstructed = splitHighlightedLines(html).map(stripTags).join("\n");
    expect(reconstructed).toBe(sourceText);
  });
});
