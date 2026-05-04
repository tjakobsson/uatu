import Asciidoctor from "@asciidoctor/core";
import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";

import {
  type DocumentMetadata,
  type DocumentMetadataAuthor,
  type RawMetadataValue,
  isAsciidocInternalAttribute,
  normalizeMetadata,
} from "./document-metadata";
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

export type RenderedAsciidoc = {
  html: string;
  metadata: DocumentMetadata | undefined;
};

export function renderAsciidocToHtml(source: string): RenderedAsciidoc {
  // Match the Markdown size threshold: above the limit, skip Asciidoctor
  // entirely and render as plain escaped text so the browser stays responsive.
  if (source.length >= SYNTAX_HIGHLIGHT_BYTES_LIMIT) {
    return {
      html: `<pre><code class="hljs">${escapeHtml(source)}</code></pre>`,
      metadata: undefined,
    };
  }

  // SECURE matches GitHub's posture (no `include::`, no filesystem/URI reads,
  // no author-controlled `source-highlighter`/`docinfo`/`backend`). `showtitle`
  // emits the level-0 doctitle as <h1>. `relfilesuffix=.adoc` keeps the
  // author's extension on cross-document `xref:` and `<<>>` shorthand instead
  // of Asciidoctor's default `.html` rewrite.
  //
  // We split `convert()` into `load()` + `doc.convert()` so the parsed
  // Document model is available for metadata extraction. The two-step form
  // produces byte-identical body HTML — `convert()` is implemented as a
  // load+convert pair internally.
  const doc = asciidoctor.load(source, {
    safe: "secure",
    standalone: false,
    attributes: { showtitle: true, relfilesuffix: ".adoc" },
  });
  const rawHtml = doc.convert();

  const html = typeof rawHtml === "string" ? rawHtml : "";
  const normalized = normalizeAsciidoctorListings(html);
  const tree = fromHtml(normalized, { fragment: true });
  const safe = sanitize(tree, sanitizeSchema);
  return {
    html: highlightCodeBlocks(rewriteInPageAnchors(toHtml(safe))),
    metadata: extractAsciidocMetadata(doc),
  };
}

// Asciidoctor exposes the document title via `getDocumentTitle()` and every
// header attribute via `getAttributes()`. Authors are surfaced as numbered
// `author_N` / `email_N` keys on the attribute map (1-indexed, with
// `authorcount` declaring how many were declared). We use the attribute map
// directly rather than `getAuthors()` because the latter returns Opal-wrapped
// objects whose property access is brittle across Asciidoctor versions.
function extractAsciidocMetadata(doc: ReturnType<Asciidoctor["load"]>): DocumentMetadata | undefined {
  const attrs = doc.getAttributes() as Record<string, unknown>;
  const raw: Record<string, RawMetadataValue> = {};

  const authors = collectAsciidocAuthors(attrs);
  if (authors.length > 0) {
    raw.authors = authors;
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== "string" || value === "") {
      continue;
    }
    if (isAsciidocAuthorAttribute(key)) {
      continue;
    }
    if (key === "doctitle" || key === "title") {
      // The doctitle is surfaced explicitly below via `getDocumentTitle()`.
      // Asciidoctor also exposes the same string under `:title:` and
      // `:doctitle:` — skip both so they don't shadow our explicit value.
      continue;
    }
    if (isAsciidocInternalAttribute(key)) {
      // Filter Asciidoctor's runtime defaults (caption labels, doctype/safe
      // mode metadata, asset-directory paths, etc.) at this layer so the
      // "is there any author metadata?" check below can decide cleanly
      // without the internals padding the count.
      continue;
    }
    raw[key] = value;
  }

  // Title is "secondary" for AsciiDoc: every `.adoc` file authored as a
  // document declares one (`= Heading` is the conventional opener), and the
  // body already renders that heading as `<h1>`. Surfacing a card with ONLY
  // a title would mean every existing fixture suddenly grows a card without
  // any other useful information — duplicating what the heading already shows.
  // So we only include the title when at least one other metadata field is
  // present, mirroring the design's "card is editorial, not archival" stance.
  if (Object.keys(raw).length > 0) {
    const title = doc.getDocumentTitle();
    if (typeof title === "string" && title.trim() !== "") {
      raw.title = title;
    }
  }

  return normalizeMetadata(raw, "asciidoc");
}

function collectAsciidocAuthors(attrs: Record<string, unknown>): DocumentMetadataAuthor[] {
  const countRaw = attrs.authorcount;
  const count = typeof countRaw === "number" ? countRaw : Number.parseInt(String(countRaw ?? "0"), 10);
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const authors: DocumentMetadataAuthor[] = [];
  for (let index = 1; index <= count; index += 1) {
    // For a single-author document declared via `:author:` (rather than the
    // positional second line), Asciidoctor sets `author` / `email` but does
    // NOT set `author_1` / `email_1`. Fall back to the bare keys when the
    // numbered ones are absent.
    const nameRaw =
      attrs[`author_${index}`] ?? (index === 1 ? attrs.author : undefined);
    if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
      continue;
    }
    const emailRaw =
      attrs[`email_${index}`] ?? (index === 1 ? attrs.email : undefined);
    authors.push(
      typeof emailRaw === "string" && emailRaw.trim() !== ""
        ? { name: nameRaw.trim(), email: emailRaw.trim() }
        : { name: nameRaw.trim() },
    );
  }
  return authors;
}

const ASCIIDOC_AUTHOR_ATTR_PREFIXES = ["author", "email", "firstname", "middlename", "lastname", "authorinitials"];

function isAsciidocAuthorAttribute(key: string): boolean {
  // We've already populated `raw.authors` from the numbered `author_N` /
  // `email_N` family before reaching the attribute loop, so every author-
  // related key is filtered out here to keep them from re-appearing as
  // extras. `authorcount` is internal scaffolding and never reaches the card.
  if (key === "authors" || key === "authorcount") {
    return true;
  }
  return ASCIIDOC_AUTHOR_ATTR_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}_`));
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
