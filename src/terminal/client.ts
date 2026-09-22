import { appUrl } from "../shared/app-url";
import { Terminal, type IBuffer, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";

import "@xterm/xterm/css/xterm.css";

import {
  acquireKeyboardLockOnce,
  createOsc52Handler,
  detectIsMac,
  handleClipboardKeyEvent,
  synthesizeCtrlByte,
  type Osc52Notice,
} from "./clipboard";
import {
  classifySwipeGesture,
  swipeToArrowSequences,
  wheelDeltaToPixels,
  type SwipeGestureMode,
} from "./touch-scroll";
import {
  classifyInventoryResponse,
  readinessBudgetMs,
  recoverAttachment,
  type AttachAttemptResult,
  type InventoryRead,
  type RecoveryClock,
  type RecoveryRun,
} from "./recovery";

const TERMINAL_TOKEN_KEY = "uatu:terminal-token";

// Reads a CSS custom property off `:root` and returns it trimmed, falling back
// to a sensible dark-palette default when the variable isn't defined yet.
// Keeps the xterm theme in lock-step with the rest of the uatu palette without
// hardcoding hex values in two places.
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || !document?.documentElement) return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function buildTheme(): ITheme {
  return {
    background: readVar("--terminal-bg", "#0b1220"),
    foreground: readVar("--terminal-fg", "#e6edf3"),
    cursor: readVar("--terminal-cursor", "#e6edf3"),
    cursorAccent: readVar("--terminal-bg", "#0b1220"),
    selectionBackground: readVar("--terminal-selection-bg", "rgba(28, 168, 167, 0.4)"),
    black: readVar("--terminal-ansi-black", "#1f2937"),
    red: readVar("--terminal-ansi-red", "#f87171"),
    green: readVar("--terminal-ansi-green", "#4ade80"),
    yellow: readVar("--terminal-ansi-yellow", "#facc15"),
    blue: readVar("--terminal-ansi-blue", "#60a5fa"),
    magenta: readVar("--terminal-ansi-magenta", "#c084fc"),
    cyan: readVar("--terminal-ansi-cyan", "#22d3ee"),
    white: readVar("--terminal-ansi-white", "#cbd5f5"),
    brightBlack: readVar("--terminal-ansi-bright-black", "#475569"),
    brightRed: readVar("--terminal-ansi-bright-red", "#fca5a5"),
    brightGreen: readVar("--terminal-ansi-bright-green", "#86efac"),
    brightYellow: readVar("--terminal-ansi-bright-yellow", "#fde68a"),
    brightBlue: readVar("--terminal-ansi-bright-blue", "#93c5fd"),
    brightMagenta: readVar("--terminal-ansi-bright-magenta", "#d8b4fe"),
    brightCyan: readVar("--terminal-ansi-bright-cyan", "#67e8f9"),
    brightWhite: readVar("--terminal-ansi-bright-white", "#f8fafc"),
  };
}

// Hoist the URL token into sessionStorage AND post it to /api/auth so the
// server sets an HttpOnly auth cookie. The cookie is what makes PWA installs
// authenticate without re-pasting — the install's `start_url` is "/" with
// no query, but the cookie persists across the install. sessionStorage stays
// as a belt-and-suspenders fallback for environments where the cookie is
// rejected.
//
// Returns the live token, or `null` if no token has been observed (terminal
// feature off or first visit predates the URL parameter).
let credentialPromotion: Promise<boolean> | null = null;

