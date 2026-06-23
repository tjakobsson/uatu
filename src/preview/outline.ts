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

import type { ViewMode } from "../shared/types";
import { copyToClipboard } from "./code-block";
import { copySourceButton, outlineToggleButton } from "./header";
import { collectHeadings, type OutlineHeading } from "./outline-headings";

export { collectHeadings, cleanHeadingText, type OutlineHeading } from "./outline-headings";

const WIDTH_KEY = "uatu:outline-width";
const MIN_WIDTH = 200; // px
const DEFAULT_WIDTH = 288; // px (~18rem) used until the user resizes
const MIN_CONTENT = 280; // px of document kept visible beside a docked outline
const EDGE_MARGIN = 16; // px kept between the panel and the preview-area edges

function readWidthPreference(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const value = raw === null ? NaN : Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeWidthPreference(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
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
let currentDocPath: string | null = null;
// Scroll-spy state: the element that actually scrolls for the current layout,
// its bound scroll listener, and a rAF handle so we recompute at most once per
// frame while scrolling.
let scrollRootElement: HTMLElement | null = null;
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

// Position and size the docked panel against the preview-shell: pinned just
// below the sticky header, full height down to the shell's bottom, flush to the
// right edge, at the current (clamped) width. Reserves the matching gutter on
// the document so its content reflows beside the panel. Re-runs whenever the
// shell changes (terminal dock/resize, window resize) while open.
function layoutPanel(): void {
  if (!panel) {
    return;
  }
  const shell = previewShellEl();
  if (!shell) {
    return;
  }
  const stackRect = mainStackElement().getBoundingClientRect();
  const shellRect = shell.getBoundingClientRect();
  const header = document.querySelector<HTMLElement>(".preview-header");
  const headerHeight = header ? header.getBoundingClientRect().height : 64;
  const topOffset = Math.max(0, shellRect.top - stackRect.top) + headerHeight + 8;

  panel.style.top = `${topOffset}px`;
  panel.style.right = `${Math.max(0, stackRect.right - shellRect.right) + EDGE_MARGIN}px`;
  panel.style.height = `${Math.max(120, shellRect.height - headerHeight - 8 - EDGE_MARGIN)}px`;

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

function setOpen(next: boolean): void {
  open = next;
  if (panel) {
    panel.hidden = !next;
    if (next) {
      layoutPanel();
    } else {
      releaseGutter();
    }
  }
  outlineToggleButton.setAttribute("aria-pressed", String(next));
  if (next && filterInput) {
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
  const panelEl = ensurePanel();
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
    });
    list.appendChild(link);
  }
  void panelEl;
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

// Detach the scroll-spy listener (and cancel any pending frame). Called on
// teardown and before re-attaching to a new scroll container.
function detachScrollSpy(): void {
  if (scrollListener && scrollRootElement) {
    scrollRootElement.removeEventListener("scroll", scrollListener);
  }
  if (scrollRafId !== null) {
    window.cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
  scrollListener = null;
  scrollRootElement = null;
}

// (Re)attach scroll-spy to the element that actually scrolls for the current
// layout. We track by scroll position rather than IntersectionObserver: an
// observer can only flag a heading "active" once it reaches a trigger band near
// the viewport top, but the document's final sections sit in the last screenful
// with no scroll runway left to push them up there — so they could never
// activate and the highlight stuck on the last heading that did. The
// position-based scan plus an explicit at-bottom rule fixes that tail.
function attachScrollSpy(scrollRoot: HTMLElement): void {
  detachScrollSpy();
  scrollRootElement = scrollRoot;
  scrollListener = () => {
    if (scrollRafId !== null) {
      return;
    }
    scrollRafId = window.requestAnimationFrame(() => {
      scrollRafId = null;
      updateActiveHeading();
    });
  };
  scrollRoot.addEventListener("scroll", scrollListener, { passive: true });
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
  const rootRect = scrollRoot.getBoundingClientRect();

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
// layout. In split layout both are the rendered pane; in single layout the
// headings live directly under #preview and the shell is the scroll container.
function resolveRoots(): { headingsRoot: HTMLElement; scrollRoot: HTMLElement } | null {
  const previewElement = document.querySelector<HTMLElement>("#preview");
  const previewShell = document.querySelector<HTMLElement>(".preview-shell");
  if (!previewElement || !previewShell) {
    return null;
  }
  const renderedPane = previewElement.querySelector<HTMLElement>(".preview-pane-rendered");
  if (renderedPane) {
    return { headingsRoot: renderedPane, scrollRoot: renderedPane };
  }
  return { headingsRoot: previewElement, scrollRoot: previewShell };
}

export type OutlineDocument = {
  path: string;
  kind: "markdown" | "asciidoc" | "text";
  view: ViewMode;
};

// Re-evaluate the action bar and outline for the freshly-rendered document.
// Called from mount.ts after every render. `doc` is null for non-document
// previews (commit / review-score / empty), which hide the whole bar.
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

  currentDocPath = doc.path;
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
  attachScrollSpy(roots.scrollRoot);
  // Preserve the open/closed state across remounts (panel stays open if the
  // user had it open); default is closed.
  setOpen(open);
}

async function handleCopySource(): Promise<void> {
  if (!currentDocPath) {
    return;
  }
  try {
    const response = await fetch(
      new URL(currentDocPath.replace(/^\/+/, ""), `${window.location.origin}/`).toString(),
    );
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const text = await response.text();
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
