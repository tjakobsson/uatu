import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import "@xterm/xterm/css/xterm.css";

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

// Hand the token to the server so it can mint an HttpOnly cookie. Returns
// true if the server accepted it; the panel UI uses the result to decide
// whether to retry the WebSocket connection.
export async function persistTerminalToken(token: string): Promise<boolean> {
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
  // emptied; the panel can be re-attached later.
  detach(): void;
  // Recompute character grid + send resize frame. Call after any panel-height
  // change. Cheap; safe to debounce or invoke from a ResizeObserver.
  fit(): void;
  isAttached(): boolean;
};

export type MountTerminalOptions = {
  container: HTMLElement;
  getToken: () => string | null;
  // Optional per-session overrides sourced from `.uatu.json` via /api/state.
  // Falls back to CSS variable / built-in defaults when omitted.
  fontFamily?: string;
  fontSize?: number;
};

// Single-terminal panel. v1 spawns one PTY per browser; multi-tab is a future
// change. Mount once at app boot and call attach()/detach() as the panel
// shows/hides.
export function mountTerminalPanel(options: MountTerminalOptions): TerminalPanelHandle {
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let socket: WebSocket | null = null;
  let attached = false;
  let resizeObserver: ResizeObserver | null = null;

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
    fit = new FitAddon();
    term.loadAddon(fit);
    options.container.replaceChildren();
    term.open(options.container);
    fit.fit();

    const wsUrl = new URL(window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/api/terminal";
    // Token in URL when we have one (first-tab path); otherwise rely on the
    // HttpOnly auth cookie set by /api/auth (PWA / subsequent visits).
    wsUrl.search = token ? `?t=${encodeURIComponent(token)}` : "";
    socket = new WebSocket(wsUrl.toString());
    socket.binaryType = "arraybuffer";

    let didOpen = false;

    socket.addEventListener("open", () => {
      didOpen = true;
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

    socket.addEventListener("close", () => {
      if (!didOpen) {
        // Connection failed BEFORE the WebSocket opened. The browser exposes
        // no upgrade status code on the close event, but a close-without-
        // open after an attempted upgrade is functionally equivalent to a
        // 401 / 403 on /api/terminal. Show the paste-token UI so the user
        // can re-authenticate (typical case: uatu was restarted and the
        // cookie went stale, or this is a PWA's first launch with no
        // cookie yet).
        showPasteTokenUI();
        return;
      }
      if (term) term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
    });

    socket.addEventListener("open", () => {
      // Send the initial size so the server's PTY matches the viewport
      // before the first keystroke. The fit-addon-driven ResizeObserver
      // below covers subsequent changes.
      if (term && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });

    const encoder = new TextEncoder();
    term.onData(data => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encoder.encode(data));
    });

    // Re-fit and notify the server whenever the panel height changes.
    let lastCols = term.cols;
    let lastRows = term.rows;
    resizeObserver = new ResizeObserver(() => {
      if (!term || !fit) return;
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
    // Tear down any partial xterm state — the failed-upgrade socket cleanup
    // doesn't go through detach() because attached was never set to true.
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

  function detach(): void {
    if (!attached) return;
    attached = false;
    try {
      resizeObserver?.disconnect();
    } catch {
      // Already disconnected.
    }
    resizeObserver = null;
    try {
      socket?.close(1000, "panel hidden");
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

  function fitNow(): void {
    if (!fit) return;
    try {
      fit.fit();
    } catch {
      // Hidden / zero-rect — ignore.
    }
  }

  return {
    attach,
    detach,
    fit: fitNow,
    isAttached: () => attached,
  };
}
