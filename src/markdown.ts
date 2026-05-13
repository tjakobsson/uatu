import type { BundledLanguage } from "@pierre/diffs";
import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { micromark } from "micromark";
import { frontmatter, frontmatterHtml } from "micromark-extension-frontmatter";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import {
  renderInlineCode,
  renderWholeFileCode,
  type WholeFileRender,
} from "./code-render";
import {
  type DocumentMetadata,
  normalizeMetadata,
  parseSimpleToml,
  parseSimpleYaml,
} from "./document-metadata";

const CODE_BLOCK_PATTERN = /<pre><code(?:\s+class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g;

export const SYNTAX_HIGHLIGHT_BYTES_LIMIT = 1_048_576;

// Start from hast-util-sanitize's default schema (modeled on GitHub's allowlist)
// and extend it with the README idioms GitHub also permits but which aren't in
// the base default: `align` on block elements, and `alt`/`title`/`width`/`height`
// on `<img>` so inline image sizing survives.
const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    p: [...(defaultSchema.attributes?.p ?? []), "align"],
    div: [...(defaultSchema.attributes?.div ?? []), "align"],
    h1: [...(defaultSchema.attributes?.h1 ?? []), "align"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "align"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "align"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "align"],
    h5: [...(defaultSchema.attributes?.h5 ?? []), "align"],
    h6: [...(defaultSchema.attributes?.h6 ?? []), "align"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "alt",
      "title",
      "align",
      "width",
      "height",
    ],
    table: [...(defaultSchema.attributes?.table ?? []), "align"],
    th: [...(defaultSchema.attributes?.th ?? []), "align"],
    td: [...(defaultSchema.attributes?.td ?? []), "align"],
    tr: [...(defaultSchema.attributes?.tr ?? []), "align"],
  },
};

// Match the leading `---\n…\n---` (YAML) or `+++\n…\n+++` (TOML) block at
// document start. The closing fence must be followed by a newline or EOF so a
// document that opens with a thematic-break-shaped paragraph (e.g.
// `---\nfoo\n--- bar`) does not get misread as frontmatter.
const FRONTMATTER_PATTERN = /^(---|\+{3})\r?\n([\s\S]*?)\r?\n\1(?:\r?\n|$)/;

export type RenderedMarkdown = {
  html: string;
  metadata: DocumentMetadata | undefined;
};

export function renderMarkdownToHtml(source: string): RenderedMarkdown {
  const metadata = extractMarkdownMetadata(source);

  // micromark-extension-frontmatter consumes the leading frontmatter block from
  // the token stream so it never lands in body HTML — even when our local
  // metadata extractor decides the block is malformed and bails out. We still
  // pass the original source through so micromark sees the leading delimiter
  // it knows how to consume; downstream we only surface metadata when our own
  // parser succeeded.
  const rawHtml = micromark(source, {
    allowDangerousHtml: true,
    extensions: [gfm(), frontmatter(["yaml", "toml"])],
    htmlExtensions: [gfmHtml(), frontmatterHtml(["yaml", "toml"])],
  });

  const tree = fromHtml(rawHtml, { fragment: true });
  const safe = sanitize(tree, sanitizeSchema);
  return { html: highlightCodeBlocks(toHtml(safe)), metadata };
}

function extractMarkdownMetadata(source: string): DocumentMetadata | undefined {
  const match = source.match(FRONTMATTER_PATTERN);
  if (!match) {
    return undefined;
  }
  const fence = match[1]!;
  const body = match[2] ?? "";

  const raw = fence === "---" ? parseSimpleYaml(body) : parseSimpleToml(body);
  if (!raw) {
    return undefined;
  }
  return normalizeMetadata(raw, fence === "---" ? "yaml" : "toml");
}

// Post-sanitize string pass: replace each `<pre><code class="language-X">…</code></pre>`
// block produced by micromark / sanitize with the same block re-emitted with
// Shiki syntax highlighting. Mermaid blocks short-circuit so the
// client-side `replaceMermaidCodeBlocks` pass can still identify them by the
// `language-mermaid` info string.
export function highlightCodeBlocks(html: string): string {
  return html.replaceAll(CODE_BLOCK_PATTERN, (match, language: string | undefined, body: string) => {
    if (language === "mermaid") {
      return match;
    }
    const source = decodeHtmlEntities(body);
    return renderInlineCode(source, normalizeLanguage(language));
  });
}

function normalizeLanguage(language: string | undefined): BundledLanguage | undefined {
  if (!language) {
    return undefined;
  }
  // The supported-language set is enumerated in src/file-languages.ts. Anything
  // not in Shiki's BundledLanguage falls through to plain-text rendering inside
  // renderInlineCode (which accepts the `'text'` escape hatch).
  return language as BundledLanguage;
}

// Render an entire file's source as the source-view code region. The output is
// `@pierre/diffs`'s File-component HTML — a `<pre data-file>` containing per-line
// `<div data-line="N">` elements plus a sibling gutter — wrapped in a host
// `<div class="uatu-source-pre">` so the Selection Inspector can identify the
// whole-file region uniformly (it keys off this class).
//
// Returns both the HTML (for innerHTML mounting) and the FileContents shape the
// browser needs to hand to `File.hydrate()` to attach interactivity.
export async function renderCodeAsHtml(
  name: string,
  source: string,
  language: BundledLanguage | undefined,
): Promise<WholeFileRender> {
  if (source.length >= SYNTAX_HIGHLIGHT_BYTES_LIMIT) {
    // Over the size cap: skip highlighting entirely and emit verbatim text in a
    // plain `<pre>` so the browser stays responsive. Hydration is unnecessary
    // because there is no token markup to attach interactivity to.
    return {
      html: `<div class="uatu-source-pre uatu-source-pre--plain"><pre><code>${escapeHtml(source)}</code></pre></div>`,
      hydration: { name, contents: source, lang: undefined },
    };
  }
  const rendered = await renderWholeFileCode(name, source, language);
  return {
    html: `<div class="uatu-source-pre">${rendered.html}</div>`,
    hydration: rendered.hydration,
  };
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