export function captureTerminalToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("t");
    if (fromUrl) {
      window.sessionStorage.setItem(TERMINAL_TOKEN_KEY, fromUrl);
      // Promote the URL token into a same-origin auth cookie. Fire-and-forget
      // — failures aren't fatal because the in-memory token is still in
      // sessionStorage and ?t= still works for this tab.
      credentialPromotion = persistTerminalToken(fromUrl);
      url.searchParams.delete("t");
      const next = url.pathname + (url.search ? url.search : "") + url.hash;
      window.history.replaceState(null, "", next);
      return fromUrl;
    }
    return window.sessionStorage.getItem(TERMINAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Wait for a URL credential to become the shared HttpOnly workspace cookie.
 * Read-only features such as Chat call this before their first authenticated
 * request so they cannot race the fire-and-forget promotion above. */
export async function waitForWorkspaceCredential(): Promise<void> {
  await credentialPromotion;
}

// Fired after the server accepts a token and re-mints the workspace cookie —
// the terminal's reconnect form is the usual source. Features whose bootstrap
// failed on stale credentials (a PWA cookie holding a pre-restart token)
// listen here to retry instead of staying dead until a full page reload.
const credentialRefreshListeners = new Set<() => void>();

export function onWorkspaceCredentialRefresh(listener: () => void): void {
  credentialRefreshListeners.add(listener);
}

// Build the WebSocket URL for the terminal endpoint. The `pageUrl` source
// (usually `window.location.href`) carries the current page's hash when the
// user arrived via a deep link like `/some/doc.md#section`. The WebSocket
// constructor REJECTS any URL with a fragment identifier — so we drop the
// hash here at the single site where WebSocket URLs are minted, rather than
// trying to keep the page URL fragment-free (which would break deep-link
// scroll).
export function buildTerminalWebSocketUrl(
  pageUrl: string,
  sessionId: string,
  token: string | null,
  takeover = false,
): string {
  const wsUrl = new URL(pageUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = appUrl("/api/terminal");
  wsUrl.hash = "";
  const params = new URLSearchParams();
  if (token) params.set("t", token);
  params.set("sessionId", sessionId);
  // Explicit claim on a session another client holds: the server detaches
  // the current holder (close code 4410) instead of refusing with 409.
  // Harmless on a detached session — it degrades to a plain reattach.
  if (takeover) params.set("takeover", "1");
  wsUrl.search = params.toString();
  return wsUrl.toString();
}

// Map a `GET /api/auth` probe status to what a refused terminal connection
// was. 204: credentials AND origin fine — the refusal was about the PTY (a
// sessionId collision). 403: credentials fine, origin gate refused this
// page's address — unrecoverable by reconnecting or re-pasting a token.
// Anything else (401, network error mapped to 0 by the caller): credentials
// are the problem — paste-token form. The pane's recovery reads the
// inventory route instead, which answers the same way and also says what
// became of the PTY; this remains for callers that only need the verdict.
export type PreOpenFailureKind = "collision" | "origin-rejected" | "auth-required";

export function classifyAuthProbeStatus(status: number): PreOpenFailureKind {
  if (status === 204) return "collision";
  if (status === 403) return "origin-rejected";
  return "auth-required";
}

// Hand the token to the server so it can mint an HttpOnly cookie. Returns
// true if the server accepted it; the panel UI uses the result to decide
// whether to retry the WebSocket connection.
export async function persistTerminalToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(appUrl("/api/auth"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) for (const listener of [...credentialRefreshListeners]) listener();
    return response.ok;
  } catch {
    return false;
  }
}

// What a pane is doing with its PTY right now. The panel reads it to decide
// what a close means and which panes a page departure releases.
//   idle             not attached: never attached, or detached/terminated.
//   connecting       the first attempt of an attach is in flight.
//   ready            reconstruction was delivered; the shell is interactive.
//   recovering       an attempt failed or a connection was lost; the pane is
//                    reconciling with inventory inside one bounded budget.
//   suspended        released for a page departure; resumes on return.
//   occupied         the PTY is held by another client (explicit Take over).
//   ended            the shell exited or the PTY is gone (explicit New shell).
//   unreachable      recovery ran out of budget without a verdict (Retry).
//   taken            another client took the PTY over (explicit Take back).
//   auth-required    credentials refused (paste-token form).
//   origin-rejected  the origin gate refused this address (no action).
export type TerminalPaneState =
  | "idle"
  | "connecting"
  | "ready"
  | "recovering"
  | "suspended"
  | "occupied"
  | "ended"
  | "unreachable"
  | "taken"
  | "auth-required"
  | "origin-rejected";

export type TerminalPanelHandle = {
  // Mount xterm in the container and attach to the PTY, recovering through
  // inventory when the attach fails. Idempotent: a second call while an
  // attach is in flight or established is a no-op. From a parked state it
  // starts a new recovery budget.
  attach(): void;
  // Tear down the WebSocket and free xterm. The container's contents are
  // emptied; the panel can be re-attached later. The server keeps the PTY
  // running — reattaching with the same sessionId resumes the session.
  detach(): void;
  // Like detach(), but closes the WebSocket with the app-defined
  // user-terminate code so the server kills the PTY. The ONLY client path
  // that ends a shell session; reserved for the confirmed pane/panel close.
  // Returns whether the code actually went out on a connection the server
  // recognises as this PTY's holder — a pane mid-recovery has none, and the
  // caller then kills the PTY through the inventory route instead.
  terminate(): boolean;
  // The page is being hidden: release the transport without touching what
  // the pane is or shows. An attaching, attached or recovering pane gives
  // up its transport; an idle pane (added while the document is suspended)
  // is marked suspended so the return attaches it; every other state is
  // left as it is.
  release(): void;
  // The page runs again: a released pane attaches again, once.
  resume(): void;
  state(): TerminalPaneState;
  // Recompute character grid + send resize frame. Call after any panel-height
  // change. Cheap; safe to debounce or invoke from a ResizeObserver.
  fit(): void;
  // Move keyboard focus into xterm. No-op when not attached.
  focus(): void;
  // Live font-size change (touch stepper). Applies to the running xterm and
  // refits; the PTY connection is untouched. No-op when not attached.
  setFontSize(px: number): void;
  // Write raw bytes down the PTY exactly as typed input would travel —
  // the touch keybar's path for control sequences (^C, Esc, arrows) that
  // software keyboards cannot produce. No-op when not connected.
  sendInput(data: string): void;
  // Paste text through xterm so newline normalization and bracketed-paste
  // mode match native clipboard input. No-op when not connected or empty.
  paste(text: string): void;
  // Open/close the touch selection sheet for this pane. The snapshot is
  // static while open so native selection cannot be invalidated by output.
  showSelectionSheet(): boolean;
  dismissSelectionSheet(): boolean;
  isSelectionSheetOpen(): boolean;
  // Whether this mount holds, or is working to hold, its PTY: attaching,
  // attached, or recovering. Parked and released panes are not attached.
  isAttached(): boolean;
  // Scrollback search, driving the pane's own search addon. Reads the buffer
  // and moves xterm's selection only — nothing is written to the PTY, so a
  // running program is unaffected. All no-ops when not attached.
  search: TerminalSearch;
};

// The searchable face of a pane, consumed by the find bar's terminal engine.
export type TerminalSearch = {
  findNext(query: string, options: TerminalSearchOptions): void;
  findPrevious(query: string, options: TerminalSearchOptions): void;
  clear(): void;
  // Subscribe to result counts; pass null to unsubscribe. Only one listener
  // at a time — the bar searches one pane.
  onResults(listener: ((result: { index: number; total: number }) => void) | null): void;
};

export type TerminalSearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type MountTerminalOptions = {
  container: HTMLElement;
  getToken: () => string | null;
  // Per-pane session id (UUID). The server multiplexes multiple PTYs per
  // browser tab by this id. Reusing a pane's id across page reload — or a
  // browser restart, or a laptop sleep — lets the server hand back the SAME
  // live PTY however long the session was detached.
  sessionId: string;
  // Runtime font size (touch stepper override or the built-in default).
  fontSize?: number;
  // Receives the bridge's UI events (copied / pending / oversized); the panel
  // renders them as the pane-scoped toast — including the blocked-write
  // fallback, whose pending copy needs a surface to land on.
  onOsc52Notice?: (notice: Osc52Notice) => void;
  // The user chose "New shell" on a parked card (the shell ended, or the PTY
  // is held elsewhere): the controller replaces this pane with a fresh one.
  onNewShell?: () => void;
  // Fires on every state transition; the controller uses it for nothing
  // more than bookkeeping today, tests for assertions.
  onStateChange?: (state: TerminalPaneState) => void;
  // Connect with an explicit takeover claim (session picker attaching to a
  // session held by another window). Consumed by the first attempt of the
  // first attach: a later resume, retry or reload never inherits it, so a
  // saved pane reference can never authorize a takeover by itself. The
  // parked cards' Take over / Take back actions re-arm it explicitly.
  takeover?: boolean;
  // Applied to every typed-input chunk before it is sent to the PTY — the
  // sticky-Ctrl composition hook. MUST be an identity function when its
  // latch is unarmed; it sits on the path every keystroke travels.
  transformInput?: (data: string) => string;
  // Fires on every PTY output frame written into xterm. The controller uses
  // it to badge the Terminal tab when output arrives while another touch
  // tab is active. Keep it cheap — it sits on the output hot path.
  onOutput?: () => void;
  // Test seam: the clock the recovery budget runs on.
  clock?: RecoveryClock;
};

export function pasteTerminalInput(
  term: Pick<Terminal, "paste"> | null,
  connected: boolean,
  text: string,
  setSemanticPasteActive: (active: boolean) => void,
): boolean {
  if (!term || !connected || !text) return false;
  setSemanticPasteActive(true);
  try {
    term.paste(text);
  } finally {
    setSemanticPasteActive(false);
  }
  return true;
}

export function applyTerminalInputTransform(
  data: string,
  transformInput: ((data: string) => string) | undefined,
  semanticPasteActive: boolean,
): string {
  if (semanticPasteActive || !transformInput) return data;
  return transformInput(data);
}

export function terminalBufferText(buffer: Pick<IBuffer, "getLine" | "length">): string {
  const logicalLines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text;
    } else {
      logicalLines.push(text);
    }
  }
  while (logicalLines.at(-1) === "") logicalLines.pop();
  return logicalLines.join("\n");
}

