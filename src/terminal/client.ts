import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import "@xterm/xterm/css/xterm.css";

import {
  acquireKeyboardLockOnce,
  detectIsMac,
  handleClipboardKeyEvent,
} from "./clipboard";

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
      void persistTerminalToken(fromUrl);
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
  wsUrl.pathname = "/api/terminal";
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

// Hand the token to the server so it can mint an HttpOnly cookie. Returns
// true if the server accepted it; the panel UI uses the result to decide
// whether to retry the WebSocket connection.
async function persistTerminalToken(token: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type TerminalPanelHandle = {
  // Mount xterm in the container and connect to the server. Idempotent: a
  // second call when already connected is a no-op.
  attach(): void;
  // Tear down the WebSocket and free xterm. The container's contents are
  // emptied; the panel can be re-attached later. The server keeps the PTY
  // running — reattaching with the same sessionId resumes the session.
  detach(): void;
  // Like detach(), but closes the WebSocket with the app-defined
  // user-terminate code so the server kills the PTY. The ONLY client path
  // that ends a shell session; reserved for the confirmed pane/panel close.
  terminate(): void;
  // Recompute character grid + send resize frame. Call after any panel-height
  // change. Cheap; safe to debounce or invoke from a ResizeObserver.
  fit(): void;
  // Move keyboard focus into xterm. No-op when not attached.
  focus(): void;
  isAttached(): boolean;
};

export type MountTerminalOptions = {
  container: HTMLElement;
  getToken: () => string | null;
  // Per-pane session id (UUID). The server multiplexes multiple PTYs per
  // browser tab by this id. Reusing a pane's id across page reload — or a
  // browser restart, or a laptop sleep — lets the server hand back the SAME
  // live PTY however long the session was detached.
  sessionId: string;
  // Optional per-session overrides sourced from `.uatu.json` via /api/state.
  // Falls back to CSS variable / built-in defaults when omitted.
  fontFamily?: string;
  fontSize?: number;
  // Fires when the WebSocket closes for a reason OTHER than `detach()`
  // (shell exited, server gone, connection dropped). Lets the controller
  // tear down the dead pane automatically. NOT called on auth failure
  // (close-before-open) — that path shows the paste-token form instead.
  onClose?: () => void;
  // Fires when the WebSocket closed before opening but `GET /api/auth`
  // confirms this window's credentials are valid — i.e. the upgrade was
  // rejected for a non-auth reason, in practice a sessionId collision
  // (HTTP 409, another window holds this pane's persisted id). The
  // controller responds by minting a fresh sessionId and rebuilding the
  // pane. When absent, the paste-token form is shown as a fallback.
  onCollision?: () => void;
  // Connect with an explicit takeover claim (session picker attaching to a
  // session held by another window). The mount also re-arms takeover itself
  // when the user activates "Take back" on a parked pane.
  takeover?: boolean;
};

// Mirror of the server's CLOSE_CODE_USER_TERMINATE (terminal/server.ts).
// Defined as a literal on each side — like the 4409 hijack code — because
// importing across the client/server boundary would drag the other side's
// dependencies (node-pty / xterm) into the wrong bundle.
const CLOSE_CODE_USER_TERMINATE = 4001;

// Per-pane terminal mount. The controller owns the panel-level concerns
// (dock, display mode, split layout, visibility); this function owns the
// xterm + WebSocket lifecycle for a single pane.
export function mountTerminalPanel(options: MountTerminalOptions): TerminalPanelHandle {
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let socket: WebSocket | null = null;
  let attached = false;
  let resizeObserver: ResizeObserver | null = null;
  // Set to true when the caller invokes `detach()` so the close-event
  // handler can distinguish "the panel hid me" from "the server hung up".
  // Only the latter triggers `onClose` — hiding the panel must be
  // reversible without auto-removing the pane.
  let detachInitiated = false;
  // One-shot guard for the collision hand-off. The controller's replacement
  // pane is a fresh mount (fresh guard), so this bounds recovery to one
  // retry per mount rather than a reconnect loop against a broken server.
  let collisionSignaled = false;
  // Whether the next connect carries `takeover=1`. Seeded from the mount
  // options (picker attach) and re-armed by the parked pane's "Take back"
  // action. Never reset — takeover of a session this mount already owns
  // degrades to a plain reattach, so over-claiming is harmless.
  let takeoverArmed = options.takeover === true;

  function attach(): void {
    if (attached) return;
    // No token in sessionStorage is valid in two distinct cases:
    //   1) terminal feature off — caller should have guarded; bail safely.
    //   2) PWA fresh launch — start_url has no ?t=; rely on the auth cookie
    //      established when the user first opened the URL in a browser. We
    //      attempt connection without a token and let the cookie do the
    //      work. If both fail, the close handler shows the paste UI.
    connect(options.getToken());
  }

  function connect(token: string | null): void {
    if (attached) return;
    detachInitiated = false;

    term = new Terminal({
      theme: buildTheme(),
      cursorBlink: true,
      // Resolution order for fontFamily: explicit option (from .uatu.json
      // via /api/state) → CSS variable → built-in fallback. Same idea for
      // fontSize. Keeps user settings in one place but lets CSS own the
      // default look.
      fontFamily:
        options.fontFamily
          || readVar("--terminal-font-family", "")
          || '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: options.fontSize ?? 13,
      // 1.0 — anything larger leaves a visible gap between rows that breaks
      // half-block / box-drawing tiling (TUIs like opencode and lazygit
      // render large logos out of stacked half-blocks). Comfortable reading
      // text height belongs to the document preview, not the terminal.
      lineHeight: 1.0,
      scrollback: 5000,
      allowProposedApi: false,
    });
    // Windows-Terminal-parity clipboard shortcuts. Attached BEFORE open()
    // because xterm.js consults this handler from its keydown listener; the
    // listener is wired during open(). Mac short-circuits to passthrough
    // inside the handler so Cmd+C / Cmd+V keep using xterm's defaults.
    const isMac = detectIsMac();
    term.attachCustomKeyEventHandler(event => handleClipboardKeyEvent(event, term!, isMac));
    fit = new FitAddon();
    term.loadAddon(fit);
    options.container.replaceChildren();

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
    let openDone = false;
    let lastCols = 0;
    let lastRows = 0;

    function openXtermNow(): void {
      if (!term || !fit || openDone) return;
      openDone = true;
      try {
        term.open(options.container);
        fit.fit();
        lastCols = term.cols;
        lastRows = term.rows;
        // Belt-and-suspenders repaint. xterm buffers any term.write()
        // calls that happened before open(); the buffered data renders on
        // first paint after open(), but a canvas that was created during
        // a transition can hold a stale frame until something forces a
        // repaint. refresh() does exactly that, cheaply.
        term.refresh(0, term.rows - 1);
        // If the WebSocket already opened (data may already be flowing),
        // send a corrected resize now that we have real dimensions.
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
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

    // Token in URL when we have one (first-tab path); otherwise rely on the
    // HttpOnly auth cookie set by /api/auth (PWA / subsequent visits).
    // sessionId is always present — the server requires it for multiplexing.
    socket = new WebSocket(
      buildTerminalWebSocketUrl(window.location.href, options.sessionId, token, takeoverArmed),
    );
    socket.binaryType = "arraybuffer";

    let didOpen = false;

    socket.addEventListener("open", () => {
      didOpen = true;
      // If xterm is already opened (toggle path — container had real
      // dimensions before observe() fired), send the initial resize now.
      // If xterm isn't opened yet (auto-restore path), openXtermNow() will
      // send the resize the moment it opens.
      if (term && openDone && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });

    socket.addEventListener("message", event => {
      if (!term) return;
      if (typeof event.data === "string") {
        // Control frames (e.g. shell-exit) are JSON; render them as a faint
        // marker rather than swallowing silently so the user knows the
        // session ended.
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.type === "exit") {
            term.write(`\r\n\x1b[2m[shell exited${parsed.exitCode != null ? ` with code ${parsed.exitCode}` : ""}]\x1b[0m\r\n`);
          }
        } catch {
          // Non-JSON text from the server is unexpected; ignore.
        }
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      term.write(bytes);
    });

    socket.addEventListener("close", event => {
      if (!didOpen) {
        // Connection failed BEFORE the WebSocket opened. The browser exposes
        // no upgrade status code on the close event, so a close-without-open
        // is ambiguous between an auth failure (401/403 — stale cookie after
        // a uatu restart, fresh PWA window) and a sessionId collision (409 —
        // another window already holds this pane's persisted id; common now
        // that PTY sessions persist indefinitely). Probe `GET /api/auth` to
        // disambiguate: valid credentials → collision → the controller
        // rebuilds the pane with a fresh sessionId; invalid → paste-token
        // form.
        void classifyPreOpenFailure();
        return;
      }
      // 4410 = "session taken": another window claimed this session with an
      // explicit takeover. Park the pane — notice + take-back action — and
      // never reconnect on our own; the session is alive, just elsewhere,
      // and silent re-claims would ping-pong it between windows.
      if (event.code === 4410) {
        attached = false;
        showTakenOverUI();
        return;
      }
      // 4409 = our app-defined "sessionId hijacked" code (see
      // terminal-server.ts in-open race guard). Close the pane silently —
      // the controller's onClose callback below tears it down.
      const isHijacked = event.code === 4409;
      if (isHijacked && term) {
        term.write("\r\n\x1b[2m[session claimed by another tab]\x1b[0m\r\n");
      }
      // User toggled the panel hidden (or confirmed a close); the teardown
      // is intentional and the pane should NOT be auto-removed here — for a
      // plain detach its sessionId is reused to reattach to the still-live
      // PTY later.
      if (detachInitiated) return;
      // Server-initiated close (shell exited or connection dropped).
      // Surface a brief "[disconnected]" line for debug visibility, then
      // signal the controller to remove the dead pane.
      if (term) term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
      attached = false;
      options.onClose?.();
    });

    const encoder = new TextEncoder();
    term.onData(data => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encoder.encode(data));
    });

    // Re-fit and notify the server whenever the panel height changes.
    // This SAME observer also drives the initial xterm open: the first
    // time the container has a non-zero contentRect, openXtermNow() runs
    // synchronously inside the observer callback. After that, every
    // observation is a refit. observe() itself fires an initial dispatch
    // right after layout settles, so on the toggle path (container
    // already has dimensions) and the auto-restore-on-refresh path
    // (container dimensions land after observe()), open happens at the
    // right moment in both cases.
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
      try {
        fit.fit();
      } catch {
        // FitAddon throws if the terminal is hidden (zero rect); benign.
        return;
      }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      }
    });
    resizeObserver.observe(options.container);

    attached = true;
  }

  // Replace the xterm host with a small form prompting the user to paste a
  // fresh token from their `uatu` CLI output. Used when a WebSocket upgrade
  // fails before opening — typically because uatu was restarted (cookie now
  // stale) or this is a PWA's first launch with no auth cookie yet.
  function showPasteTokenUI(): void {
    // Tear down any partial xterm state inline. `attached` is set at mount
    // time (end of connect()), not at socket-open — so detach() WOULD work
    // here, but this path also replaces the container with the form, so it
    // owns its whole cleanup explicitly.
    try {
      socket?.close();
    } catch {
      // Already closing.
    }
    socket = null;
    try {
      term?.dispose();
    } catch {
      // Already disposed.
    }
    term = null;
    fit = null;
    try {
      resizeObserver?.disconnect();
    } catch {
      // Already disconnected.
    }
    resizeObserver = null;
    attached = false;

    const container = options.container;
    container.replaceChildren();
    const wrap = document.createElement("div");
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
    container.append(wrap);
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
      // Re-attempt connection. attach() short-circuits if attached, so call
      // connect() directly with the now-cached token.
      connect(candidate);
    });
  }

  function teardown(closeCode: number, closeReason: string): void {
    if (!attached) return;
    attached = false;
    detachInitiated = true;
    try {
      resizeObserver?.disconnect();
    } catch {
      // Already disconnected.
    }
    resizeObserver = null;
    try {
      socket?.close(closeCode, closeReason);
    } catch {
      // Already closing.
    }
    socket = null;
    try {
      term?.dispose();
    } catch {
      // Already disposed.
    }
    term = null;
    fit = null;
    options.container.replaceChildren();
  }

  // Park the pane after a takeover: the session is alive in another window.
  // Same teardown shape as showPasteTokenUI, then a notice with an explicit
  // "Take back" action — the ONLY path that re-claims the session, so two
  // windows can never ping-pong it without a human in the loop.
  function showTakenOverUI(): void {
    try {
      socket?.close();
    } catch {
      // Already closing.
    }
    socket = null;
    try {
      term?.dispose();
    } catch {
      // Already disposed.
    }
    term = null;
    fit = null;
    try {
      resizeObserver?.disconnect();
    } catch {
      // Already disconnected.
    }
    resizeObserver = null;
    attached = false;

    const container = options.container;
    container.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "terminal-taken";
    const heading = document.createElement("p");
    heading.className = "terminal-taken-heading";
    heading.textContent = "Attached in another window";
    const help = document.createElement("p");
    help.className = "terminal-taken-help";
    help.textContent =
      "Another uatu window took over this session. It keeps running there — take it back to continue here.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "terminal-taken-takeback";
    button.textContent = "Take back";
    button.addEventListener("click", () => {
      takeoverArmed = true;
      attach();
    });
    wrap.append(heading, help, button);
    container.append(wrap);
  }

  // Disambiguate a close-before-open failure. 204 from `GET /api/auth`
  // means this window's credentials are valid, so the upgrade was refused
  // for a non-auth reason — in practice the pre-upgrade 409 for a sessionId
  // another window holds — and the controller should rebuild the pane with
  // a fresh id. 401 (or a network error, where the form's copy is still the
  // most useful guidance) falls back to the paste-token form.
  async function classifyPreOpenFailure(): Promise<void> {
    let authed = false;
    try {
      const token = options.getToken();
      const url = token ? `/api/auth?t=${encodeURIComponent(token)}` : "/api/auth";
      const response = await fetch(url, { method: "GET" });
      authed = response.status === 204;
    } catch {
      authed = false;
    }
    if (authed && options.onCollision && !collisionSignaled) {
      collisionSignaled = true;
      options.onCollision();
      return;
    }
    showPasteTokenUI();
  }

  function detach(): void {
    // 1000 is a plain goodbye: the server detaches the session and the PTY
    // keeps running for a later reattach.
    teardown(1000, "panel hidden");
  }

  function terminate(): void {
    // The user confirmed losing the session — tell the server to kill the
    // PTY. Everything else about the teardown is identical to detach().
    teardown(CLOSE_CODE_USER_TERMINATE, "user-close");
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
    try {
      term?.focus();
    } catch {
      // term has been disposed or hasn't opened yet — no-op.
    }
  }

  return {
    attach,
    detach,
    terminate,
    fit: fitNow,
    focus: focusNow,
    isAttached: () => attached,
  };
}
