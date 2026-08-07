## Context

`@xterm/xterm` does not support native touch selection on iOS, even with its DOM renderer. Its event and selection machinery is desktop-centered. Real-device attempts to enable selection on xterm itself and on a pane-local text overlay both failed: Safari latched into caret magnification or scrolling without committing a selection. Preview text selection works on the same device because it is ordinary document content using body scrolling.

Uatu therefore needs to leave the terminal interaction hierarchy entirely for selection while keeping the PTY and xterm instance alive in the background.

## Goals / Non-Goals

**Goals:**

- Present terminal output through the same ordinary document-selection model that already works in Preview.
- Include the active buffer's available scrollback and visible rows in a stable snapshot.
- Open near the current prompt, retain older output above, and wrap long lines for phone reading.
- Keep the live terminal attached and restore it with accumulated output and keyboard focus.
- Preserve normal terminal, Paste, desktop selection, TUI mouse, and OSC 52 behavior outside transcript mode.

**Non-Goals:**

- Modifying xterm internals or emulating native handles.
- Sending transcript selection gestures to a TUI.
- Freezing PTY output.
- Reproducing ANSI styling or terminal cell geometry in the transcript.

## Decisions

### Render a document-level transcript

Select snapshots `term.buffer.active` and appends a transcript directly to `document.body`, as a sibling of the app shell. Each logical line is ordinary non-editable DOM rather than xterm rows, a focusable text control, one giant `<pre>`, or a pane-local overlay. Lines use Preview-like wrapping so the page remains readable at phone width.

This is preferred over the failed pane-local approaches because it removes every xterm ancestor, fixed terminal overlay, pane overflow clip, and terminal gesture listener from the selection event path.

### Use body scrolling and park the app shell

While the transcript is open, a body class overrides touch Terminal's page lock. The app shell and tab bar remain mounted at full size but become fixed, invisible, inert, and non-interactive; the transcript becomes the only normal-flow document. A compact terminal-styled heading provides context, while a fixed safe-area-aware bottom action bar takes the touch tab bar's place and keeps Done reachable regardless of transcript length. After layout and fonts settle, the document scrolls to its live end; users can scroll upward through retained output.

### Keep a static bounded snapshot

The formatter iterates xterm's bounded active buffer, trims trailing empty screen rows, and joins wrapped rows into logical lines. The transcript splits those logical lines into individual DOM elements. Output continues into xterm underneath without mutating text nodes under native selection. Reopening Select creates a fresh snapshot.

### Restore explicitly

Done removes the transcript and body mode, clears transcript selection, restores the prior document scroll position, removes xterm inertness, and focuses the terminal. Teardown also removes an open transcript without attempting focus restoration.

### Verify structural parity, then use real devices

Automated coverage verifies that the transcript is a direct body child, uses document scrolling, supports DOM Range selection, stays stable during delayed output, and restores xterm. Native iOS handles and the system Copy menu still require iPhone/iPad validation.

## Risks / Trade-offs

- [Transcript loses ANSI styling] -> Treat it explicitly as a reading/copy surface and preserve text content rather than cloning fragile renderer DOM.
- [Logical line reconstruction differs from terminal wrapping] -> Wrap transcript line DOM to the phone viewport; copied text preserves logical lines rather than visual cell wraps.
- [Large transcript increases page size] -> xterm already bounds scrollback to 5,000 lines, and the transcript uses one element per logical line.
- [Output changes while reading] -> Keep the snapshot stable and reveal accumulated output only after Done.
