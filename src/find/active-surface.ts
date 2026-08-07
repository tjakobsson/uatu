// Which surface the user is working in — the routing input for the find
// shortcut, and the owner of `appState.activeSurface`.
//
// This is tracked from user interaction rather than read from
// `document.activeElement`, because focus gives the wrong answer for the most
// common interaction in the app. Clicking a file in the tree leaves focus
// inside `@pierre/trees`' shadow root; a literal focus rule would then send
// ⌘F at the sidebar, when the user has just declared interest in a document.
// "Sidebar interaction means the preview" is a product judgement no DOM
// property can express, so it lives here as one.
//
// The other half of the reason is inertness: selection also changes from
// file-watcher events (follow-mode Rules C/D), and a background file change
// must not relocate the user's working context. The writers are the pointer
// and focus listeners below, joined by the committed touch-tab change they
// are bound alongside — and a tab only ever changes from a user action (a tab
// tap, a Rule A row click, the terminal's own keyboard shortcuts), never from
// the watcher. `active-surface.test.ts` asserts structurally that no
// file-event module reaches the setter OR the tab.

import { appState, type ActiveSurface, type TouchTab } from "../shell/state";
import { onActiveTabChange } from "../shell/tab-bar";
import { uiMode } from "../shell/ui-mode";

// The surface roots as they exist in the DOM. Sidebar is a root of its own
// rather than being folded into `preview` by selector, so that the
// sidebar-means-preview rule stays visible in `surfaceForRoot` instead of
// hiding inside a selector list.
export type SurfaceRoot = "preview" | "terminal" | "sidebar";

const ROOT_SELECTORS: ReadonlyArray<readonly [SurfaceRoot, string]> = [
  // Terminal first: the panel is a sibling of the preview shell inside
  // `.main-stack`, and checking it first keeps the match unambiguous if the
  // markup is ever nested differently.
  ["terminal", "#terminal-panel"],
  ["preview", ".preview-shell"],
  // `.sidebar-rail` is the collapsed sidebar's expand button, which sits
  // outside `.sidebar` but is still sidebar chrome.
  ["sidebar", ".sidebar, .sidebar-rail"],
];

// Narrow an event target to the element to walk up from. Targets that are not
// elements (the document, the window, a text node) have no ancestry worth
// consulting and resolve to no surface.
function elementFor(target: EventTarget | null): Element | null {
  if (target && typeof (target as Element).closest === "function") {
    return target as Element;
  }
  const parent = (target as Node | null)?.parentElement;
  return parent ?? null;
}

// The surface root an interaction landed in, or null when it landed on none
// of them (the app shell's own chrome, a resizer, the document background).
//
// Events originating inside the tree library's open shadow root arrive here
// already retargeted to its host element, so a plain `closest` walk is enough
// — no need to read composed paths.
export function findSurfaceRoot(target: EventTarget | null): SurfaceRoot | null {
  const element = elementFor(target);
  if (!element) {
    return null;
  }
  // The find bar is chrome belonging to whichever surface is being searched,
  // not a surface of its own. It is nested inside the preview shell for layout
  // reasons, so without this it would claim `preview` the moment its query box
  // takes focus — meaning opening find over the terminal silently reassigned
  // the surface, and the *next* ⌘F searched the document instead.
  if (element.closest("#find-bar")) {
    return null;
  }
  for (const [root, selector] of ROOT_SELECTORS) {
    if (element.closest(selector)) {
      return root;
    }
  }
  return null;
}

// Map a surface root to the surface find should act on. The sidebar is not a
// find target: directing it is an act about the document it is directing.
export function surfaceForRoot(root: SurfaceRoot | null): ActiveSurface | null {
  switch (root) {
    case "terminal":
      return "terminal";
    case "preview":
    case "sidebar":
      return "preview";
    default:
      return null;
  }
}

// The surface an interaction implies, or null when the interaction was not
// with a surface at all — in which case the current surface stands rather
// than being reset to a default.
export function resolveSurfaceFromTarget(target: EventTarget | null): ActiveSurface | null {
  return surfaceForRoot(findSurfaceRoot(target));
}

// The surface a touch tab presents once it is the active one.
export function surfaceForTab(tab: TouchTab): ActiveSurface {
  // Files renders the sidebar pane stack, and directing the sidebar is an act
  // about the document it directs — the same rule `surfaceForRoot` applies.
  return tab === "terminal" ? "terminal" : "preview";
}

export function getActiveSurface(): ActiveSurface {
  return appState.activeSurface;
}

// Owner mutator for `appState.activeSurface`. Everything else routes through
// `noteInteraction`, so there is exactly one place where a surface can be
// claimed and it is reachable only from a user event.
export function setActiveSurface(next: ActiveSurface): void {
  appState.activeSurface = next;
}

// Claim a surface from a user interaction. Interactions that land outside any
// surface leave the current one in place: clicking a resizer or the window
// chrome is not a statement about where you are working.
export function noteInteraction(target: EventTarget | null): void {
  const next = resolveSurfaceFromTarget(target);
  if (next !== null && next !== appState.activeSurface) {
    setActiveSurface(next);
  }
}

let listening = false;

// Bind the trackers. Capture phase, because a surface that stops propagation
// for its own reasons (xterm does, for keyboard handling) must not be able to
// hide the fact that the user just interacted with it.
export function initActiveSurfaceTracking(): void {
  if (listening) {
    return;
  }
  listening = true;
  const handle = (event: Event): void => {
    noteInteraction(event.target);
  };
  document.addEventListener("pointerdown", handle, { capture: true });
  document.addEventListener("focusin", handle, { capture: true });

  // Touch mode presents one surface at a time, so a COMMITTED tab change is
  // itself the statement of where the user is now working — and the only
  // reliable one. The tab bar sits outside every surface root, so resolving a
  // tab tap through the listeners above got it wrong in both directions:
  // `pointerdown`/`focusin` fire before the bar's click commits (press a tab
  // and drag off, or merely focus it with a keyboard, and a surface is
  // claimed that never becomes visible), while the terminal panel changes
  // tabs from seven call sites of its own — Ctrl/Cmd+`, Escape, leaving
  // fullscreen, boot fallbacks — that produce no tab-bar event at all and so
  // left the surface stale. Subscribing to the change covers every path
  // exactly once. Desktop mode renders all surfaces together, where which tab
  // is "active" says nothing about where the user is working.
  onActiveTabChange(tab => {
    if (uiMode() === "touch") {
      setActiveSurface(surfaceForTab(tab));
    }
  });
}
