// Clipboard shortcut handling for the embedded terminal. Lives in its own
// module so unit tests can exercise the logic without pulling in xterm's
// canvas/CSS deps. Wired into mountTerminalPanel via
// `term.attachCustomKeyEventHandler(buildClipboardKeyHandler(term, isMac))`.
//
// Behavior mirrors Windows Terminal on non-Mac platforms:
//   Ctrl+C with selection      → copy + clear selection, swallow event
//   Ctrl+C without selection   → pass through (SIGINT)
//   Ctrl+V                     → readText → term.paste, swallow event
//   Ctrl+Shift+C with sel.     → copy, swallow event
//   Ctrl+Shift+C without sel.  → swallow (no-op; defeats DevTools shortcut)
//   Ctrl+Shift+V               → readText → term.paste, swallow event
//
// On macOS the handler short-circuits to passthrough so xterm.js's built-in
// Cmd+C / Cmd+V copy/paste event hooks remain authoritative.

// Subset of the xterm.js Terminal surface we touch. Kept narrow so the test
// stub doesn't have to implement the full Terminal API.
export type ClipboardTerminal = {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
};

// `navigator.userAgentData` is Chromium-only and not yet in the standard lib
// type defs at the version we pin. Narrow shape we need.
type UserAgentDataLike = { platform?: string };
type NavigatorWithUAData = Navigator & { userAgentData?: UserAgentDataLike };

// Detect macOS via the modern UA-Client-Hints API, falling back to the
// deprecated `navigator.platform`. Defaults to `false` when neither is
// populated — non-Mac is the safer default since the handler's non-Mac path
// is the one the user is asking us to add; misclassifying a Mac as non-Mac
// only changes Ctrl+C-with-selection behavior (Mac users typically use Cmd).
export function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithUAData;
  const fromUAData = nav.userAgentData?.platform;
  const fromLegacy = nav.platform;
  const platform = (fromUAData ?? fromLegacy ?? "").toLowerCase();
  return platform.startsWith("mac");
}

type KeyboardWithLock = { lock?: (keys: string[]) => Promise<void> };
type NavigatorWithKeyboard = Navigator & { keyboard?: KeyboardWithLock };

let keyboardLockAttempted = false;

// Page-singleton call to navigator.keyboard.lock(['KeyC']) so Ctrl+Shift+C
// reaches our handler instead of opening Edge's DevTools inspector. Silent
// best-effort: only fires inside an installed PWA (display-mode: standalone)
// on a browser that implements Keyboard Lock. Reload resets the flag
// implicitly when the module re-evaluates.
export function acquireKeyboardLockOnce(): void {
  if (keyboardLockAttempted) return;
  keyboardLockAttempted = true;
  if (typeof window === "undefined") return;
  let isStandalone = false;
  try {
    isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return;
  }
  if (!isStandalone) return;
  const kbd = (navigator as NavigatorWithKeyboard).keyboard;
  if (!kbd?.lock) return;
  kbd.lock(["KeyC"]).catch(err => {
    // Diagnostic only — failure means Ctrl+Shift+C may still open DevTools.
    // The selection-aware bare Ctrl+C path still works as a fallback.
    console.debug("uatu: navigator.keyboard.lock(['KeyC']) rejected", err);
  });
}

// Exposed for tests so they can re-exercise the gates from a clean state.
// Not exported from terminal.ts — callers outside tests should not need it.
export function resetKeyboardLockForTests(): void {
  keyboardLockAttempted = false;
}

// Pure event-handling logic. Returns `true` to let xterm.js process the key
// normally, `false` to swallow. On Mac OR for any key outside the handled
// chord set, always returns `true`. Async clipboard work is fire-and-forget
// so the handler stays synchronous (xterm.js requires a sync boolean).
export function handleClipboardKeyEvent(
  event: KeyboardEvent,
  term: ClipboardTerminal,
  isMac: boolean,
): boolean {
  if (event.type !== "keydown") return true;
  if (isMac) return true;

  const key = (event.key ?? "").toLowerCase();
  if (key !== "c" && key !== "v") return true;

  const { ctrlKey, shiftKey, altKey, metaKey } = event;
  if (!ctrlKey || altKey || metaKey) return true;

  if (key === "c") {
    if (shiftKey) {
      // Ctrl+Shift+C: copy AND clear the selection so the user gets the same
      // "the markings disappear, it copied" feedback Windows Terminal gives.
      // ALWAYS swallow so the browser's DevTools shortcut never fires
      // (Keyboard Lock should already have prevented the OS from delivering
      // this, but belt-and-suspenders).
      if (term.hasSelection()) {
        writeClipboardText(term.getSelection());
        term.clearSelection();
      }
      event.preventDefault();
      return false;
    }
    // Bare Ctrl+C: selection-aware. With selection → copy + clear. Without
    // selection → fall through so xterm sends ETX (SIGINT).
    if (term.hasSelection()) {
      writeClipboardText(term.getSelection());
      term.clearSelection();
      event.preventDefault();
      return false;
    }
    return true;
  }

  // key === "v"
  // Bare Ctrl+V and Ctrl+Shift+V both paste. Bare Ctrl+V deliberately
  // replaces readline's "literal-next" — matches Windows Terminal.
  readClipboardAndPaste(term);
  event.preventDefault();
  return false;
}

function writeClipboardText(text: string): void {
  if (typeof navigator === "undefined") return;
  const clip = navigator.clipboard;
  if (!clip?.writeText) return;
  // Fire-and-forget. Rejection (focus lost, permission) is silently swallowed
  // — surfacing a modal would be more disruptive than the silent failure.
  clip.writeText(text).catch(() => {});
}

function readClipboardAndPaste(term: ClipboardTerminal): void {
  if (typeof navigator === "undefined") return;
  const clip = navigator.clipboard;
  if (!clip?.readText) return;
  clip
    .readText()
    .then(text => {
      // term.paste handles bracketed-paste wrapping when the shell has
      // enabled it. Guard against empty strings to skip a no-op call.
      if (text.length > 0) term.paste(text);
    })
    .catch(() => {});
}
