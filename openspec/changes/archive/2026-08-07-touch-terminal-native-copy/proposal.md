## Why

Terminal output cannot be selected with ordinary iOS touch gestures, so iPhone and iPad users cannot invoke the native Copy action even though Preview selection and terminal Paste work. This leaves a basic remote-workspace interaction unavailable on the mobile platforms Uatu now supports.

## What Changes

- Add a touch-keybar Select action that opens the active pane's terminal output as a document-level transcript using the same normal page-selection model as Preview.
- Let users use ordinary iOS long-press selection and Copy in the transcript, then return to the still-running terminal through a sticky Done action.
- Keep existing desktop mouse selection, terminal keyboard shortcuts, touch Paste, TUI scrolling, and OSC 52 behavior unchanged.
- Cover the browser-facing selection contract with automated tests and validate the complete interaction on real iPhone and iPad devices.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `embedded-terminal`: Require reliable touch selection and Copy for terminal output on coarse-pointer Apple mobile clients without regressing existing terminal input and scrolling behavior.

## Impact

- Browser terminal and touch-keybar integration in `src/terminal/client.ts`, `src/terminal/panel.ts`, and `src/terminal/keybar.ts`.
- Terminal-specific touch styles in `src/styles.css`.
- Terminal unit and mobile E2E coverage, plus real-device Safari/PWA validation.
- No server protocol, PTY lifecycle, configuration, or dependency changes are expected.
