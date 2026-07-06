# Add OSC 52 clipboard bridge

## Why

When uatu runs inside a container (or on a remote host) and the user runs a mouse-mode TUI such as Claude Code or opencode in the embedded terminal, the TUI's select-to-copy lands nowhere useful: the app copies via the OSC 52 escape sequence (which xterm.js silently drops today because no handler is registered) or via an in-container clipboard tool that the host can never see. The browser rendering the terminal already runs on the host, so every dropped OSC 52 payload arrives one hop away from the host clipboard and is thrown away. Paste already crosses the boundary correctly (`navigator.clipboard.readText` → PTY); copy is the missing half.

## What Changes

- Register a write-only OSC 52 handler on the embedded terminal's xterm.js parser that decodes the base64 payload and writes it to the host clipboard via `navigator.clipboard.writeText`.
- Never implement the OSC 52 read/query form (`ESC ] 52 ; c ; ?`) — queries are ignored, eliminating the clipboard-exfiltration attack class entirely.
- Enforce a payload size cap (100 KB decoded, the conventional terminal limit); oversized payloads are dropped.
- Show a transient, terminal-scoped toast on every accepted OSC 52 copy ("Copied N characters from terminal") so silent clipboard poisoning by hostile escape sequences is always visible.
- Degrade gracefully on browsers that require user activation for `clipboard.writeText` (Firefox, Safari): when the silent write rejects, the toast persists with a Copy button that performs the write inside the click gesture.
- Add a `terminal.clipboard` policy key to the existing `.uatu.json` `terminal` block: `"notify"` (default — write + toast), `"confirm"` (always require the toast's Copy button), `"silent"` (write, no toast), `"off"` (handler not registered; sequences fall through to xterm.js's default ignore).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `embedded-terminal`: Add a requirement that the terminal bridges application-initiated OSC 52 clipboard writes to the host clipboard under a configurable policy, write-only, size-capped, with copy-visibility feedback; extend the `.uatu.json` terminal config requirement with the `clipboard` key.

## Impact

- `src/terminal/clipboard.ts` — new OSC 52 decode/policy logic beside the existing shortcut handling (colocated unit tests in `clipboard.test.ts`).
- `src/terminal/client.ts` — register the OSC 52 handler on terminal creation (`term.parser.registerOscHandler(52, …)`, stable public API; `allowProposedApi` stays `false`).
- `src/terminal/panel.ts` — host the terminal-scoped copy toast.
- `src/terminal/config.ts` — parse and validate the new `terminal.clipboard` key (colocated tests in `config.test.ts`).
- No new dependencies: `@xterm/addon-clipboard` is deliberately not used because it also implements the read side, which this change forbids.
- E2E coverage in `tests/e2e/` exercising an emitted OSC 52 sequence end to end.
