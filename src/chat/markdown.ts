import { escapeHtml } from "../render/markdown";
import { appUrl } from "../shared/app-url";
import { prepareChatVisualMarkdown } from "./visual-markdown";
import type { ChatVisualInput, ChatVisualSnapshot } from "./visual-types";
import { CHAT_VISUAL_ID_PATTERN, VISUAL_MAX_COUNT } from "./visual-types";

export type ChatMarkdownOptions = { streaming?: boolean; visuals?: readonly ChatVisualSnapshot[] };

export function renderChatMarkdown(source: string, options: ChatMarkdownOptions = {}): string {
  const prepared = prepareChatVisualMarkdown(source, options.streaming ?? false);
  return prepared.html.replace(/<span data-uatu-visual="(\d+)"><\/span>/g, (_marker, index: string) => {
    const input = prepared.visuals[Number(index)];
    return input ? renderVisual(input, options) : "";
  });
}

function renderVisual(input: ChatVisualInput, options: ChatMarkdownOptions): string {
  const snapshot = options.visuals?.slice(0, VISUAL_MAX_COUNT).find(visual => visual.index === input.index);
  const hasId = snapshot?.id !== undefined && CHAT_VISUAL_ID_PATTERN.test(snapshot.id);
  const ready = snapshot?.status === "ready" && hasId;
  const external = /^(?:https?:)?\/\//i.test(input.source);
  const svg = input.kind === "svg" || (!external && (snapshot?.mimeType === "image/svg+xml" || /\.svg(?:[?#]|$)/i.test(input.source)));
  const pending = snapshot?.status === "pending" || (!snapshot && (options.streaming ?? false));
  const refusedCount = !snapshot && (options.visuals !== undefined || input.index >= VISUAL_MAX_COUNT);
  const src = ready ? appUrl(`/api/chat/visuals/${encodeURIComponent(snapshot.id!)}`) : "";
  const sourceUrl = svg && hasId ? appUrl(`/api/chat/visuals/${encodeURIComponent(snapshot.id!)}/source`) : "";
  let message = snapshot?.message ?? (pending ? "Preparing image…" : "Image unavailable.");
  if (input.kind === "svg" && !input.complete) message = options.streaming ? "Generating image…" : "SVG block is unfinished.";
  if (refusedCount) message = `At most ${VISUAL_MAX_COUNT} images can be displayed per message.`;
  // A refused external URL is inert text, not an image. Only an explicit
  // follow of its link can contact the host; no browser or server prefetch.
  const reference = input.kind === "file"
    ? external
      ? `<a href="${escapeHtml(input.source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(input.alt || input.source)}</a>`
      : `<code class="chat-visual-reference">${escapeHtml(input.source)}</code>`
    : "";
  const image = ready && !refusedCount
    ? `<button type="button" class="chat-visual-enlarge" data-attachment-view="${escapeHtml(src)}" data-attachment-view-name="${escapeHtml(input.alt)}" aria-label="Enlarge ${escapeHtml(input.alt)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(input.alt)}" loading="lazy" decoding="async"></button><span class="chat-visual-fallback" role="status" hidden>Could not display ${escapeHtml(input.alt || "image")}.${reference ? ` ${reference}` : ""}</span>`
    : `<span class="chat-visual-fallback"${pending ? ' role="status"' : ""}>${escapeHtml(message)}${reference ? ` ${reference}` : ""}</span>`;
  const controls = svg
    ? `<span class="chat-visual-controls" role="group" aria-label="SVG view"><button type="button" data-visual-tab="preview" aria-pressed="true">Preview</button><button type="button" data-visual-tab="source" aria-pressed="false">Source</button><button type="button" data-visual-copy${input.kind === "svg" && !hasId ? "" : ' disabled title="Open Source to load SVG before copying"'}>Copy source</button></span>`
    : "";
  const original = input.kind === "svg" && !hasId ? escapeHtml(input.source) : "";
  const source = svg ? `<span class="chat-visual-source" hidden><code>${original}</code></span>` : "";
  return `<span class="chat-visual${svg ? " is-svg" : ""}" data-visual-index="${input.index}"${hasId ? ` data-visual-key="${escapeHtml(snapshot.id!)}"` : ""}${sourceUrl ? ` data-visual-source-url="${escapeHtml(sourceUrl)}"` : ""}${input.kind === "svg" && !hasId ? ' data-visual-source-loaded="true"' : ""}>${controls}<span class="chat-visual-preview">${image}</span>${source}<span class="chat-visual-status" role="status"></span></span>`;
}
