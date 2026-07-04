// Document rendering pipeline — fetches the `/api/document` payload, caches
// the result per-document × per-view, and mounts it (single or split) into
// the preview DOM. Extracted from `app.ts` so the preview/ feature folder
// owns the entire render-on-load flow.

import { recomputeSelectionInspector } from "../shell/inspector-instance";
import type { DocumentDiffPayload } from "./diff-view";
import { findDocumentById } from "../shell/storage";
import { closeMermaidViewer } from "./mermaid-viewer";
import { renderMermaidDiagrams, replaceMermaidCodeBlocks } from "../render/preview";
import type { ViewMode } from "../shared/types";
import { appState } from "../shell/state";
import { renderBinaryUnavailable } from "./binary";
import { applyDiffForActiveDocument } from "./diff";
import { renderEmptyPreview } from "./empty";
import {
  clearPreviewType,
  previewPathElement,
  previewTitleElement,
  setPreviewBase,
  setPreviewType,
} from "./header";
import { applySourceWrap, attachCopyButtons, attachLineNumbers } from "./code-block";
import {
  applyAutoStackIfNeeded,
  applySplitRatioToDom,
  attachSplitResizer,
  mountLayoutToolbar,
  syncLayoutChooser,
} from "./layout";
import { isViewableImageName, renderImagePreview } from "./image";
import { currentMermaidThemeInputs } from "./mermaid";
import { refreshOutline } from "./outline";
import { attachMetadataCardToggleListener, renderMetadataCard } from "./metadata-card";
import { syncViewToggle } from "./view-mode";
import { setPreviewMode } from "../shell/selection";

export type RenderedDocumentAuthor = { name: string; email?: string };

export type RenderedDocumentMetadata = {
  title?: string;
  authors?: RenderedDocumentAuthor[];
  date?: string;
  revision?: string;
  description?: string;
  tags?: string[];
  status?: string;
  extras?: Record<string, string>;
};

export type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
  kind: "markdown" | "asciidoc" | "text";
  view: ViewMode;
  language: string | null;
  metadata?: RenderedDocumentMetadata;
};

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");
const previewShellElementMaybe = document.querySelector<HTMLElement>(".preview-shell");

if (!previewElementMaybe || !previewShellElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/mount)");
}

const previewElement: HTMLElement = previewElementMaybe;
const previewShellElement: HTMLElement = previewShellElementMaybe;

// Track which document is currently mounted so `loadDocument` can distinguish
// a document switch (scroll the preview back to the top — the user is reading
// new content from the beginning) from an in-place refresh of the same doc
// (preserve scroll — the user is mid-read and a file-watcher reload must not
// yank them back to the top).
let lastLoadedDocumentId: string | null = null;

// `DocumentDiffPayload` is imported from `./document-diff-view` (above) so
// the client type stays in lockstep with the renderer's view of the
// discriminated union.
export const documentDiffCache = new Map<string, DocumentDiffPayload>();

// Per-document, per-view cache so toggling Source ↔ Rendered for an
// already-loaded document is instantaneous. Dropped entries are recreated on
// the next fetch; we drop a document's entry when navigating away to bound
// memory across long sessions.
type DocumentViewCacheEntry = { source?: RenderedDocument; rendered?: RenderedDocument };
export const documentViewCache = new Map<string, DocumentViewCacheEntry>();

export function rememberDocumentPayload(payload: RenderedDocument): void {
  const entry = documentViewCache.get(payload.id) ?? {};
  entry[payload.view] = payload;
  documentViewCache.set(payload.id, entry);
}

export function forgetDocumentCache(documentId: string): void {
  documentViewCache.delete(documentId);
}

