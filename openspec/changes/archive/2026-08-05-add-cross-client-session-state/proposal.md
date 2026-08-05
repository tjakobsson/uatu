## Why

Hub sessions can now be opened from multiple browsers and computers, but Uatu still treats origin-scoped browser storage as both personal workspace memory and terminal identity. That loses continuity on a new client, leaks unnamespaced settings between Hub workspace paths, couples PTY ownership to one browser's storage, and cannot faithfully reconstruct a running TUI when a fresh terminal emulator attaches at different dimensions.

## What Changes

- Add Hub-backed personal workspace state keyed by authenticated user and stable workspace id, with the implicit `local` user in trusted local mode.
- Persist the user's last document, Follow preference, preview mode, compare target, Files filter, and last-active PTY reference across browser, Desktop, Hub, and child-session restarts.
- Keep physical presentation client-local: widths, heights, docking, split ratios, zoom, window arrangement, terminal pane arrangement, and other viewport-dependent values are never authoritative Hub state.
- Resolve boot state predictably: an explicit document or preview URL wins; otherwise restore personal workspace state; otherwise use session defaults.
- Make compare target and browsing scope personal rather than shared mutable child-session state, so one open client does not alter another client's active view or review lens.
- Persist personal changes for future opens without live-synchronizing navigation or presentation into already-open clients.
- Replace browser-created PTY identity and localStorage reattach hints with server-created, inventoried PTY resources that clients explicitly create, attach, take over, or terminate.
- Keep one interactive attachment per PTY; another client may explicitly take over, while existing PTYs are listed rather than automatically attached on a new client.
- Introduce an attach-ready handshake in which the client reports its fitted dimensions before terminal restoration, and reconstruct a coherent fresh-client terminal display rather than replaying an arbitrary byte tail. This includes fixing issue #168 for raw-mode TUIs, alternate-screen state, scrollback, and cross-size attachment.
- Reset existing browser-persisted Uatu preferences when the new state model ships; no legacy storage migration or fallback is retained.

## Capabilities

### New Capabilities
- `personal-workspace-state`: Durable Hub-owned per-user/per-workspace semantic resume state, client-local presentation boundaries, boot precedence, persistence lifetime, local-mode identity, and non-live synchronization semantics.

### Modified Capabilities
- `document-routing`: Root workspace arrivals restore the user's last document while explicit document and preview URLs remain authoritative.
- `follow-mode`: Follow becomes a persisted personal workspace preference rather than only a server default or transient browser value.
- `change-review-load`: Compare target becomes personal per user/workspace instead of a single shared session-global value.
- `sidebar-shell`: The Files filter persists as personal workspace state rather than an origin-wide localStorage key.
- `embedded-terminal`: PTYs become server-created resources with explicit attachment ownership, client-local layout, and coherent fresh-emulator reconstruction at the attaching client's dimensions.
- `hub-auth`: Local mode exposes a stable implicit `local` identity for ownership of personal workspace state.
- `hub-service`: The Hub durably stores personal workspace state and identifies the authenticated user and workspace at session-facing state APIs without exposing child tokens.

## Impact

- Hub state storage, authenticated request handling, proxy/session API routing, and workspace removal lifecycle.
- SPA boot, URL precedence, `appState` ownership, preference persistence, and removal of scattered semantic localStorage reads/writes.
- Watch-session scope and compare-target APIs, which must stop imposing one client's personal choices on every connected client.
- Terminal REST/WebSocket protocol, PTY registry, terminal-state reconstruction, session picker, takeover behavior, and browser pane persistence.
- macOS Desktop continues to own native geometry in `UserDefaults`; its WKWebView consumes the same Hub personal-state API as a browser.
- New terminal-emulation/serialization dependencies may be required, subject to a focused compatibility spike and license audit.
