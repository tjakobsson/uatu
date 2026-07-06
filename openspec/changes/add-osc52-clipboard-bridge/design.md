# Design — OSC 52 clipboard bridge

## Context

uatu's embedded terminal is xterm.js in the browser connected over a WebSocket to a PTY on the uatu server. When the server runs in a container and the browser on the host, the two copy paths diverge:

- **xterm.js-owned selection** (plain shell): handled today by `src/terminal/clipboard.ts` — Ctrl+C / Ctrl+Shift+C writes to `navigator.clipboard`, which is the host clipboard because the browser runs on the host. Works.
- **TUI-owned selection** (Claude Code, opencode, anything enabling mouse-tracking mode): the app receives the mouse events, handles selection itself, and copies by emitting OSC 52 (`ESC ] 52 ; <sel> ; <base64> BEL/ST`) up the PTY. `src/terminal/client.ts` creates the Terminal with only `FitAddon` and no OSC 52 handler, so xterm.js drops the sequence. The payload dies one hop from the host clipboard.

Paste already crosses correctly (`navigator.clipboard.readText` → `term.paste` → PTY), so only the copy direction needs bridging.

## Goals / Non-Goals

**Goals:**
- Application-initiated copies (OSC 52) from inside the terminal reach the host clipboard.
- Zero clipboard-exfiltration surface: the query form is never answered.
- Poisoning is visible: users can always tell when something in the terminal set their clipboard.
- Works on Chromium silently and on Firefox/Safari via a one-click fallback.
- Policy is configurable per uatu instance via the existing `.uatu.json` `terminal` block.

**Non-Goals:**
- OSC 52 read/query support — permanently out of scope, not just deferred.
- Bridging in-container clipboard *tools* (`xclip`, `wl-copy`); apps that bypass the TTY are out of reach by design. OSC 52 is the documented mechanism.
- A server-side clipboard or clipboard history.
- Changes to the existing keyboard-shortcut copy/paste behavior.

## Decisions

### D1: Bridge at the xterm.js parser via `registerOscHandler(52, …)`
The handler is registered in `src/terminal/client.ts` at Terminal creation, per pane. `term.parser.registerOscHandler` is stable public xterm.js API (no `allowProposedApi`, which stays `false`). Alternatives considered:
- **`@xterm/addon-clipboard`**: rejected — it implements both directions of OSC 52; we would depend on a package and then disable half of it. A ~40-line handler we fully control is a smaller trusted surface and needs no new license-audit entry.
- **Server-side interception of the PTY stream**: rejected — the server would have to parse escape sequences out of a byte stream xterm.js already parses, and the clipboard lives in the browser anyway.

### D2: Write-only, by construction
The OSC 52 payload format is `<selection>;<data>`. When `<data>` is `?` the app is asking to *read* the clipboard; the handler returns without emitting any response, so the app's query times out exactly as on a terminal without OSC 52 support. There is no code path that reads `navigator.clipboard` in response to PTY output. This eliminates exfiltration rather than mitigating it.

### D3: Policy ladder with `notify` as default
`terminal.clipboard` in `.uatu.json`: `"notify"` (default) | `"confirm"` | `"silent"` | `"off"`.

- `notify`: attempt `writeText` immediately, show a transient toast "Copied N characters from terminal". Default because the terminal is an authenticated, deliberately opened surface, and the toast gives *better* poisoning visibility than native terminals that ship OSC 52 silently enabled. Defaulting to `off` would leave the exact users this change targets (container users) with the current broken behavior.
- `confirm`: never write silently; the toast shows a preview-length and a Copy button, and the write happens inside the click gesture. Maximum posture for users who paste terminal content into privileged host contexts.
- `silent`: write with no toast, for users who find the toast noisy and accept the poisoning-visibility trade-off.
- `off`: the handler is not registered; xterm.js's default ignore applies.

The config value is validated in `src/terminal/config.ts` (warning + fallback to `notify` on invalid values, mirroring the existing `fontFamily`/`fontSize` handling) and delivered to the client the same way font config already flows.

### D4: `confirm`-style toast is also the browser-compat fallback
Chromium permits `clipboard.writeText` without user activation while the document is focused; Firefox and Safari generally require a gesture, and an OSC 52 write arrives with none. In `notify`/`silent` modes, a rejected `writeText` promotes the toast to its `confirm` form (Copy button, write inside the click). One mechanism degrades gracefully instead of a per-browser code path.

### D5: Size cap and payload hygiene
Decoded payloads over 100 KB (the conventional terminal OSC 52 limit) are dropped; in `notify`/`confirm` modes the toast reports the rejection so a truncated copy is never mistaken for a successful one. Invalid base64 is dropped silently. Only selection parameters `c`, `p`, and `s` are honored (all map to the single browser clipboard — the first write wins per sequence); other parameters are ignored.

### D6: Toast lives in the terminal panel
The toast is rendered by `src/terminal/panel.ts`, scoped to the pane that received the sequence, not the app-wide shell — the event is terminal-local, and panel ownership keeps `src/shell/` free of terminal concerns (matching the module boundaries in `module-structure`). Auto-dismiss after a few seconds in `notify` mode; persistent until acted on or dismissed in `confirm`/fallback mode. Multiple rapid copies coalesce into the latest toast.

## Risks / Trade-offs

- [Clipboard poisoning in `silent` mode] → Mode is opt-in via config; default `notify` keeps every write visible.
- [Toast fatigue in `notify` mode] → Rapid sequences coalesce; `silent` exists as an explicit opt-out.
- [TUIs that copy via in-container tools instead of OSC 52 still fail] → Out of scope by design; most TUI clipboard libraries fall back to OSC 52 when no tool is found, and headless containers rarely have one. Document OSC 52 as the supported mechanism.
- [`writeText` rejection semantics differ across browsers/versions] → The fallback triggers on *any* rejection, not on browser sniffing, so behavior drift degrades to the Copy button rather than to data loss.
- [A hostile sequence could spam toasts to annoy] → Coalescing bounds this to one visible toast; the size cap bounds memory.

## Open Questions

- None blocking. Whether `confirm` should additionally show a content preview (first ~80 chars) can be decided during implementation; it aids verification but risks rendering hostile content in the UI — if included, it must be text-node-only (no HTML interpretation).
