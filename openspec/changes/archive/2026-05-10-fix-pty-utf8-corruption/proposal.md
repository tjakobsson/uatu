## Why

The embedded terminal corrupts multi-byte UTF-8 output from the PTY whenever a kernel `read()` boundary lands mid-codepoint, which is routine for TUIs that emit dense runs of box-drawing characters. The corruption manifests as `U+FFFD REPLACEMENT CHARACTER` glyphs ("diamonds") at chunk seams, and — because each `U+FFFD` occupies one cell where the original codepoint occupied one cell of *different* visual content — TUIs like Claude Code and opencode that redraw via cursor positioning accumulate cell-layout drift, producing ghost overlays, character clipping, and table scrambling. Verified with `printf '%.0s─' {1..2200}` showing diamonds at every wrap-row seam. The bug makes the embedded terminal unusable for the AI coding agents it most needs to host.

## What Changes

- Stop decoding PTY bytes to a `string` on the server and re-encoding back to bytes on the wire. Pass the raw `Uint8Array` end-to-end and let xterm.js's stateful UTF-8 decoder handle partial codepoints across chunk boundaries.
- Change `PtyProcess.onData(listener: (data: string) => void)` to `PtyProcess.onData(listener: (data: Uint8Array) => void)`. **BREAKING** for any internal caller of `terminal-pty.ts`, but the only caller is `terminal-server.ts` which already handles both shapes.
- Drop the module-level shared `TextDecoder` from `terminal-pty.ts` (would have caused cross-session contamination even with a streaming-decode fix).
- Drop the `string → bytes` re-encode branch in `terminal-server.ts` since the listener now always delivers bytes.
- Add a regression test that splits a `─`-heavy stream at every byte offset and asserts no `U+FFFD` reaches the parsed terminal buffer.

## Capabilities

### New Capabilities
<!-- None — this is a fix to an existing capability. -->

### Modified Capabilities
- `embedded-terminal`: the "Terminal protocol carries input, output, and resize" requirement gains an end-to-end byte-fidelity guarantee for shell output. No new requirement is added; an existing one is tightened with a scenario asserting that arbitrary UTF-8 (including codepoints split across chunk boundaries) round-trips faithfully to the rendered cell buffer.

## Impact

- **Code**: `src/terminal-pty.ts` (listener signature + decoder removal), `src/terminal-server.ts` (drop conditional re-encode in `pty.onData` handler).
- **Tests**: new `src/terminal-pty.test.ts` or extension of `src/terminal-server.test.ts` covering byte-boundary splits.
- **APIs**: `PtyProcess.onData` listener signature changes from `string` to `Uint8Array`. Internal-only; no public consumers.
- **Dependencies**: none — fix is purely subtractive.
- **Operational**: behavior change is invisible to users except that the diamond/scramble artifacts disappear. No migration, no flag.
