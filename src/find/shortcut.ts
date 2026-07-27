// Find-shortcut routing: the one place that decides which surface ⌘F acts on.
//
// The rule is a single line — find searches the active surface — and the
// interesting part is what "active" means. It is not DOM focus; see
// `active-surface.ts` for why. Surfaces with no find of their own fall
// through to the preview, which is what makes ⌘F work immediately after a
// tree click.

import { detectIsMac } from "../terminal/clipboard";
import { getActiveSurface } from "./active-surface";
import type { FindEngine } from "./engine";
import {
  closeFindBar,
  getPreviewEngine,
  isFindBarOpen,
  openFindBar,
  previewIsSearchable,
  step,
} from "./find-bar";
import { supportsHighlights } from "./highlight";
import { clampSeed } from "./find-status";

// The terminal registers its engine here rather than this module importing the
// terminal — the router should not have to know how a surface searches itself,
// only that it can.
let terminalEngine: FindEngine | null = null;

// Project search registers here rather than this module importing the sidebar,
// keeping the shortcut router free of feature dependencies in both directions.
let projectSearch: ((seed: string) => void) | null = null;

export function registerProjectSearch(open: ((seed: string) => void) | null): void {
  projectSearch = open;
}

// Selections seed both find and search, with the same clamping: a multi-line
// or paragraph-length selection is not a search term.
function seedFromSelection(): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return "";
  }
  return clampSeed(selection.toString());
}

export function registerTerminalFind(engine: FindEngine | null): void {
  terminalEngine = engine;
}

// Whether any available signal says this is a Mac.
//
// `detectIsMac()` in the terminal module prefers `navigator.userAgentData` and
// falls back to `navigator.platform`. That is right for its purpose, but it is
// not safe here: UA-Client-Hints is reduced or spoofed in some environments —
// headless Chromium reports `userAgentData.platform === "Windows"` while
// `navigator.platform` still says `MacIntel` — and trusting the first signal
// alone would make ⌘F silently do nothing on the platform this feature exists
// for. Taking either signal as sufficient errs toward "is a Mac", which is the
// safe direction for the one decision that depends on it below.
function looksLikeMac(): boolean {
  if (detectIsMac()) {
    return true;
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  return (navigator.platform ?? "").toLowerCase().startsWith("mac");
}

// ⌘ always means find — no platform binds Super+F to anything that would
// conflict. Ctrl means find only off the Mac: claiming Ctrl+F there would take
// readline's forward-char away from every shell in the embedded terminal.
function hasPrimaryModifier(event: KeyboardEvent): boolean {
  if (event.metaKey) {
    return !event.ctrlKey;
  }
  return event.ctrlKey && !looksLikeMac();
}

// Which engine ⌘F acts on right now. Surfaces without a find of their own
// fall through to the preview — which is what makes the shortcut work
// immediately after a tree click, with focus still inside the sidebar.
//
// `browser` never reaches here: when the split browser has focus this page
// receives no key events at all, and the wrapper routes natively.
function activeEngine(): FindEngine | null {
  if (getActiveSurface() === "terminal" && terminalEngine !== null) {
    return terminalEngine;
  }
  if (!supportsHighlights() || !previewIsSearchable()) {
    return null;
  }
  return getPreviewEngine();
}

// Boot-time wiring. Called once by app.ts.
//
// Capture phase, because surfaces that install their own key handling — xterm
// most of all — must not be able to swallow the shortcut before it is routed.
export function initFindShortcuts(): void {
  document.addEventListener(
    "keydown",
    event => {
      if (!hasPrimaryModifier(event) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();

      // ⇧⌘F is project search. Unlike ⌘F it does not consult the active
      // surface — the tree is not a surface the user can be "in", so it means
      // the same thing from the document, the terminal, or anywhere else.
      if (key === "f" && event.shiftKey) {
        if (!projectSearch) {
          return;
        }
        event.preventDefault();
        projectSearch(seedFromSelection());
        return;
      }

      if (key === "f" && !event.shiftKey) {
        const engine = activeEngine();
        if (!engine) {
          return;
        }
        // Claim the key. Letting the host's unscoped find through would be
        // worse than nothing, which is the whole reason this feature exists.
        event.preventDefault();
        openFindBar(engine);
        return;
      }

      if (key === "g") {
        if (!isFindBarOpen()) {
          return;
        }
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    },
    { capture: true },
  );

  // Escape closes find from anywhere, including when focus has already moved
  // back into the document.
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && isFindBarOpen()) {
      closeFindBar();
    }
  });

  installHostBridge();
}

// Entry point for a native host that intercepts the shortcut before the page
// can see it.
//
// UatuCode Desktop needs this because ⌘F does not reliably reach the page: it
// arrives fine while the document has focus, but WebKit consumes it for its own
// editing machinery when an editable element does — and xterm keeps a helper
// `<textarea>` focused the entire time the terminal is in use, which made find
// dead exactly there. The wrapper claims the key with an `NSEvent` monitor and
// calls in here instead. Routing still happens on this side, so the host does
// not need to know which surface is active.
declare global {
  interface Window {
    __uatuFind?: {
      open(): void;
      search(): void;
      step(delta: number): void;
      close(): void;
    };
  }
}

function installHostBridge(): void {
  window.__uatuFind = {
    open() {
      const engine = activeEngine();
      if (engine) {
        openFindBar(engine);
      }
    },
    // ⇧⌘F. Separate from `open` because the two are different features, not
    // one feature with a modifier: the host must not have to know that.
    search() {
      projectSearch?.(seedFromSelection());
    },
    step(delta: number) {
      if (isFindBarOpen()) {
        step(delta);
      }
    },
    close() {
      closeFindBar();
    },
  };
}
