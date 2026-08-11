// Document outline overlay — a non-modal panel that lists the rendered
// document's headings as a nested, clickable jump-list, highlights the heading
// currently scrolled into view, supports filtering, and can be resized (and
// remembers that size). It can float over the content or dock beside it (a
// reserved gutter reflows the document so the panel never covers text); the
// dock/float choice persists. Built by enumerating the rendered DOM, so it
// works identically for Markdown and AsciiDoc with no renderer-specific logic.
// The panel is anchored to the top-right of the preview area.
//
// Lifecycle: `refreshOutline()` is called from `mount.ts` after every document
// render (single or split). It rebuilds the heading list and re-points the
// scroll-spy listener at whichever element actually scrolls for the current
// layout — `.preview-shell` in single layout, `.preview-pane-rendered` when
// split — so the overlay survives live document remounts and layout switches.
// `initOutline()` wires the toggle / copy-source / filter / resize controls
// once at boot.

import { appUrl } from "../shared/app-url";
import { contextualAppUrl } from "../shell/watch-context";
import {
  previewScrollEventTarget,
  previewScrollRoot,
  scrollportRect,
} from "../shell/preview-scroll-root";
import { coarsePointer, onUiModeChange } from "../shell/ui-mode";
import { presentationLocalStorage } from "../shell/presentation-storage";
import type { ViewMode } from "../shared/types";
import { copyToClipboard } from "./code-block";
import { copySourceButton, outlineToggleButton } from "./header";
import { collectHeadings, type OutlineHeading } from "./outline-headings";
import {
  pickPresentation,
  type OutlinePresentation,
  type PreviewArea,
} from "./outline-presentation";

export { collectHeadings, cleanHeadingText, type OutlineHeading } from "./outline-headings";

const WIDTH_KEY = "uatu:outline-width";
const MIN_WIDTH = 200; // px
const DEFAULT_WIDTH = 288; // px (~18rem) used until the user resizes
const MIN_CONTENT = 280; // px of document kept visible beside a docked outline
const EDGE_MARGIN = 16; // px kept between the panel and the preview-area edges

function readWidthPreference(): number | null {
  try {
    const raw = presentationLocalStorage()?.getItem(WIDTH_KEY) ?? null;
    const value = raw === null ? NaN : Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeWidthPreference(width: number): void {
  try {
    presentationLocalStorage()?.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // best-effort persistence; localStorage may be disabled
  }
}

// Module-level overlay state. The panel is created once (lazily) and reused
// across documents; the heading list and scroll-spy observer are rebuilt on
// every refresh. The outline is always docked — it reserves a right-hand gutter
// so the document reflows beside it (never covering text), like a side panel.
let panel: HTMLElement | null = null;
let listElement: HTMLElement | null = null;
let filterInput: HTMLInputElement | null = null;
let open = false;
let width = readWidthPreference() ?? DEFAULT_WIDTH;
let currentHeadings: OutlineHeading[] = [];
let currentDocId: string | null = null;
// Scroll-spy state: the element that actually scrolls for the current layout,
// its bound scroll listener, and a rAF handle so we recompute at most once per
// frame while scrolling.
let scrollRootElement: HTMLElement | null = null;
// Kept separately from the element because they are not the same object when
// the page is the scroller: scroll events for the viewport scroller fire at
// the *document*, never at `documentElement`.
let scrollEventTarget: EventTarget | null = null;
let scrollListener: (() => void) | null = null;
let scrollRafId: number | null = null;

function mainStackElement(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".main-stack");
  if (!el) {
    throw new Error("uatu UI failed to initialize (preview/outline)");
  }
  return el;
}

function ensurePanel(): HTMLElement {
  if (panel) {
    return panel;
  }
  const root = mainStackElement();
  const aside = document.createElement("aside");
  aside.className = "uatu-outline";
  aside.setAttribute("aria-label", "Document outline");
  aside.hidden = true;

  // Width drag handle on the left edge — the panel docks on the right, so its
  // left edge resizes horizontally, mirroring the app's other side panels
  // (sidebar, right-docked terminal). Height is always full, so there is no
  // vertical resize, fit, or reset to manage.
  const resizer = document.createElement("div");
  resizer.className = "uatu-outline-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-label", "Resize outline");
  attachResizeHandle(aside, resizer);

  const head = document.createElement("div");
  head.className = "uatu-outline-head";

  const title = document.createElement("span");
  title.className = "uatu-outline-title";
  title.textContent = "Outline";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "uatu-outline-close";
  closeButton.title = "Close outline";
  closeButton.setAttribute("aria-label", "Close outline");
  closeButton.textContent = "✕";
  closeButton.addEventListener("click", () => setOpen(false));

  head.append(title, closeButton);

  const filter = document.createElement("input");
  filter.type = "text";
  filter.className = "uatu-outline-filter";
  filter.placeholder = "Filter headings…";
  filter.setAttribute("aria-label", "Filter headings");
  filter.addEventListener("input", () => applyFilter());

  const list = document.createElement("nav");
  list.className = "uatu-outline-list";
  list.setAttribute("aria-label", "Document headings");

  aside.append(resizer, head, filter, list);
  root.appendChild(aside);

  panel = aside;
  listElement = list;
  filterInput = filter;

  // The panel is anchored to .main-stack (a non-scrolling parent, so it stays
  // pinned as the preview scrolls), but it must align with the *preview-shell*
  // sub-region — not the whole main area, which also contains the terminal. When
  // the terminal docks (especially right-dock, where main-stack becomes a row),
  // the preview-shell shrinks/moves; re-lay-out while open.
  const shell = previewShellEl();
  if (shell) {
    const observer = new ResizeObserver(() => {
      if (open) {
        layoutPanel();
      }
    });
    observer.observe(shell);
  }

  return aside;
}

function previewShellEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".preview-shell");
}

// The area the outline actually has to work with.
//
// Width comes from the preview shell — the region the panel docks into, which
// is what shrinks when the terminal docks right or the sidebar widens. Height
// must come from the SCROLLPORT instead: in touch mode and the ≤900px stacked
// layout the shell is `height: auto` with the page scrolling, so its rect
// height is the length of the whole document rather than the room on screen.
// Asking the shell for both is exactly the mistake that sized the panel at
// 57,220px.
function previewArea(): PreviewArea | null {
  const shell = previewShellEl();
  if (!shell) {
    return null;
  }
  const shellStyle = getComputedStyle(shell);
  const preview = document.querySelector<HTMLElement>("#preview");
  // The document's own left padding, counted for BOTH sides on purpose: its
  // right padding is the reserved outline gutter whenever the rail is open, so
  // reading it back would fold the rail's width into the measurement and let
  // the answer depend on the previous answer. The natural padding is symmetric,
  // so the left side is the honest sample.
  const previewPadLeft = preview ? parseFloat(getComputedStyle(preview).paddingLeft) || 0 : 0;
  return {
    width: shell.getBoundingClientRect().width,
    height: scrollportRect(previewScrollRoot()).height,
    documentPadding:
      (parseFloat(shellStyle.paddingLeft) || 0)
      + (parseFloat(shellStyle.paddingRight) || 0)
      + previewPadLeft * 2,
  };
}

// The last resolution that came from a real measurement, so an unmeasurable
// moment can answer with the truth from just before it instead of a guess.
let lastPresentation: OutlinePresentation = "rail";

// Resolved per call, never cached — the available width changes on rotation, a
// window drag, a UI-mode switch, and a terminal dock, and the same reasoning
// `preview-scroll-root` gives applies: the resolution is cheap and caching it
// would buy nothing while costing correctness.
//
// A zero measurement is the one thing that must NOT be taken at face value. The
// preview shell is `display: none` for a frame during a touch-mode tab switch,
// and a hidden element measures 0 — which is not "narrow", it is the absence of
// an answer. Reading it as narrow would resolve to the sheet and dismiss an
// open rail on every iPad document change.
function currentPresentation(): OutlinePresentation {
  const area = previewArea();
  if (!area || area.width === 0 || area.height === 0) {
    return lastPresentation;
  }
  lastPresentation = pickPresentation(area);
  return lastPresentation;
}

