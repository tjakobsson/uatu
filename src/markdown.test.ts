import { describe, expect, test } from "bun:test";

import {
  renderCodeAsHtml,
  renderMarkdownToHtml,
  SYNTAX_HIGHLIGHT_BYTES_LIMIT,
} from "./markdown";

describe("renderMarkdownToHtml", () => {
  test("renders common GFM features", () => {
    const { html } = renderMarkdownToHtml(`| A | B |
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
    const { html } = renderMarkdownToHtml("```mermaid\ngraph TD\n  A-->B\n```");

    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).toContain("graph TD");
    expect(html).not.toContain('class="hljs');
  });

  test("highlights known languages with github-style tokens", () => {
    const { html } = renderMarkdownToHtml("```js\nconst answer = 42;\n```");

    expect(html).toContain('<pre><code class="hljs language-js">');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");
  });

  test("falls back gracefully for unknown languages", () => {
    const { html } = renderMarkdownToHtml("```madeuplang\nnot a real language\n```");

    expect(html).toContain('<pre><code class="hljs');
    expect(html).toContain("not a real language");
    expect(html).not.toContain("hljs-keyword");
  });

  test("passes through GitHub-style inline HTML blocks (e.g. centered README hero)", () => {
    const { html } = renderMarkdownToHtml(
      `<p align="center">\n  <img src="./uatu-logo.svg" alt="uatu logo" width="128" />\n</p>\n\n# uatu\n`,
    );

    expect(html).toContain('<p align="center">');
    expect(html).toContain('<img src="./uatu-logo.svg"');
    expect(html).not.toContain("&lt;p align");
  });

  test("still escapes HTML inside fenced code blocks", () => {
    const { html } = renderMarkdownToHtml("```html\n<script>alert(1)</script>\n```");

    expect(html).toContain('<pre><code class="hljs');
    expect(html).not.toContain("<script>alert(1)</script>");
    // Either named (&lt;) or numeric (&#x3C;) — both are valid HTML escapes.
    expect(html).toMatch(/&(lt;|#x3[Cc];)/);
  });

  test("no executable <script> tag survives the pipeline", () => {
    const { html } = renderMarkdownToHtml("Hello\n\n<script>alert('xss')</script>\n\nWorld");

    // The opening "<" of <script> must be escaped (as &lt; or &#x3C;) so the
    // browser never parses it as a real script element. Literal text of the
    // script body may remain, but only as inert characters inside a paragraph.
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain("Hello");
    expect(html).toContain("World");
  });

  test("sanitizer strips inline event handlers", () => {
    const { html } = renderMarkdownToHtml('<img src="x" alt="x" onerror="alert(1)" />');

    expect(html).toContain("<img");
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain("alert(1)");
  });

  test("sanitizer strips javascript: URLs on anchors", () => {
    const { html } = renderMarkdownToHtml('<a href="javascript:alert(1)">click</a>');

    expect(html).not.toContain("javascript:");
  });

  test("leaves relative URLs in the rendered HTML untouched", () => {
    // With <base href> driving resolution in the browser, the server no longer
    // needs to rewrite the HTML — relative URLs stay as the author wrote them.
    const { html } = renderMarkdownToHtml(
      '<p><img src="./hero.svg" alt="hero" /></p>\n\n[docs](docs/intro.md) [abs](/abs) [ext](https://example.com) [anchor](#top)',
    );

    expect(html).toContain('src="./hero.svg"');
    expect(html).toContain('href="docs/intro.md"');
    expect(html).toContain('href="/abs"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="#top"');
  });

  test("preserves cross-document Markdown links verbatim (no .md → .html rewrite)", () => {
    // Mirror the AsciiDoc cross-doc link regression: links to other Markdown
    // files MUST keep their `.md` extension so the in-app static fallback can
    // resolve them against the watched roots.
    const { html } = renderMarkdownToHtml(
      `# Index\n\nSee [Other](other.md) and [Setup](guides/setup.md).\n`,
    );
    expect(html).toContain('<a href="other.md">Other</a>');
    expect(html).toContain('<a href="guides/setup.md">Setup</a>');
    expect(html).not.toContain("other.html");
    expect(html).not.toContain("guides/setup.html");
  });

  test("sanitizer keeps the centered-hero README idiom intact", () => {
    const { html } = renderMarkdownToHtml(
      `<p align="center">\n  <img src="./uatu-logo.svg" alt="uatu logo" width="128" height="130" />\n</p>\n\n# uatu\n`,
    );

    expect(html).toContain('align="center"');
    expect(html).toContain('src="./uatu-logo.svg"');
    expect(html).toMatch(/width="128"/);
    expect(html).toMatch(/height="130"/);
    expect(html).toContain('alt="uatu logo"');
  });
});

describe("renderMarkdownToHtml frontmatter", () => {
  test("YAML frontmatter is parsed out of the body", () => {
    const { html, metadata } = renderMarkdownToHtml(
      `---\ntitle: My Doc\nauthor: Tobias\ndate: 2026-05-04\ntags: [api, draft]\nstatus: draft\n---\n\n# Heading\n\nBody.\n`,
    );
    // The leading `---` MUST NOT survive as a thematic break.
    expect(html).not.toMatch(/<hr\s*\/?>/);
    expect(html).not.toContain("title: My Doc");
    expect(html).toContain("<h1>Heading</h1>");
    expect(metadata).toBeDefined();
    expect(metadata?.title).toBe("My Doc");
    expect(metadata?.authors?.[0]?.name).toBe("Tobias");
    expect(metadata?.date).toBe("2026-05-04");
    expect(metadata?.tags).toEqual(["api", "draft"]);
    expect(metadata?.status).toBe("draft");
  });

  test("YAML block-array tags are normalized to a string list", () => {
    const { metadata } = renderMarkdownToHtml(
      `---\ntitle: T\ntags:\n  - alpha\n  - beta\n  - gamma\n---\n\n# T\n`,
    );
    expect(metadata?.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  test("TOML frontmatter is parsed out of the body", () => {
    const { html, metadata } = renderMarkdownToHtml(
      `+++\ntitle = "My Doc"\nauthor = "Tobias"\ndate = "2026-05-04"\ntags = ["api", "draft"]\n+++\n\n# Heading\n\nBody.\n`,
    );
    expect(html).not.toContain("+++");
    expect(html).not.toContain("title =");
    expect(html).toContain("<h1>Heading</h1>");
    expect(metadata).toBeDefined();
    expect(metadata?.title).toBe("My Doc");
    expect(metadata?.authors?.[0]?.name).toBe("Tobias");
    expect(metadata?.tags).toEqual(["api", "draft"]);
  });

  test("malformed frontmatter falls back to undefined metadata (no parse error)", () => {
    const { html, metadata } = renderMarkdownToHtml(
      `---\nthis: is\n  : not [valid]\n: yaml\n---\n\n# Body\n`,
    );
    expect(metadata).toBeUndefined();
    // The micromark frontmatter extension still consumes the block, so the
    // body is unaffected — no `<hr />` regression, no leaked `key: value`
    // text. The reader simply gets no metadata card.
    expect(html).toContain("<h1>Body</h1>");
    expect(html).not.toContain("this: is");
  });

  test("documents without frontmatter produce undefined metadata and unchanged body", () => {
    const { html, metadata } = renderMarkdownToHtml("# Hello\n\nWorld.\n");
    expect(metadata).toBeUndefined();
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>World.</p>");
  });

  test("unknown frontmatter fields land in extras", () => {
    const { metadata } = renderMarkdownToHtml(
      `---\ntitle: T\nslug: my-slug\npermalink: /docs/t\ncategory: reference\n---\n\nBody.\n`,
    );
    expect(metadata?.title).toBe("T");
    expect(metadata?.extras).toBeDefined();
    expect(metadata?.extras?.slug).toBe("my-slug");
    expect(metadata?.extras?.permalink).toBe("/docs/t");
    expect(metadata?.extras?.category).toBe("reference");
  });

  test("YAML curated alias keys map to the canonical field", () => {
    const { metadata } = renderMarkdownToHtml(
      `---\ntitle: T\nversion: 1.2\nkeywords: [a, b]\n---\n\nBody.\n`,
    );
    expect(metadata?.revision).toBe("1.2");
    expect(metadata?.tags).toEqual(["a", "b"]);
  });

  test("a leading `---` thematic break inside body content is unaffected", () => {
    const { html, metadata } = renderMarkdownToHtml(
      `# Title\n\nIntro paragraph.\n\n---\n\nMore content.\n`,
    );
    expect(metadata).toBeUndefined();
    expect(html).toMatch(/<hr\s*\/?>/);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("More content");
  });
});

describe("renderCodeAsHtml", () => {
  test("emits language-X class for known languages", () => {
    const html = renderCodeAsHtml("const answer = 42;\n", "javascript");
    expect(html).toContain('<pre><code class="hljs language-javascript">');
    expect(html).toContain("hljs-keyword");
  });

  test("omits language- class when language is undefined", () => {
    const html = renderCodeAsHtml("plain text\n", undefined);
    expect(html).toContain('<pre><code class="hljs">');
    expect(html).not.toContain("language-");
  });

  test("escapes raw HTML in the source so it never executes", () => {
    const html = renderCodeAsHtml("<script>alert(1)</script>\n", "javascript");
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toMatch(/&(lt;|#x3[Cc];)/);
  });

  test("bypasses syntax highlighting above the size threshold", () => {
    const big = "a".repeat(SYNTAX_HIGHLIGHT_BYTES_LIMIT + 1);
    const html = renderCodeAsHtml(big, "javascript");
    expect(html).toContain('<pre><code class="hljs">');
    expect(html).not.toContain("hljs-");
    expect(html).not.toContain("language-javascript");
  });
});