// Mount a fetched document payload into the preview body. Centralizes the
// DOM mutations that follow either a cache hit (toggle path) or a fresh
// network fetch (loadDocument). In single layout this renders just the
// given payload; in split layouts it ensures both Source and Rendered
// representations are cached and renders them together.
export async function applyDocumentPayload(payload: RenderedDocument): Promise<void> {
  // Common header / title updates are payload-driven and identical across
  // single and split layouts.
  setPreviewMode({ kind: "document" });
  previewTitleElement.textContent = payload.title;
  previewPathElement.textContent = payload.path;
  setPreviewType(payload);
  previewElement.classList.remove("empty");
  setPreviewBase(payload.path);
  closeMermaidViewer();

  if (appState.viewLayout === "single" || !documentSupportsSplit(payload)) {
    await renderSinglePayload(payload);
  } else {
    await renderSplitForDocument(payload);
  }

  syncViewToggle(payload);
  syncLayoutChooser(payload);
  // The previous document's content (and any selection within it) was just
  // replaced. Re-evaluate so the pane reflects the new state instead of a
  // stale capture from the prior document.
  recomputeSelectionInspector();
}

// True for documents that can meaningfully render as both Source and Rendered.
// Text / source / code files have no rendered representation distinct from
// source, so the layout chooser and the split layouts are hidden for them.
export function documentSupportsSplit(payload: RenderedDocument | null): boolean {
  return payload !== null && (payload.kind === "markdown" || payload.kind === "asciidoc");
}

// Per-document set of allowed ViewModes used by the view chooser. Markdown
// and AsciiDoc support all three (Rendered, Source, Diff); plain text /
// source files have no distinct rendered representation, so the chooser
// only offers Source and Diff. Non-document previews return an empty set
// and the chooser is hidden entirely.
export function availableViewModes(payload: RenderedDocument | null): Set<ViewMode> {
  if (!payload) return new Set();
  if (payload.kind === "markdown" || payload.kind === "asciidoc") {
    return new Set<ViewMode>(["rendered", "source", "diff"]);
  }
  if (payload.kind === "text") {
    return new Set<ViewMode>(["source", "diff"]);
  }
  return new Set();
}

// First viewMode the chooser should fall back to when the persisted preference
// is not in the set available for the active document's kind. Mirrors the
// existing "first available segment" rule (Rendered for markdown/asciidoc,
// Source for text). Returns null when no segments are available.
export function firstAvailableViewMode(payload: RenderedDocument | null): ViewMode | null {
  if (!payload) return null;
  if (payload.kind === "markdown" || payload.kind === "asciidoc") return "rendered";
  if (payload.kind === "text") return "source";
  return null;
}

// Render a single-pane layout for the given payload. This is the legacy
// (pre-split) DOM shape: #preview itself carries the body content directly.
export async function renderSinglePayload(payload: RenderedDocument): Promise<void> {
  previewElement.classList.remove("is-split", "is-split-h", "is-split-v");
  previewElement.removeAttribute("data-auto-stack");
  const cardHtml = renderMetadataCard(payload.metadata);
  previewElement.innerHTML = cardHtml + replaceMermaidCodeBlocks(payload.html);
  // For markdown / asciidoc, mount the inline layout chooser above the
  // preview body so users can switch between Single / Side by side /
  // Stacked from beside the content — same pattern as the diff view's
  // Unified / Split.
  mountLayoutToolbar(documentSupportsSplit(payload));
  attachMetadataCardToggleListener(previewElement);
  await renderMermaidDiagrams(previewElement, currentMermaidThemeInputs());
  // Source rendering — for text/source files always, and for markdown /
  // asciidoc when the user is in Source view — needs the line-number gutter
  // so the inspector pane can produce accurate `@path#L<a>-<b>` references.
  if (payload.view === "source") {
    attachLineNumbers(previewElement);
    applySourceWrap(previewElement, appState.wrap);
  }
  attachCopyButtons(previewElement);
  // Rebuild the outline + action bar from the freshly-mounted content. In
  // Source view this hides the outline (a `<pre>` has no heading elements);
  // in Rendered view it enumerates the headings under #preview.
  refreshOutline({ id: payload.id, kind: payload.kind, view: payload.view });
}

