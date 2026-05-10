## 1. Adapter changes

- [x] 1.1 In `src/terminal-pty.ts`, change the `PtyProcess.onData` listener type from `(data: string) => void` to `(data: Uint8Array) => void`.
- [x] 1.2 In `src/terminal-pty.ts`, delete the module-level `const decoder = new TextDecoder()` declaration.
- [x] 1.3 In `src/terminal-pty.ts`, change the Bun `terminal.data` callback to forward the raw `bytes` (a `Uint8Array`) directly to listeners — no decode.
- [x] 1.4 Update the `dataListeners` `Set` type parameter to `(data: Uint8Array) => void`.

## 2. Server changes

- [x] 2.1 In `src/terminal-server.ts`, simplify the `pty.onData(chunk => …)` handler so it sends `chunk` (now always `Uint8Array`) directly via `socket.send`. Drop the `typeof chunk === "string"` branch and the `new TextEncoder().encode(chunk)` re-encode.
- [x] 2.2 Verify no other call site in the repo consumes `PtyProcess.onData` with a string-typed listener (`grep -rn "pty.onData\|PtyProcess" src/`). Update any test doubles or mocks accordingly.

## 3. Regression tests

- [x] 3.1 Created `src/terminal-pty.test.ts` with a real-PTY fixture: shell emits N=2200 copies of `─` (E2 94 80) — large enough to span multiple kernel `read()` chunks, exercising the actual production chunk-boundary scenario.
- [x] 3.2 Replaced exhaustive-offset xterm.js test (would have tested upstream xterm parser, not our pipeline) with the more direct byte-fidelity assertion through the production `spawnPty` data path. The real PTY produces real chunk splits at the kernel boundary — the exact scenario the bug manifests in.
- [x] 3.3 Assert: zero `EF BF BD` (U+FFFD) byte triplets in the captured stream, AND exactly N `E2 94 80` triplets — both conditions must hold. Pre-fix would have failed both.
- [x] 3.4 Added cross-session isolation test: two concurrent `spawnPty` calls emit different codepoints (`─` and `│`) in parallel; assert each session's bytes contain only its own codepoint, no replacement bytes, and no cross-contamination.

## 4. Manual verification

- [x] 4.1 Run `bun test` and ensure all existing terminal tests still pass. (Result: 414 pass / 2 skip / 0 fail across 30 files.)
- [x] 4.2 Manually verified: ran `printf '%.0s─' {1..2200} && echo` in the embedded terminal — diamond clusters that previously appeared at row seams are gone.
- [x] 4.3 Manually verified: bug no longer reproducible with Claude Code inside the embedded terminal.
- [x] 4.4 Manually verified: bug no longer reproducible with the box-drawing TUIs that previously triggered it.

## 5. Cleanup

- [x] 5.1 Updated the comment block at the top of `src/terminal-pty.ts` to document the byte-pass-through invariant and explain why we deliberately don't UTF-8 decode in the adapter (kernel read() boundaries land mid-codepoint; xterm.js's `term.write(Uint8Array)` has the right stateful decoder for this).
- [x] 5.2 Run `openspec validate fix-pty-utf8-corruption --strict` and confirm clean.