// Mirror of the server's CLOSE_CODE_USER_TERMINATE (terminal/server.ts).
// Defined as a literal on each side — like the 4409 hijack code — because
// importing across the client/server boundary would drag the other side's
// dependencies (node-pty / xterm) into the wrong bundle.
const CLOSE_CODE_USER_TERMINATE = 4001;
// Server→client: another client took this PTY over with an explicit claim.
const CLOSE_CODE_SESSION_TAKEN = 4410;
// Server→client: this socket lost the in-open race for the PTY.
const CLOSE_CODE_SESSION_HIJACKED = 4409;

const defaultClock: RecoveryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// The authenticated inventory read the recovery reconciles against. Classified
// into the recovery's vocabulary here; a network failure is a `failed` read,
// which proves nothing about any PTY. Same-origin GETs carry no Origin
// header, so the page's address goes in the page-origin header (the literal
// mirrors PAGE_ORIGIN_HEADER in terminal/auth.ts): it is what lets the
// inventory answer 403 for an address the origin gate refuses — the verdict
// `origin-rejected` is built on, and the reason a refused attach behind a
// Host-rewriting proxy ends in the origin diagnostic rather than in retries.
export async function readTerminalInventory(token: string | null, signal: AbortSignal): Promise<InventoryRead> {
  const url = token
    ? appUrl(`/api/terminal/sessions?t=${encodeURIComponent(token)}`)
    : appUrl("/api/terminal/sessions");
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Uatu-Page-Origin": window.location.origin },
      signal,
    });
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    return classifyInventoryResponse(response.status, body);
  } catch {
    return { kind: "failed" };
  }
}

