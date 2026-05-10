## Context

The embedded terminal pipes shell output from a Bun-spawned PTY through a server-side adapter (`terminal-pty.ts`) into a per-session WebSocket handler (`terminal-server.ts`), and finally into xterm.js in the browser (`terminal.ts`). The current adapter decodes the kernel's `read()` chunks to JavaScript strings via a module-level `TextDecoder`, then the server re-encodes those strings back to UTF-8 bytes for the WebSocket frame.

PTY chunks have no awareness of UTF-8 codepoint boundaries. When a chunk ends mid-codepoint — extremely common with TUIs that emit dense `─` (`E2 94 80`) runs — `TextDecoder.decode(bytes)` (without `{ stream: true }`) replaces every leftover byte with `U+FFFD` instead of buffering them for the next call. The replacement-character glyphs are then re-encoded as `EF BF BD` and shipped to the browser, where they render as visible "diamonds" and, more insidiously, throw off the cell-layout math of cursor-positioning TUIs (Claude Code, opencode), producing ghost overlays and table scrambling.

A single shared module-level `TextDecoder` would also corrupt across sessions if `{ stream: true }` were enabled — its internal partial-codepoint buffer would mix bytes from different PTYs.

Verified end-to-end with `printf '%.0s─' {1..2200}` showing `U+FFFD` clusters at every `read()` boundary.

## Goals / Non-Goals

**Goals:**
- Eliminate `U+FFFD` substitutions caused by PTY-chunk-boundary splits in shell output.
- Preserve byte fidelity from the PTY's `read()` to xterm.js's parser without server-side string round-trips.
- Add a regression test that fails before the fix and passes after, exercising splits at every byte offset of a multi-byte codepoint.

**Non-Goals:**
- Changing the input direction (browser → PTY). The browser's `TextEncoder` always produces complete UTF-8, so the existing `string`-based input path is correct as-is. (Noted as future cleanup, not part of this change.)
- Adding image-protocol support, OSC 8 hyperlinks, or any other capability — this is purely a correctness fix.
- Loading the `@xterm/addon-unicode11` width-table addon. Unrelated to this bug; it can be evaluated separately.
- Bundling a Nerd Font webfont. Earlier hypothesis, ruled out by the verification step. Not relevant.

## Decisions

### Decision 1: Pass `Uint8Array` end-to-end (Option A) over streaming-decode patch (Option B)

**Chosen:** Option A — change `PtyProcess.onData` listener type to `(data: Uint8Array) => void` and forward the raw bytes from Bun's PTY callback to xterm.js untouched.

**Alternatives considered:**

```
Option A — Pass-through Uint8Array
─────────────────────────────────────────────────────────────
PTY ─bytes─▶ spawnPty data callback ─bytes─▶ listener
                                                │
                                                ▼
              terminal-server: socket.send(bytes)
                                                │
                                                ▼
                          xterm.write(Uint8Array)
                          (built-in stateful UTF-8 decoder
                           handles split codepoints correctly)

✓ Zero conversions. Bug class eliminated structurally.
✓ Removes the module-level TextDecoder entirely (kills the
  cross-session contamination risk dead).
✓ Smaller code: deletes the decoder, deletes the conditional
  re-encode in terminal-server.ts.
✗ Listener signature change (BREAKING for callers of
  PtyProcess.onData — internal only, single caller).

Option B — Streaming-decode patch
─────────────────────────────────────────────────────────────
PTY ─bytes─▶ spawnPty: decoder.decode(bytes, { stream: true })
                                                │
                                                ▼
                                listener(string)
                                                │
                                                ▼
              terminal-server: TextEncoder.encode(string) ─▶ bytes
                                                │
                                                ▼
                            socket.send(bytes)

✓ Two-line patch (per-session decoder + stream flag).
✓ No interface change.
✗ Keeps the bytes → string → bytes round trip with no benefit.
✗ Trailing partial codepoint at PTY exit becomes one final
  U+FFFD (acceptable but avoidable with Option A).
✗ Needs eternal vigilance: if a future contributor reverts
  { stream: true } or moves the decoder back to module scope,
  the bug returns silently.
```

**Rationale:** Option A removes the bug class structurally rather than patching the symptom. The "BREAKING" listener change is internal-only — `terminal-server.ts` is the sole consumer and already has a code path that accepts `Uint8Array`. The diff is net-negative in lines of code.

### Decision 2: Trust xterm.js's built-in UTF-8 decoder

xterm.js's `Terminal.write(data: string | Uint8Array)` accepts a `Uint8Array` and processes it through `Utf8ToUtf32` (in xterm's `src/common/input/TextDecoder.ts`), which maintains a `_interim` buffer for partial codepoints across calls. This is the canonical contract for streaming PTY data into xterm; it is what node-pty + xterm integrations rely on.

**Alternatives considered:** introduce a custom server-side streaming decoder. Rejected — duplicates work xterm already does, adds maintenance, and gains nothing.

### Decision 3: Keep `PtyProcess.write(data: string)` (input direction) unchanged

Browser → PTY input arrives at the WebSocket handler as `Uint8Array` and is currently converted via `Buffer.from(data).toString("utf8")`. Because the browser's `TextEncoder` always emits complete UTF-8 (no streaming, no partials), this conversion is lossless for normal keystrokes. Large pastes are still atomic from `TextEncoder`'s perspective.

A future cleanup could switch this side to bytes too for symmetry, but it is **not** the bug we are fixing and falls outside this change.

### Decision 4: Test by exhaustive-offset splitting

The regression test will:
1. Build a fixture buffer of N copies of the byte sequence `E2 94 80` (`─`).
2. For each offset 0..N*3, slice the buffer into two chunks at that offset.
3. Feed both chunks through the production code path into a real `Terminal` instance.
4. Assert the resulting buffer's row content contains no `U+FFFD` (`�`) and exactly N `─` characters.

This catches the original bug, all 3-byte split positions, and any future regression to non-streaming decoding.

## Risks / Trade-offs

- **Listener signature change** → mitigated: only one in-tree caller; type system catches the migration.
- **Future contributors might reintroduce a string round-trip** → mitigated: regression test pins behavior at every byte offset; reviewers will see test fail.
- **xterm.js parser bugs around UTF-8 splits** → low risk: xterm.js has explicit support for chunked binary input; this is the documented use case for `term.write(Uint8Array)`. If an upstream bug surfaces, it would have surfaced with node-pty already.
- **Trailing partial codepoint on PTY exit** → with Option A, xterm.js drops the partial silently when the connection ends, which is identical to terminal behavior elsewhere; no user-visible regression.
