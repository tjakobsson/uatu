// View-mode (Rendered / Source / Diff) toggle wiring. Owns the chooser's
// visibility, persistence, and the click handlers that fire `applyViewMode`.
// Extracted from `app.ts` so the preview/ feature folder owns the entire
// view-mode flow alongside layout and mount.

import { writePreviewWrapPreference, writeViewModePreference, type ViewMode } from "../shared/types";
import { appState, safeLocalStorage } from "../shell/state";
import { applySourceWrap } from "./code-block";
import { applyDiffForActiveDocument } from "./diff";
import { mountLayoutToolbar } from "./layout";
import { applyDocumentPayload, documentViewCache, loadDocument } from "./mount";
import { refreshOutline } from "./outline";

const viewControlElementMaybe = document.querySelector<HTMLDivElement>("#view-control");
const viewRenderedButtonMaybe = document.querySelector<HTMLButtonElement>("#view-rendered");
const viewSourceButtonMaybe = document.querySelector<HTMLButtonElement>("#view-source");
const viewDiffButtonMaybe = document.querySelector<HTMLButtonElement>("#view-diff");
const wrapControlElementMaybe = document.querySelector<HTMLDivElement>("#wrap-control");
const wrapToggleButtonMaybe = document.querySelector<HTMLButtonElement>("#wrap-toggle");
const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (
  !viewControlElementMaybe
  || !viewRenderedButtonMaybe
  || !viewSourceButtonMaybe
  || !viewDiffButtonMaybe
  || !wrapControlElementMaybe
  || !wrapToggleButtonMaybe
  || !previewElementMaybe
) {
  throw new Error("uatu UI failed to initialize (preview/view-mode)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies.
const viewControlElement: HTMLDivElement = viewControlElementMaybe;
const viewRenderedButton: HTMLButtonElement = viewRenderedButtonMaybe;
const viewSourceButton: HTMLButtonElement = viewSourceButtonMaybe;
const viewDiffButton: HTMLButtonElement = viewDiffButtonMaybe;
const wrapControlElement: HTMLDivElement = wrapControlElementMaybe;
const wrapToggleButton: HTMLButtonElement = wrapToggleButtonMaybe;
const previewElement: HTMLElement = previewElementMaybe;

// Views for which the Wrap toggle is meaningful and wired. Diff honors wrap
// via @pierre/diffs' `overflow` option; Source honors it via the per-line
// gutter's `is-wrapped` CSS (the §3 spike selected the homegrown path).
// Rendered (markdown/asciidoc body) has nothing to wrap and is excluded.
const WRAP_SUPPORTING_VIEWS: ReadonlySet<ViewMode> = new Set<ViewMode>(["source", "diff"]);

// Minimal payload shape consumed by the chooser. The chooser only reads
// `kind`; importing the full `RenderedDocument` type from mount.ts would
// create a circular type dep, so we use the structural subset here.
type ViewChooserPayload = { kind: "markdown" | "asciidoc" | "text" } | null;

// Per-document set of allowed ViewModes used by the view chooser. Markdown
// and AsciiDoc support all three (Rendered, Source, Diff); plain text /
// source files have no distinct rendered representation, so the chooser
// only offers Source and Diff. Non-document previews return an empty set
// and the chooser is hidden entirely.
function availableViewModes(payload: ViewChooserPayload): Set<ViewMode> {
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
export function firstAvailableViewMode(payload: ViewChooserPayload): ViewMode | null {
  if (!payload) return null;
  if (payload.kind === "markdown" || payload.kind === "asciidoc") return "rendered";
  if (payload.kind === "text") return "source";
  return null;
}

// Reflect the current view-mode preference and the active document's actual
// rendering on the Source / Rendered toggle. The toggle is hidden whenever
// the active document does not have a separate rendered representation
// (text / source / code files), whenever the preview is not in document mode,
// and whenever the layout is split (both representations are already visible).
export function syncViewToggle(payload: ViewChooserPayload): void {
  const available = availableViewModes(payload);
  // The view chooser stays visible whenever the document has at least one
  // view to choose. In split layout Source and Rendered are both already
  // visible — clicking them in that state only updates the persisted
  // preference for when the user returns to single — but the Diff segment
  // is the third option and MUST be reachable from split. Hiding the
  // whole cluster to suppress a redundant Source / Rendered click would
  // also bury Diff, which is worse than the redundancy.
  const showToggle = available.size > 0;
  viewControlElement.hidden = !showToggle;
  if (!showToggle) {
    syncWrapToggle(null);
    return;
  }

  // Show/hide each segment based on the active document's kind.
  viewRenderedButton.hidden = !available.has("rendered");
  viewSourceButton.hidden = !available.has("source");
  viewDiffButton.hidden = !available.has("diff");

  // If the persisted preference isn't valid for this kind, fall back to
  // the first available segment without writing back to localStorage —
  // the user's choice should re-engage as soon as they navigate to a
  // document that supports it.
  const effectiveMode = available.has(appState.viewMode)
    ? appState.viewMode
    : firstAvailableViewMode(payload) ?? appState.viewMode;

  const segments: Array<{ button: HTMLButtonElement; value: ViewMode }> = [
    { button: viewRenderedButton, value: "rendered" },
    { button: viewSourceButton, value: "source" },
    { button: viewDiffButton, value: "diff" },
  ];
  for (const { button, value } of segments) {
    const active = effectiveMode === value;
    button.setAttribute("aria-checked", String(active));
    button.classList.toggle("is-active", active);
  }

  syncWrapToggle(effectiveMode);
}

// Reflect the global wrap preference on the Wrap toggle, and show it only
// when the effective view actually honors wrapping. `effectiveMode` is null
// when there is no view chooser on screen (non-document preview or a
// document with no available views), in which case the toggle is hidden.
export function syncWrapToggle(effectiveMode: ViewMode | null): void {
  const show = effectiveMode !== null && WRAP_SUPPORTING_VIEWS.has(effectiveMode);
  wrapControlElement.hidden = !show;
  if (!show) {
    return;
  }
  wrapToggleButton.setAttribute("aria-pressed", String(appState.wrap));
}

// Hide the Source/Rendered toggle for non-document previews (commit,
// review-score, empty). Also clear any split-layout classes so the
// preview body resets to a normal flow container for the upcoming
// non-document content, and tear down the inline layout toolbar.
export function hideViewToggle(): void {
  viewControlElement.hidden = true;
  syncWrapToggle(null);
  previewElement.classList.remove("is-split", "is-split-h", "is-split-v");
  previewElement.removeAttribute("data-auto-stack");
  mountLayoutToolbar(false);
  // Non-document previews (commit, review-score, empty, binary, image) have no
  // outline and no source to copy — hide the action bar and tear down scroll-spy.
  refreshOutline(null);
}

export function applyViewMode(next: ViewMode): void {
  if (appState.viewMode === next) {
    return;
  }
  appState.viewMode = next;
  writeViewModePreference(safeLocalStorage(), next);
  // Re-render the active document in the new view. Prefer the cached
  // payload when both representations are already in memory — this is what
  // makes Source ↔ Rendered toggling feel instantaneous and avoids a flash
  // of empty preview during the round-trip. Fall back to a network fetch
  // when the new view hasn't been loaded yet.
  if (appState.previewMode.kind !== "document" || !appState.selectedId) {
    return;
  }
  if (next === "diff") {
    void applyDiffForActiveDocument(appState.selectedId);
    return;
  }
  const cached = documentViewCache.get(appState.selectedId)?.[next];
  if (cached) {
    void applyDocumentPayload(cached);
    return;
  }
  void loadDocument(appState.selectedId);
}

// Toggle the global wrap preference and re-apply it to the active view in
// place. Mirrors `applyDiffStyle`: persist immediately, then re-render the
// current representation from cache — no network round-trip, no full reload.
export function applyWrap(next: boolean): void {
  if (appState.wrap === next) {
    return;
  }
  appState.wrap = next;
  writePreviewWrapPreference(safeLocalStorage(), next);
  wrapToggleButton.setAttribute("aria-pressed", String(next));

  if (appState.previewMode.kind !== "document" || !appState.selectedId) {
    return;
  }
  if (appState.viewMode === "diff") {
    // Diff re-renders from the cached payload (no refetch when present) so
    // Pierre picks up the new `overflow` option.
    void applyDiffForActiveDocument(appState.selectedId);
    return;
  }
  // Otherwise (Source single/split — and harmlessly Rendered, where it's a
  // no-op since no `pre.uatu-source-pre` is in the DOM): wrap is pure CSS on
  // the per-line gutter, so just flip the class on any already-rendered
  // source block(s). No re-render; covers the Source pane of a split layout.
  applySourceWrap(previewElement, next);
}

// Tiny adapter that uses the existing source-view language map (highlight.js
// names) for the Diff view language hint. Pierre infers the language from
// the patch filename on its own; this hint is a fallback for ambiguous cases.
export function extensionToLanguage(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot).toLowerCase();
  switch (ext) {
    case ".ts": case ".mts": case ".cts": return "typescript";
    case ".tsx": return "tsx";
    case ".js": case ".mjs": case ".cjs": return "javascript";
    case ".jsx": return "jsx";
    case ".json": return "json";
    case ".yml": case ".yaml": return "yaml";
    case ".md": case ".markdown": return "markdown";
    case ".adoc": case ".asciidoc": return "asciidoc";
    case ".py": return "python";
    case ".go": return "go";
    case ".rs": return "rust";
    case ".sh": case ".bash": case ".zsh": return "shell";
    case ".css": return "css";
    case ".html": case ".htm": return "html";
    default: return null;
  }
}

// Boot-time wiring for the chooser's click handlers. Called once by app.ts.
export function initViewModeControls(): void {
  viewRenderedButton.addEventListener("click", () => applyViewMode("rendered"));
  viewSourceButton.addEventListener("click", () => applyViewMode("source"));
  viewDiffButton.addEventListener("click", () => applyViewMode("diff"));
  wrapToggleButton.addEventListener("click", () => applyWrap(!appState.wrap));
}
