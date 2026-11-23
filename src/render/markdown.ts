import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import hljs from "highlight.js/lib/common";
import { compile, parse, postprocess, preprocess } from "micromark";
import { frontmatter, frontmatterHtml } from "micromark-extension-frontmatter";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import {
  type DocumentMetadata,
  normalizeMetadata,
  parseSimpleToml,
  parseSimpleYaml,
} from "../document/metadata";
import { MARKDOWN_CODE_ATTRIBUTE } from "../shared/code-copy";
import { markExternalAnchors } from "./external-links";

declare module "micromark-util-types" {
  interface TokenTypeMap { markdownCodeOrigin: "markdownCodeOrigin" }
}
declare module "hast" {
  interface ElementData { markdownCodeBlock?: boolean }
}

const CODE_BLOCK_PATTERN = new RegExp(
  `<pre((?:\\s+${MARKDOWN_CODE_ATTRIBUTE}(?:="")?)?)><code(?:\\s+class="language-([^"]+)")?>([\\s\\S]*?)<\\/code><\\/pre>`,
  "g",
);

export const SYNTAX_HIGHLIGHT_BYTES_LIMIT = 1_048_576;

// Shared by document and chat Markdown. Start from hast-util-sanitize's default
// schema (modeled on GitHub's allowlist)
// and extend it with the README idioms GitHub also permits but which aren't in
// the base default: `align` on block elements, and `alt`/`title`/`width`/`height`
// on `<img>` so inline image sizing survives.
export const markdownSanitizeSchema: Schema = {
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
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "rel",
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
  const { html: rawHtml, preOffsets } = compileMarkedMarkdown(source);

  const tree = fromHtml(rawHtml, { fragment: true });
  markMarkdownCodeBlocks(tree, preOffsets);
  const safe = sanitize(tree, markdownSanitizeSchema);
  if (safe.type === "root") applyMarkdownCodeAttribute(safe);
  markExternalAnchors(safe);
  return { html: highlightCodeBlocks(toHtml(safe)), metadata };
}

type HtmlNode = ReturnType<typeof fromHtml>["children"][number];
type MarkdownEvent = ReturnType<typeof postprocess>[number];

function compileMarkedMarkdown(source: string): { html: string; preOffsets: Set<number> } {
  const events = postprocess(
    parse({ extensions: [gfm(), frontmatter(["yaml", "toml"])] })
      .document()
      .write(preprocess()(source, undefined, true)),
  );
  // Lone UTF-16 surrogates cannot be produced by Markdown entity decoding
  // (which replaces surrogate code points with U+FFFD), and scanning `source`
  // guarantees the sentinel never collides with literal input. Stripping it
  // before `fromHtml` records exact `<pre>` offsets (including across reordered
  // GFM footnote buffers) without ever passing a marker to the HTML parser.
  let suffix = 0;
  let sentinel = `\uD800uatu-pre-${suffix}\uD801`;
  while (source.includes(sentinel)) {
    suffix += 1;
    sentinel = `\uD800uatu-pre-${suffix}\uD801`;
  }

  const wrapped: MarkdownEvent[] = [];
  const wrappers = new Map<MarkdownEvent[1], MarkdownEvent[1]>();
  for (const [event, token, context] of events) {
    if (event === "enter" && (token.type === "codeFenced" || token.type === "codeIndented")) {
      const wrapper = { ...token, type: "markdownCodeOrigin" as const };
      wrappers.set(token, wrapper);
      wrapped.push(["enter", wrapper, context]);
    }
    wrapped.push([event, token, context]);
    if (event === "exit" && wrappers.has(token)) {
      wrapped.push(["exit", wrappers.get(token)!, context]);
    }
  }
  const markedHtml = compile({
    allowDangerousHtml: true,
    htmlExtensions: [gfmHtml(), frontmatterHtml(["yaml", "toml"]), {
      enter: {
        markdownCodeOrigin() {
          this.lineEndingIfNeeded();
          this.buffer();
        },
      },
      exit: {
        markdownCodeOrigin() {
          let chunk = this.resume();
          const position = chunk.indexOf("<pre");
          if (position !== -1) {
            chunk = `${chunk.slice(0, position)}${sentinel}${chunk.slice(position)}`;
          }
          const lastWasTag = this.getData("lastWasTag");
          this.raw(chunk);
          this.setData("lastWasTag", lastWasTag);
        },
      },
    }],
  })(wrapped);

  const preOffsets = new Set<number>();
  if (!markedHtml.includes(sentinel)) return { html: markedHtml, preOffsets };
  const parts: string[] = [];
  let cursor = 0;
  let cleanLength = 0;
  while (true) {
    const index = markedHtml.indexOf(sentinel, cursor);
    if (index === -1) break;
    const segment = markedHtml.slice(cursor, index);
    parts.push(segment);
    cleanLength += segment.length;
    preOffsets.add(cleanLength);
    cursor = index + sentinel.length;
  }
  parts.push(markedHtml.slice(cursor));
  return { html: parts.join(""), preOffsets };
}

