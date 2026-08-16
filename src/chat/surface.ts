// Desktop chat panel — Preview and Chat co-visible as a split of the work
// row (chat-side-panel change). Chat is a primary surface fixed to the right
// of Preview and left of a right-docked terminal: resizable and collapsible,
// never movable or dockable. This module owns the panel's state (open +
// split fraction), its persistence, the divider drag, and the
// narrow-viewport guard.
//
// Presentation is keyed on <html>: `data-chat-panel="open" | "collapsed"`
// plus the `--chat-fraction` custom property. The surface itself stays
// mounted in every state — collapse is CSS, exactly how the retired
// Preview/Chat switch preserved surface state — so collapsing loses nothing.
// The pre-paint boot script in index.html restates the preference read below
// so first paint lands on the persisted layout; `boot-stamp.test.ts` keeps
// the restatement honest.
//
// Touch mode is untouched by all of this: there Chat is a full-screen tab
// keyed on `data-active-tab`, and every rule keying on `data-chat-panel` is
// scoped to desktop mode.

import { appState, safeLocalStorage } from "../shell/state";
import { onUiModeChange } from "../shell/ui-mode";

export const CHAT_PANEL_KEY = "uatu:chat-panel";

// Chat's share of the work row. Persisted as a FRACTION, not pixels: both
// sides of the split are primary content, and a pixel width would degrade
// into a drawer on a large display and a crush on a small one.
export const CHAT_PANEL_DEFAULT_FRACTION = 0.4;
// Layout-time minimums. Chat needs roughly its touch minimum to keep the
// composer and timeline usable; the preview needs a readable column. Their
// sum is the viewport-guard threshold below which the panel yields.
export const CHAT_PANEL_MIN_WIDTH = 340;
export const CHAT_PREVIEW_MIN_WIDTH = 360;
// Mirror of styles.css's `@media (max-width: 900px)` stacked layout, where
// desktop chrome gives up side-by-side surfaces entirely. The guard treats
// that viewport as not fitting so the data-chat-panel attribute agrees with
// the CSS backstop.
export const DESKTOP_STACKED_BREAKPOINT = 900;
// Storage-level sanity bounds for the fraction, applied when no work-row
// width is available to clamp against (reading a persisted value, a
// zero-width measurement during boot).
const FRACTION_FLOOR = 0.15;
const FRACTION_CEIL = 0.85;
// Keyboard resize step for the divider, in fraction space.
const KEYBOARD_STEP = 0.02;

export type ChatPanelPreference = { open: boolean; fraction: number };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function clampStoredFraction(fraction: number): number {
  return Math.min(Math.max(fraction, FRACTION_FLOOR), FRACTION_CEIL);
}

// Whether the work row is wide enough to show both primary surfaces at their
// minimum usable widths. Below this the guard collapses Chat — Preview wins —
// without overwriting the user's open preference.
export function chatViewportFits(workWidth: number): boolean {
  return workWidth >= CHAT_PANEL_MIN_WIDTH + CHAT_PREVIEW_MIN_WIDTH;
}

// The full guard condition: the split needs both a wide-enough work row and
// a window above the stacked-layout breakpoint.
export function chatPanelFits(workWidth: number, windowWidth: number): boolean {
  return windowWidth > DESKTOP_STACKED_BREAKPOINT && chatViewportFits(workWidth);
}

// Pixel-aware clamp: keeps Chat at or above its minimum and leaves Preview
// its minimum, expressed in fraction space for the given work-row width.
// When the row cannot fit both minimums the guard is about to collapse the
// panel anyway, so only the storage-level bounds apply.
export function clampChatFraction(fraction: number, workWidth: number): number {
  if (!(workWidth > 0) || !chatViewportFits(workWidth)) {
    return clampStoredFraction(fraction);
  }
  const min = CHAT_PANEL_MIN_WIDTH / workWidth;
  const max = 1 - CHAT_PREVIEW_MIN_WIDTH / workWidth;
  return clampStoredFraction(Math.min(Math.max(fraction, min), max));
}

