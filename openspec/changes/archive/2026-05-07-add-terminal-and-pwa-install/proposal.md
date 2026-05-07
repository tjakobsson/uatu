## Why

UatuCode is widening from a pure read-only watcher into a light dev surface that lives next to the rendered codebase. Two pieces support that pivot: an embedded terminal so users can sanity-check, run a test, or inspect git state without alt-tabbing out of the preview, and a PWA install path so the UI runs in a standalone window where TUI editors (nvim, helix) and other keyboard-heavy tools don't fight the browser for `Cmd+W`, `Cmd+T`, `Cmd+L`, or `Cmd+R`.

## What Changes

- Add a hidden-by-default bottom panel hosting an `xterm.js`-rendered terminal attached to a real PTY in the watched repo's working directory, toggled with `Ctrl+`` (VS Code muscle memory).
- Add a WebSocket upgrade route on the existing Bun server (uatu's first bidirectional transport) that pipes terminal I/O between the browser and a PTY backed by Bun's built-in `Bun.spawn(..., { terminal })` API (Bun 1.3.5+).
- Spawn the PTY on websocket attach, kill it on disconnect with a short reconnect grace window. No persistent terminal sessions in v1.
- Ship a uatu-themed ANSI-color dark palette as the default xterm theme, driven by CSS variables so it tracks the existing app palette.
- Add an authentication token issued at server start and required on the websocket upgrade, plus an `Origin` allowlist on the upgrade handshake. Localhost-only binding stays unchanged.
- Make the app installable as a PWA: ship a `/manifest.webmanifest`, raster icons (192px and 512px PNGs), and a minimal pass-through service worker so Edge/Chrome surface the install affordance.
- Pin a default port (e.g. 4711) and only roll on conflict, so the PWA install identity stays stable across sessions. **BREAKING** for users relying on dynamic-port behavior — opt out with `--port 0` or `--port <n>`.
- Add a layout primitive for a horizontal-resizable bottom panel that coexists with the existing sidebar resizer, with collapsed-state and panel-height persistence in `localStorage`.

## Capabilities

### New Capabilities
- `embedded-terminal`: Bottom-panel xterm.js terminal backed by a localhost PTY, including transport, lifecycle, theme, keyboard model, and security envelope.
- `pwa-install`: Manifest, icons, service worker, and stable-port story that makes uatu installable as a desktop-style standalone webapp.

### Modified Capabilities
<!-- None — these are net-new surfaces. The watch / preview / sidebar capabilities are untouched in their requirements. -->

## Impact

- **Code**: New `src/terminal.ts` (browser pane), new `src/terminal-server.ts` (PTY + WS lifecycle), new `src/terminal-pty.ts` (thin adapter over `Bun.spawn { terminal }`), new `src/terminal-backend.ts` / `src/terminal-auth.ts` / `src/terminal-config.ts` / `src/port-probe.ts` helpers, edits to `src/cli.ts` (route table, port pinning, token issuance, manifest/icon/SW routes, `/api/auth` cookie endpoint), edits to `src/app.ts` (panel mount, runtime PWA link injection, SW registration), edits to `src/index.html` (panel markup), edits to `src/styles.css` (panel + resizer + xterm theme tokens + auth form), new asset files under `src/assets/` (192/512 PNG icons, manifest, service worker).
- **Dependencies**: Add `@xterm/xterm` and `@xterm/addon-fit`. No native dependency — the PTY uses Bun 1.3.5+'s built-in `Bun.spawn(..., { terminal })`, so the standalone binary works out of the box on macOS and Linux.
- **Server surface**: First WebSocket upgrade in this codebase. Establishes the pattern for any future bidirectional features.
- **Security posture**: Localhost-only binding still applies, but the endpoint now accepts shell input. Token + origin check are non-negotiable.
- **Tests**: New unit tests for token issuance, origin checks, PTY lifecycle on disconnect, and panel layout persistence. New e2e test that opens the panel, types a command, asserts output, closes the panel, asserts PTY teardown.
