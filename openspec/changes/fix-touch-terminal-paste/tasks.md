## 1. Keybar Activation Semantics

- [x] 1.1 Split Paste from the keybar's `pointerdown` action path: retain `preventDefault()` for focus preservation and invoke clipboard reading only from the Paste button's semantic `click` activation.
- [x] 1.2 Replace the keybar's raw-send callback for clipboard text with an injected semantic paste callback, and contain missing API support, synchronous throws, rejected reads, and empty text without escaping errors or sending input.
- [x] 1.3 Extend `keybar.test.ts` to prove pointerdown does not read, one pointer/click sequence pastes once, Enter/Space-style click activation follows the same path, focus-preserving prevention remains, and every clipboard failure form is inert.

## 2. Xterm Paste Path

- [x] 2.1 Add `paste(text)` to `TerminalPanelHandle`, delegating connected non-empty input to xterm's `term.paste()` while leaving `sendInput()` unchanged for raw keybar sequences.
- [x] 2.2 Wire the panel's keybar paste callback to resolve the active attached pane at completion time, invoke its semantic paste operation, and retain/restore terminal focus.
- [x] 2.3 Add client/panel coverage proving keybar clipboard text uses the xterm paste seam rather than raw socket input and remains inert without an active attached pane.

## 3. Browser And Device Coverage

- [x] 3.1 Extend the mobile Playwright suite to grant clipboard permission, seed clipboard text, activate the visible Paste button, and observe exactly one copy of the text reaching the terminal.
- [x] 3.2 Verify multiline keybar input uses bracketed-paste framing when the shell enables bracketed-paste mode.
- [ ] 3.3 Run a real-device acceptance pass in iPhone and iPad Safari, checking the permission callout, successful paste, exactly-once input, and that the software keyboard/focus does not collapse; record the result in this change.
  - Partial findings (2026-08-07, uatu hub over Tailscale HTTPS): keybar Paste succeeded in Safari on an iPhone 13 Pro running iOS 26.6. The iPad pass and the remaining explicit acceptance checks are still required.
- [x] 3.4 Verify ordinary iOS touch selection and native Copy while on-device; if broken, file a separate follow-up rather than expanding this change.
  - Finding: terminal output could not be selected and native Copy was unavailable on the iPhone 13 Pro, while Preview selection worked. Tracked separately in GitHub issue #196.

## 4. Verification

- [x] 4.1 Run the focused terminal keybar, client, panel, and clipboard unit tests.
- [x] 4.2 Run `bun test` and the relevant mobile/terminal Playwright tests, then run `openspec validate fix-touch-terminal-paste`.