// Ensure both Source and Rendered payloads are available for the active
// document, then mount them into the split-pane DOM. If one is missing from
// the cache, fetch it without clearing the visible content (the caller has
// already populated the header / type chip from `payload`). Falls back to
// single rendering when the additional fetch fails.
export async function renderSplitForDocument(payload: RenderedDocument): Promise<void> {
  const cache = documentViewCache.get(payload.id) ?? {};
  let sourcePayload = cache.source;
  let renderedPayload = cache.rendered;
  // Fetch any missing view(s) in parallel. The both-missing path is rare in
  // practice (at least the active viewMode payload is usually warm by the
  // time split is mounted), but handling it here avoids a fall-through to
  // single rendering when the user enters split with a cold cache.
  if (!sourcePayload || !renderedPayload) {
    const [fetchedSource, fetchedRendered] = await Promise.all([
      sourcePayload ? Promise.resolve(null) : fetchDocumentView(payload.id, "source"),
      renderedPayload ? Promise.resolve(null) : fetchDocumentView(payload.id, "rendered"),
    ]);
    if (fetchedSource) {
      rememberDocumentPayload(fetchedSource);
      sourcePayload = fetchedSource;
    }
    if (fetchedRendered) {
      rememberDocumentPayload(fetchedRendered);
      renderedPayload = fetchedRendered;
    }
  }
  if (!sourcePayload || !renderedPayload) {
    await renderSinglePayload(payload);
    return;
  }
  await renderSplitPayloads(sourcePayload, renderedPayload);
}

// Fetch a single view of a document via the existing /api/document endpoint.
// Returns null when the request fails (e.g., file was deleted on disk between
// the initial fetch and the split-completion fetch) so callers can fall back
// gracefully without clearing visible content.
export async function fetchDocumentView(
  documentId: string,
  view: ViewMode,
): Promise<RenderedDocument | null> {
  try {
    const response = await fetch(
      `/api/document?id=${encodeURIComponent(documentId)}&view=${encodeURIComponent(view)}`,
    );
    if (!response.ok) return null;
    return (await response.json()) as RenderedDocument;
  } catch {
    return null;
  }
}

// Mount two payloads as a split layout. The Source pane uses the same
// source-rendering DOM shape that single Source view uses (whole-file `<pre>`
// with the distinguishing `uatu-source-pre` class plus the line-number gutter),
// so Selection Inspector detection logic continues to work without changes.
export async function renderSplitPayloads(
  sourcePayload: RenderedDocument,
  renderedPayload: RenderedDocument,
): Promise<void> {
  const orientation: "split-h" | "split-v" =
    appState.viewLayout === "split-v" ? "split-v" : "split-h";
  const orientationClass = orientation === "split-h" ? "is-split-h" : "is-split-v";
  const otherOrientationClass = orientation === "split-h" ? "is-split-v" : "is-split-h";
  previewElement.classList.add("is-split", orientationClass);
  previewElement.classList.remove(otherOrientationClass);
  // Metadata card lives only on the rendered side — duplicating it would
  // double the document header for no benefit.
  const cardHtml = renderMetadataCard(renderedPayload.metadata);

  const sourcePane = document.createElement("div");
  sourcePane.className = "preview-pane preview-pane-source markdown-body";
  sourcePane.setAttribute("data-split-side", "source");
  sourcePane.innerHTML = sourcePayload.html;

  const resizer = document.createElement("div");
  resizer.className = "preview-split-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", orientation === "split-h" ? "vertical" : "horizontal");
  resizer.setAttribute("aria-label", "Resize split panes");
  resizer.setAttribute("tabindex", "0");

  const renderedPane = document.createElement("div");
  renderedPane.className = "preview-pane preview-pane-rendered markdown-body";
  renderedPane.setAttribute("data-split-side", "rendered");
  renderedPane.innerHTML = cardHtml + replaceMermaidCodeBlocks(renderedPayload.html);

  mountLayoutToolbar(true);
  previewElement.replaceChildren(sourcePane, resizer, renderedPane);

  attachMetadataCardToggleListener(renderedPane);
  await renderMermaidDiagrams(renderedPane, currentMermaidThemeInputs());
  attachLineNumbers(sourcePane);
  applySourceWrap(sourcePane, appState.wrap);
  attachCopyButtons(sourcePane);
  attachCopyButtons(renderedPane);

  // Apply persisted ratio for the active orientation. The auto-stack
  // ResizeObserver may further override the orientation visually, but the
  // ratio is applied to whichever orientation is currently rendered.
  applySplitRatioToDom();
  attachSplitResizer(resizer);
  applyAutoStackIfNeeded();
  // The rendered pane is always present in split layout, so the outline
  // enumerates it (and scroll-spy roots on that pane, not the shell).
  refreshOutline({
    id: renderedPayload.id,
    kind: renderedPayload.kind,
    view: "rendered",
  });
}

