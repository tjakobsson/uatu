import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import hljs from "highlight.js/lib/common";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

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

export function renderMarkdownToHtml(source: string): string {
  const rawHtml = micromark(source, {
    allowDangerousHtml: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });

  const tree = fromHtml(rawHtml, { fragment: true });
  const safe = sanitize(tree, sanitizeSchema);
  return highlightCodeBlocks(toHtml(safe));
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