function markMarkdownCodeBlocks(parent: { children: HtmlNode[] }, preOffsets: ReadonlySet<number>): void {
  if (preOffsets.size === 0) return;
  for (const node of parent.children) {
    if (node.type !== "element") continue;
    const offset = node.position?.start.offset;
    if (node.tagName === "pre" && offset !== undefined && preOffsets.has(offset)) {
      node.data ??= { position: {} };
      node.data.markdownCodeBlock = true;
    }
    markMarkdownCodeBlocks(node, preOffsets);
  }
}

function isMermaidPre(node: HtmlNode): boolean {
  if (node.type !== "element" || node.tagName !== "pre") return false;
  const code = node.children.find(child => child.type === "element" && child.tagName === "code");
  return code?.type === "element"
    && Array.isArray(code.properties.className)
    && code.properties.className.some(name => String(name) === "language-mermaid");
}

function applyMarkdownCodeAttribute(parent: { children: HtmlNode[] }): void {
  for (const node of parent.children) {
    if (node.type !== "element") continue;
    if (node.tagName === "pre" && node.data?.markdownCodeBlock && !isMermaidPre(node)) {
      node.properties[MARKDOWN_CODE_ATTRIBUTE] = true;
    }
    applyMarkdownCodeAttribute(node);
  }
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
  return html.replaceAll(CODE_BLOCK_PATTERN, (match, preAttrs: string, language: string | undefined, body: string) => {
    if (language === "mermaid") {
      return match;
    }

    const source = decodeHtmlEntities(body);
    const highlighted = highlightSource(source, language);
    const classAttribute = highlighted.language
      ? ` class="hljs language-${escapeAttribute(highlighted.language)}"`
      : ' class="hljs"';

    return `<pre${preAttrs}><code${classAttribute}>${highlighted.value}</code></pre>`;
  });
}

export type HighlightResult = { value: string; language: string | undefined };

function highlightSource(source: string, language: string | undefined): HighlightResult {
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

// Render an entire file's source as a single `<pre><code>` block. The wrapping
// `<pre>` carries `class="uatu-source-pre"` to mark it as the *whole-file*
// source view (as opposed to a fenced code block embedded inside rendered
// Markdown / AsciiDoc body content). Consumers like the word-wrap control
// key off this class to target the whole-file block unambiguously.
export function renderCodeAsHtml(source: string, language: string | undefined): string {
  if (source.length >= SYNTAX_HIGHLIGHT_BYTES_LIMIT) {
    return `<pre class="uatu-source-pre"><code class="hljs">${escapeHtml(source)}</code></pre>`;
  }

  const highlighted = highlightSource(source, language);
  const classAttribute = highlighted.language
    ? ` class="hljs language-${escapeAttribute(highlighted.language)}"`
    : ' class="hljs"';
  return `<pre class="uatu-source-pre"><code${classAttribute}>${highlighted.value}</code></pre>`;
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
