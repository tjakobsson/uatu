## Why

Shell output now looks like terminal output, but its 12-line preview interrupts longer logs, the chat column constrains wide output, and following the latest content has been reported to jump up and down. Stable scrollback and a resizable floating output window would let readers inspect running and completed commands without losing their place.

## What Changes

- Present shell command output as one bounded-height scrollback viewport, with all provider-supplied output available by scrolling while running and after completion.
- Follow incoming output while at the bottom; pause following when the reader scrolls upward and resume when they return to the bottom or choose a latest-output control.
- Reproduce and fix follow jitter across passive following, activating latest, and scrolling upward during updates; verify both the outer timeline and shell output rather than assuming the new viewport resolves it.
- Keep inline height adjustment and add Pop out into one movable, horizontally and vertically resizable window inside UatuCode. It can exceed both the transcript text width and Chat panel width, and Maximize fills the app work area.
- Provide Return to chat and Escape to return inline; Restore size returns a maximized window to its previous floating geometry. Touch uses a full-area output view rather than a draggable window.
- Preserve output position, horizontal offset, inline height, floating geometry, and follow state through updates, movement, resizing, pop-out, and completion.
- Keep a popped-out command visible after completion, failure, or cancellation, with its command, conversation, actual outcome, and completion time when supplied. Later commands do not replace it automatically. Explicit conversation changes or leaving the owning child still close the window.
- Apply the same behavior to shell tools and normalized command items in parent and subagent conversations, retaining existing ANSI interpretation and terminal styling.
- Keep non-shell output's existing preview behavior and preserve long-chat responsiveness, find, selection, and outer timeline anchoring.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Replace shell preview truncation with terminal-style scrollback; specify stable following, accessible resizing, in-app floating output, command identity and outcome, and reading-position continuity.

## Impact

- Shared Chat rendering and interactions in `src/chat/timeline-renderer.ts`, `src/chat/ui.ts`, and focused shell-output/window controllers; incremental terminal-text support in `src/chat/ansi.ts` as needed.
- Follow coordination in `src/chat/anchor.ts`, `src/chat/viewport.ts`, and their UI call sites, guided by browser reproduction evidence.
- An app-level floating output host, layout, and terminal styles in `src/index.html` and `src/styles.css`.
- Colocated renderer/controller/ANSI tests and shell-output browser scenarios in `tests/e2e/chat-shell-output.e2e.ts`, plus frame-level follow diagnostics and long-output responsiveness checks.
- The known-completion requirement needs optional `completedAt` propagation through tool/command types, validation, provider normalization, and the wire schema. Closed response objects require workspace API revision 19 with migration guidance. No provider protocol, PTY, or dependency changes are needed. Scrollback covers output supplied by the provider; it cannot recover upstream truncation.
