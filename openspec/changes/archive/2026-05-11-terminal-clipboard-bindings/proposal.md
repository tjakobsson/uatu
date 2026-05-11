## Why

Today the embedded terminal inherits whatever copy/paste behavior the browser and `xterm.js` provide by default. That works on macOS (Cmd+C / Cmd+V hit `xterm.js`'s built-in `copy` / `paste` event hooks) but breaks the moment the UatuCode PWA is used on Windows: bare `Ctrl+V` is consumed by `xterm.js`'s keydown handler and sent to the PTY as the literal `^V` byte instead of pasting the clipboard, and `Ctrl+Shift+C` — the Windows Terminal convention for copy — is hijacked by Edge's DevTools inspector shortcut even inside an installed standalone PWA. The net effect is that users on Windows cannot copy or paste in the terminal using the conventional shortcuts they expect from Windows Terminal, despite our PWA otherwise being feature-complete on Windows.

We want explicit, platform-appropriate clipboard bindings that match Windows Terminal so users get the same muscle memory inside UatuCode.

## What Changes

- Add an `attachCustomKeyEventHandler` to every `xterm.js` instance that intercepts a small, fixed set of clipboard shortcuts before `xterm.js` interprets them as keystrokes.
- `Ctrl+C` becomes selection-aware: when the terminal has a non-empty selection, it copies the selection to the clipboard and clears the selection; when there is no selection, it passes through to the PTY as before (SIGINT).
- `Ctrl+V` is overridden to paste the clipboard via `term.paste()` (bracketed-paste-aware). Bare `Ctrl+V` no longer reaches the PTY as `^V` (readline's literal-next). This matches Windows Terminal's behavior.
- `Ctrl+Shift+C` copies the current selection (or is a no-op when nothing is selected — explicitly swallowed so it cannot fall through to the browser's DevTools shortcut).
- `Ctrl+Shift+V` pastes the clipboard.
- When the page is running as an installed PWA in standalone display mode and `navigator.keyboard.lock` is available, request a lock on `KeyC` so the browser cannot consume `Ctrl+Shift+C` for DevTools. Lock acquisition is best-effort and silent on failure or unsupported browsers.
- macOS `Cmd+C` / `Cmd+V` behavior is unchanged — `xterm.js`'s existing `copy` / `paste` event hooks already handle these, and our handler does not intercept Cmd-modified keys.

Out of scope (explicitly): right-click context menu, `Ctrl+Insert` / `Shift+Insert` aliases, auto-copy on selection, paste confirmation for large or multi-line clipboard content.

## Capabilities

### New Capabilities
<!-- None — this extends an existing capability. -->

### Modified Capabilities
- `embedded-terminal`: adds a requirement that the terminal exposes Windows-Terminal-parity clipboard shortcuts and acquires a Keyboard Lock on `KeyC` in installed-PWA standalone mode.

## Impact

- **Code**: `src/terminal.ts` (custom key event handler, Keyboard Lock call). No server-side changes; no protocol changes; no new dependencies.
- **Tests**: new unit / integration coverage for the key handler logic in `src/terminal*.test.ts`; manual verification on Windows Edge PWA for the Keyboard Lock path (Keyboard Lock cannot be exercised in headless test environments).
- **Behavior change for existing users**: `Ctrl+V` in the terminal no longer sends `^V` to the shell — readline's "quoted-insert" via `Ctrl+V` is no longer available. This matches Windows Terminal; users who need to insert literal control characters can still do so via `Ctrl+Q` (in many readline configurations) or by typing the character directly through their shell's escape mechanism. Considered a deliberate, documented behavior change.
- **No impact** on terminal protocol, PTY lifecycle, session management, persistence, theming, dock/display modes, or split-pane behavior.