export async function loadDocument(documentId: string) {
  // A document *switch* (different id than what's currently mounted) resets
  // the preview scroll to the top so the user lands at the beginning of the
  // new doc. An in-place *refresh* (same id, e.g. file-watcher reload of the
  // active doc) leaves scroll alone so the user isn't yanked mid-read.
  // Callers that need to scroll to a fragment after load (popstate with
  // `#section`, cross-doc link with hash) run their own `scrollToFragment`
  // afterwards — the reset happens first, then the fragment scroll wins.
  const isDocumentSwitch = lastLoadedDocumentId !== documentId;
  lastLoadedDocumentId = documentId;
  if (isDocumentSwitch) {
    // Reset synchronously *before* fetch + innerHTML swap so the new content
    // paints at the top in a single layout pass. Doing it after the swap can
    // briefly flash the new content at the previous doc's scroll offset.
    previewShellElement.scrollTo({ top: 0 });
  }

  // `loadDocument` always fetches fresh — callers that want the cached
  // payload for the active document should look it up themselves
  // (currently only `applyViewMode`, for instantaneous Source ↔ Rendered
  // toggling). The cache is bounded to one doc × two views, so a full
  // clear has the same effect as targeted purge + invalidate, with less
  // ceremony. The diff cache is invalidated alongside since file-change
  // events route through this same function.
  documentViewCache.clear();
  documentDiffCache.delete(documentId);

  // Binary files have no rendered representation through the document API.
  // Route them straight to a binary-specific preview: an inline `<img>` for
  // viewable image extensions, a "preview unavailable" notice otherwise.
  // Skipping the /api/document fetch also avoids the misleading 4xx error
  // path that used to surface as "The selected file no longer exists."
  const doc = findDocumentById(documentId);
  if (doc?.kind === "binary") {
    if (isViewableImageName(doc.name)) {
      renderImagePreview(doc);
    } else {
      renderBinaryUnavailable(doc);
    }
    return;
  }

  // Diff view bypasses the rendered/source pipeline entirely — it has its
  // own endpoint and renderer. The /api/document fetch is skipped for now;
  // toggling out of Diff will lazy-load the rendered/source view on demand.
  if (appState.viewMode === "diff") {
    await applyDiffForActiveDocument(documentId);
    return;
  }

  // Server-side renderDocument only understands "rendered" | "source". If
  // the viewMode is somehow "diff" we already short-circuited above; this
  // assertion narrows the param so the response stays well-typed.
  const apiView: "rendered" | "source" = appState.viewMode === "source" ? "source" : "rendered";
  const response = await fetch(
    `/api/document?id=${encodeURIComponent(documentId)}&view=${encodeURIComponent(apiView)}`,
  );

  if (!response.ok) {
    setPreviewMode({ kind: "empty" });
    renderEmptyPreview("Document unavailable", "The selected file no longer exists.");
    return;
  }

  const payload = (await response.json()) as RenderedDocument;
  rememberDocumentPayload(payload);
  await applyDocumentPayload(payload);
}
