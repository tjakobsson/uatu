## Context

The embedded terminal panel uses `xterm.js` v6 (`@xterm/xterm`) rendered into a DOM container managed by `mountTerminalPanel` in `src/terminal.ts`. Bytes flow between the browser and a real PTY over a per-session WebSocket. Today the `Terminal` instance is constructed with default options and no custom key handler is registered, so all clipboard behavior comes from `xterm.js`'s built-in `copy` / `paste` DOM event listeners and from the user's browser.

Empirical findings on Microsoft Edge (Windows) running the installed UatuCode PWA:

- **Bare `Ctrl+V`**: `xterm.js`'s `keydown` handler runs first and sends the literal `0x16` byte (`^V`) to the PTY; the browser-level `paste` event either never fires on the helper textarea or fires after the keystroke has been consumed.
- **`Ctrl+Shift+V`**: Edge's "paste as plain text" handling forces a real `paste` DOM event before the keystroke is delivered to `xterm.js`, so `xterm.js`'s built-in paste hook catches it and the bracketed-paste path works.
- **`Ctrl+Shift+C`**: Edge consumes the chord for the DevTools "inspect element" shortcut **even inside the installed PWA in `display: standalone`** mode. The keystroke never reaches our page.
- **`Ctrl+C`**: passes through to the PTY as SIGINT (`0x03`), as expected. There is no selection-aware copy behavior.

On macOS the existing `xterm.js` defaults work fine — Cmd+C / Cmd+V are routed via the browser's `copy` / `paste` events and `xterm.js`'s `SelectionService` handles them. No change wanted there.

The reference target for "correct" behavior is Windows Terminal: bare `Ctrl+C` copies if there is a selection and SIGINTs otherwise; bare `Ctrl+V` pastes; `Ctrl+Shift+C` / `Ctrl+Shift+V` are aliases for the same actions.

## Goals / Non-Goals

**Goals:**

- Match Windows Terminal's copy/paste keybindings inside the embedded terminal for users on Windows and Linux.
- Preserve `xterm.js`'s existing macOS Cmd+C / Cmd+V behavior unchanged.
- Preserve bare `Ctrl+C` as SIGINT whenever the terminal has no selection.
- Defeat Edge's `Ctrl+Shift+C` DevTools shortcut inside the installed PWA so users get the Windows-Terminal-parity binding they expect.
- Keep the change localized to `src/terminal.ts` — no protocol or server-side work.

**Non-Goals:**

- Right-click context menu for Copy / Paste.
- `Ctrl+Insert` / `Shift+Insert` aliases.
- Auto-copy on selection release (iTerm2-style).
- Confirmation prompt for large or multi-line paste.
- Restoring readline's `Ctrl+V` literal-next behavior (the override deliberately replaces it, matching Windows Terminal).
- Capturing any browser-reserved key beyond `Ctrl+Shift+C` (no `Ctrl+T` / `Ctrl+W` / `Ctrl+N` lock; not needed for clipboard parity).
- Behavior changes outside the embedded terminal (the rest of the UatuCode UI already has its own clipboard handling for the copy-code button and similar controls).

## Decisions

### Use `attachCustomKeyEventHandler`, not a document-level capture listener

`xterm.js` exposes `term.attachCustomKeyEventHandler((e: KeyboardEvent) => boolean)`. The handler runs **before** `xterm.js`'s internal key→bytes translation; returning `false` swallows the event entirely. This is the supported API for exactly this purpose. Alternatives considered:

- **Document-level `keydown` listener in capture phase** (as used today for the panel-toggle hotkey in `src/app.ts:3220`). This works but is brittle: it conflicts with the panel-toggle handler, requires guarding against firing while focus is outside the terminal, and fights `xterm.js`'s own listeners for the same event. The `xterm.js`-blessed API avoids these pitfalls.
- **Replace the default `copy` / `paste` DOM event handlers.** These work on macOS but, as we have just established, they don't fire reliably for bare `Ctrl+V` in Edge PWA. Relying on them is the bug we are fixing.

### Use the async Clipboard API, not `document.execCommand`

For copy we use `navigator.clipboard.writeText(selection)`. For paste we use `navigator.clipboard.readText()` and feed the result into `term.paste(text)` so `xterm.js` performs the bracketed-paste wrapping when the shell has enabled it. UatuCode is always served over `localhost` (or a future HTTPS deploy), which satisfies the secure-context requirement for the async Clipboard API. `document.execCommand('copy' | 'paste')` is deprecated, fragile, and on Firefox cannot read the clipboard at all.

`readText()` requires a user gesture in most browsers; firing it directly from a `keydown` handler that the user actually initiated satisfies that requirement. If `readText()` rejects (focus lost, denied permission, missing API), we catch and silently no-op rather than fall back — the user can try again, and pretending to paste empty content would be more confusing than doing nothing.

### Platform detection: only run the Ctrl-prefixed branches on non-Mac

On macOS the user uses Cmd-prefixed shortcuts and the existing `xterm.js` defaults handle them. We do not want our handler to fire for `Ctrl+C` on a Mac and accidentally swallow it when the user did want SIGINT but happened to have a selection from a prior mouse drag. Detection: prefer `navigator.userAgentData?.platform` (modern Chromium) and fall back to `navigator.platform` (deprecated but still populated everywhere we care about). A platform string starting with `"mac"` (case-insensitive) is treated as macOS. The detection happens once at handler-attach time; the resulting boolean is captured in closure.

