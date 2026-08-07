## 1. Document-Level Transcript

- [x] 1.1 Add a pure bounded-buffer snapshot formatter that preserves hard breaks, joins wrapped rows, and trims trailing empty screen rows.
- [x] 1.2 Add a body-level terminal transcript with ordinary line DOM, document scrolling, live-end positioning, and a fixed bottom return bar replacing touch navigation.
- [x] 1.3 Park and inert the mounted app while the transcript is open, then restore document position, xterm interaction, and focus on Done or teardown.

## 2. Automated Verification

- [x] 2.1 Cover snapshot hard breaks, wrapped rows, trailing blanks, and touch-keybar Select routing in unit tests.
- [x] 2.2 Cover body-level transcript structure, native DOM Range selection, document live-end scrolling, snapshot stability, Done restoration, and unchanged Paste in mobile E2E.
- [x] 2.3 Run terminal unit tests, type checking, the relevant mobile/clipboard E2E tests, the full unit suite, and the production build.

## 3. Real-Device Acceptance

- [x] 3.1 Validate long-press, handle adjustment, native Copy, transcript scrolling, and Done on iPhone Safari using single-line, multi-line, and wrapped output.
  - Findings (2026-08-07): the body-level transcript selected and copied normally on iPhone once the installed PWA loaded matching JS and CSS; scrolling and the persistent return control also worked. Earlier contradictory passes were stale restored PWA assets.
- [x] 3.2 Validate the same transcript flow on iPad Safari and an installed iOS/iPadOS PWA where available.
  - Findings (2026-08-07): the transcript flow also passed on iPad/PWA after refreshing stale cached assets.
- [x] 3.3 Confirm transcript Copy works with `terminal.clipboard: off`, emits no OSC 52 toast or PTY input, and does not regress normal-mode touch Paste or TUI interaction.
  - Findings (2026-08-07): transcript Copy and normal-mode Paste/TUI interaction passed on device with `terminal.clipboard: off`; automated coverage confirms OSC 52 suppression and no PTY input.