// Fixed bottom chrome that overlays the scrollport rather than shortening it.
// The touch tab bar is `position: fixed` over the layout viewport, so
// `documentElement.clientHeight` still counts the strip underneath it — a
// full-height rail measured from the scrollport alone would run below the bar.
// Measured from the element so a hidden bar contributes nothing without this
// having to ask which mode is live.
function bottomChromeInset(): number {
  const bar = document.querySelector<HTMLElement>(".touch-tab-bar");
  return bar ? bar.getBoundingClientRect().height : 0;
}

// Position and size the panel against the preview's SCROLLPORT — the box the
// reader can actually see — in viewport coordinates, for both presentations.
//
// Emphatically NOT against the shell's bounding box. In touch mode and the
// ≤900px stacked layout the shell is `height: auto` with the page scrolling, so
// its rect describes the entire document: measuring it gave the rail a height
// of 12,395px on iPad and 57,220px on iPhone, scrolled it out of reach with the
// page, and let its empty lower reaches cover the very toggle that would close
// it (#231). The horizontal extent still comes from the shell, which IS the
// region the outline belongs to and the thing that narrows when the terminal
// docks right.
//
// Re-runs whenever the shell changes (terminal dock/resize, window resize,
// rotation, UI-mode switch) while open.
function layoutPanel(): void {
  if (!panel) {
    return;
  }
  const shell = previewShellEl();
  if (!shell) {
    return;
  }

  // The presentation attribute is what the stylesheet keys on, so it is stamped
  // before either branch runs — including when the panel is closed, so a sheet
  // never paints one frame as a rail on open.
  const presentation = currentPresentation();
  panel.dataset.presentation = presentation;

  const shellRect = shell.getBoundingClientRect();
  const port = scrollportRect(previewScrollRoot());
  // The lowest the panel may reach: the scrollport's own bottom, or the top of
  // the fixed bottom chrome, whichever comes first.
  const usableBottom = Math.min(port.bottom, window.innerHeight - bottomChromeInset());
  // ...expressed as a distance up from the window's bottom edge, which is what
  // a `bottom` offset on a fixed element wants.
  const bottomGap = Math.max(0, window.innerHeight - usableBottom);

  if (presentation === "sheet") {
    // Fills the preview SURFACE, not the window. In touch mode the scrollport
    // is the viewport, so this is the fullscreen sheet above the tab bar; on a
    // desktop with the terminal right-docked it covers the preview pane and
    // leaves the sidebar and terminal reachable, instead of blanketing both.
    panel.style.setProperty("--outline-surface-top", `${Math.round(port.top)}px`);
    panel.style.setProperty("--outline-surface-left", `${Math.round(shellRect.left)}px`);
    panel.style.setProperty("--outline-surface-width", `${Math.round(shellRect.width)}px`);
    panel.style.setProperty("--outline-surface-gap", `${Math.round(bottomGap)}px`);
    // The rail's inline geometry has to come back off, or it would out-specify
    // the sheet's stylesheet rules and win.
    panel.style.removeProperty("top");
    panel.style.removeProperty("right");
    panel.style.removeProperty("height");
    panel.style.removeProperty("width");
    // A sheet covers the preview rather than sitting beside it, so it reserves
    // nothing. This is also what releases the gutter when a rail becomes a
    // sheet mid-session (a rotation, or docking the terminal).
    releaseGutter();
    return;
  }

  // The sticky preview header covers the top of the scrollport in single
  // layout; in split layout the rendered pane starts below it and there is no
  // overlap. Taking the lower of the two edges handles both without asking
  // which layout is live.
  const header = document.querySelector<HTMLElement>(".preview-header");
  const contentTop = Math.max(port.top, header ? header.getBoundingClientRect().bottom : port.top + 64);
  const top = contentTop + 8;

  panel.style.top = `${Math.round(top)}px`;
  panel.style.right = `${Math.round(Math.max(0, window.innerWidth - shellRect.right) + EDGE_MARGIN)}px`;
  panel.style.height = `${Math.round(Math.max(120, usableBottom - top - EDGE_MARGIN))}px`;

  // Clamp width so at least MIN_CONTENT of document stays visible beside it.
  const maxWidth = Math.max(MIN_WIDTH, shellRect.width - MIN_CONTENT);
  const clamped = Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth));
  panel.style.width = `${clamped}px`;
  shell.style.setProperty("--outline-gutter", `${clamped + EDGE_MARGIN}px`);
  shell.classList.add("is-outline-docked");
}

