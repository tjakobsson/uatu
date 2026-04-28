import Asciidoctor from "@asciidoctor/core";
import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";

import { escapeHtml, highlightCodeBlocks, SYNTAX_HIGHLIGHT_BYTES_LIMIT } from "./markdown";

const asciidoctor = Asciidoctor();

// Asciidoctor wraps every [source,LANG] listing in
// `<pre class="highlight"><code class="language-X" data-lang="X">…</code></pre>`.
// Normalizing to the `<pre><code class="language-X">` shape that micromark
// already produces means the existing `highlightCodeBlocks` post-pass and the
// existing client-side `replaceMermaidCodeBlocks` both apply uniformly — the
// AsciiDoc-ness of a listing isn't visible past this normalization.
const ASCIIDOCTOR_LISTING_PATTERN =
  /<pre class="highlight"><code class="language-([^"]+)"[^>]*>([\s\S]*?)<\/code><\/pre>/g;

// Class names Asciidoctor emits on its structural wrappers that we want to
// preserve through sanitize so the minimal admonition/callout/listing CSS can
// target them. Anything not in this list survives only if hast-util-sanitize's
// default schema would have allowed it on the element.
const ALLOWED_ASCIIDOC_CLASSES = new Set([
  "admonitionblock",
  "note",
  "tip",
  "important",
  "caution",
  "warning",
  "listingblock",
  "literalblock",
  "title",
  "content",
  "icon",
  "paragraph",
  "sect1",
  "sect2",
  "sect3",
  "sect4",
  "sect5",
  "sectionbody",
  "preamble",
  "ulist",
  "olist",
  "dlist",
  "colist",
  "conum",
  "openblock",
  "exampleblock",
  "sidebarblock",
  "quoteblock",
  "verseblock",
  "tableblock",
  "imageblock",
  "stretch",
  "fit-content",
  "frame-all",
  "grid-all",
  "halign-left",
  "halign-center",
  "halign-right",
  "valign-top",
  "valign-middle",
  "valign-bottom",
  "bare",
  "include",
  // TOC (`:toc:` attribute) — Asciidoctor wraps it in `<div id="toc"
  // class="toc">` and the nested lists carry `class="sectlevelN"`.
  "toc",
  "sectlevel1",
  "sectlevel2",
  "sectlevel3",
  "sectlevel4",
  "sectlevel5",
  // Quote block author + citation line.
  "attribution",
]);

// Build the sanitize schema for AsciiDoc: start from the existing GitHub-modeled
// default, broaden the `className` allowlist on the elements Asciidoctor uses
// for structure, and pick up the Markdown sanitize allowances for `align`/etc.
// so README idioms shared between Markdown and AsciiDoc behave the same.
const sanitizeSchema: Schema = (() => {
  const baseAttributes = defaultSchema.attributes ?? {};
  const expandedClassName: Array<string | [string, ...Array<string | RegExp>]> = [
    [
      "className",
      ...ALLOWED_ASCIIDOC_CLASSES,
      // language-X for code listings (matches hljs's expectation later).
      /^language-/,
      // hljs-X tokens added by the highlight pass downstream.
      /^hljs/,
    ],
  ];

  // hast-util-sanitize keeps only the FIRST attribute rule that matches a
  // given attribute name, so our className allowlist must be prepended to
  // shadow the narrower one the default schema defines on some elements.
  const withClass = (existing: ReadonlyArray<string | [string, ...Array<string | RegExp>]> | undefined) => {
    return [...expandedClassName, ...(existing ?? [])];
  };

  return {
    ...defaultSchema,
    attributes: {
      ...baseAttributes,
      div: withClass(baseAttributes.div),
      pre: withClass(baseAttributes.pre),
      code: withClass(baseAttributes.code),
      span: withClass(baseAttributes.span),
      table: withClass(baseAttributes.table),
      tr: withClass(baseAttributes.tr),
      td: withClass(baseAttributes.td),
      th: withClass(baseAttributes.th),
      ul: withClass(baseAttributes.ul),
      ol: withClass(baseAttributes.ol),
      li: withClass(baseAttributes.li),
      dl: withClass(baseAttributes.dl),
      dt: withClass(baseAttributes.dt),
      dd: withClass(baseAttributes.dd),
      section: withClass(baseAttributes.section),
      a: withClass(baseAttributes.a),
      img: [
        ...(baseAttributes.img ?? []),
        "alt",
        "title",
        "width",
        "height",
      ],
      // The same `align` allowances the Markdown schema grants, so README
      // idioms render identically in both pipelines.
      p: [...(baseAttributes.p ?? []), "align"],
      h1: [...(baseAttributes.h1 ?? []), "align"],
      h2: [...(baseAttributes.h2 ?? []), "align"],
      h3: [...(baseAttributes.h3 ?? []), "align"],
      h4: [...(baseAttributes.h4 ?? []), "align"],
      h5: [...(baseAttributes.h5 ?? []), "align"],
      h6: [...(baseAttributes.h6 ?? []), "align"],
    },
  };
})();

export function renderAsciidocToHtml(source: string): string {
  // Match the Markdown size threshold: above the limit, skip Asciidoctor
  // entirely and render as plain escaped text so the browser stays responsive.
  if (source.length >= SYNTAX_HIGHLIGHT_BYTES_LIMIT) {
    return `<pre><code class="hljs">${escapeHtml(source)}</code></pre>`;
  }

  // SECURE matches GitHub's posture (no `include::`, no filesystem/URI reads,
  // no author-controlled `source-highlighter`/`docinfo`/`backend`). `showtitle`
  // emits the level-0 doctitle as <h1>. `relfilesuffix=.adoc` keeps the
  // author's extension on cross-document `xref:` and `<<>>` shorthand instead
  // of Asciidoctor's default `.html` rewrite.
  const rawHtml = asciidoctor.convert(source, {
    safe: "secure",
    standalone: false,
    attributes: { showtitle: true, relfilesuffix: ".adoc" },
  });

  const html = typeof rawHtml === "string" ? rawHtml : "";
  const normalized = normalizeAsciidoctorListings(html);
  const tree = fromHtml(normalized, { fragment: true });
  const safe = sanitize(tree, sanitizeSchema);
  return highlightCodeBlocks(rewriteInPageAnchors(toHtml(safe)));
}

// hast-util-sanitize prefixes element `id` attributes with `user-content-` to
// defend against id-collision attacks. Asciidoctor-generated TOC entries and
// `<<xref>>` cross-references write `href="#section"` against the bare id the
// author authored — so after sanitize prefixes the heading id, in-page jumps
// stop resolving. Mirror the prefix on in-page hrefs so navigation works while
// the prefix protection stays in place. Only `href="#X"` shapes are rewritten;
// `href="other.adoc#X"` and other cross-document fragments are left alone.
export function rewriteInPageAnchors(html: string): string {
  return html.replaceAll(/href="#([^"]+)"/g, (match, fragment: string) => {
    if (fragment.startsWith("user-content-")) {
      return match;
    }
    return `href="#user-content-${fragment}"`;
  });
}

export function normalizeAsciidoctorListings(html: string): string {
  return html.replaceAll(
    ASCIIDOCTOR_LISTING_PATTERN,
    (_match, language: string, body: string) => `<pre><code class="language-${language}">${body}</code></pre>`,
  );
}
