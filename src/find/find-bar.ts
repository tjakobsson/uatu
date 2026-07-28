// The find bar: one control, whichever surface is being searched.
//
// Owns the query box, the match options, and the counter. It does not know how
// anything is matched — that belongs to the engine it is pointed at (see
// `engine.ts`). Pointing the same bar at the preview and at the terminal is
// what keeps ⌘F feeling like one feature rather than two that share a key.

import { appState } from "../shell/state";
import { findDocument } from "../shared/types";
import type { FindEngine } from "./engine";
import { clampSeed, describeStatus } from "./find-status";
import { supportsHighlights } from "./highlight";
import { DEFAULT_MATCH_OPTIONS, type MatchOptions } from "./matcher";
import { createPreviewEngine } from "./preview-engine";

const findBarElementMaybe = document.querySelector<HTMLElement>("#find-bar");
const queryInputMaybe = document.querySelector<HTMLInputElement>("#find-query");
const statusElementMaybe = document.querySelector<HTMLElement>("#find-status");
const caseToggleMaybe = document.querySelector<HTMLButtonElement>("#find-case");
const wordToggleMaybe = document.querySelector<HTMLButtonElement>("#find-word");
const regexToggleMaybe = document.querySelector<HTMLButtonElement>("#find-regex");
const previousButtonMaybe = document.querySelector<HTMLButtonElement>("#find-previous");
const nextButtonMaybe = document.querySelector<HTMLButtonElement>("#find-next");
const closeButtonMaybe = document.querySelector<HTMLButtonElement>("#find-close");
const previewElementMaybe = document.querySelector<HTMLElement>("#preview");
const previewShellElementMaybe = document.querySelector<HTMLElement>(".preview-shell");
const previewFindSlotMaybe = document.querySelector<HTMLElement>("#preview-find-slot");

if (
  !findBarElementMaybe ||
  !queryInputMaybe ||
  !statusElementMaybe ||
  !caseToggleMaybe ||
  !wordToggleMaybe ||
  !regexToggleMaybe ||
  !previousButtonMaybe ||
  !nextButtonMaybe ||
  !closeButtonMaybe ||
  !previewElementMaybe ||
  !previewShellElementMaybe ||
  !previewFindSlotMaybe
) {
  throw new Error("uatu UI failed to initialize (find/find-bar)");
}

const findBarElement: HTMLElement = findBarElementMaybe;
const queryInput: HTMLInputElement = queryInputMaybe;
const statusElement: HTMLElement = statusElementMaybe;
const caseToggle: HTMLButtonElement = caseToggleMaybe;
const wordToggle: HTMLButtonElement = wordToggleMaybe;
const regexToggle: HTMLButtonElement = regexToggleMaybe;
const previousButton: HTMLButtonElement = previousButtonMaybe;
const nextButton: HTMLButtonElement = nextButtonMaybe;
const closeButton: HTMLButtonElement = closeButtonMaybe;
const previewElement: HTMLElement = previewElementMaybe;
const previewShellElement: HTMLElement = previewShellElementMaybe;
const previewFindSlot: HTMLElement = previewFindSlotMaybe;

// Long enough that typing a word does not repaint on every keystroke, short
// enough that the counter still feels live.
const SEARCH_DEBOUNCE_MS = 120;

const previewEngine = createPreviewEngine(previewElement, previewShellElement, previewFindSlot);

let open = false;
let engine: FindEngine | null = null;
// Session-scoped, not persisted: match options are about the search you are
// doing now, and inheriting last week's regex mode is a surprise.
let options: MatchOptions = { ...DEFAULT_MATCH_OPTIONS };
let total = 0;
let currentIndex = -1;
let truncated = false;
let patternError: string | null = null;
let debounceHandle: number | null = null;

export function isFindBarOpen(): boolean {
  return open;
}

export function getPreviewEngine(): FindEngine {
  return previewEngine;
}

function render(): void {
  const status = describeStatus({
    query: queryInput.value,
    total,
    currentIndex,
    truncated,
    error: patternError,
  });
  statusElement.textContent = status.label;
  statusElement.dataset.state = status.state;
  previousButton.disabled = total === 0;
  nextButton.disabled = total === 0;
  caseToggle.setAttribute("aria-pressed", String(options.caseSensitive));
  wordToggle.setAttribute("aria-pressed", String(options.wholeWord));
  regexToggle.setAttribute("aria-pressed", String(options.regex));
}

function receiveOutcome(outcome: {
  total: number;
  index: number;
  truncated: boolean;
  error: string | null;
}): void {
  total = outcome.total;
  currentIndex = outcome.index;
  truncated = outcome.truncated;
  patternError = outcome.error;
  render();
}

function run(reveal: boolean): void {
  engine?.run(queryInput.value, options, { reveal });
}

