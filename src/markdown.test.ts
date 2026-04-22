import { describe, expect, test } from "bun:test";

import { renderMarkdownToHtml } from "./markdown";

describe("renderMarkdownToHtml", () => {
  test("renders common GFM features", () => {
    const html = renderMarkdownToHtml(`| A | B |
| - | - |
| 1 | 2 |

- [x] done
- [ ] todo

Visit https://example.com and ~~remove~~ text.`);

    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>remove</del>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  test("preserves mermaid fenced blocks for client-side hydration", () => {
    const html = renderMarkdownToHtml("```mermaid\ngraph TD\n  A-->B\n```");

    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).toContain("graph TD");
    expect(html).not.toContain('class="hljs');
  });

  test("highlights known languages with github-style tokens", () => {
    const html = renderMarkdownToHtml("```js\nconst answer = 42;\n```");

    expect(html).toContain('<pre><code class="hljs language-js">');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");
  });

  test("falls back gracefully for unknown languages", () => {
    const html = renderMarkdownToHtml("```madeuplang\nnot a real language\n```");

    expect(html).toContain('<pre><code class="hljs');
    expect(html).toContain("not a real language");
    expect(html).not.toContain("hljs-keyword");
  });

  test("passes through GitHub-style inline HTML blocks (e.g. centered README hero)", () => {
    const html = renderMarkdownToHtml(
      `<p align="center">\n  <img src="./uato-logo.svg" alt="uatu logo" width="128" />\n</p>\n\n# uatu\n`,
    );

    expect(html).toContain('<p align="center">');
    expect(html).toContain('<img src="./uato-logo.svg"');
    expect(html).not.toContain("&lt;p align");
  });

  test("still escapes HTML inside fenced code blocks", () => {
    const html = renderMarkdownToHtml("```html\n<script>alert(1)</script>\n```");

    expect(html).toContain('<pre><code class="hljs');
    expect(html).not.toContain("<script>alert(1)</script>");
    // Either named (&lt;) or numeric (&#x3C;) — both are valid HTML escapes.
    expect(html).toMatch(/&(lt;|#x3[Cc];)/);
  });

  test("no executable <script> tag survives the pipeline", () => {
    const html = renderMarkdownToHtml("Hello\n\n<script>alert('xss')</script>\n\nWorld");

    // The opening "<" of <script> must be escaped (as &lt; or &#x3C;) so the
    // browser never parses it as a real script element. Literal text of the
    // script body may remain, but only as inert characters inside a paragraph.
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain("Hello");
    expect(html).toContain("World");
  });

  test("sanitizer strips inline event handlers", () => {
    const html = renderMarkdownToHtml('<img src="x" alt="x" onerror="alert(1)" />');

    expect(html).toContain("<img");
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain("alert(1)");
  });

  test("sanitizer strips javascript: URLs on anchors", () => {
    const html = renderMarkdownToHtml('<a href="javascript:alert(1)">click</a>');

    expect(html).not.toContain("javascript:");
  });

  test("leaves relative URLs in the rendered HTML untouched", () => {
    // With <base href> driving resolution in the browser, the server no longer
    // needs to rewrite the HTML — relative URLs stay as the author wrote them.
    const html = renderMarkdownToHtml(
      '<p><img src="./hero.svg" alt="hero" /></p>\n\n[docs](docs/intro.md) [abs](/abs) [ext](https://example.com) [anchor](#top)',
    );

    expect(html).toContain('src="./hero.svg"');
    expect(html).toContain('href="docs/intro.md"');
    expect(html).toContain('href="/abs"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#top"');
  });

  test("sanitizer keeps the centered-hero README idiom intact", () => {
    const html = renderMarkdownToHtml(
      `<p align="center">\n  <img src="./uato-logo.svg" alt="uatu logo" width="128" height="130" />\n</p>\n\n# uatu\n`,
    );

    expect(html).toContain('align="center"');
    expect(html).toContain('src="./uato-logo.svg"');
    expect(html).toMatch(/width="128"/);
    expect(html).toMatch(/height="130"/);
    expect(html).toContain('alt="uatu logo"');
  });
});
