# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/);
versions follow the `package.json`'s `version` field.

## Unreleased

### Added

- **Embedded terminal.** Hidden-by-default bottom panel with a real PTY
  shell in the watched repo, toggled with `Ctrl+`` / `Cmd+``. xterm.js
  rendering, ANSI-color dark theme, locally-installed Nerd Fonts picked up
  by default, optional `.uatu.json` overrides via `terminal.fontFamily`
  and `terminal.fontSize`. Backed by Bun's built-in
  `Bun.spawn(..., { terminal })` API (Bun ≥ 1.3.5).
- **PWA install.** `/manifest.webmanifest`, 192/512 PNG icons, a minimal
  pass-through service worker, and a stable default origin so uatu can be
  installed as a desktop-style standalone webapp from Chrome / Edge /
  Brave (or via "Add to Dock" in Safari). Eliminates browser-shortcut
  conflicts with embedded TUI tools.
- **Token-gated terminal endpoint.** Per-server-session 32-byte token,
  required on the `/api/terminal` WebSocket upgrade alongside an `Origin`
  allowlist. Token persists across PWA launches via an HttpOnly
  SameSite=Strict cookie (`uatu_term`). The browser shows a
  "Reconnect to uatu" form when the cookie is stale (typically after a
  uatu restart), and pasting a fresh token from `uatu`'s stdout refreshes
  the cookie.

### Changed

- **BREAKING — default port is now 4711** (was 4312). The pin keeps PWA
  install identity stable across launches; uatu scans upward to the next
  free port if 4711 is occupied. Pass `--port 4312` to restore the
  previous default, or `--port 0` to opt back into a kernel-assigned
  ephemeral port.
- The startup-printed URL now includes `?t=<token>` when the terminal
  feature is enabled. The browser strips it from `location` on first
  load and stores it in `sessionStorage` + the `uatu_term` cookie.

### Notes

- Windows is unsupported for the terminal feature pending Bun's upstream
  Windows PTY work; on Windows uatu reports `terminal: "disabled"` and
  hides the toolbar terminal toggle. The rest of uatu still runs.
- Safari 17+ blocks pages from seeing user-installed fonts as
  anti-fingerprinting protection. Locally-installed Nerd Fonts will fall
  through to Menlo in the terminal on Safari; Chrome / Edge / Brave have
  no such restriction.
