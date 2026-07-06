# Tasks — add-osc52-clipboard-bridge

## 1. Config plumbing

- [x] 1.1 Add `clipboard` to `TerminalConfig` in `src/terminal/config.ts` with values `notify` | `confirm` | `silent` | `off`, warn-and-fallback-to-`notify` validation mirroring `fontFamily`/`fontSize`; unit tests in `config.test.ts`
- [x] 1.2 Deliver the clipboard policy to the browser client along the same path the terminal font config already flows, defaulting to `notify` when absent

## 2. OSC 52 handler

- [x] 2.1 Implement the OSC 52 payload parser in `src/terminal/clipboard.ts`: split `<selection>;<data>`, accept selections `c`/`p`/`s` only, detect the `?` query form, base64-decode, enforce the 100 KB decoded cap; return a discriminated result (accepted / query / invalid / oversized) — pure function, unit-tested in `clipboard.test.ts`
- [x] 2.2 Implement the policy layer in `src/terminal/clipboard.ts`: given a parse result and a policy, decide write-now / hold-for-confirm / drop, with `writeText` rejection promoting to hold-for-confirm; queries and `off` produce no action and never touch `readText`; unit-tested with a stubbed clipboard
- [x] 2.3 Register the handler in `src/terminal/client.ts` via `term.parser.registerOscHandler(52, …)` at pane creation, skipping registration entirely when the policy is `off`; keep `allowProposedApi: false`

## 3. Copy toast

- [x] 3.1 Add a pane-scoped toast to `src/terminal/panel.ts`: transient "Copied N characters" form (auto-dismiss) and persistent Copy-button form; text-node-only rendering; rapid events coalesce to one visible toast per pane
- [x] 3.2 Wire the Copy button so the pending text is written to the clipboard inside the click gesture, then dismiss; oversized-payload rejections surface through the same toast under `notify`/`confirm`

## 4. Verification

- [x] 4.1 E2E test in `tests/e2e/` (new `terminal-clipboard.e2e.ts` or the existing terminal suite): `printf` an OSC 52 sequence in the PTY, assert the clipboard content and toast under `notify`; assert no clipboard change under `off`; assert a `?` query produces no PTY response
- [x] 4.2 Run `bun test` and the terminal-related e2e specs; verify manually via `bun run dev` by emitting `printf '\e]52;c;%s\a' "$(printf hi | base64)"` in the embedded terminal and pasting on the host
- [x] 4.3 Document the `terminal.clipboard` key and the container copy story in README/ARCHITECTURE alongside the existing `.uatu.json` terminal options
