import { describe, expect, test } from "bun:test";

import { normalizeAsciidoctorListings, renderAsciidocToHtml, rewriteInPageAnchors } from "./asciidoc";
import { SYNTAX_HIGHLIGHT_BYTES_LIMIT } from "./markdown";
import { replaceMermaidCodeBlocks } from "./preview";

describe("renderAsciidocToHtml", () => {
  test("renders the level-0 doctitle as <h1>", () => {
    const html = renderAsciidocToHtml(`= Document Title\n\nBody.\n`);
    expect(html).toContain("<h1>Document Title</h1>");
  });

  test("maps AsciiDoc heading depth to <h1>–<h6>", () => {
    const html = renderAsciidocToHtml(`= L0

== L1

=== L2

==== L3

===== L4

====== L5
`);
    // Doctitle → h1; each `=` adds one heading level.
    expect(html).toContain("<h1>L0</h1>");
    expect(html).toMatch(/<h2[^>]*>L1<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>L2<\/h3>/);
    expect(html).toMatch(/<h4[^>]*>L3<\/h4>/);
    expect(html).toMatch(/<h5[^>]*>L4<\/h5>/);
    expect(html).toMatch(/<h6[^>]*>L5<\/h6>/);
  });

  test("renders a Table of Contents whose links resolve to (prefixed) heading ids", () => {
    const html = renderAsciidocToHtml(`= Doc
:toc:

== Alpha

== Bravo

== Charlie
`);
    expect(html).toContain("Table of Contents");
    // Hrefs are user-content-prefixed so they match the (also-prefixed)
    // heading ids — without this rewrite, clicking a TOC entry doesn't
    // navigate.
    expect(html).toContain('href="#user-content-_alpha"');
    expect(html).toContain('href="#user-content-_bravo"');
    expect(html).toContain('href="#user-content-_charlie"');
    expect(html).toContain('id="user-content-_alpha"');
  });

  test("cross-references via <<id>> render as anchor links that match their target id", () => {
    const html = renderAsciidocToHtml(`[#target]
== Target Section

See <<target>> for details.
`);
    expect(html).toMatch(/<a[^>]*href="#user-content-target"[^>]*>/);
    expect(html).toMatch(/id="user-content-target"/);
  });

  test("renders sections, lists, and tables as formatted HTML", () => {
    const html = renderAsciidocToHtml(`= Doc

== Section A

* item one
* item two

|===
| A | B
| 1 | 2
|===
`);
    expect(html).toContain("<h2");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table");
    expect(html).toContain("item one");
  });

  test("preserves the admonition kind class for styling", () => {
    const html = renderAsciidocToHtml(`NOTE: be careful\n`);
    expect(html).toContain("admonitionblock");
    expect(html).toContain("note");
  });

  test("emits highlight.js token coloring for [source,LANG] listings", () => {
    const html = renderAsciidocToHtml(`[source,javascript]
----
const answer = 42;
----
`);
    expect(html).toContain('<pre><code class="hljs language-javascript">');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");
  });

  test("[source,mermaid] survives as a language-mermaid code block (client-side hydration)", () => {
    const html = renderAsciidocToHtml(`[source,mermaid]
----
graph TD; A-->B
----
`);
    // The renderer leaves it as a plain language-mermaid block; the client-side
    // replaceMermaidCodeBlocks handler then hydrates it into a <div class="mermaid">.
    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).not.toContain("hljs-");

    const hydrated = replaceMermaidCodeBlocks(html);
    expect(hydrated).toContain('<div class="mermaid">');
    expect(hydrated).toContain("graph TD");
  });

  test("bare [mermaid] block (no source style) renders as a literal block — matches GitHub", () => {
    // GitHub does NOT recognize the bare [mermaid] form; we follow that.
    const html = renderAsciidocToHtml(`[mermaid]
....
graph TD; X-->Y
....
`);
    // No language-mermaid class to trigger the diagram path.
    expect(html).not.toContain("language-mermaid");
    // Stays as a literal pre.
    expect(html).toContain("literalblock");
    expect(html).toContain("graph TD;");

    const hydrated = replaceMermaidCodeBlocks(html);
    expect(hydrated).not.toContain('<div class="mermaid">');
  });

  test("falls back gracefully for unknown source languages", () => {
    const html = renderAsciidocToHtml(`[source,madeuplang]
----
not a real language
----
`);
    expect(html).toContain('<pre><code class="hljs');
    expect(html).toContain("not a real language");
    expect(html).not.toContain("hljs-keyword");
  });

  test("include:: directives are not resolved under SECURE safe mode", () => {
    const html = renderAsciidocToHtml(`include::secret-file.adoc[]\n`);
    // Asciidoctor in secure mode renders the include as a clickable link; it
    // does NOT read or embed the referenced file's contents.
    expect(html).not.toContain("CONTENTS_OF_OTHER_FILE");
    // The include marker becomes a bare link to the unresolved target.
    expect(html.toLowerCase()).toContain("secret-file.adoc");
  });

  test("strips <script> emitted via inline passthrough", () => {
    const html = renderAsciidocToHtml(`pass:[<script>alert(1)</script>]\n`);
    expect(html).not.toMatch(/<script\b/i);
  });

  test("strips inline event handlers on passthrough HTML", () => {
    const html = renderAsciidocToHtml(`pass:[<img src="x" alt="x" onerror="alert(1)">]\n`);
    expect(html).toContain("<img");
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain("alert(1)");
  });

  test("strips javascript: URLs on links", () => {
    const html = renderAsciidocToHtml(`link:javascript:alert(1)[click]\n`);
    expect(html).not.toContain("javascript:");
  });

  test("source listings inside fenced delimiters keep raw HTML literal", () => {
    const html = renderAsciidocToHtml(`[source,html]
----
<script>alert(1)</script>
----
`);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toMatch(/&(lt;|#x3[Cc];)/);
  });

  test("bypasses Asciidoctor and emits plain text above the size threshold", () => {
    const big = "= title\n\n" + "x".repeat(SYNTAX_HIGHLIGHT_BYTES_LIMIT);
    const html = renderAsciidocToHtml(big);
    expect(html.startsWith('<pre><code class="hljs">')).toBe(true);
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("admonitionblock");
  });
});

describe("renderAsciidocToHtml cross-document links", () => {
  // Asciidoctor's default `xref:other.adoc[]` rewrites the extension to the
  // configured output suffix (`.html`). The preview spec requires preserving
  // the author's `href` verbatim — the in-app static-file fallback resolves
  // those URLs against the watched roots, where the actual file is `.adoc`.
  // Set `relfilesuffix=.adoc` so cross-doc xrefs keep their extension.

  test("xref to a sibling .adoc file preserves the .adoc extension", () => {
    const html = renderAsciidocToHtml(`= Index\n\nxref:other.adoc[Other doc]\n`);
    expect(html).toContain('<a href="other.adoc">Other doc</a>');
    expect(html).not.toContain("other.html");
  });

  test("xref into a subdirectory preserves the relative path", () => {
    const html = renderAsciidocToHtml(`= Index\n\nxref:guides/setup.adoc[Setup]\n`);
    expect(html).toContain('<a href="guides/setup.adoc">Setup</a>');
    expect(html).not.toContain("guides/setup.html");
  });

  test("xref with a fragment preserves the .adoc extension and the fragment", () => {
    const html = renderAsciidocToHtml(`= Index\n\nxref:other.adoc#section[Other]\n`);
    expect(html).toContain('<a href="other.adoc#section">Other</a>');
    expect(html).not.toContain("other.html");
  });

  test("<<other.adoc#sec,Title>> shorthand preserves the .adoc extension", () => {
    const html = renderAsciidocToHtml(`= Index\n\n<<other.adoc#section,Other>>\n`);
    expect(html).toContain('<a href="other.adoc#section">Other</a>');
    expect(html).not.toContain("other.html");
  });

  test("link: macro to a sibling .adoc file preserves the extension", () => {
    const html = renderAsciidocToHtml(`= Index\n\nlink:other.adoc[Other]\n`);
    expect(html).toContain('<a href="other.adoc">Other</a>');
    expect(html).not.toContain("other.html");
  });

  test("xref to a sibling .asciidoc file preserves the .asciidoc extension", () => {
    const html = renderAsciidocToHtml(`= Index\n\nxref:other.asciidoc[Other]\n`);
    expect(html).toContain('<a href="other.asciidoc">Other</a>');
    expect(html).not.toContain("other.html");
  });

  test("bare xref:id[] still resolves as an in-page anchor (no extension to preserve)", () => {
    // With no extension hint Asciidoctor treats the target as an in-document
    // anchor reference; rewriteInPageAnchors then prefixes it with
    // `user-content-` to mirror sanitize's id namespacing.
    const html = renderAsciidocToHtml(`= Doc\n\nxref:target[Jump]\n\n[[target]]\n== Target\n`);
    expect(html).toContain('href="#user-content-target"');
    expect(html).not.toContain("target.html");
  });

  test("external link is not affected by the .adoc preservation rule", () => {
    const html = renderAsciidocToHtml(`= T\n\nlink:https://example.com[Example]\n`);
    expect(html).toContain('<a href="https://example.com">Example</a>');
  });
});

describe("normalizeAsciidoctorListings", () => {
  test("rewrites Asciidoctor's listing wrapper into the Markdown-shaped pre/code", () => {
    const input =
      '<pre class="highlight"><code class="language-yaml" data-lang="yaml">key: value</code></pre>';
    const output = normalizeAsciidoctorListings(input);
    expect(output).toBe('<pre><code class="language-yaml">key: value</code></pre>');
  });

  test("leaves non-listing pre/code blocks alone (literal blocks, etc.)", () => {
    const input = "<pre>plain</pre>";
    expect(normalizeAsciidoctorListings(input)).toBe(input);
  });
});

describe("rewriteInPageAnchors", () => {
  test("prefixes bare in-page hrefs to match sanitize's user-content- id prefix", () => {
    expect(rewriteInPageAnchors('<a href="#section">x</a>')).toBe(
      '<a href="#user-content-section">x</a>',
    );
  });

  test("does not rewrite cross-document fragments (other.adoc#section)", () => {
    const input = '<a href="other.adoc#section">x</a>';
    expect(rewriteInPageAnchors(input)).toBe(input);
  });

  test("does not double-prefix already-prefixed hrefs", () => {
    const input = '<a href="#user-content-section">x</a>';
    expect(rewriteInPageAnchors(input)).toBe(input);
  });

  test("does not touch external URLs", () => {
    const input = '<a href="https://example.com">x</a>';
    expect(rewriteInPageAnchors(input)).toBe(input);
  });
});