On macOS the handler still attaches, but every branch short-circuits on `isMac && event.ctrlKey` so the event passes through to `xterm.js`.

### Selection-aware Ctrl+C: copy on selection, SIGINT otherwise

The condition is `event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "c" && term.hasSelection()`. When true: `navigator.clipboard.writeText(term.getSelection())`, `term.clearSelection()`, return `false` to swallow. When false (no selection): return `true` so `xterm.js` emits the SIGINT byte. Clearing the selection after copy matches Windows Terminal and avoids the easy-to-trip footgun of pressing Ctrl+C twice and getting one copy and one SIGINT.

### Ctrl+V always pastes (does not pass through as `^V`)

This is a deliberate, documented behavior change. It matches Windows Terminal. The trade-off — losing readline's literal-next — is acceptable because (a) Windows Terminal users have already accepted it, (b) advanced users who need to insert literal control characters have other escape hatches in their shells, and (c) the alternative is leaving the most common keyboard convention broken for Windows users.

### Ctrl+Shift+C / Ctrl+Shift+V are explicit branches

For `Ctrl+Shift+C` we copy when there is a selection and swallow as a no-op when there is none. The no-op case still returns `false` because if we let it through, the browser's DevTools shortcut would fire (in browser tabs, and possibly in some PWA edge cases where Keyboard Lock did not engage). Better to do nothing than to leak focus into DevTools.

For `Ctrl+Shift+V` we paste exactly like `Ctrl+V`. Same code path.

### Keyboard Lock API for Ctrl+Shift+C in standalone PWA

`navigator.keyboard.lock(['KeyC'])` instructs the browser to deliver `KeyC` keystrokes (including with modifiers) to the page instead of consuming them for browser shortcuts like `Ctrl+Shift+C` → DevTools. Constraints:

- Requires a secure context (localhost OK).
- Standalone display mode (or fullscreen). We gate on `window.matchMedia('(display-mode: standalone)').matches`.
- Currently Chromium-only. We feature-detect `navigator.keyboard?.lock` and silently skip on Firefox / Safari / older browsers.
- The lock is page-scoped, not per-`Terminal` instance. We acquire it once per page (on first terminal mount) and never release it explicitly. Reload drops it.

Lock acquisition uses `.then(undefined, () => {})` (no `await`, no surfaced error) — we treat success and failure identically because the keystroke is still handled correctly **when the user is using it as a copy**, and the failure mode (DevTools opens) is recoverable. We log a single `console.debug` line on rejection for diagnostics; no user-visible message.

### Handler attaches per `Terminal` instance, but lock is page-wide

Each panel pane constructs its own `Terminal` and calls `attachCustomKeyEventHandler`. The Keyboard Lock call is wrapped in a module-level "tried once" flag so 8 panes do not call it 8 times. The flag is reset on `beforeunload` only implicitly (the page reloads).

### Pass-through return value semantics

`attachCustomKeyEventHandler` semantics: returning `true` lets `xterm.js` process the key normally; returning `false` swallows. For chords we explicitly handle, we always return `false` (and call `event.preventDefault()` defensively). For everything else we return `true`. We do **not** call `event.stopPropagation()` because we want our document-level panel-toggle handler in `src/app.ts:3226` to keep working for `Ctrl+`` ` and `Esc`; those keys are not in our handled set so they pass through anyway, but being explicit about not stopping propagation is documented in a code comment.

## Risks / Trade-offs

- **[Risk]** `navigator.clipboard.readText()` rejection inside Edge PWA when focus is on the terminal helper textarea. → Mitigation: wrap in try/catch; silent no-op on rejection. Empirically `readText()` works in Edge PWA standalone when the gesture originates from a key event on a focused element.
- **[Risk]** Keyboard Lock does not actually defeat Edge's DevTools shortcut in some Edge versions or enterprise-policy-restricted environments. → Mitigation: feature-detect and accept best-effort behavior; document the limitation in the spec's scenarios. The selection-aware bare `Ctrl+C` and right-click clipboard menus available in the OS still let users copy text another way.
- **[Risk]** Losing readline's `Ctrl+V` literal-next breaks workflows for power users who relied on it. → Mitigation: documented behavior change; matches Windows Terminal so the population of affected users is small and already calibrated. No mitigation in code.
- **[Risk]** Platform detection misclassifies a non-Mac browser as Mac (or vice versa). → Mitigation: detection happens once at handler attach; both `navigator.userAgentData.platform` and `navigator.platform` are extremely stable for this distinction. Misclassification on Mac only causes `Ctrl+C` with selection to copy (mild surprise on Mac); misclassification on non-Mac would cause `Ctrl+V` to send `^V` (current broken behavior). Acceptable failure mode.
- **[Trade-off]** Per-pane handler attachment vs. one page-level handler. Per-pane is the `xterm.js`-blessed pattern, it scopes the closure to the specific `Terminal` instance (we need `term.getSelection()` and `term.paste()`), and there is no measurable cost for the soft cap of 8 panes.
- **[Trade-off]** No right-click menu means users who get stuck (Keyboard Lock unsupported, focus lost) have to discover Ctrl+Shift+V or the OS clipboard menu. Accepted per scope decision.