// Default is collapsed: the strip keeps Chat discoverable at one click, while
// a workspace that never uses Chat (or has no OpenCode installed) is not
// forced to give 40% of its width to an unavailable-state card.
export function readChatPanelPreference(
  storage: StorageLike | null = safeLocalStorage(),
): ChatPanelPreference {
  const fallback: ChatPanelPreference = { open: false, fraction: CHAT_PANEL_DEFAULT_FRACTION };
  try {
    const raw = storage?.getItem(CHAT_PANEL_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ChatPanelPreference>;
    return {
      open: typeof parsed.open === "boolean" ? parsed.open : fallback.open,
      fraction:
        typeof parsed.fraction === "number" && Number.isFinite(parsed.fraction)
          ? clampStoredFraction(parsed.fraction)
          : fallback.fraction,
    };
  } catch {
    return fallback;
  }
}

export function writeChatPanelPreference(storage: StorageLike | null, preference: ChatPanelPreference): void {
  try {
    storage?.setItem(CHAT_PANEL_KEY, JSON.stringify(preference));
  } catch {
    /* storage is best effort */
  }
}

let preference: ChatPanelPreference = readChatPanelPreference();
// Viewport guard state. Deliberately NOT part of the persisted preference:
// yielding to a narrow window must not overwrite the user's choice, so the
// panel comes back on its own when the viewport grows.
let guardCollapsed = false;

export function isChatPanelOpen(): boolean {
  return preference.open && !guardCollapsed;
}

function applyChatPanelDom(): void {
  const el = document.documentElement;
  el.setAttribute("data-chat-panel", isChatPanelOpen() ? "open" : "collapsed");
  el.style.setProperty("--chat-fraction", String(preference.fraction));
}

function persist(): void {
  writeChatPanelPreference(safeLocalStorage(), preference);
}

export function setChatPanelOpen(open: boolean): void {
  preference = { ...preference, open };
  persist();
  applyChatPanelDom();
}

// Expand a collapsed panel before acting on Chat content — find-in-chat, a
// programmatic reveal. A no-op when already open; never collapses.
export function expandChatPanel(): void {
  if (!preference.open) setChatPanelOpen(true);
}

function setFraction(fraction: number, workWidth: number): void {
  preference = { ...preference, fraction: clampChatFraction(fraction, workWidth) };
  applyChatPanelDom();
}

function initDividerDrag(divider: HTMLElement, workRow: HTMLElement): void {
  divider.addEventListener("pointerdown", event => {
    if (!isChatPanelOpen()) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    // The row's box is stable for the whole gesture (dragging the divider
    // reapportions the row, it doesn't resize it), so measure once.
    const rect = workRow.getBoundingClientRect();
    document.body.classList.add("is-resizing-chat");
    const move = (moveEvent: PointerEvent): void => {
      setFraction((rect.right - moveEvent.clientX) / rect.width, rect.width);
    };
    const finish = (): void => {
      divider.removeEventListener("pointermove", move);
      document.body.classList.remove("is-resizing-chat");
      persist();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish, { once: true });
    divider.addEventListener("pointercancel", finish, { once: true });
  });

  divider.addEventListener("keydown", event => {
    if (!isChatPanelOpen()) return;
    // Growing chat moves the divider left, so ArrowLeft grows.
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    setFraction(preference.fraction + direction * KEYBOARD_STEP, workRow.getBoundingClientRect().width);
    persist();
  });
}

export function initChatPanel(): void {
  preference = readChatPanelPreference();

  const workRow = document.querySelector<HTMLElement>(".work-row");
  const divider = document.getElementById("chat-resizer");
  const collapseButton = document.getElementById("chat-collapse");
  const expandButton = document.getElementById("chat-expand");

  collapseButton?.addEventListener("click", () => setChatPanelOpen(false));
  expandButton?.addEventListener("click", () => setChatPanelOpen(true));

  if (workRow) {
    const evaluateGuard = (): void => {
      const next = !chatPanelFits(workRow.clientWidth, window.innerWidth);
      if (next !== guardCollapsed) {
        guardCollapsed = next;
        applyChatPanelDom();
      }
    };
    // ResizeObserver rather than window resize alone: the work row also
    // narrows when the terminal docks right or the sidebar expands, with no
    // window event at all.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(evaluateGuard).observe(workRow);
    }
    window.addEventListener("resize", evaluateGuard);
    evaluateGuard();

    if (divider) initDividerDrag(divider, workRow);
  }

  // Mode-switch normalization, touch→desktop half: arriving in desktop with
  // the Chat tab active means the user was working in Chat, so the panel
  // opens rather than silently parking that surface behind a strip. The
  // desktop→touch half (which tab to land on) lives in shell/tab-bar.ts.
  onUiModeChange(mode => {
    if (mode === "desktop" && appState.activeTab === "chat") {
      setChatPanelOpen(true);
      return;
    }
    applyChatPanelDom();
  });

  applyChatPanelDom();
}
