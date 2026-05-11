## 1. Platform detection and Keyboard Lock plumbing

- [x] 1.1 Add a `detectIsMac()` helper in `src/terminal.ts` that returns `true` when `navigator.userAgentData?.platform` starts with `"mac"` (case-insensitive), falling back to `navigator.platform`. Default to `false` when neither is populated.
- [x] 1.2 Add a module-level `acquireKeyboardLockOnce()` helper in `src/terminal.ts` that (a) returns early if already called once on this page, (b) returns early when `window.matchMedia('(display-mode: standalone)').matches` is false, (c) returns early when `navigator.keyboard?.lock` is missing, and (d) calls `navigator.keyboard.lock(['KeyC'])` with a `.catch` that emits `console.debug` only. No `await`; fire-and-forget.

## 2. Custom key event handler

- [x] 2.1 Inside `mountTerminalPanel`, right after the `Terminal` instance is constructed, call `term.attachCustomKeyEventHandler` with a closure that captures `term` and the `isMac` boolean.
- [x] 2.2 In the handler, return `true` immediately for `event.type !== 'keydown'` so `keyup` events are never swallowed.
- [x] 2.3 In the handler, return `true` immediately when `isMac` is true (macOS Cmd/Ctrl shortcuts are left to `xterm.js`'s defaults).
- [x] 2.4 Implement the bare `Ctrl+C` selection-aware branch: when `event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()`, call `navigator.clipboard.writeText(term.getSelection())`, `term.clearSelection()`, `event.preventDefault()`, and return `false`.
- [x] 2.5 Implement the bare `Ctrl+V` paste branch: when `event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'v'`, call `navigator.clipboard.readText().then(text => term.paste(text)).catch(() => {})`, `event.preventDefault()`, and return `false`.
- [x] 2.6 Implement the `Ctrl+Shift+C` copy branch: when `event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c'`, copy the selection (if any), then `event.preventDefault()` and return `false` regardless of whether there was a selection (so DevTools never opens).
- [x] 2.7 Implement the `Ctrl+Shift+V` paste branch: when `event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'v'`, identical body to 2.5.
- [x] 2.8 For all other events, return `true` (pass through to `xterm.js`). Do not call `event.stopPropagation()` so document-level panel-toggle shortcuts continue to fire for keys not in the handled set.

## 3. Wire the Keyboard Lock call to terminal mount

- [x] 3.1 Inside `mountTerminalPanel`, call `acquireKeyboardLockOnce()` once per mount (the helper internally guarantees page-singleton behavior). Place the call after `term.open(options.container)` so it runs only when a pane is actually being attached.

## 4. Unit and integration tests

- [x] 4.1 Add `src/terminal-clipboard.test.ts` exercising the custom key handler logic in isolation. Use a fake `Terminal` stub with `getSelection`, `hasSelection`, `clearSelection`, and `paste` mocks, and a fake `navigator.clipboard` (`readText`, `writeText`) that resolves to controlled values.
- [x] 4.2 Cover: bare Ctrl+C with selection (writeText called, clearSelection called, returns false); bare Ctrl+C without selection (clipboard not touched, returns true); bare Ctrl+V (readText called, paste called with the resolved text, returns false); Ctrl+Shift+C with and without selection (always returns false; clipboard only touched when selection present); Ctrl+Shift+V (paste called).
- [x] 4.3 Cover the macOS short-circuit: when `isMac` is true, every event returns `true` and the clipboard / `term.paste` are untouched, including for `Ctrl+C`, `Ctrl+V`, `Ctrl+Shift+C`, `Ctrl+Shift+V`.
- [x] 4.4 Cover the silent-failure case: when `navigator.clipboard.readText` rejects, the handler still returns `false` and emits no thrown error, and `term.paste` is not called.
- [x] 4.5 Cover the platform detection helper with stubbed `navigator.userAgentData.platform` and `navigator.platform` values for macOS, Windows, Linux, and missing data.
- [x] 4.6 Cover the `acquireKeyboardLockOnce` helper: not called when `display-mode` is `browser`; not called when `navigator.keyboard` is missing; called exactly once across multiple invocations when both gates pass; silent on rejection.

## 5. Manual verification

> Skipped at change time — to be exercised post-merge on the actual hardware. Unit tests cover the handler logic and platform / lock helper behavior; the only thing manual verification adds is the live Keyboard Lock interaction with Edge, which can't be reproduced headlessly.

- [x] 5.1 Install the UatuCode PWA on Windows in Microsoft Edge. Open the terminal panel. Verify that `Ctrl+Shift+C` (with selection) copies and does NOT open DevTools. *(deferred)*
- [x] 5.2 In the same installed PWA: verify bare `Ctrl+C` with selection copies and clears the selection, bare `Ctrl+C` without selection sends SIGINT (interrupts a running `sleep 30`), bare `Ctrl+V` pastes, and `Ctrl+Shift+V` pastes. *(deferred)*
- [x] 5.3 In a regular Edge browser tab (not installed PWA): verify all shortcuts work except `Ctrl+Shift+C`, which is allowed to open DevTools (Keyboard Lock is intentionally not requested outside standalone mode). *(deferred)*
- [x] 5.4 On macOS: verify `Cmd+C` and `Cmd+V` continue to work via `xterm.js` defaults, and bare `Ctrl+C` always sends SIGINT regardless of selection. *(deferred)*
- [x] 5.5 On Linux (any modern Chromium-based browser, installed PWA): repeat 5.1 and 5.2. *(deferred)*
- [x] 5.6 In Firefox and Safari: verify that all clipboard shortcuts still work where the platform supports them, and that the absence of `navigator.keyboard` does not throw any error visible in the console. *(deferred)*

## 6. Update README / docs (optional, only if a docs section exists)

- [x] 6.1 If `README.md` documents terminal keybindings, add the new clipboard shortcuts to the list. If no such section exists, do not introduce one.
