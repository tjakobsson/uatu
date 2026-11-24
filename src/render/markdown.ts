import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import hljs from "highlight.js/lib/common";
import type { Element, Root, RootContent } from "hast";
import { compile, micromark, parse, postprocess, preprocess } from "micromark";
import type { CompileContext, Event, HtmlExtension, Options, Token } from "micromark-util-types";
import { frontmatter, frontmatterHtml } from "micromark-extension-frontmatter";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import {
  type DocumentMetadata,
  normalizeMetadata,
  parseSimpleToml,
  parseSimpleYaml,
} from "../document/metadata";
import { markExternalAnchors, resolveRelativeUrls } from "./external-links";

// A code block, optionally carrying its source line (`sourceLines`).
const CODE_BLOCK_PATTERN = /<pre( data-source-line="\d+")?><code(?:\s+class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g;

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

// With `sourceLines`, each top-level rendered block also carries the
// 1-based source line it starts on, `data-source-line="<n>"` (only digits
// pass the sanitizer, and any the author wrote are removed first), so a
// review thread on a source line can be marked beside its rendered block.
const sourceLineSchema: Schema = {
  ...markdownSanitizeSchema,
  attributes: {
    ...markdownSanitizeSchema.attributes,
    "*": [...(markdownSanitizeSchema.attributes?.["*"] ?? []), ["dataSourceLine", /^\d+$/]],
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

// `baseUrl` resolves relative link and image URLs against an absolute URL
// (GitHub bodies resolve against their pull request's URL, design D13);
// without it, relative URLs stay for the preview's own link handling.
export function renderMarkdownToHtml(source: string, options: { baseUrl?: string; sourceLines?: boolean } = {}): RenderedMarkdown {
  const metadata = extractMarkdownMetadata(source);

  // micromark-extension-frontmatter consumes the leading frontmatter block from
  // the token stream so it never lands in body HTML — even when our local
  // metadata extractor decides the block is malformed and bails out. We still
  // pass the original source through so micromark sees the leading delimiter
  // it knows how to consume; downstream we only surface metadata when our own
  // parser succeeded.
  const micromarkOptions = {
    allowDangerousHtml: true,
    extensions: [gfm(), frontmatter(["yaml", "toml"])],
    htmlExtensions: [gfmHtml(), frontmatterHtml(["yaml", "toml"])],
  };
  const marker = options.sourceLines ? `uatu-source-line:${crypto.randomUUID()}:` : null;
  const rawHtml = marker ? renderWithLineMarkers(source, micromarkOptions, marker) : micromark(source, micromarkOptions);

  const tree = fromHtml(rawHtml, { fragment: true });
  if (marker) applySourceLines(tree, marker);
  const safe = sanitize(tree, marker ? sourceLineSchema : markdownSanitizeSchema);
  if (options.baseUrl) resolveRelativeUrls(safe, options.baseUrl);
  markExternalAnchors(safe);
  return { html: highlightCodeBlocks(toHtml(safe)), metadata };
}

// Top-level constructs that render as a block. `content` is a paragraph or
// only link definitions (which render nothing).
const SOURCE_LINE_BLOCKS = new Set([
  "atxHeading", "setextHeading", "content", "listOrdered", "listUnordered", "blockQuote",
  "codeFenced", "codeIndented", "thematicBreak", "htmlFlow", "table",
]);
const SOURCE_LINE_TOKEN = "uatuSourceLine";

// micromark's own pipeline, with an HTML comment naming the source line
// written before each top-level block. The comments carry a per-render nonce,
// so an author's own comments can't pose as them; applySourceLines turns
// them into attributes before the sanitizer drops every comment.
function renderWithLineMarkers(source: string, options: Options, marker: string): string {
  const events = postprocess(parse(options).document().write(preprocess()(source, undefined, true)));
  const marked: Event[] = [];
  let depth = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event[0] === "enter" && depth === 0 && SOURCE_LINE_BLOCKS.has(event[1].type)) {
      const start = event[1].type === "content" ? paragraphStart(events, index) : event[1].start;
      if (start) {
        const token = { type: SOURCE_LINE_TOKEN, start, end: start } as unknown as Token;
        marked.push(["enter", token, event[2]], ["exit", token, event[2]]);
      }
    }
    depth += event[0] === "enter" ? 1 : -1;
    marked.push(event);
  }
  // The token type is uatu's own, outside micromark's typed token map.
  const enter = { [SOURCE_LINE_TOKEN](this: CompileContext, token: Token) { this.raw(`<!--${marker}${token.start.line}-->`); } };
  const lineMarkers = { enter } as unknown as HtmlExtension;
  return compile({ ...options, htmlExtensions: [...(options.htmlExtensions ?? []), lineMarkers] })(marked);
}

// The paragraph a top-level `content` token holds (after any link
// definitions), or none.
function paragraphStart(events: Event[], contentIndex: number): Token["start"] | null {
  let depth = 0;
  for (let index = contentIndex; index < events.length; index += 1) {
    const [kind, token] = events[index]!;
    if (kind === "enter" && depth === 1 && token.type === "paragraph") return token.start;
    depth += kind === "enter" ? 1 : -1;
    if (depth === 0) return null;
  }
  return null;
}

// Each marker comment names the line of the next top-level element. Any
// `data-source-line` the author wrote is removed first.
function applySourceLines(tree: Root, marker: string): void {
  const strip = (node: Root | RootContent) => {
    if (node.type === "element") delete node.properties.dataSourceLine;
    if ("children" in node) for (const child of node.children) strip(child);
  };
  strip(tree);
  let line: number | null = null;
  for (const node of tree.children) {
    if (node.type === "comment" && node.value.startsWith(marker)) {
      line = Number(node.value.slice(marker.length));
    } else if (node.type === "element") {
      if (line !== null) (node as Element).properties.dataSourceLine = String(line);
      line = null;
    }
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
  return html.replaceAll(CODE_BLOCK_PATTERN, (match, line: string | undefined, language: string | undefined, body: string) => {
    if (language === "mermaid") {
      return match;
    }

    const source = decodeHtmlEntities(body);
    const highlighted = highlightSource(source, language);
    const classAttribute = highlighted.language
      ? ` class="hljs language-${escapeAttribute(highlighted.language)}"`
      : ' class="hljs"';

    return `<pre${line ?? ""}><code${classAttribute}>${highlighted.value}</code></pre>`;
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
