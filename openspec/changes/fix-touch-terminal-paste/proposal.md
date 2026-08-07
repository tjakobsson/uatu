## Why

The touch terminal's Paste action is inert on iPhone and iPad because it requests clipboard access on `pointerdown`, before non-mouse input receives the transient user activation required by the Clipboard API. Paste is part of the 0.5.0 initial mobile-support release bar, and commands, paths, and tokens cannot be entered practically without it.

## What Changes

- Preserve terminal focus when the Paste control is pressed, but defer clipboard access to a touch-release or equivalent semantic activation event that carries user activation.
- Ensure one physical activation pastes at most once while retaining keyboard-operable button behavior.
- Forward keybar clipboard text through xterm's paste path so newline normalization and bracketed-paste handling match native and keyboard paste.
- Treat unavailable, denied, synchronous-failure, and empty clipboard reads as inert without sending PTY input or crashing the terminal.
- Add automated coverage for activation timing, duplicate suppression, keyboard activation, paste semantics, and failure paths, plus real-device Safari verification.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `embedded-terminal`: Strengthen the touch-keybar Paste requirement to define release-time user activation, focus preservation, keyboard operability, exactly-once activation, xterm paste semantics, and failure behavior.

## Impact

- Affects the touch keybar event handling in `src/terminal/keybar.ts`, terminal panel/client input seams, and their colocated tests.
- Extends mobile terminal browser coverage in `tests/e2e/`; WebKit clipboard authorization still requires a real iPhone/iPad acceptance pass.
- Changes no server protocol, PTY lifecycle, configuration, dependencies, desktop keybar visibility, or broader terminal layout behavior.
- Tracks GitHub issue #189 and remains independent of the terminal redesign in #180.