function scheduleRun(): void {
  if (debounceHandle !== null) {
    window.clearTimeout(debounceHandle);
  }
  debounceHandle = window.setTimeout(() => {
    debounceHandle = null;
    run(true);
  }, SEARCH_DEBOUNCE_MS);
}

export function step(delta: number): void {
  engine?.step(delta, queryInput.value, options);
}

// Re-run against freshly mounted content. The engine keeps the reading
// position; the bar only has to ask.
function refreshAfterContentChange(): void {
  if (open) {
    run(false);
  }
}

// The reader's current selection, if it lies inside the searched surface — a
// selection elsewhere is not a statement about this search. Only the preview
// engine searches the DOM the selection lives in; a preview selection says
// nothing about a terminal search.
function selectionSeed(target: FindEngine): string {
  if (target !== previewEngine) {
    return "";
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }
  const anchor = selection.anchorNode;
  if (!anchor || !isWithinPreview(anchor)) {
    return "";
  }
  return clampSeed(selection.toString());
}

// `Node.contains` does not cross shadow boundaries, and Diff view's visible
// text lives inside `<diffs-container>`'s shadow root — a selection there is
// part of the searched surface, but its anchor is not "contained" by
// `#preview` in light-DOM terms. Climb host chains until the light tree.
function isWithinPreview(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (previewElement.contains(current)) {
      return true;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

// Open the bar against `target`. Reopening against a different surface swaps
// the engine and clears the previous one, so one surface's highlights never
// linger while another is being searched.
export function openFindBar(target: FindEngine): void {
  if (engine !== null && engine !== target) {
    engine.unwatch?.();
    engine.clear();
    engine.setOnOutcome(null);
    receiveOutcome({ total: 0, index: -1, truncated: false, error: null });
  }
  engine = target;
  engine.setOnOutcome(receiveOutcome);
  engine.watch?.(refreshAfterContentChange);
  mountOn(engine);

  const seed = selectionSeed(target);
  if (!open) {
    open = true;
    findBarElement.hidden = false;
  }
  if (seed.length > 0) {
    queryInput.value = seed;
  }
  queryInput.focus();
  queryInput.select();
  run(true);
}

export function openPreviewFind(): void {
  if (!supportsHighlights()) {
    // Without the highlight API the bar would count matches it cannot show.
    // Leaving ⌘F alone beats opening something that does not work.
    return;
  }
  openFindBar(previewEngine);
}

export function closeFindBar(): void {
  if (!open) {
    return;
  }
  open = false;
  findBarElement.hidden = true;
  if (debounceHandle !== null) {
    window.clearTimeout(debounceHandle);
    debounceHandle = null;
  }
  const closing = engine;
  engine = null;
  closing?.unwatch?.();
  closing?.clear();
  closing?.setOnOutcome(null);
  total = 0;
  currentIndex = -1;
  truncated = false;
  patternError = null;
  render();
  // Hand focus back to the surface at the position the reader was left at, so
  // Space and PageDown keep working instead of falling through to the body.
  closing?.focusSurface();
}

// Relocate the bar onto the surface being searched, and say which one that is.
// Moving the element keeps every listener intact — they are bound to the
// controls, not to a position in the tree. Falls back to leaving the bar where
// it is if the surface has no slot (the terminal panel is absent when the
// backend is off).
function mountOn(target: FindEngine): void {
  const host = target.barHost();
  if (host && findBarElement.parentElement !== host) {
    host.appendChild(findBarElement);
  }
  const description = `Find in ${target.label}`;
  queryInput.placeholder = description;
  queryInput.setAttribute("aria-label", description);
}

function toggleOption(key: keyof MatchOptions): void {
  options = { ...options, [key]: !options[key] };
  run(true);
  render();
  queryInput.focus();
}

// Boot-time wiring. Called once by app.ts.
export function initFindBar(): void {
  queryInput.addEventListener("input", scheduleRun);
  queryInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeFindBar();
    }
  });
  caseToggle.addEventListener("click", () => toggleOption("caseSensitive"));
  wordToggle.addEventListener("click", () => toggleOption("wholeWord"));
  regexToggle.addEventListener("click", () => toggleOption("regex"));
  previousButton.addEventListener("click", () => step(-1));
  nextButton.addEventListener("click", () => step(1));
  closeButton.addEventListener("click", closeFindBar);
  render();
}

// Whether find should act on the preview at all. A binary notice or an empty
// preview has nothing to search.
export function previewIsSearchable(): boolean {
  const mode = appState.previewMode.kind;
  if (mode === "empty") {
    return false;
  }
  if (mode !== "document") {
    return true;
  }
  // A binary selection keeps `previewMode.kind` as "document" while rendering
  // either an image or the "not viewable" notice — chrome, not document text.
  // Opening a find bar over it would search nothing.
  return findDocument(appState.roots, appState.selectedId)?.kind !== "binary";
}
