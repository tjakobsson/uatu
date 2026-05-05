import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import hljs from "highlight.js/lib/common";
import { micromark } from "micromark";
import { frontmatter, frontmatterHtml } from "micromark-extension-frontmatter";
import { gfm, gfmHtml } from "micromark-extension-gfm";

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

export function highlightCodeBlocks(html: string): string {
  return html.replaceAll(CODE_BLOCK_PATTERN, (match, language: string | undefined, body: string) => {
    if (language === "mermaid") {
      return match;
    }

    const source = decodeHtmlEntities(body);
    const highlighted = highlightSource(source, language);
    const classAttribute = highlighted.language
      ? ` class="hljs language-${escapeAttribute(highlighted.language)}"`
      : ' class="hljs"';

    return `<pre><code${classAttribute}>${highlighted.value}</code></pre>`;
  });
}

export type HighlightResult = { value: string; language: string | undefined };

export function highlightSource(source: string, language: string | undefined): HighlightResult {
  if (language && hljs.getLanguage(language)) {
    try {
      const result = hljs.highlight(source, { language, ignoreIllegals: true });
      return { value: result.value, language };
    } catch {
      // fall through to escaped source
    }
  }

  return { value: escapeHtml(source), language };
}

export function renderCodeAsHtml(source: string, language: string | undefined): string {
  if (source.length >= SYNTAX_HIGHLIGHT_BYTES_LIMIT) {
    return `<pre><code class="hljs">${escapeHtml(source)}</code></pre>`;
  }

  const highlighted = highlightSource(source, language);
  const classAttribute = highlighted.language
    ? ` class="hljs language-${escapeAttribute(highlighted.language)}"`
    : ' class="hljs"';
  return `<pre><code${classAttribute}>${highlighted.value}</code></pre>`;
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

function escapeAttribute(value: string): string {
  return value.replaceAll('"', "&quot;");
}