// Per-pane terminal mount. The controller owns the panel-level concerns
// (dock, display mode, split layout, visibility); this function owns the
// xterm + WebSocket lifecycle for a single pane — including what happens
// when that lifecycle goes wrong. Two ideas carry it:
//
// One xterm per attach cycle, many transport attempts. The Terminal (and
// its addons, observer and input wiring) is created when the pane attaches
// and disposed when it detaches, terminates, releases or parks; the
// WebSocket is created per ATTEMPT, and a retry reuses the terminal, resetting
// it only when the next reconstruction lands. So a pane mid-recovery keeps
// showing its last screen under a "Reconnecting…" note instead of blanking
// on every attempt.
//
// Every callback is generation-guarded. `generation` advances on each
// attach cycle and each teardown, and each attempt additionally checks that
// its socket is still the pane's current one. A late close from a socket
// the pane has since abandoned — a retry, a suspend/resume, a user hide, a
// takeover — cannot change what the pane shows, remove it, or attach it to
// a PTY it no longer means to hold.
export function mountTerminalPanel(options: MountTerminalOptions): TerminalPanelHandle {
  const clock = options.clock ?? defaultClock;
  let term: Terminal | null = null;
  // Set by focusNow() when focus is requested before xterm has opened;
  // consumed by openXtermNow() the moment it can actually take focus.
  let pendingFocus = false;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;
  let searchResultsSubscription: { dispose(): void } | null = null;
  let searchResultsListener: ((result: { index: number; total: number }) => void) | null = null;
  // The current attempt's socket while connecting; the live socket once
  // ready; null between attempts and when not attached.
  let socket: WebSocket | null = null;
  let state: TerminalPaneState = "idle";
  let protocolReady = false;
  let semanticPasteActive = false;
  let resizeObserver: ResizeObserver | null = null;
  // Advanced by every attach cycle and every teardown. Callbacks captured
  // an earlier value and bow out when it no longer matches.
  let generation = 0;
  let run: RecoveryRun | null = null;
  let statusNote: HTMLElement | null = null;
  // Whether the next attempt carries `takeover=1`. Seeded from the mount
  // options and by the parked cards' explicit actions; consumed by the
  // attempt that uses it, so nothing automatic ever inherits it.
  let takeoverArmed = options.takeover === true;
  // xterm open bookkeeping, per Terminal instance.
  let openDone = false;
  let lastCols = 0;
  let lastRows = 0;
  // Whether the terminal has shown a reconstruction; the next attempt's
  // snapshot then starts from a reset screen rather than appending.
  let termWritten = false;
  let needsReset = false;
  // Per attempt: the attach-ready frame goes out once per socket.
  let attemptReadySent = false;
  // Tears down the alternate-screen touch-scroll listeners with the mount.
  let touchScrollAbort: AbortController | null = null;
  let selectionSheet: HTMLElement | null = null;
  let transcriptPreviousScrollY = 0;
  let transcriptParkedElements: HTMLElement[] = [];
  // Connect-scoped fit-and-publish (it closes over that connection's
  // lastCols/lastRows and socket); the font-size setter calls it so a grid
  // change without a container resize still reaches the PTY.
  let syncPtySize: (() => void) | null = null;

  function setState(next: TerminalPaneState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function liveSocket(): WebSocket | null {
    return protocolReady && socket && socket.readyState === WebSocket.OPEN ? socket : null;
  }

  function dismissSelectionSheet(restoreFocus = true): boolean {
    if (!selectionSheet) return false;
    selectionSheet.remove();
    selectionSheet = null;
    document.body.classList.remove("terminal-transcript-open");
    for (const element of transcriptParkedElements) {
      element.inert = false;
      element.removeAttribute("aria-hidden");
    }
    transcriptParkedElements = [];
    window.getSelection()?.removeAllRanges();
    if (term?.element) {
      term.element.inert = false;
      term.element.removeAttribute("aria-hidden");
    }
    window.scrollTo(0, transcriptPreviousScrollY);
    document.dispatchEvent(new Event("uatu:terminal-selection-change"));
    if (restoreFocus) term?.focus();
    return true;
  }

  function showSelectionSheet(): boolean {
    if (!term?.element) return false;
    if (selectionSheet) return true;

    const sheet = document.createElement("section");
    sheet.className = "terminal-transcript";
    sheet.setAttribute("role", "document");
    sheet.setAttribute("aria-label", "Terminal transcript");

    const header = document.createElement("header");
    header.className = "terminal-transcript-header";
    const title = document.createElement("span");
    title.className = "terminal-transcript-title";
    title.textContent = "Terminal transcript";
    const hint = document.createElement("span");
    hint.className = "terminal-transcript-hint";
    hint.textContent = "Long-press text to select and copy";
    header.append(title, hint);

    const text = document.createElement("article");
    text.className = "terminal-transcript-text";
    if (term.options.fontFamily) text.style.fontFamily = term.options.fontFamily;
    text.style.fontSize = `${term.options.fontSize}px`;
    for (const value of terminalBufferText(term.buffer.active).split("\n")) {
      const line = document.createElement("div");
      line.className = "terminal-transcript-line";
      if (value) line.textContent = value;
      else line.append(document.createElement("br"));
      text.append(line);
    }
    sheet.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissSelectionSheet();
    });
    const navigation = document.createElement("nav");
    navigation.className = "terminal-transcript-nav";
    navigation.setAttribute("aria-label", "Transcript navigation");
    const done = document.createElement("button");
    done.type = "button";
    done.className = "terminal-transcript-return";
    done.setAttribute("aria-label", "Done selecting terminal text and return to Terminal");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", "M2 3h12v10H2zM4.25 6.25 6.5 8.5l-2.25 2.25M8.5 10.75h3.25");
    icon.append(path);
    const doneLabel = document.createElement("span");
    doneLabel.textContent = "Done";
    const returnLabel = document.createElement("span");
    returnLabel.className = "terminal-transcript-return-hint";
    returnLabel.textContent = "Return to Terminal";
    done.append(icon, doneLabel, returnLabel);
    done.addEventListener("click", () => dismissSelectionSheet());
    navigation.append(done);
    sheet.append(header, text, navigation);

    term.blur();
    term.element.inert = true;
    term.element.setAttribute("aria-hidden", "true");
    transcriptPreviousScrollY = window.scrollY;
    selectionSheet = sheet;
    transcriptParkedElements = [
      document.querySelector<HTMLElement>(".app-shell"),
      document.querySelector<HTMLElement>(".touch-tab-bar"),
    ].filter((element): element is HTMLElement => element !== null);
    for (const element of transcriptParkedElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.classList.add("terminal-transcript-open");
    document.body.append(sheet);
    document.dispatchEvent(new Event("uatu:terminal-selection-change"));
    const revealLiveEnd = () => {
      if (selectionSheet !== sheet) return;
      window.scrollTo(0, document.documentElement.scrollHeight);
    };
    requestAnimationFrame(() => {
      if (selectionSheet !== sheet) return;
      revealLiveEnd();
      requestAnimationFrame(revealLiveEnd);
    });
    void document.fonts.ready.then(revealLiveEnd);
    return true;
  }

  // The attach-ready frame: sent once per attempt, as soon as the socket is
  // open and the pane knows its grid. Sending it is the moment the child is
  // asked for the PTY, which is when the attempt's readiness clock starts
  // (see `openAttempt`). The grid is xterm's first layout when the pane has
  // one — or, for a pane that has no layout right now (a minimized panel, a
  // pane behind another touch tab) but had one in an earlier attach cycle,
  // that cycle's grid. Attaching at the last known grid is what keeps a
  // shell held across a page suspend while the panel is minimized, exactly
  // as minimize itself keeps it held: the reconstruction is written into the
  // not-yet-opened terminal, xterm buffers it, and it paints — refitted —
  // when the panel is expanded. A pane that has never had a grid waits for
  // layout: there is nothing known to attach at.
  let onAttachReadySent: (() => void) | null = null;
  const knownGrid = (): boolean => lastCols > 0 && lastRows > 0;
  const hasLayout = (): boolean => {
    const rect = options.container.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  function sendAttachReady(): void {
    if (attemptReadySent || !term || !socket || socket.readyState !== WebSocket.OPEN) return;
    // With layout, xterm opens on the next observer tick and sends from
    // there with the measured grid.
    if (!openDone && (hasLayout() || !knownGrid())) return;
    socket.send(JSON.stringify({ type: "attach-ready", cols: term.cols, rows: term.rows }));
    attemptReadySent = true;
    onAttachReadySent?.();
  }

  function openXtermNow(): void {
    if (!term || !fit || openDone) return;
    openDone = true;
    try {
      term.open(options.container);
      fit.fit();
      if (attemptReadySent && !protocolReady) {
        // Attached at the last known grid before layout, and the
        // reconstruction is still on its way: the measured grid is
        // published once the child holds this socket (the ready path runs
        // `syncPtySize`), which compares against the grid we attached at.
      } else {
        if (attemptReadySent && (term.cols !== lastCols || term.rows !== lastRows)) {
          liveSocket()?.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
        lastCols = term.cols;
        lastRows = term.rows;
      }
      // Belt-and-suspenders repaint. xterm buffers any term.write()
      // calls that happened before open(); the buffered data renders on
      // first paint after open(), but a canvas that was created during
      // a transition can hold a stale frame until something forces a
      // repaint. refresh() does exactly that, cheaply.
      term.refresh(0, term.rows - 1);
      // If the WebSocket already opened (data may already be flowing),
      // send a corrected resize now that we have real dimensions.
      sendAttachReady();
      // Honor a focus requested before the terminal could take it.
      if (pendingFocus) {
        pendingFocus = false;
        term.focus();
      }
    } catch {
      // Container vanished between observe() and the callback. Undo so
      // the next observation tries again.
      openDone = false;
      return;
    }
    // Best-effort: in installed-PWA standalone mode, ask the browser to
    // deliver KeyC to the page so Ctrl+Shift+C reaches our handler
    // instead of opening Edge's DevTools. Page-singleton inside the
    // helper.
    acquireKeyboardLockOnce();
  }

  // Creates the Terminal for an attach cycle: theme, key handling, addons,
  // the container's touch/wheel listeners and the ResizeObserver that opens
  // xterm once the container has layout. No-op while one exists.
  function ensureTerminal(): void {
    if (term) return;
    dismissSelectionSheet(false);
    delete options.container.dataset.terminalReady;
    openDone = false;
    termWritten = false;
    needsReset = false;

    term = new Terminal({
      theme: buildTheme(),
      cursorBlink: true,
      // Resolution order for fontFamily: CSS variable → built-in fallback.
      // CSS owns the default look; there is no config override.
      fontFamily:
        readVar("--terminal-font-family", "")
          || '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: options.fontSize ?? 13,
      // 1.0 — anything larger leaves a visible gap between rows that breaks
      // half-block / box-drawing tiling (TUIs like opencode and lazygit
      // render large logos out of stacked half-blocks). Comfortable reading
      // text height belongs to the document preview, not the terminal.
      lineHeight: 1.0,
      scrollback: 5000,
      // Search decorations (`registerDecoration`) are still proposed API in
      // xterm 6, and calling into them without this throws rather than
      // degrading — which is exactly how terminal find looked completely dead
      // instead of merely unstyled. Flipped from `false` deliberately: the
      // cost is that proposed APIs can shift across xterm minors, so read the
      // changelog on upgrade. The gain is marking every match instead of only
      // selecting one, matching how the preview reads.
      allowProposedApi: true,
      // A grid known from an earlier attach cycle: what attach-ready is sent
      // with when the pane has no layout, and what a reconstruction written
      // before open() lays out for. fit() corrects it once there is layout.
      ...(lastCols > 0 && lastRows > 0 ? { cols: lastCols, rows: lastRows } : {}),
    });
    // Windows-Terminal-parity clipboard shortcuts. Attached BEFORE open()
    // because xterm.js consults this handler from its keydown listener; the
    // listener is wired during open(). Mac short-circuits to passthrough
    // inside the handler so Cmd+C / Cmd+V keep using xterm's defaults.
    const isMac = detectIsMac();
    term.attachCustomKeyEventHandler(event => {
      // Clipboard shortcuts first: on non-Mac, Ctrl+C with a selection is a
      // copy and must win over the interrupt.
      if (!handleClipboardKeyEvent(event, term!, isMac)) {
        return false;
      }
      // Bare Ctrl+letter: synthesize the control byte from event.key and
      // send it down the PTY ourselves. xterm derives these from keyCode,
      // which iPadOS hardware keyboards don't populate usably — deriving
      // from key works everywhere and emits the same bytes on desktop.
      const ctrlByte = synthesizeCtrlByte(event);
      if (ctrlByte !== null) {
        liveSocket()?.send(new TextEncoder().encode(ctrlByte));
        event.preventDefault();
        return false;
      }
      return true;
    });
    // OSC 52 bridge: application-initiated copies (mouse-mode TUIs) reach the
    // host clipboard. `registerOscHandler` is stable public API — no
    // allowProposedApi needed. Write-only by construction; see clipboard.ts.
    term.parser.registerOscHandler(
      52,
      createOsc52Handler({
        notify: notice => options.onOsc52Notice?.(notice),
      }),
    );
    fit = new FitAddon();
    term.loadAddon(fit);
    search = new SearchAddon();
    term.loadAddon(search);
    // Route the addon's result counts to whoever is currently searching this
    // pane. Subscribed once per mount; the listener itself is swappable so the
    // find bar can move between panes without re-registering.
    searchResultsSubscription = search.onDidChangeResults(result => {
      searchResultsListener?.({ index: result.resultIndex, total: result.resultCount });
    });
    options.container.replaceChildren();

    const encoder = new TextEncoder();
    term.onData(data => {
      const live = liveSocket();
      if (!live) return;
      const output = applyTerminalInputTransform(data, options.transformInput, semanticPasteActive);
      live.send(encoder.encode(output));
    });

    touchScrollAbort?.abort();
    touchScrollAbort = new AbortController();

    // Wheel alternate-scroll (all pointer types). xterm.js has no built-in
    // DECSET 1007 behavior: when a TUI on the alternate buffer has NOT
    // enabled mouse tracking, wheel events fall through to the viewport and
    // scroll scrollback — the user sees their prompt history move instead of
    // the TUI's content. Real terminal emulators default to converting the
    // wheel into arrow keys in exactly this situation (iTerm's "scroll wheel
    // sends arrow keys when in alternate screen mode"); mirror that. When
    // the app DOES track the mouse, xterm forwards wheel reports itself and
    // this handler stays out of the way.
    {
      const { signal } = touchScrollAbort;
      let wheelCarry = 0;
      options.container.addEventListener(
        "wheel",
        event => {
          if (!term) return;
          if (term.buffer.active.type !== "alternate") return;
          if (term.modes.mouseTrackingMode !== "none") return;
          const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
          const pageHeight = screen?.clientHeight ?? options.container.clientHeight;
          const cellHeight = pageHeight / Math.max(1, term.rows);
          // Wheel-down (positive deltaY) scrolls content down = arrow down,
          // the opposite sign convention from a downward finger drag.
          const translated = swipeToArrowSequences({
            deltaY: -wheelDeltaToPixels(event.deltaY, event.deltaMode, cellHeight, pageHeight),
            cellHeight,
            applicationCursor: term.modes.applicationCursorKeysMode,
            carry: wheelCarry,
          });
          wheelCarry = translated.carry;
          if (translated.sequences) liveSocket()?.send(encoder.encode(translated.sequences));
          // Consume it either way — the viewport scrolling scrollback under
          // an alternate-screen TUI is the misbehavior being replaced.
          event.preventDefault();
          event.stopPropagation();
        },
        { signal, passive: false, capture: true },
      );
    }

    // Alternate-screen touch scrolling (coarse pointers only): TUIs run on
    // the alternate buffer, which has no scrollback for xterm's native touch
    // path to move — swipes hit nothing. Translate vertical swipe distance
    // into arrow-key sequences (touch-scroll.ts), leaving normal-buffer
    // swipes to xterm's own viewport scrolling.
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) {
      const { signal } = touchScrollAbort;
      let touchStartX: number | null = null;
      let touchStartY: number | null = null;
      let lastTouchY: number | null = null;
      let gestureMode: SwipeGestureMode = "pending";
      let swipeCarry = 0;
      options.container.addEventListener(
        "touchstart",
        event => {
          if (event.touches.length !== 1) {
            touchStartX = touchStartY = lastTouchY = null;
            gestureMode = "ignore";
            return;
          }
          touchStartX = event.touches[0]!.clientX;
          touchStartY = event.touches[0]!.clientY;
          lastTouchY = touchStartY;
          gestureMode = "pending";
          swipeCarry = 0;
        },
        { signal, passive: true },
      );
      options.container.addEventListener(
        "touchmove",
        event => {
          if (!term || lastTouchY === null || touchStartX === null || touchStartY === null) return;
          if (event.touches.length !== 1) return;
          // A drag on xterm's selection is not a terminal scroll gesture.
          if (term.hasSelection()) {
            gestureMode = "ignore";
            return;
          }
          if (gestureMode === "ignore") return;
          const touch = event.touches[0]!;
          if (gestureMode === "pending") {
            gestureMode = classifySwipeGesture(
              touch.clientX - touchStartX,
              touch.clientY - touchStartY,
            );
            // Until the gesture commits to vertical, leave the event alone
            // (and drop the pre-threshold travel — starting the scroll from
            // here avoids a jump when the gesture resolves).
            if (gestureMode !== "scroll") {
              lastTouchY = touch.clientY;
              return;
            }
          }
          const currentY = touch.clientY;
          const deltaY = currentY - lastTouchY;
          lastTouchY = currentY;
          const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
          const cellHeight =
            (screen?.clientHeight ?? options.container.clientHeight) / Math.max(1, term.rows);
          // Normal buffer: scroll scrollback "as usual". xterm.js has no
          // native touch scrolling, so quantize the swipe into scrollLines
          // ourselves (finger down = reveal earlier output = scroll up).
          if (term.buffer.active.type !== "alternate") {
            const total = swipeCarry + deltaY;
            const cells = Math.trunc(total / cellHeight);
            swipeCarry = total - cells * cellHeight;
            if (cells !== 0) term.scrollLines(-cells);
            event.preventDefault();
            return;
          }
          // Mouse-tracking TUIs (opencode, htop, lazygit) want real wheel
          // events — xterm converts those into the mouse reports the app
          // asked for, and the app scrolls its own content. Synthesize one
          // from the swipe instead of sending arrows, which such apps map
          // to history/selection navigation.
          if (term.modes.mouseTrackingMode !== "none") {
            (screen ?? options.container).dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: -deltaY,
                deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                clientX: touch.clientX,
                clientY: touch.clientY,
                bubbles: true,
                cancelable: true,
              }),
            );
            event.preventDefault();
            return;
          }
          const translated = swipeToArrowSequences({
            deltaY,
            cellHeight,
            applicationCursor: term.modes.applicationCursorKeysMode,
            carry: swipeCarry,
          });
          swipeCarry = translated.carry;
          if (translated.sequences) liveSocket()?.send(encoder.encode(translated.sequences));
          // The swipe is driving the TUI now — keep the page from
          // rubber-banding underneath it. Registered passive: false for this.
          event.preventDefault();
        },
        { signal, passive: false },
      );
      options.container.addEventListener(
        "touchend",
        () => {
          touchStartX = touchStartY = lastTouchY = null;
          gestureMode = "pending";
        },
        { signal, passive: true },
      );
    }

    // Refit xterm and, when the grid actually changed, publish the new
    // cols/rows to the server so the PTY tracks the client. Shared by the
    // container ResizeObserver below AND the font-size setter — a font
    // change alters the grid without touching the container, so the
    // observer alone would leave the PTY rendering for the old dimensions.
    syncPtySize = () => {
      if (!term || !fit || !openDone) return;
      try {
        fit.fit();
      } catch {
        // FitAddon throws if the terminal is hidden (zero rect); benign.
        return;
      }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        liveSocket()?.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    // xterm initialization is driven by ResizeObserver rather than rAF
    // timing. Reason: on a page refresh that restores the persisted
    // terminal-visible preference, setVisible(true) unhides the panel and
    // synchronously calls attach(); calling term.open() before the panel
    // container has its real layout caches a degenerate cell measurement
    // that subsequent fit.fit() calls don't fully recover from. rAF
    // ordering relative to layout varies subtly across browsers and
    // panel-CSS arrangements, so we wait for the container to actually
    // have a non-zero contentRect — that's guaranteed to fire only AFTER
    // layout has settled. The same ResizeObserver also handles subsequent
    // user-initiated resizes.
    resizeObserver = new ResizeObserver(entries => {
      if (!term || !fit) return;
      const entry = entries.at(-1);
      if (!entry) return;
      if (!openDone) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          openXtermNow();
        }
        return;
      }
      syncPtySize?.();
    });
    resizeObserver.observe(options.container);
  }

  function showStatusNote(text: string): void {
    if (!statusNote) {
      statusNote = document.createElement("div");
      statusNote.className = "terminal-pane-status";
      statusNote.setAttribute("role", "status");
      statusNote.setAttribute("aria-live", "polite");
      options.container.append(statusNote);
    }
    statusNote.textContent = text;
  }

  function hideStatusNote(): void {
    statusNote?.remove();
    statusNote = null;
  }

  // One transport attempt: a socket that either reaches readiness within
  // `deadlineMs` and becomes the pane's live connection, or ends with a
  // verdict the recovery loop reconciles. Token in the URL when we have one
  // (first-tab path); otherwise the HttpOnly auth cookie set by /api/auth
  // (PWA / subsequent visits). The generation and the socket identity are
  // both checked, so a socket the pane has moved on from changes nothing.
  function openAttempt(gen: number, deadlineMs: number, signal: AbortSignal): Promise<AttachAttemptResult> {
    return new Promise<AttachAttemptResult>(resolve => {
      if (gen !== generation || signal.aborted || !term) {
        resolve("refused");
        return;
      }
      const takeover = takeoverArmed;
      takeoverArmed = false;
      const attempt = new WebSocket(
        buildTerminalWebSocketUrl(window.location.href, options.sessionId, options.getToken(), takeover),
      );
      attempt.binaryType = "arraybuffer";
      socket = attempt;
      attemptReadySent = false;
      protocolReady = false;
      needsReset = termWritten;
      const isCurrent = () => gen === generation && socket === attempt;
      let settled = false;
      let exitSeen = false;
      const finish = (result: AttachAttemptResult) => {
        if (settled) return;
        settled = true;
        disarmDeadline();
        if (onAttachReadySent !== null) onAttachReadySent = null;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const abandon = (reason: string) => {
        try {
          attempt.close(1000, reason);
        } catch {
          // Already closing.
        }
        if (isCurrent()) socket = null;
      };
      // Two silences are bounded, and one wait is not. A socket that never
      // opens (a hub that hangs the handshake) and a child that never answers
      // attach-ready with reconstruction (through the hub the browser side
      // opens before the child has been asked at all) share `deadlineMs`:
      // the readiness wait gets what the handshake left of it, so an attempt
      // never runs its deadline twice over. The wait BETWEEN them — an open
      // socket whose attach-ready has not gone out because the pane has no
      // layout and no grid known from an earlier cycle (a first attach
      // behind another touch tab, a panel not yet painted) — is not a
      // silence and is not charged: the child has not been asked, holds
      // nothing for us, and the frame goes out the moment the pane is laid
      // out. A pane that knows its grid does not wait (see sendAttachReady).
      let deadline: unknown = null;
      const armDeadline = (reason: string, ms: number) => {
        if (deadline !== null) clock.clearTimeout(deadline);
        deadline = clock.setTimeout(() => {
          if (settled) return;
          abandon(reason);
          finish("silent");
        }, ms);
      };
      const disarmDeadline = () => {
        if (deadline !== null) clock.clearTimeout(deadline);
        deadline = null;
      };
      const startedAt = clock.now();
      let connectSpentMs = 0;
      armDeadline("connect timeout", deadlineMs);
      onAttachReadySent = () => {
        if (!isCurrent() || settled) return;
        armDeadline("readiness timeout", readinessBudgetMs(deadlineMs, connectSpentMs));
      };
      const onAbort = () => {
        if (settled) return;
        abandon("cancelled");
        finish("refused");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      attempt.addEventListener("open", () => {
        if (!isCurrent()) return;
        connectSpentMs = clock.now() - startedAt;
        disarmDeadline();
        // If xterm is already opened (toggle path — container had real
        // dimensions before observe() fired), or the pane has no layout but
        // knows its grid (a resume while minimized), attach-ready goes out
        // now. Otherwise (auto-restore path) openXtermNow() sends it the
        // moment xterm opens.
        sendAttachReady();
      });

      attempt.addEventListener("message", event => {
        if (!isCurrent() || !term) return;
        if (typeof event.data === "string") {
          // Control frames (e.g. shell-exit) are JSON; render them as a faint
          // marker rather than swallowing silently so the user knows the
          // session ended.
          try {
            const parsed = JSON.parse(event.data);
            if (parsed?.type === "exit") {
              exitSeen = true;
              term.write(`\r\n\x1b[2m[shell exited${parsed.exitCode != null ? ` with code ${parsed.exitCode}` : ""}]\x1b[0m\r\n`);
            }
          } catch {
            // Non-JSON text from the server is unexpected; ignore.
          }
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        options.onOutput?.();
        if (!protocolReady) {
          // The first binary frame is the reconstruction: the child accepted
          // this socket as the PTY's holder. That receipt ends the readiness
          // silence — the deadline is about the transport, and xterm painting
          // a large snapshot slowly must not turn a committed attachment into
          // a timeout. A retry's snapshot replaces the previous attempt's
          // screen rather than appending to it.
          disarmDeadline();
          if (needsReset) {
            needsReset = false;
            term.reset();
          }
          term.write(bytes, () => {
            if (!isCurrent()) return;
            protocolReady = true;
            termWritten = true;
            // xterm may have opened between a pre-layout attach-ready and
            // this reconstruction; its measured grid is published now.
            syncPtySize?.();
            options.container.dataset.terminalReady = "true";
            hideStatusNote();
            setState("ready");
            finish("ready");
          });
          return;
        }
        term.write(bytes);
      });

      attempt.addEventListener("close", event => {
        if (!isCurrent()) return;
        socket = null;
        protocolReady = false;
        delete options.container.dataset.terminalReady;
        if (!settled) {
          // Ended before readiness: whether it opened first says nothing —
          // the hub accepts the browser before the child has been asked.
          if (event.code === CLOSE_CODE_SESSION_TAKEN) finish("taken");
          else if (exitSeen) finish("exit");
          else finish("refused");
          return;
        }
        onEstablishedLoss(gen, event.code, exitSeen);
      });
    });
  }

  // An established connection ended. Not a pane closure and not a request
  // to hide anything: only two facts are final here — a takeover notice and
  // a confirmed exit. Everything else is a transport loss, and the pane
  // reconciles it exactly as it would a failed restore.
  function onEstablishedLoss(gen: number, code: number, exitSeen: boolean): void {
    if (gen !== generation) return;
    if (code === CLOSE_CODE_SESSION_TAKEN) {
      showTakenOverUI();
      return;
    }
    if (exitSeen) {
      showEndedUI();
      return;
    }
    if (code === CLOSE_CODE_SESSION_HIJACKED && term) {
      term.write("\r\n\x1b[2m[session claimed by another tab]\x1b[0m\r\n");
    }
    begin("recovering");
  }

  // Starts an attach cycle: one recovery run with one budget, whose outcome
  // the pane then presents. `initial` is what the pane says while the first
  // attempt runs — connecting from a fresh attach, recovering after a loss.
  function begin(initial: "connecting" | "recovering"): void {
    const gen = ++generation;
    run?.cancel();
    hideStatusNote();
    ensureTerminal();
    setState(initial);
    if (initial === "recovering") showStatusNote("Reconnecting…");
    const current = recoverAttachment(options.sessionId, {
      clock,
      readInventory: signal => readTerminalInventory(options.getToken(), signal),
      attach: (deadlineMs, signal) => openAttempt(gen, deadlineMs, signal),
      onPhase: phase => {
        if (gen !== generation || phase.phase !== "reconciling") return;
        setState("recovering");
        showStatusNote("Reconnecting…");
      },
    });
    run = current;
    void current.outcome.then(outcome => {
      if (gen !== generation || run !== current) return;
      run = null;
      switch (outcome) {
        case "attached":
          hideStatusNote();
          setState("ready");
          return;
        case "cancelled":
          return;
        case "occupied":
          showOccupiedUI();
          return;
        case "ended":
          showEndedUI();
          return;
        case "unreachable":
          showUnreachableUI();
          return;
        case "taken":
          showTakenOverUI();
          return;
        case "auth-required":
          showPasteTokenUI();
          return;
        case "origin-rejected":
          showOriginRejectedUI();
          return;
      }
    });
  }

  function attach(): void {
    if (state === "connecting" || state === "ready" || state === "recovering") return;
    begin("connecting");
  }

  // Ends the attach cycle: invalidates every callback it armed, closes the
  // transport with `closeCode`, disposes xterm and empties the container.
  // Returns whether the close code went out on the PTY's established
  // holder — the only close the server acts on as a termination.
  function teardown(closeCode: number, closeReason: string, next: TerminalPaneState): boolean {
    generation += 1;
    const live = socket;
    socket = null;
    const wasHolder = protocolReady && live !== null && live.readyState === WebSocket.OPEN;
    protocolReady = false;
    if (live) {
      try {
        live.close(closeCode, closeReason);
      } catch {
        // Already closing.
      }
    }
    run?.cancel();
    run = null;
    hideStatusNote();
    delete options.container.dataset.terminalReady;
    touchScrollAbort?.abort();
    touchScrollAbort = null;
    syncPtySize = null;
    dismissSelectionSheet(false);
    try {
      resizeObserver?.disconnect();
    } catch {
      // Already disconnected.
    }
    resizeObserver = null;
    try {
      term?.dispose();
    } catch {
      // Already disposed.
    }
    term = null;
    fit = null;
    openDone = false;
    termWritten = false;
    searchResultsSubscription?.dispose();
    searchResultsSubscription = null;
    searchResultsListener = null;
    search = null;
    options.container.replaceChildren();
    setState(next);
    return wasHolder && closeCode === CLOSE_CODE_USER_TERMINATE;
  }

  // A parked card replaces the terminal: the attach cycle is over, the
  // transport is gone, and the card names the one way forward.
  function park(next: TerminalPaneState): HTMLElement {
    teardown(1000, "parked", next);
    const container = options.container;
    container.replaceChildren();
    const wrap = document.createElement("div");
    container.append(wrap);
    return wrap;
  }

  function card(wrap: HTMLElement, className: string, heading: string, help: string): void {
    wrap.className = className;
    const headingEl = document.createElement("p");
    headingEl.className = `${className}-heading`;
    headingEl.textContent = heading;
    const helpEl = document.createElement("p");
    helpEl.className = `${className}-help`;
    helpEl.textContent = help;
    wrap.append(headingEl, helpEl);
  }

  function actionButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  // Replace the xterm host with a small form prompting the user to paste a
  // fresh token from their `uatu` CLI output. Used when the inventory read
  // that reconciles a failed attach answers 401 — typically because uatu
  // was restarted (cookie now stale) or this is a PWA's first launch with no
  // auth cookie yet.
  function showPasteTokenUI(): void {
    const wrap = park("auth-required");
    wrap.className = "terminal-auth";
    const heading = document.createElement("p");
    heading.className = "terminal-auth-heading";
    heading.textContent = "Reconnect to uatu";
    const help = document.createElement("p");
    help.className = "terminal-auth-help";
    help.textContent =
      "uatu has restarted or this window has no saved credentials. Paste the token printed by `uatu` in your shell to continue.";
    const form = document.createElement("form");
    form.className = "terminal-auth-form";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "paste token";
    input.className = "terminal-auth-input";
    input.setAttribute("aria-label", "uatu terminal token");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Connect";
    submit.className = "terminal-auth-submit";
    const status = document.createElement("p");
    status.className = "terminal-auth-status";
    status.setAttribute("aria-live", "polite");
    form.append(input, submit);
    wrap.append(heading, help, form, status);
    requestAnimationFrame(() => input.focus());

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const candidate = input.value.trim();
      if (!candidate) return;
      submit.disabled = true;
      status.textContent = "Validating…";
      const ok = await persistTerminalToken(candidate);
      if (!ok) {
        submit.disabled = false;
        status.textContent = "Token rejected. Check the value printed by uatu in your shell.";
        input.select();
        return;
      }
      try {
        window.sessionStorage.setItem(TERMINAL_TOKEN_KEY, candidate);
      } catch {
        // sessionStorage unavailable; cookie is still set so we can proceed.
      }
      status.textContent = "Connected.";
      attach();
    });
  }

  // Park the pane when credentials are valid but the origin gate refused
  // this page's address (inventory answered 403). Deliberately a dead end:
  // no token input (the token is fine), no reconnect (the next attempt fails
  // identically), no claim that uatu restarted (it didn't). Reached only
  // when the browser's address genuinely fails the gate — e.g. a reverse
  // proxy rewriting the Host header.
  function showOriginRejectedUI(): void {
    const wrap = park("origin-rejected");
    const address = (() => {
      try {
        return window.location.host;
      } catch {
        return "this page's address";
      }
    })();
    card(
      wrap,
      "terminal-origin-rejected",
      "Terminal blocked for this address",
      `Your credentials are valid, but the terminal refused the connection because the address this page uses (${address}) ` +
        "did not pass its origin check. uatu allows localhost and 127.0.0.1 on the same port the browser is connected to. " +
        "This can happen when a proxy in front of uatu rewrites the Host header.",
    );
  }

  // Park the pane after a takeover: the session is alive in another window.
  // A notice with an explicit "Take back" action — the ONLY path that
  // re-claims a session lost this way, so two windows can never ping-pong
  // it without a human in the loop.
  function showTakenOverUI(): void {
    const wrap = park("taken");
    card(
      wrap,
      "terminal-taken",
      "Attached in another window",
      "Another uatu window took over this session. It keeps running there — take it back to continue here.",
    );
    wrap.append(actionButton("terminal-taken-takeback", "Take back", () => {
      takeoverArmed = true;
      attach();
    }));
  }

  // Recovery found the PTY held by another client for the whole window: a
  // real second holder, or a copied pane reference. The choice is the
  // user's — an explicit takeover, or a shell of this pane's own.
  function showOccupiedUI(): void {
    const wrap = park("occupied");
    card(
      wrap,
      "terminal-occupied",
      "Attached in another window",
      "This shell is attached to another uatu window. Take it over to continue here, or open a new shell in this pane.",
    );
    const actions = document.createElement("div");
    actions.className = "terminal-card-actions";
    actions.append(
      actionButton("terminal-occupied-takeover", "Take over", () => {
        takeoverArmed = true;
        attach();
      }),
      actionButton("terminal-occupied-new", "New shell", () => options.onNewShell?.()),
    );
    wrap.append(actions);
  }

  // The shell exited, or inventory no longer lists the PTY: nothing to
  // reattach and nothing to take over. The pane stays until the user acts.
  function showEndedUI(): void {
    const wrap = park("ended");
    card(
      wrap,
      "terminal-ended",
      "Shell ended",
      "This terminal's shell is no longer running. Open a new shell here, or close the pane.",
    );
    wrap.append(actionButton("terminal-ended-new", "New shell", () => options.onNewShell?.()));
  }

  // The recovery budget ran out without a verdict: inventory could not be
  // read, or the transport never delivered reconstruction. The saved PTY
  // reference is kept — the shell may well be running — and Retry starts a
  // fresh budget.
  function showUnreachableUI(): void {
    const wrap = park("unreachable");
    card(
      wrap,
      "terminal-unreachable",
      "Terminal not reachable",
      "Couldn't reconnect this terminal. Its shell may still be running — try again in a moment.",
    );
    wrap.append(actionButton("terminal-unreachable-retry", "Retry", () => attach()));
  }

  function detach(): void {
    // 1000 is a plain goodbye: the server detaches the session and the PTY
    // keeps running for a later reattach.
    teardown(1000, "panel hidden", "idle");
  }

  function terminate(): boolean {
    // The user confirmed losing the session — tell the server to kill the
    // PTY. Everything else about the teardown is identical to detach().
    return teardown(CLOSE_CODE_USER_TERMINATE, "user-close", "idle");
  }

  function release(): void {
    if (state === "idle") {
      // Nothing to release, but the pane must resume with the others: a
      // pane added while the document is suspended (its create resolved
      // after pagehide) must not attach until the document runs again.
      setState("suspended");
      return;
    }
    if (state !== "connecting" && state !== "ready" && state !== "recovering") return;
    // 1000 again: a page departure is a detach, never a termination, and
    // saying so explicitly is what lets the child release the PTY promptly
    // instead of whenever the browser gets around to the socket.
    teardown(1000, "page hidden", "suspended");
  }

  function resume(): void {
    if (state !== "suspended") return;
    begin("connecting");
  }

  function fitNow(): void {
    if (!fit) return;
    try {
      fit.fit();
    } catch {
      // Hidden / zero-rect — ignore.
    }
  }

  function focusNow(): void {
    // Focus is a promise, not a moment: xterm can only take focus after
    // term.open() runs, and open happens on the first ResizeObserver tick —
    // an unpredictable time after attach() (WS connect, layout, session
    // chooser). Focusing "now" when the terminal isn't open yet is the race
    // that made the sidebar button only sometimes land the cursor, so an
    // early call parks the intent and openXtermNow() honors it.
    try {
      if (term?.element) {
        term.focus();
        pendingFocus = false;
        return;
      }
    } catch {
      // term has been disposed — fall through and park the intent.
    }
    pendingFocus = true;
  }

  // Decorations give the scrollback the same "all matches plus a brighter
  // current one" reading the preview highlights do. The colors are literals
  // because the addon requires #RRGGBB and cannot resolve CSS variables; they
  // mirror the dark-scheme --find-match-bg / --find-current-bg values, which
  // is the right pair since the terminal is always dark-themed.
  const searchDecorations = {
    matchBackground: "#3f2e00",
    activeMatchBackground: "#9e6a03",
    matchOverviewRuler: "#3f2e00",
    activeMatchColorOverviewRuler: "#9e6a03",
  };

  const terminalSearch: TerminalSearch = {
    findNext(query, options) {
      search?.findNext(query, { ...options, decorations: searchDecorations });
    },
    findPrevious(query, options) {
      search?.findPrevious(query, { ...options, decorations: searchDecorations });
    },
    clear() {
      // Searching for nothing is how the addon is told to drop its
      // decorations and selection.
      search?.findNext("", { decorations: searchDecorations });
    },
    onResults(listener) {
      searchResultsListener = listener;
    },
  };

  return {
    attach,
    detach,
    terminate,
    release,
    resume,
    state: () => state,
    fit: fitNow,
    focus: focusNow,
    setFontSize(px: number) {
      if (!term) return;
      term.options.fontSize = px;
      // The container hasn't changed size, so the ResizeObserver will not
      // fire — fit AND publish the new grid to the PTY explicitly, or
      // shells and TUIs keep rendering for the old cols/rows.
      if (syncPtySize) {
        syncPtySize();
      } else {
        fitNow();
      }
    },
    sendInput(data: string) {
      liveSocket()?.send(new TextEncoder().encode(data));
    },
    paste(text: string) {
      pasteTerminalInput(
        term,
        liveSocket() !== null,
        text,
        active => {
          semanticPasteActive = active;
        },
      );
    },
    showSelectionSheet,
    dismissSelectionSheet: () => dismissSelectionSheet(),
    isSelectionSheetOpen: () => selectionSheet !== null,
    isAttached: () => state === "connecting" || state === "ready" || state === "recovering",
    search: terminalSearch,
  };
}