// Release the reserved document gutter (panel closing / hidden / no headings),
// so a hidden outline never leaves the document narrowed.
function releaseGutter(): void {
  const shell = previewShellEl();
  if (!shell) {
    return;
  }
  shell.classList.remove("is-outline-docked");
  shell.style.removeProperty("--outline-gutter");
}

function attachResizeHandle(panelEl: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener("pointerdown", event => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    const startX = event.clientX;
    const startWidth = panelEl.getBoundingClientRect().width;

    const onMove = (move: PointerEvent) => {
      // Left-edge handle on a right-docked panel: dragging left (smaller
      // clientX) widens, dragging right narrows.
      width = startWidth + (startX - move.clientX);
      layoutPanel();
    };
    const onUp = (up: PointerEvent) => {
      handle.releasePointerCapture(up.pointerId);
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // Persist the clamped width that actually took effect.
      width = panelEl.getBoundingClientRect().width;
      writeWidthPreference(width);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

// Scroll the outline's OWN list so the active entry is visible.
//
// Written against the list's `scrollTop` rather than `scrollIntoView`, which
// scrolls every scrollable ancestor as well — including the page in touch mode
// and the stacked layout. That would move the reader away from the position
// they opened the outline to inspect, which is the opposite of the point.
function revealActiveEntry(): void {
  const list = listElement;
  if (!list) {
    return;
  }
  const active = list.querySelector<HTMLElement>(".uatu-outline-link.is-active");
  if (!active) {
    return;
  }
  const listRect = list.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  // Centre the entry in the list's scrollport. The browser clamps to the
  // scrollable range, so an active entry near either end simply lands at that
  // end — which is why opening at the top of a document still shows entry one.
  list.scrollTop += activeRect.top - listRect.top - (list.clientHeight - activeRect.height) / 2;
}

function setOpen(next: boolean): void {
  open = next;
  if (panel) {
    panel.hidden = !next;
    if (next) {
      layoutPanel();
      // After layout, so the list has its final height to centre within.
      revealActiveEntry();
    } else {
      releaseGutter();
    }
  }
  outlineToggleButton.setAttribute("aria-pressed", String(next));
  // Focusing the filter raises the software keyboard over the very list the
  // panel was opened to read. Gated on the pointer rather than the presentation
  // because this is an input-device question — an iPad in desktop mode still
  // has no cursor — matching how the keybar and size steppers are gated.
  if (next && filterInput && !coarsePointer()) {
    filterInput.focus();
  }
}

// Hide the overlay and tear down its scroll-spy observer. Used when the active
// view can no longer host an outline (non-rendered view, no headings).
function teardownOutline(): void {
  detachScrollSpy();
  currentHeadings = [];
  outlineToggleButton.hidden = true;
  outlineToggleButton.setAttribute("aria-pressed", "false");
  open = false;
  if (panel) {
    panel.hidden = true;
  }
  if (listElement) {
    listElement.replaceChildren();
  }
  // Release the docked gutter so a hidden outline never narrows the document.
  releaseGutter();
}

// Build the clickable heading list. Each entry navigates by scrolling its
// captured element reference into view, which works even when ids are missing
// or duplicated.
function buildList(headings: OutlineHeading[]): void {
  ensurePanel();
  const list = listElement;
  if (!list) {
    return;
  }
  list.replaceChildren();
  for (const heading of headings) {
    const link = document.createElement("a");
    link.className = "uatu-outline-link";
    link.dataset.level = String(heading.level);
    link.textContent = heading.text;
    link.title = heading.text;
    // A real href when an id exists keeps the entry copyable / middle-clickable;
    // navigation itself is handled by the click listener against the element
    // reference, so a missing id is fine.
    link.href = heading.id ? `#${heading.id}` : "#";
    link.addEventListener("click", event => {
      event.preventDefault();
      heading.element.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveLink(heading.element);
      // A sheet covers the document it just navigated, so staying open would
      // hide the destination. The rail sits beside the document and stays, as
      // it always has.
      if (currentPresentation() === "sheet") {
        setOpen(false);
      }
    });
    list.appendChild(link);
  }
}

function linkForElement(element: Element): HTMLElement | null {
  if (!listElement) {
    return null;
  }
  const index = currentHeadings.findIndex(heading => heading.element === element);
  if (index < 0) {
    return null;
  }
  return listElement.children.item(index) as HTMLElement | null;
}

function setActiveLink(element: Element): void {
  if (!listElement) {
    return;
  }
  for (const child of Array.from(listElement.children)) {
    child.classList.remove("is-active");
  }
  const active = linkForElement(element);
  active?.classList.add("is-active");
}

// Filter visible entries by case-insensitive substring. Filtering only toggles
// row visibility — it never touches the active-heading tracking, so the real
// scrolled-to heading keeps its highlight underneath even when filtered out.
function applyFilter(): void {
  if (!listElement || !filterInput) {
    return;
  }
  const query = filterInput.value.trim().toLowerCase();
  let anyVisible = false;
  Array.from(listElement.children).forEach((child, index) => {
    const heading = currentHeadings[index];
    const matches = !query || (heading?.text.toLowerCase().includes(query) ?? false);
    (child as HTMLElement).hidden = !matches;
    if (matches) {
      anyVisible = true;
    }
  });
  let empty = listElement.querySelector<HTMLElement>(".uatu-outline-empty");
  if (!anyVisible) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "uatu-outline-empty";
      empty.textContent = "No matching headings";
      listElement.appendChild(empty);
    }
    empty.hidden = false;
  } else if (empty) {
    empty.hidden = true;
  }
}

// Re-point the spy when the effective scroll container has changed underneath
// it. A no-op while no outline is live, and a no-op when the container is
// still the same one — so the resize handler this hangs off costs a single
// computed-style read per event.
function resyncScrollSpy(): void {
  if (currentHeadings.length === 0 || scrollRootElement === null) {
    return;
  }
  const root = previewScrollRoot();
  if (root === scrollRootElement) {
    return;
  }
  attachScrollSpy(root, previewScrollEventTarget());
}

// Detach the scroll-spy listener (and cancel any pending frame). Called on
// teardown and before re-attaching to a new scroll container.
function detachScrollSpy(): void {
  if (scrollListener && scrollEventTarget) {
    scrollEventTarget.removeEventListener("scroll", scrollListener);
  }
  if (scrollRafId !== null) {
    window.cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
  scrollListener = null;
  scrollRootElement = null;
  scrollEventTarget = null;
}

// (Re)attach scroll-spy to the element that actually scrolls for the current
// layout. We track by scroll position rather than IntersectionObserver: an
// observer can only flag a heading "active" once it reaches a trigger band near
// the viewport top, but the document's final sections sit in the last screenful
// with no scroll runway left to push them up there — so they could never
// activate and the highlight stuck on the last heading that did. The
// position-based scan plus an explicit at-bottom rule fixes that tail.
function attachScrollSpy(scrollRoot: HTMLElement, eventTarget: EventTarget): void {
  detachScrollSpy();
  scrollRootElement = scrollRoot;
  scrollEventTarget = eventTarget;
  scrollListener = () => {
    if (scrollRafId !== null) {
      return;
    }
    scrollRafId = window.requestAnimationFrame(() => {
      scrollRafId = null;
      updateActiveHeading();
    });
  };
  eventTarget.addEventListener("scroll", scrollListener, { passive: true });
  // Compute an initial active heading so the highlight is correct before the
  // first scroll event fires.
  updateActiveHeading();
}

// Pick the active heading from the current scroll position. A heading "wants"
// to activate when its top reaches a trigger line just below the sticky header
// — i.e. at a specific scrollTop, its *activation point*. The active heading is
// the last one whose activation point we have passed.
//
// The complication is the document's tail: the closing sections sit in the
// final screenful, so their natural activation points lie beyond the maximum
// scrollTop and can never be reached. Rather than snap to the last heading at
// the very bottom (which skips every section in between), we redistribute those
// unreachable activation points evenly across the remaining scroll distance.
// The highlight then steps through the closing sections as the user scrolls the
// last screenful, landing on the final heading exactly at the bottom.
function updateActiveHeading(): void {
  const scrollRoot = scrollRootElement;
  if (!scrollRoot || currentHeadings.length === 0) {
    return;
  }
  // The SCROLLPORT, not the bounding box. For the viewport scroller the
  // bounding box has `top: -scrollTop`, which would double-count the offset in
  // `offsetInContent` below and push every activation point further out of
  // reach the further down the page the reader is.
  const rootRect = scrollportRect(scrollRoot);

  // The sticky preview-header overlaps the top of the scroll viewport in single
  // layout (the shell scrolls beneath it); in split layout the rendered pane
  // starts below the header so there is no overlap. Measure it either way so
  // the trigger line sits just under whatever covers the top.
  const header = document.querySelector<HTMLElement>(".preview-header");
  const overlap = header
    ? Math.max(0, header.getBoundingClientRect().bottom - rootRect.top)
    : 0;
  const triggerOffset = overlap + 8;
  const scrollTop = scrollRoot.scrollTop;
  const maxScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);

  // Natural activation point of each heading: the scrollTop at which its top
  // crosses the trigger line. `rect.top - rootRect.top + scrollTop` is the
  // heading's offset from the top of the scrollable content.
  const activations = currentHeadings.map(heading => {
    const offsetInContent = heading.element.getBoundingClientRect().top - rootRect.top + scrollTop;
    return offsetInContent - triggerOffset;
  });

  // Redistribute the unreachable tail (headings whose natural activation lies
  // beyond maxScroll) evenly across the remaining scroll distance, so each gets
  // its own slice of the final screenful instead of all snapping at the bottom.
  // `tailStart < 0` → every heading is reachable, no redistribution needed.
  // `tailStart === 0` → even the first heading never reaches the trigger line
  // (e.g. a barely-scrollable document); we intentionally skip redistribution
  // and fall through to highlighting the first heading.
  const tailStart = activations.findIndex(point => point > maxScroll);
  if (tailStart > 0) {
    const base = activations[tailStart - 1]!;
    const count = activations.length - tailStart;
    const span = maxScroll - base;
    for (let j = 0; j < count; j++) {
      activations[tailStart + j] = base + (span * (j + 1)) / count;
    }
  }

  let activeIndex = 0;
  for (let i = 0; i < activations.length; i++) {
    // +1px tolerance so the final heading reliably activates at the exact bottom.
    if (scrollTop + 1 >= activations[i]!) {
      activeIndex = i;
    } else {
      break;
    }
  }
  setActiveLink(currentHeadings[activeIndex]!.element);
}

// Resolve the heading-enumeration root and scroll container for the current
// layout. The headings root is a rendering question — the rendered pane when
// split, `#preview` otherwise — while the scroll container is the shared
// question `shell/preview-scroll-root` answers for every caller. This used to
// answer both itself, and its scroll half was the only place in the codebase
// that reasoned about the split layout at all; delegating keeps one rule
// instead of growing a second.
function resolveRoots(): { headingsRoot: HTMLElement; scrollRoot: HTMLElement } | null {
  const previewElement = document.querySelector<HTMLElement>("#preview");
  const previewShell = document.querySelector<HTMLElement>(".preview-shell");
  if (!previewElement || !previewShell) {
    return null;
  }
  const renderedPane = previewElement.querySelector<HTMLElement>(".preview-pane-rendered");
  return {
    headingsRoot: renderedPane ?? previewElement,
    scrollRoot: previewScrollRoot(),
  };
}

export type OutlineDocument = {
  id: string;
  kind: "markdown" | "asciidoc" | "text";
  view: ViewMode;
};

// Re-evaluate the action bar and outline for the freshly-rendered document.
// Called from mount.ts after every render. `doc` is null for non-document
// previews (commit / empty), which hide the whole bar.
export function refreshOutline(doc: OutlineDocument | null): void {
  const isDocKind = doc !== null && (doc.kind === "markdown" || doc.kind === "asciidoc");
  const renderedVisible = doc !== null && doc.view === "rendered";

  // Both copy-source and the outline are Rendered-view affordances for
  // markdown / asciidoc. Outside that, hide the bar entirely.
  if (!doc || !isDocKind || !renderedVisible) {
    copySourceButton.hidden = true;
    teardownOutline();
    return;
  }

  // Captured before the assignment: a live remount of the SAME document (a
  // watched file changed) must not be mistaken for the user opening a different
  // one, or every save would dismiss an open sheet.
  const documentChanged = currentDocId !== doc.id;
  currentDocId = doc.id;
  copySourceButton.hidden = false;

  const roots = resolveRoots();
  const headings = roots ? collectHeadings(roots.headingsRoot) : [];

  // A document with no headings has nothing to outline — keep copy-source but
  // hide the outline toggle (and close the panel if it was open).
  if (!roots || headings.length === 0) {
    teardownOutline();
    return;
  }

  currentHeadings = headings;
  outlineToggleButton.hidden = false;
  buildList(headings);
  applyFilter();
  attachScrollSpy(roots.scrollRoot, previewScrollEventTarget());
  // Preserve the open/closed state across remounts (panel stays open if the
  // user had it open); default is closed. The sheet is the exception: it covers
  // the preview, so carrying it across a document change would leave a modal
  // surface on top of the document the user just chose to open.
  setOpen(open && !(documentChanged && currentPresentation() === "sheet"));
}

async function handleCopySource(): Promise<void> {
  if (!currentDocId) {
    return;
  }
  try {
    // Fetch the raw source by document *id*, not by path. Id-scoped so it always
    // resolves the selected document even when two watched roots share a
    // relative path, and free of URL-delimiter pitfalls in file names (`#`,
    // `?`, spaces) that a path-based URL would misparse. The source view returns
    // the raw text escaped inside a `<pre>`; reading it back as textContent
    // recovers the source verbatim.
    const response = await fetch(
      contextualAppUrl(appUrl(`/api/document?id=${encodeURIComponent(currentDocId)}&view=source`)),
    );
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const payload = (await response.json()) as { html?: string };
    const scratch = document.createElement("div");
    scratch.innerHTML = payload.html ?? "";
    const text = scratch.textContent ?? "";
    await copyToClipboard(text);
    flashActionIcon(copySourceButton, "is-copied");
  } catch {
    flashActionIcon(copySourceButton, "is-failed");
  }
}

let flashTimeoutId: number | null = null;

function flashActionIcon(button: HTMLButtonElement, modifier: string): void {
  button.classList.add(modifier);
  if (flashTimeoutId !== null) {
    window.clearTimeout(flashTimeoutId);
  }
  flashTimeoutId = window.setTimeout(() => {
    button.classList.remove("is-copied", "is-failed");
    flashTimeoutId = null;
  }, 1200);
}

// Boot-time wiring for the action bar's click handlers and the global Escape
// shortcut. Called once by app.ts.
export function initOutline(): void {
  // The effective scroll container can change with no document remount and no
  // scroll event on the container we are currently listening to: switching UI
  // mode swaps it outright, and crossing the ≤900px stacked breakpoint by
  // resizing or rotating does the same in desktop mode. Left unhandled, the
  // spy stays bound to an element that will never fire again and the active
  // heading freezes.
  // The same events also change the width the presentation is resolved from —
  // a rotation, a window drag, or a mode flip can carry the preview across the
  // rail/sheet threshold with the panel open. Re-laying out is what adopts the
  // new presentation; the panel deliberately stays open across the swap.
  const onViewportChange = (): void => {
    resyncScrollSpy();
    if (open) {
      layoutPanel();
    }
  };
  onUiModeChange(onViewportChange);
  window.addEventListener("resize", onViewportChange, { passive: true });

  outlineToggleButton.addEventListener("click", () => {
    ensurePanel();
    setOpen(!open);
  });
  copySourceButton.addEventListener("click", () => void handleCopySource());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && open) {
      setOpen(false);
      outlineToggleButton.focus();
    }
  });
}
