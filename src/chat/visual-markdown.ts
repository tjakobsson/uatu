import { fromHtml } from "hast-util-from-html";
import { sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { compile, parse, postprocess, preprocess } from "micromark";
import { frontmatter, frontmatterHtml } from "micromark-extension-frontmatter";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import { markExternalAnchors } from "../render/external-links";
import { highlightCodeBlocks, markdownSanitizeSchema } from "../render/markdown";
import { measureChatWork } from "./performance";
import type { ChatVisualInput } from "./visual-types";

type HtmlNode = ReturnType<typeof fromHtml>["children"][number];
type MarkdownEvent = ReturnType<typeof postprocess>[number];
type Origin = { offset: number; svg?: { source: string; complete: boolean } };
declare module "micromark-util-types" {
  interface TokenTypeMap { chatVisualOrigin: "chatVisualOrigin" }
}
declare module "hast" {
  interface ElementData { chatVisualOrigin?: Origin; chatVisualSource?: string }
}

type Prepared = { html: string; visuals: ChatVisualInput[] };
const cache = new Map<string, Prepared>();
const BYTE_LIMIT = 4 * 1024 * 1024;
let retainedBytes = 0;

/** One parser for snapshot capture and presentation, so occurrence ids agree. */
export function prepareChatVisualMarkdown(source: string, streaming: boolean): Prepared {
  const key = `${streaming ? "1" : "0"}${source}`;
  const previous = cache.get(key);
  if (previous) { cache.delete(key); cache.set(key, previous); return previous; }
  const finish = measureChatWork("markdown");
  try { return prepareUncached(source, streaming, key); }
  finally { finish(); }
}

function prepareUncached(source: string, streaming: boolean, key: string): Prepared {
  // Extract SVG before syntax highlighting: source text is not HTML, and
  // must never be reconstructed by decoding highlighted markup.
  const { html, attribute, origins } = visualSyntax(source);
  const unsafe = fromHtml(html, { fragment: true });
  const attributeOrigins = (parent: { children: HtmlNode[] }) => {
    for (const node of parent.children) {
      if (node.type !== "element") continue;
      const origin = origins.get(String(node.properties[attribute]));
      if (origin) {
        node.data ??= { position: {} };
        node.data.chatVisualOrigin = origin;
      }
      if (node.tagName === "img") {
        // Retain refused schemes as private text before the shared sanitizer
        // removes src. This never grants a URL presentation or file authority.
        node.data ??= { position: {} };
        node.data.chatVisualSource = String(node.properties.src ?? "");
      }
      delete node.properties[attribute];
      attributeOrigins(node);
    }
  };
  attributeOrigins(unsafe);
  const tree = sanitize(unsafe, markdownSanitizeSchema);
  markExternalAnchors(tree);
  const visuals: ChatVisualInput[] = [];
  const visit = (parent: { children: HtmlNode[] }) => {
    parent.children = parent.children.map(node => {
      if (node.type !== "element") return node;
      let input: Omit<ChatVisualInput, "index"> | undefined;
      const origin = node.data?.chatVisualOrigin;
      if (node.tagName === "img") {
        const offset = origin?.offset;
        input = { kind: "file", source: node.data?.chatVisualSource ?? String(node.properties.src ?? ""), alt: String(node.properties.alt ?? "Image"), complete: true, ...(offset === undefined ? {} : { key: `offset:${offset}` }) };
      } else if (node.tagName === "pre") {
        const code = node.children.find(child => child.type === "element" && child.tagName === "code");
        if (code?.type === "element" && Array.isArray(code.properties.className)
          && code.properties.className.some(name => String(name).toLowerCase() === "language-svg")) {
          // Only Markdown SVG fences are previews. A raw HTML <pre><code>
          // remains ordinary code, including when its tags span tokens.
          if (origin?.svg) input = { kind: "svg", source: origin.svg.source, alt: "SVG graphic", complete: origin.svg.complete, key: `offset:${origin.offset}` };
        }
      }
      if (!input) {
        if (node.tagName === "pre") {
          // HTML pre is formatted text, not an inert container. Quote its
          // nested markup so a raw <img> can never escape the capture path.
          const code = node.children.length === 1 && node.children[0]?.type === "element" && node.children[0].tagName === "code"
            ? node.children[0] : node;
          code.children = [{ type: "text", value: code.children.map(child => child.type === "text" ? child.value : toHtml(child)).join("") }];
          return node;
        }
        visit(node);
        // Linked images open in the in-chat viewer, never navigate away from
        // the conversation through a wrapping Markdown link.
        if (node.tagName === "a" && node.children.some(containsVisual)) {
          node.tagName = "span";
          node.properties = {};
        }
        return node;
      }
      const index = visuals.length;
      visuals.push({ ...input, index });
      // Replace every img before HTML reaches a DOM. Even a failed or not-yet
      // captured reference must never trigger a request to the original URL.
      return { type: "element", tagName: "span", properties: { "data-uatu-visual": String(index) }, children: [] };
    });
  };
  if (tree.type === "root") visit(tree);
  const result = { html: highlightCodeBlocks(toHtml(tree)), visuals };
  const bytes = 2 * (key.length + result.html.length + visuals.reduce((n, visual) => n + visual.source.length + visual.alt.length, 0));
  if (bytes <= BYTE_LIMIT) {
    while (cache.size >= 128 || retainedBytes + bytes > BYTE_LIMIT) {
      const [oldKey, old] = cache.entries().next().value!;
      cache.delete(oldKey);
      retainedBytes -= 2 * (oldKey.length + old.html.length + old.visuals.reduce((n, visual) => n + visual.source.length + visual.alt.length, 0));
    }
    cache.set(key, result);
    retainedBytes += bytes;
  }
  return result;
}

export function getChatVisuals(source: string, streaming: boolean): ChatVisualInput[] {
  return prepareChatVisualMarkdown(source, streaming).visuals;
}

function containsVisual(node: HtmlNode): boolean {
  return node.type === "element" && ("data-uatu-visual" in node.properties || node.children.some(containsVisual));
}

// micromark knows fences inside lists/quotes, tilde fences, escaping, and
// fences inside other code. A regex over Markdown cannot make this decision.
function visualSyntax(source: string): { html: string; attribute: string; origins: Map<string, Origin> } {
  const events = postprocess(parse({ extensions: [gfm(), frontmatter(["yaml", "toml"])] }).document().write(preprocess()(source, undefined, true)));
  // Pick an attribute absent from the source so raw HTML cannot forge an origin.
  // It is removed before sanitization and never reaches presentation HTML.
  // Fixed-width suffixes outnumber source characters. Collect their used
  // prefixes once, then choose a short absent name without rescanning source.
  const prefix = "uatu-origin-";
  const width = String(source.length).length;
  const usedSuffixes = new Set<number>();
  for (const match of source.matchAll(new RegExp(`${prefix}([0-9]{${width}})`, "gi"))) {
    usedSuffixes.add(Number(match[1]));
  }
  let suffix = 0;
  while (usedSuffixes.has(suffix)) suffix++;
  const attribute = prefix + String(suffix).padStart(width, "0");
  const origins = new Map<string, Origin>();
  const annotate = (html: string, position: number, origin: Origin) => {
    const id = String(origins.size);
    origins.set(id, origin);
    return html.slice(0, position) + ` ${attribute}="${id}"` + html.slice(position);
  };
  const wrapped: MarkdownEvent[] = [];
  const wrappers = new Map<MarkdownEvent[1], MarkdownEvent[1]>();
  const fenceOrigins = new Map<MarkdownEvent[1], Origin>();
  let imageDepth = 0;
  let block: { svg: boolean; fences: number; parts: string[]; firstEnding: boolean; offset: number } | undefined;
  for (const [event, token, context] of events) {
    if (event === "enter" && imageDepth === 0 && ["image", "htmlFlow", "htmlText", "codeFenced", "codeIndented"].includes(token.type)) {
      const wrapper = { ...token, type: "chatVisualOrigin" as const };
      wrappers.set(token, wrapper);
      wrapped.push(["enter", wrapper, context]);
    }
    wrapped.push([event, token, context]);
    if (event === "exit" && wrappers.has(token)) wrapped.push(["exit", wrappers.get(token)!, context]);
    if (token.type === "image") {
      if (event === "enter") imageDepth += 1;
      if (event === "exit") imageDepth -= 1;
    }
    if (event === "enter" && token.type === "codeFenced") block = { svg: false, fences: 0, parts: [], firstEnding: true, offset: token.start.offset! };
    if (!block) continue;
    if (event === "enter" && token.type === "codeFencedFence") block.fences += 1;
    if (event === "exit" && token.type === "codeFencedFenceInfo") {
      block.svg = source.slice(token.start.offset, token.end.offset).toLowerCase() === "svg";
    }
    if (event === "exit" && block.fences === 1) {
      if (token.type === "codeFlowValue") block.parts.push(source.slice(token.start.offset, token.end.offset));
      if (token.type === "lineEnding") {
        if (!block.firstEnding) block.parts.push(source.slice(token.start.offset, token.end.offset).match(/^(?:\r\n|\r|\n)/)?.[0] ?? "\n");
        block.firstEnding = false;
      }
    }
    if (event === "exit" && token.type === "codeFenced") {
      fenceOrigins.set(wrappers.get(token)!, { offset: block.offset, ...(block.svg ? { svg: { source: block.parts.join(""), complete: block.fences === 2 } } : {}) });
      block = undefined;
    }
  }
  const originals = new Map([...wrappers].map(([token, wrapper]) => [wrapper, token]));
  const html = compile({
    allowDangerousHtml: true,
    // Let the private tree retain image destinations for refusal references.
    // The shared sanitizer still strips unsafe URL attributes before output,
    // and every image is replaced by a captured-snapshot placeholder.
    allowDangerousProtocol: true,
    htmlExtensions: [gfmHtml(), frontmatterHtml(["yaml", "toml"]), {
      enter: { chatVisualOrigin(token) {
        const original = originals.get(token)!;
        if (["htmlFlow", "codeFenced", "codeIndented"].includes(original.type)) this.lineEndingIfNeeded();
        this.buffer();
      } },
      exit: { chatVisualOrigin(token) {
        const original = originals.get(token)!;
        let html = this.resume();
        if (original.type === "htmlFlow" || original.type === "htmlText") {
          // Positions refer to the un-repaired tag text, not foster-parented
          // DOM order. Source slices retain list/quote prefixes and offsets.
          const positions = (raw: string) => {
            const result: { tag: string; offset: number; insertion: number }[] = [];
            const visit = (parent: { children: HtmlNode[] }) => {
              for (const node of parent.children) {
                if (node.type !== "element") continue;
                if ((node.tagName === "img" || node.tagName === "pre") && node.position?.start.offset !== undefined) {
                  const offset = node.position.start.offset;
                  // HTML normalizes aliases such as <image> to img. Insert
                  // after the lexical name, not inside its longer source tag.
                  const name = /^<[^\t\n\f\r />]+/.exec(raw.slice(offset));
                  if (name) result.push({ tag: node.tagName, offset, insertion: offset + name[0].length });
                }
                visit(node);
              }
            };
            visit(fromHtml(raw, { fragment: true }));
            return result.sort((a, b) => a.offset - b.offset);
          };
          const sourcePositions = positions(source.slice(original.start.offset, original.end.offset));
          const renderedPositions = positions(html);
          for (let i = renderedPositions.length - 1; i >= 0; i--) {
            const rendered = renderedPositions[i]!;
            const sourcePosition = sourcePositions[i];
            if (sourcePosition?.tag === rendered.tag) html = annotate(html, rendered.insertion, { offset: original.start.offset! + sourcePosition.offset });
          }
        } else {
          const tag = original.type === "image" ? "img" : "pre";
          const position = html.indexOf(`<${tag}`);
          if (position !== -1) html = annotate(html, position + tag.length + 1, fenceOrigins.get(token) ?? { offset: original.start.offset! });
        }
        const lastWasTag = this.getData("lastWasTag");
        this.raw(html);
        this.setData("lastWasTag", lastWasTag);
      } },
    }],
  })(wrapped);
  return { html, attribute, origins };
}
