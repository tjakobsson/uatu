# Architecture

This document is the codebase-orientation guide for **uatu** (a.k.a. UatuCode). It's written for a new contributor — human or AI — who wants to know what the moving parts are, where to look for each one, and how a request or state change flows through the system.

For the user-facing pitch (features, install, usage), see [README.md](./README.md). For terse navigation cues during a Claude Code session, see [CLAUDE.md](./CLAUDE.md).

## What uatu is

`uatu` is a Bun-served Progressive Web App that watches a directory of docs and source, previews Markdown and AsciiDoc with Mermaid diagrams, surfaces the repository's change context (changed files, diffs, git log), and (where supported) hosts an embedded terminal in the same browser tab. It runs as a hub (`uatu hub`) on a machine you own: a login-gated daemon that runs one loopback-only session child per workspace and is the only server a browser talks to. There is no cloud component. It ships as a single Bun-compiled binary or runs from source.

## The 30-second map

```mermaid
flowchart LR
  SPA["browser SPA<br/>(src/app.ts → shell/preview/sidebar)"]
  Hub["uatu hub<br/>(src/hub/: auth, proxy, live broker)"]
  Child["session child<br/>(src/cli.ts serve, one per workspace)"]
  Session["WatchSession<br/>(src/server/watch-session.ts)"]
  WS["chokidar<br/>file watcher"]
  Term["terminal<br/>(WebSocket ↔ PTY)"]
  FS[("docs tree<br/>on disk")]
  Term_PTY[("user's shell<br/>(real PTY)")]

  Hub -- spawns + supervises --> Child
  SPA <-- "HTTP + WebSocket under /s/id/" --> Hub
  SPA <-- "one live SSE stream: /api/hub/live" --> Hub
  Hub <-- "HTTP, WebSocket, internal SSE (loopback)" --> Child
  Child --- Session
  Child --- Term
  FS -- mtime, contents --> WS
  WS -- file events --> Session
  Term <-- spawn/io --> Term_PTY
```

The boundaries to keep in mind:

- **The hub between browser and session child.** Browsers only talk to the hub. It authenticates them, then reverse-proxies HTTP and WebSockets under `/s/<id>/` to that workspace's loopback child and brokers the child's token (see [Base paths and the hub](#base-paths-and-the-hub)).
- **HTTP between the SPA and its session child.** Under the session's base path, `/api/state` supplies the initial snapshot, `/api/document` and `/api/document/diff` render one path, and `/api/search` sweeps content. Scope and compare target travel as validated request context on all related requests; there are no process-global mutation endpoints.
- **One live stream per page.** Pushed updates (document state, chat inventory, conversation events, other workspaces' activity) reach a page over a single `GET /api/hub/live` SSE connection to the hub. The child's own SSE routes are the internal hub↔child protocol (see [Live delivery](#live-delivery)).
- **Per-client watch context.** The Change Overview measures against `base` (merge-base reviewer view) or `last-commit` (`HEAD` working view). `src/shared/watch-context.ts` serializes the client's scope and compare target, and `server/watch-session.ts` selects the corresponding roots and cached repository snapshot independently for each request and each document subscription. Two clients can therefore browse different scopes and comparison lenses through the same child process.
- **Chokidar between the child and the filesystem.** The `WatchSession` debounces, applies the ignore policy, rebuilds the document index, and emits state events on the child's internal `/api/events` route.
- **WebSocket between SPA and terminal subsystem.** Authenticated by a cookie set on `POST /api/auth`; multiplexed across multiple PTY panes by `terminal/server.ts`.
- **A single Bun binary.** No node, no separate frontend bundler. The same binary runs the hub and every session child, and each child's `Bun.serve` serves the SPA and its API.

## Web Push delivery

The notification path runs independently of the page's brokered live stream:

```text
agent lifecycle --> ChatAdapter --> NotificationFeed
                                         |
                      /api/chat/notifications/events
                                         |
                         HubNotifications coordinator
                                         |
                        encrypted Web Push --> push worker
```

`chat/notifications.ts` tracks identified live occurrences and resolutions.
OpenCode's `notification-lifecycle.ts` correlates native step and compatibility
message records by assistant-message identity; unqualified idle/status frames
do not create completion alerts. Claude's provider attaches execution identity
and resolves cancellation/background state before emitting its notification
outcome. The adapter checks workspace membership, excludes child completion,
and routes child questions to their launching conversation.

`chat/notification-feed.ts` provides bounded replay and an atomic pending-request
snapshot/live handoff. Each lazy agent service owns a feed without starting its
runtime. `MultiAgentChatService` qualifies and merges occurrences. The internal
child route is declared by `server/routes.ts` and is refused through the browser
proxy.

`hub/notifications.ts` holds one notification upstream per interested running
workspace, independent of visible pages. `notification-store.ts` atomically
persists the VAPID keys, device enrollments, cursors, and event/device delivery
journal. Authorization is checked against the enrollment's current hub session
and workspace access before sending. Expiry, bounded retry, known interaction
resolution, and subscription removal are delivery concerns. `push-sender.ts`
uses the MIT-licensed Web Crypto implementation for encryption and VAPID signing.

The hub serves `pwa/push-worker.js` at origin scope. It handles push and clicks,
with no fetch handler or offline content cache. `notification-client.js` is a
shared browser module, bundled into the SPA and served directly to hub pages;
its declaration file supplies the TypeScript interface. Hosts inject URLs, and
workspace boot requires the proxy's explicit `uatu-hub` marker before using
`hubUrl()`. Legacy cleanup preserves active, waiting, and installing push workers.

The 192px and 512px Home Screen icons have opaque white backgrounds and keep
the complete mark inside the maskable safe circle. Regenerate them from the
canonical SVG with `bun run generate:pwa-icons`; use `--check` to validate the
checked-in pixels. `pwa/icons.ts` versions manifest and Apple touch-icon URLs,
and the static session manifest carries the same revision.

Notification URLs carry an agent-qualified `conversation` parameter through
login and document history changes. Chat opens that exact target or shows its
read error. A matching window is focused without navigating another workspace's
draft. A desktop window too narrow for the split uses a temporary Chat view
that the existing collapse control dismisses; it does not change the stored UI
mode.

## Desktop viewport on tablets

`shell/desktop-viewport.ts` owns the desktop work area's visible rectangle and
safe-area overlap. It measures at boot and on mode changes, then coalesces
visual-viewport resize/scroll and window resize events into animation frames.
The scalar viewport observer is shared with the touch terminal through
`shared/visual-viewport.ts`.

Wide desktop browser layouts fit one fixed shell to that rectangle. Sidebar,
preview, chat, and docked/fullscreen terminal therefore share the available
height, including small hardware-keyboard accessory bars. Safe-area padding
lives on that outer shell, so the desktop composer does not reserve the bottom
inset again. A bottom-docked terminal is temporarily capped while the viewport
is occluded, without changing its persisted size. Xterm refits through its
existing host ResizeObserver.

The narrow desktop layout remains a scrolling stack with a safe-area-aware
sticky preview header. Native macOS hosting retains its existing titlebar and
frost stacking contract. During pinch zoom, the desktop controller retains the
last normal-scale layout and lets the browser pan it. Switching to touch clears
the desktop measurements and hands sizing back to the touch chat/terminal
controllers; Chat clears its own obsolete overrides immediately on mode change.

Browser regressions inject safe areas and visual-viewport changes and assert
header/composer bounds in Chromium and WebKit. They do not reproduce iPadOS's
native glass or Magic Keyboard accessory UI. Those platform behaviors require
physical-device acceptance in addition to the browser checks.

## Folder tour

`src/` is organized by feature. Three entrypoint files live at the root; everything else is in a folder named after its concern. Files are listed in each folder's `ls` — open the folder when you need a specific name.

```
src/
├── app.ts                SPA entry — DOM queries, init calls, top-level boot
├── cli.ts                CLI entry — dispatches `uatu hub`, and hosts the
│                         session child the hub spawns (internal `serve`):
│                         port probing, Bun.serve assembly, watchdog spawn,
│                         signal handling
├── styles.d.ts           CSS module type declarations
├── index.html, styles.css, assets/   HTML shell + CSS + bundled assets
│                         (logo, PWA icons + manifest,
│                         and `assets/fonts/HackNerdFontMono-Regular.woff2`
│                         — the default face for *every* monospace surface
│                         in the app, surfaced via the shared
│                         `--mono-font-family` CSS variable on `:root`)
│
├── cli/                  CLI domain — argument parsing, usage text, and the
│                         refusal a user-shaped `serve` gets (parse.ts) and
│                         TTY startup output (output.ts);
│                         side-effect-free so the unit suite can import them
├── chat/                 The agent chat surface, shared across agents:
│                         seam types (provider.ts, types.ts), the adapter
│                         (queue/replay/receipts/recovery), the multi-agent
│                         registry + router (agents.ts — qualified
│                         conversation ids, per-agent status, merged
│                         inventory), client transport + validation, the
│                         timeline renderer, and the whole browser UI.
│                         Agent-specific code lives below the seam:
│                         chat/opencode/ (loopback server runtime that
│                         decides the spawned server's generation; v1/ and
│                         v2/ hold one provider + normalization mapper per
│                         OpenCode generation over a shared normalization
│                         core — see "OpenCode generations") and chat/claude/
│                         (probe-only runtime, per-conversation Claude
│                         Agent SDK sessions, native-transcript reader,
│                         model catalog (control-channel probe, manifest fallback), its own normalization)
├── shell/                App-wide chrome and the appState singleton: boot,
│                         the page's one live stream (live-channel.ts) and
│                         its lifecycle recovery (live.ts), document-state
│                         handling (events.ts), URL/history, follow-mode
│                         capability, connection chip, PWA registration
├── preview/              The right pane — every renderer that mounts HTML
│                         into #preview: rendered / source / diff views,
│                         layout chooser, mermaid, anchors, image/binary
│                         fallbacks, metadata card, code-block decorations
├── sidebar/              The left pane — sidebar shell, pane visibility/
│                         sizing, the @pierre/trees-backed Files tree,
│                         Change Overview, Git Log, Files-pane filter
├── terminal/             The full xterm + PTY subsystem: panel chrome,
│                         xterm client, WebSocket server, PTY backend,
│                         cookie/origin auth, persisted pane state
├── server/               HTTP server building blocks (Bun.serve itself is
│                         in cli.ts): routes.ts (single-source-of-truth
│                         route table + shared fetch fallback),
│                         watch-session.ts (live-reload engine), roots.ts
│                         (root resolution + scanning), render-dispatch.ts,
│                         static-files.ts, navigation.ts, port-probe.ts
├── document/             Document + repository git data (not rendering):
│                         metadata parsing, diff fetcher, text/binary
│                         classifier, language detection, compare-base
│                         resolver, and the repository-level git sweep
│                         (changed files, commit log, repo metadata)
├── render/               Source → HTML transformation: markdown
│                         (micromark + GFM + frontmatter), asciidoc
│                         (@asciidoctor/core), sanitization + mermaid markers
├── ignore/               .gitignore + `.uatu.json ignore` engine + the
│                         file's single config loader
├── hub/                  The self-hostable session hub (`uatu hub`): config,
│                         XDG state dir, workspace registry, the
│                         SessionBackend seam + local-process backend,
│                         HTTP/WS reverse proxy, the live broker
│                         (live-broker.ts, live-sse.ts), hub auth (users, signed
│                         cookie, rate limit, CSRF), dashboard pages, server
│                         assembly, process wiring
├── watchdog/             Heartbeat-driven hang recovery — spawned sibling
│                         subprocess + forensic dump bundle
├── debug/                Observability — XDG-cache path resolution +
│                         event-counter metrics
├── pwa/                  PWA assets, shared notification enrollment UI,
│                         and the hub's push-only service worker
└── shared/               Cross-cutting helpers: html escape, types,
                          license check, build version
```

Unit tests are colocated with their subjects (`foo.ts` and `foo.test.ts` sit in the same folder). E2E tests live in `tests/e2e/` under feature-named files (`mermaid.e2e.ts`, `sidebar.e2e.ts`, `document-tree.e2e.ts`, etc.); the Playwright `webServer` is `tests/e2e/server.ts`, not in `src/`.

### Outside `src/`: the desktop client

`desktop/macos/` holds **UatuCode Desktop**, a SwiftUI app whose windows are
pure hub clients: the app bundles no `uatu` binary, spawns no processes, and
supervises nothing. Each configured hub (`HubRoster.swift` — which may be
`http://localhost:<port>` for a hub the user runs on the same Mac) is
authenticated natively (`HubAPI.swift`): a JSON login yields a session id
held only in the Keychain, native API calls present it as `Authorization:
Bearer`, and the id is written into the WebView's cookie store as the
hub session cookie before navigation so web and native surfaces share one
server-side session. A 401 means the session is dead at the hub (expired or
revoked — revocation is server-side); the app silently re-logs-in once with
the Keychain password, then prompts. A sign-out observed in a web view
discards the hub's Keychain secrets. Sessions belong to hubs, so closing a
tab or quitting the app never stops anything.

The WebView is a `WKWebView` (`WebViewHost.swift`), not SwiftUI's `WebPage`:
`WebPage` has no `createWebViewWith` equivalent, so `window.open()` — how
xterm.js activates OSC 8 terminal hyperlinks — and `target="_blank"` anchors
would be silently dropped. The host's `WKUIDelegate` catches them and routes
the URL, and the window exposes Back/Forward (`⌘[`/`⌘]`, toolbar) over the
SPA's pushState history.

External `http(s)` links open by default in the **split browser**
(`BrowserSplit.swift` + `BrowserSplitView.swift`): a per-window resizable
right-hand pane with its own custom tab strip (native macOS tabs are
window-level and can't nest in a pane), per-tab back/forward/reload, an
editable address bar (URL or DuckDuckGo search), and an eject-to-browser
button. Tabs share a persistent `WKWebsiteDataStore` (logins survive
relaunch; open tabs don't). `⌘`-click, non-`http(s)` schemes, or the
"Open External Links in System Browser" menu toggle route to the system
instead (`ExternalLinkRouter`). Toggle the pane with `⌘⇧B`; `⌘W` closes the
focused browser tab, falling back to the window when the split lacks focus.

Nothing else crosses the boundary — the browser remains a first-class client,
and the desktop app rides the same release train (see
`.github/workflows/release.yml`, jobs `desktop-macos`/`update-tap`).

## Base paths and the hub

A session child is relocatable under a path prefix: `--base-path /s/uatu/`,
which the hub passes when it spawns a child, moves the entire HTTP surface — routes, assets, PWA scope, pushState
document URLs, the terminal cookie's `Path` — under the prefix, with `/` as
the byte-for-byte-unchanged default. Server-side, `buildRoutes` prefixes its
static keys and the fetch fallback 404s anything outside the prefix;
client-side, every server-relative URL flows through `appUrl()` in
`src/shared/app-url.ts`, which reads the `<meta name="uatu-base-path">` the
server injects into the shell (`relocateShellHtml` in
`server/navigation.ts`, which also rewrites the HTMLBundle's root-absolute
chunk references). A structural test (`shared/app-url-discipline.test.ts`)
fails any module that builds a root-relative `/api`/`/assets` URL outside
the helper.

The consumer of that relocatability is **the hub** (`uatu hub`, `src/hub/`):
a self-hostable daemon that keeps a workspace registry of absolute folder
paths (stable collision-suffixed slugs; folders are added through a
server-side directory browser or the API — there is no workspaces root;
`backend` field reserved for a future container/VM backend), starts one
loopback-bound session child per workspace through
the `SessionBackend` interface (`hub/backend.ts`: URL on stdout, held stdin
as orphan backstop, SIGTERM), and
reverse-proxies HTTP and WebSockets under `/s/<id>/` from a single
TLS-terminating, login-gated port (`hub/proxy.ts`, `hub/auth.ts`,
`hub/server.ts`). Authentication is a server-side session store in the hub's
state dir: login mints an opaque session id (recorded with user, issue time,
and a device label), browsers carry it in the session cookie, native
clients carry the same id as `Authorization: Bearer`, and both transports
resolve through one store lookup — so sign-out and the dashboard's
per-device revocation kill a session everywhere, immediately. The cookie
is `uatu_hub` at the scheme's default port and `uatu_hub_<port>` on any
other port (`hub/auth.ts`). Browsers scope cookies by host, so without the
suffix port-forwarded hubs on one host would share a jar. Login is
required on every interface, loopback included; there is no trusted local
mode. The hub is a trusted intermediary: it authenticates the client and
validates its Origin (bearer requests are exempt — they carry no ambient
credential), then forwards loopback-shaped `Host`/`Origin` headers and
brokers the child's session token server-side — children keep their
localhost security model unchanged and are never network-reachable. Live
updates do not go through the proxy; [Live delivery](#live-delivery) covers
them.

The hub also owns Git worktrees: a linked checkout is a child workspace of
the main one it forks from, sharing its Git objects and repository
configuration. `src/hub/worktree-service.ts` composes the service — Git
probes and the coordinator (`worktree-git.ts`), non-force creation
(`worktree-create.ts`), credential-aware fetch (`worktree-fetch.ts`),
deletion preflight and the confirm-stop-fence-recheck-remove sequence
(`worktree-delete.ts`), the rename guard (`worktree-rename-guard.ts`), the
durable intent/provenance journal with restart recovery
(`worktree-journal.ts`), Git-backed reconciliation on open/activity/manual/
periodic cadence (`worktree-reconciler.ts`), and onboarding
(`worktree-registrar.ts`) — and answers every operation through one
session-authenticated JSON family, `worktree-api.ts` at
`/api/hub/worktrees` (`GET ?source=` inventory, `POST
/{fetch,create,open,preflight-delete,delete,register,forget}`), published
like any other hub route with no separate progress poll: each call answers
its own bounded outcome, and a safety refusal is an ordinary `{ok: false,
error}` response rather than a transport failure. `src/shell/worktree-dialog.ts`
is the one client for that family — a shadow-DOM dialog embedded both in
the in-workspace picker (`shell/hub-nav.ts`) and the hub dashboard
(`hub/pages.ts`) — and `shell/worktree-live.ts` refreshes an open
register list (the fork menu's `Register worktree…`, the checkouts Git lists
that Uatu has not registered) from the live stream's cursor-free `worktrees`
topic without touching the page's own document or conversation selection. Design rationale (safety
model, provenance, parent credential inheritance) is in
`openspec/changes/archive/2026-09-20-add-git-worktree-workspaces/design.md`.

The session child is `uatu serve`, and it is no longer a user command. A
user-shaped invocation (`uatu serve`, the removed `watch` alias, a bare
`uatu <path>`) prints the hub bootstrap steps and exits non-zero
(`serveRemovedText` in `cli/parse.ts`). `serve` runs only for the hub's
spawn, whose `--exit-on-stdin-close` marks the supervisor contract, and for
source runs (`bun run src/cli.ts serve …`, detected from the script path in
`Bun.argv[1]`), which the repository's own tests use. `bun run dev` starts a
dev hub (`scripts/dev-hub.ts` with `dev/hub.json`). Operator documentation lives in
`docs/SELF-HOSTING.md`;
the design rationale (single-origin proxy over port-per-session, restart
semantics, trust model) in `openspec/changes/add-uatu-hub/design.md`.

## Live delivery

A page gets pushed updates over exactly one long-lived connection: `GET /api/hub/live`, a server-sent-events stream at the hub origin, authenticated by the hub session like any other hub request. Document state, the chat inventory, conversation events (a subagent transcript is a conversation too), and the activity of the user's other workspaces all ride it as typed envelopes. The wire contract, including frame order and bounds, is `src/shared/live-protocol.ts`. The reasoning is in `openspec/changes/hub-brokered-live-stream/design.md`.

The count is the point. Browsers allow six HTTP/1.1 connections per host, shared by every tab, and `Bun.serve` speaks only HTTP/1.1. When each pane held its own stream, two session tabs with chat open used up the budget and every later request stalled. On the hub side, Bun caps outbound `fetch` at 256 concurrent requests per process, and every proxied stream used to take one. Now a tab costs one connection whatever is open in it, and the hub's connections to a child follow what is watched, not how many tabs watch it.

```mermaid
sequenceDiagram
  participant Tab as Browser tab (shell/live-channel.ts)
  participant Hub as Hub (hub/server.ts, hub/live-broker.ts)
  participant Child as Session child (server/routes.ts)
  Tab->>Hub: GET /api/hub/live (ws, subs: document + inventory)
  Hub-->>Tab: ": open", then event: hello with the stream id
  Hub->>Child: GET base/api/events (first subscriber only)
  Child-->>Hub: event: state (snapshot)
  Hub-->>Tab: event: live, topic document, cursor, data
  Note over Child: a watched file changes
  Child-->>Hub: event: state
  Hub-->>Tab: event: live (to every tab subscribed to the topic)
  Tab->>Hub: POST /api/hub/live/streamId/subscriptions (add conversation)
  Hub->>Child: GET base/api/chat/conversations/id/events
```

- **The stream.** The response writes `: open` at once, then a `hello` event carrying an unguessable stream id, then `live` envelopes `{ ws, topic, key?, cursor, event }`. While idle it sends a `: keepalive` comment every 15 s. The query names the workspace (`ws`), opts into activity (`activity=1`), and lists the initial subscriptions with the cursor each one resumes from (`subs`).
- **Subscription changes.** Selecting a conversation or opening a subagent never opens a connection. The page posts `add` and `remove` operations to `POST /api/hub/live/<streamId>/subscriptions`, which the hub accepts only from the hub session that owns the stream, so one tab can't steer another's. An `add` for a key that is already subscribed replaces it; that is how a topic re-attaches after a resync.
- **Topics.** `document` is keyed by the watch context (compare target and scope) and carries the child's state snapshot. `inventory` is an invalidation tick that tells the chat client to re-read the merged inventory. `conversation` is keyed by the agent-qualified conversation id and carries one chat event. `activity` describes each workspace the user may access as `{ running, working, awaiting }`; the hub validates it to that fixed shape before fan-out, so it can't carry content.
- **Cursors and signals.** Each topic has its own opaque cursor, and only `data` events advance it. A reconnect presents every retained cursor, so each topic resumes independently and a stale conversation cursor never forces a document resync. Besides `data`, a topic can receive `ready` (attached, any owed replay written), `resync` (the cursor can't be replayed: take a fresh snapshot, then add the subscription again), or `unavailable` (the upstream failed or the child exited, and the hub is retrying). All three are scoped to their topic and never end the stream.

**Fan-out at the hub.** `hub/live-broker.ts` holds one upstream subscription per (workspace, topic, key). The first interested client stream opens it and every later one shares it. The upstreams are the child's own SSE routes: `/api/events` for document state, `/api/chat/conversations/events` for the inventory, `/api/chat/conversations/<id>/events` for one conversation, and `/api/activity` for the workspace's working/awaiting summary (`hub/live-sse.ts` parses them). When the last subscriber leaves, the upstream lingers for 3 s (`LIVE_LINGER_MS`), so a reload or a quick A→B→A switch doesn't churn the child. After that the broker aborts it explicitly, which cancels the request at the child. Each upstream keeps a 256 KB replay buffer (`LIVE_REPLAY_BUFFER_BYTES`). A client cursor inside the buffer replays from the hub; one behind it falls back to the child's own replay, or its resync. An upstream failure sends `unavailable` to each subscriber, leaves every client stream open, and retries with capped backoff while anyone is still subscribed. The `activity` topic is computed per user: the hub merges its own session state (`running`) with each running child's `/api/activity` summary.

**Child routes are internal.** The child's SSE routes are the hub↔child protocol, and the hub does not proxy them. A browser request for `/s/<id>/api/events` or either chat events route gets a non-cached error naming `/api/hub/live`. The child never learns the hub's address and holds no credential for it; the hub reaches the child through the endpoint and token it already brokers.

**One channel in the page.** `shell/live-channel.ts` owns the stream: capped-exponential reconnect, a generation per attempt so events from a superseded stream are dropped, per-topic cursors, and subscription changes. `shell/live.ts` holds that one channel for the page and runs the one lifecycle recovery. A `pageshow`, `visibilitychange`, or `online` wake-up reconnects the stream and runs the reconciliation each consumer registered, in one coalesced pass. A hide (`visibilitychange` to hidden, or `pagehide` whatever `persisted` says) only *suspends* the channel — socket closed, subscriptions and cursors kept, listeners still armed — because iOS fires an unpersisted `pagehide` for a home-screen page it then keeps alive; nothing disposes the channel from a lifecycle event. Each recovery task is bounded (the state fetch has a timeout, and the coalescer releases its in-flight slot after a ceiling) so one hung request cannot swallow every later wake-up. `requestManualRecovery()` is the user's escape hatch behind Chat's interruption-line Reconnect and the shell's connection indicator: the same recovery in place, then a reload if the channel does not confirm live within a bounded window. The consumers keep their own callbacks. `shell/events.ts` handles `document` and confirms the shell's connection indicator once the current generation has applied state. The chat client handles `inventory` and `conversation` and reports topic-scoped trouble as chat-surface status, never as shell status. `shell/hub-nav.ts` shows `activity` in the workspace switcher.

## Request lifecycle

A representative path: the SPA needs the rendered HTML for `guides/setup.md`.

```mermaid
sequenceDiagram
  participant Browser
  participant Routes as server/routes.ts
  participant Dispatch as server/render-dispatch.ts
  participant Render as render/markdown.ts
  Browser->>Routes: GET /api/document?id=guides/setup.md&view=rendered
  Routes->>Dispatch: renderDocument(roots, id, { view })
  Dispatch->>Dispatch: locate file in document index
  Dispatch->>Render: micromark + GFM + frontmatter + Mermaid markers
  Render-->>Dispatch: sanitized HTML string
  Dispatch-->>Routes: { id, title, html, kind: "markdown", ... }
  Routes-->>Browser: 200 JSON
  Note over Browser: preview/mount.ts<br/>writes html to #preview
```

Failure paths:

- File no longer exists → Session throws → Routes returns 404 → `preview/mount.ts` shows the "no longer exists" empty state.
- File is binary → Session throws `"document is binary"` → Routes returns 415 → `preview/binary.ts` or `preview/image.ts` renders the appropriate fallback (image for `.png` / `.jpg` / etc., a "not viewable" notice otherwise).

Pushed updates take a different path. The child emits state events on its internal `/api/events` route, and the hub fans them out to every subscribed page over `/api/hub/live` (see [Live delivery](#live-delivery)).

The route table that wires both of these requests is declared exactly once, in `src/server/routes.ts` via `buildRoutes({ mode: "prod" | "e2e", ... })`. Both `src/cli.ts` (production) and `tests/e2e/server.ts` (the Playwright harness) call it.

## State lifecycle

The SPA's source of truth is `appState`, a module-level mutable singleton in `src/shell/state.ts`. The `document` topic consumer in `src/shell/events.ts` is the only path that mutates `appState` from pushed events.

State is deliberately split into four lifetimes:

| Lifetime | Examples | Owner / storage |
|---|---|---|
| Child session | watched roots, file index, repository snapshots, live PTYs | `server/watch-session.ts` and `terminal/server.ts`; ends when the child stops |
| Client watch context | scope and compare target used by state, search, navigation, and diff requests and by the `document` topic's key | explicit URL/query context from `shell/watch-context.ts`; never mutates another client |
| Personal workspace state | selected document, Follow, preview mode, compare target, Files filter, last-active PTY id | Hub store keyed by authenticated user + stable workspace id in `hub/personal-state.ts`; local Hub uses identity `local` |
| Client presentation | sidebar and preview geometry, terminal dock/splits/pane attachments, transient visibility | base-path-namespaced browser local/session storage in `shell/presentation-storage.ts`; native macOS window/split geometry remains in `UserDefaults` |

Boot loads child state and personal state together. Explicit document or commit URLs win; otherwise semantic personal state resumes; child defaults are last. Semantic owner mutators PATCH fields through `shell/personal-state.ts`. Presentation state never enters the Hub store, and another browser restores semantics without inheriting this browser's dimensions or pane arrangement. A stale document or PTY reference is cleared independently after the current document index or terminal inventory proves it absent.

Every `appState` field has exactly one owning module: direct assignment (`appState.<field> = …`) is allowed only inside the owner, and every other module mutates through the owner's exported mutator (`setSelectedId()`, `setFilesPaneFilter()`, …). Mutators for persisted preferences own the localStorage write, so assignment and persistence can't drift apart. The contract is enforced by `src/shell/state-ownership.test.ts`, which scans `src/` for out-of-owner assignments.

| Field | Owner |
|---|---|
| `selectedId`, `previewMode` | `shell/selection.ts` |
| `followEnabled` | `shell/follow.ts` (the four follow-mode rules) |
| `roots`, `repositories`, `scope`, `unscopedFingerprint` | `shell/events.ts` (`applyServerSnapshot`) |
| `viewMode`, `wrap` | `preview/view-mode.ts` |
| `viewLayout`, `splitRatio` | `preview/layout.ts` |
| `diffStyle` | `preview/diff.ts` |
| `panes` | `sidebar/panes.ts` |
| `filesPaneFilter` | `sidebar/files-filter.ts` |
| `gitLogLimit` | `sidebar/git-log.ts` |
| `compareTarget` | `sidebar/change-overview.ts` (`adoptCompareTarget`) |

```mermaid
sequenceDiagram
  participant Watcher as chokidar (server)
  participant SSE as src/shell/events.ts
  participant State as src/shell/state.ts (appState)
  participant Sidebar as src/sidebar/shell.ts (renderSidebar)
  participant Preview as src/preview/mount.ts (loadDocument)

  Watcher->>SSE: state event (new roots, repositories, scope, changedId)
  SSE->>State: appState.roots / repositories / scope = ...
  SSE->>Sidebar: renderSidebar()
  Note over SSE: chooseSelectionForFileEvent (follow-mode)
  alt Follow on
    SSE->>State: appState.selectedId = changed file (Rule C)
    SSE->>Preview: loadDocument(newSelectedId)
  else Follow off, selection is the changed file
    SSE->>Preview: loadDocument(selectedId) — Rule D, reload in place
  else Follow off, selection unrelated to change
    Note over SSE: tree re-renders, selection unchanged
  end
```

The four authoritative rules of the `follow-mode` capability — defined in `openspec/specs/follow-mode/spec.md` — are the only paths that change `appState.followEnabled` or `appState.selectedId`:

- **Rule A** (user clicks a tree row): selection moves to that file; follow turns off. Guarded by `TreeView.duringProgrammaticUpdate` so library-fired callbacks during mount or `resetPaths` are not mistaken for user input.
- **Rule B** (user clicks the Follow toggle): `followEnabled` flips. Turning on jumps to the newest-mtime file in the current session.
- **Rule C** (file event + follow on): selection moves to the changed file.
- **Rule D** (file event + follow off): selection unchanged; if the changed file equals the current selection, the preview reloads in place; otherwise just the tree refreshes.

## Chat surface

The chat surface speaks one timeline model for every agent (`src/chat/types.ts`); each agent's provider normalizes its own wire format into it below the seam (`src/chat/provider.ts`). The kinds a conversation can hold:

| Item kind | What it is | Where it shows |
|---|---|---|
| `user_message`, `assistant_message` | The conversation. An `assistant_message` with empty markdown is a usage carrier (`usage:<id>`, one API call's occupancy), never a bubble. Claude Code streams text into a `message:stream:<api-message-id>:<block>` item that the completed block replaces. | Timeline |
| `reasoning` | The model's thinking, or recalled context when `label` is set ("Recalled from memory") | Activity row, groups |
| `tool`, `command`, `file_change` | What the agent did. A running tool carries `elapsedMs` from the agent's progress heartbeat; a shell tool's command is its subject. | Activity rows, groups |
| `permission`, `question` | Interactions the user must answer. A `question` with `source` is a tool-driven dialog or an MCP elicitation, answered through the same operations. The persistent-approval sentence on a permission card is the owning agent's own (`ChatAgent.permissionScopeNote`). | Cards |
| `task_progress` | The agent's todo list, one presentation updated in place | Pinned track |
| `background_task` | A task the agent runs in the background, updated in place from start to settling. Running ones are listed above the composer with a stop control; settled ones are rows. | Composer list, timeline |
| `context_report` | The agent's own statement of window occupancy (total, max, categories, plan utilization). Data for the readout, never a row; the readout uses whichever of a report or a usage carrier is newest. | Context meter |
| `compaction` | Where the agent compacted its context, with before/after figures | Timeline marker |
| `turn_status`, `notice` | A turn's outcome; warnings and errors. A `notice.code` (`rate-limit-*`, `refusal-fallback`) drives the composer's badge. | Timeline, composer |

Conversation status is `idle`, `sending`, `running`, `completed`, `interrupted`, `failed`, plus three named states: `retrying` and `compacting` are live-turn states (the composer offers Cancel, a new prompt is held), `background` means no turn is running but the agent still holds live background work (prompting is possible). `isLiveConversationStatus()` in `types.ts` is the one rule for which statuses are live.

A Claude Code conversation's session lifetime (`src/chat/claude/provider.ts`) follows the work, not the first result: the SDK session is retired on a turn's result only when no accepted prompt is pending, no unprompted follow-up is in flight, and the background set (`background_tasks_changed`, ambient tasks excluded) is empty. While the set is non-empty the conversation reports `background`. When a backgrounded task settles the CLI starts a follow-up turn by itself (see the D9 spike in the change's design notes); the provider reports that turn as running and completed like any other. A set that empties with no follow-up returns the conversation to idle after a short grace window. Conversation titles follow the transcript's own entries: a user rename (`custom-title`) outranks Claude Code's generated title (`ai-title`), which outranks the first prompt.

### OpenCode generations

OpenCode 1.x and 2.x have different server APIs, and a workspace has whichever one its `opencode` on `PATH` is. `src/chat/opencode/opencode-service.ts` spawns `opencode serve` the same way for both (loopback, random port, one password under both `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`) and decides the generation from the readiness answer, never from `--version` text or the binary's path: each probe cycle asks `GET /api/info` (2.x: `{ version, pid, urls }`) and then `GET /global/health` (1.x: `{ healthy, version }`), and the first well-formed body decides. A 2.x server answers every path it does not know — including the 1.x health path — with its web UI's HTML page and a 200, which is why a successful status alone is never readiness. The decision is fixed for that server's lifetime and carried on `OpenCodeConnection.generation`; `openCodeAgentRuntime` in `src/chat/service.ts` picks the provider from it, and a restart decides again, so a replaced binary is served by its own generation without a workspace restart. The reported version is bare semver for both (`1.18.31`, `2.0.13`), so the generation is legible from the status object without a new field.

The two stacks live under `src/chat/opencode/v1/` (`@opencode-ai/sdk`'s `/v2` client — the 1.x SDK's second client, nothing to do with OpenCode 2) and `src/chat/opencode/v2/` (`@opencode/client`, all routes under `/api/…`, events on `/api/event`). They share a normalization core at `src/chat/opencode/normalization.ts`: 2.x's session event vocabulary is 1.18's `session.next.*` generation with the `next.` segment dropped, so the text/reasoning/tool/step/shell/revert/compaction state machines are one implementation keyed by the 2.x names, and each generation contributes a mapper for what it alone has — 1.x its cumulative `message.*` records and `question.*` family, 2.x its `session.execution.*` turn lifecycle, `session.usage.updated`, `form.*` (presented as structured questions, one per field), and `session.message.content.updated` restatements. Every 2.x call is scoped with `location: { directory }`, and events carrying another directory's `location` are dropped before mapping.

**Developing against both generations on one machine.** Homebrew cannot hold both (`anomalyco/tap/opencode-v2` conflicts with `opencode`: both install a binary named `opencode`), but the formula only unpacks a zip, and 2.x honours `XDG_*` for every path it writes. Keep 2.x off `PATH` and give it a private home:

```sh
mkdir -p ~/.local/opt/opencode-v2/bin
curl -fsSL https://opencode.ai/files/bin/2.0.13/opencode-darwin-arm64.zip -o /tmp/oc2.zip   # the URL the tap's opencode-v2.rb points at
unzip -o /tmp/oc2.zip -d ~/.local/opt/opencode-v2/bin/real
cat > ~/.local/opt/opencode-v2/bin/opencode <<'WRAPPER'
#!/bin/sh
V2=$HOME/.local/opt/opencode-v2
export XDG_DATA_HOME=$V2/xdg/data XDG_STATE_HOME=$V2/xdg/state XDG_CACHE_HOME=$V2/xdg/cache
exec "$V2/bin/real/opencode" "$@"
WRAPPER
chmod +x ~/.local/opt/opencode-v2/bin/opencode
```

The isolation is not optional: with default paths 2.x opens `~/.local/share/opencode/opencode.db` — the 1.x database — and applies migrations 1.x does not have. Config (`~/.config/opencode/opencode.json`) is shared by design. Credentials are not: run `opencode auth login` inside the wrapper (2.x keeps them in its own database and imports a `<data>/auth.json` only on its first run); do not copy an OAuth entry that both generations would then refresh. 2.x also ships free public models (`opencode/*-free`) that need no login, which is what the integration test runs on.

Then `PATH=~/.local/opt/opencode-v2/bin:$PATH bun run dev` serves the dev hub with 2.x, and the real-OpenCode integration test takes both binaries at once, each in its own temporary home:

```sh
UATU_REAL_OPENCODE=1 \
UATU_REAL_OPENCODE_V1=$(which opencode) \
UATU_REAL_OPENCODE_V2=~/.local/opt/opencode-v2/bin/real/opencode \
bun test src/chat/opencode/real-opencode.integration.test.ts
```

## Terminal subsystem

The terminal panel is the only feature with a WebSocket transport.

```mermaid
flowchart LR
  Client["xterm.js client<br/>src/terminal/client.ts"]
  Cookie["POST /api/auth<br/>(returns Set-Cookie)"]
  Server["WebSocket server<br/>src/terminal/server.ts"]
  Auth["src/terminal/auth.ts<br/>cookie + origin check"]
  Backend["src/terminal/backend.ts<br/>(Bun PTY availability)"]
  PTY["src/terminal/pty.ts<br/>(spawned shell)"]
  Shell[("user's shell<br/>(zsh / bash / pwsh)")]

  Client -- POST /api/auth --> Cookie
  Client -- "POST /api/terminal/sessions" --> Server
  Client <-- "ws: /api/terminal?sessionId=…" --> Server
  Server --> Auth
  Server --> Backend
  Backend --> PTY
  PTY <-- spawn + stdio --> Shell
```

The panel UI (`src/terminal/panel.ts`) handles dock position, split, fullscreen, focus, page-lifecycle release/resume, and message routing across multiple PTY panes. On Windows, `terminal/backend.ts` reports unavailable and the panel button is hidden — uatu doesn't degrade other features.

Auth is deliberately Host-relative: the origin gate compares the `Origin` header against the request's `Host` (hostname pinned to loopback names), and the auth cookie is named `uatu_term_<host-port>`, so port-mapped access (container publishes, SSH forwards) and multi-instance fleets work with zero configuration. The rationale — including which parts of this design would survive a hosted multi-tenant deployment and which are deliberate localhost scaffolding — is recorded in the `fix-terminal-auth-port-mapping` change's `design.md` (decision D4).

PTY lifetime follows tmux-detach semantics, but PTYs are server-owned resources rather than side effects of WebSocket upgrade. Authenticated `POST /api/terminal/sessions` creates a resource and returns its id. A WebSocket may only attach to an existing id; malformed, unknown, attached, and explicit-takeover cases remain distinct. Disconnecting detaches while the shell keeps running. Only confirmed pane close (close code 4001), inventory deletion, shell exit, or child shutdown terminates it.

After upgrade, the client opens xterm, fits it, and sends `attach-ready` with actual dimensions. Until then the server ignores input and does not transfer ownership. Each PTY feeds a bounded `@xterm/headless` model while attached or detached. At readiness the server resizes the PTY/model, serializes coherent normal/alternate-buffer state plus a small private-mode ledger, sends that reconstruction first, then forwards buffered and live output. This replaces arbitrary byte-tail replay and preserves raw-mode TUI state across fresh clients and different viewport sizes. Takeover is transactional: the previous holder receives 4410 only after the replacement is ready; an early failed claimant leaves it attached.

Sessions are managed tmux-style: `GET /api/terminal/sessions` lists every live PTY (attached/detached, age, dimensions, best-effort foreground-process label via a POSIX `ps` adapter), and `DELETE /api/terminal/sessions/<id>` kills one. The picker lists resources not already shown in the window and requires explicit attach, takeover, kill, or new-shell actions. Local pane ids/layout are separate from server PTY ids. The personal last-active id is highlighted but never auto-attached on a new client; actual pane attachments remain base-path-namespaced per-window presentation state.

App-defined WebSocket close codes: `4001` user-terminate (client→server: kill the PTY), `4409` sessionId in use (server→client: upgrade race lost), `4410` session taken (server→client: another window took this session over).

**Pane lifecycle on the client** (`terminal/client.ts`, `terminal/recovery.ts`, `terminal/lifecycle.ts`). A pane's presentation — visibility, pane records, layout, all workspace-scoped in browser storage — is separate from its transport, and the mount tells five things apart that a bare socket close conflates: page departure, a failed attach, the loss of an established connection, a confirmed shell exit, and an explicit user close. On `pagehide` (either `persisted` value) the panel *releases* every pane: a plain `1000` close the child processes at once, so the PTY is free for whichever document comes next — this one restored from the history cache, or a fresh one reading the same records — while nothing is persisted, because leaving a page is not hiding the terminal. The return (`pageshow`, or a foreground return on platforms that resume without one) *resumes* each released pane once; an ordinary background tab releases nothing. Attachment is decided by terminal reconstruction readiness, never by the browser socket's `open`: through the hub the browser side opens before the child has been asked, so a socket that opens and then closes is an attach failure, not an exit. Failures run one bounded recovery per restore, resume, connection loss, or user Retry — a five-second budget, delays from 100 ms doubling to a one-second cap, every inventory read and readiness wait bounded by what is left — reconciling against `GET /api/terminal/sessions`, which also answers the upgrade gate's origin question (the read asserts the page's address in `X-Uatu-Page-Origin`, since a same-origin GET carries no `Origin`): detached → ordinary attach again; occupied → keep waiting for the departing holder, then park on an explicit *Take over*; absent from a successful read, or an explicit exit frame → *Shell ended* with *New shell*; inventory unreadable or the socket silent → *Retry*; 401/403 → the paste-token form or the origin notice. Nothing automatic ever sends `takeover=1`: the mount's takeover flag is consumed by the attempt that uses it, and only the parked cards' actions re-arm it. Every socket callback, timer, inventory read and reconstruction callback carries the attach cycle's generation and is ignored once a teardown, hide, close, suspend, or takeover has advanced it. The pane keeps its last screen under a *Reconnecting…* note while it recovers; a retry's reconstruction resets the terminal before it paints. Restoration never takes keyboard focus.

**Hub bridge teardown** (`hub/proxy.ts`). The browser and child handshakes of a proxied terminal socket are independent, so the bridge can end from either side at any point. Ending is one idempotent step: whichever side closes first records the close, the other side is closed with the same (sendable) code so `4001` and `4410` keep their meaning across the hub, queued browser input is dropped, a child `open` arriving after the browser has left is closed again rather than becoming a holder, a failed browser upgrade releases the child connection it had started, and a browser that attaches after the child already refused is closed with the refusal instead of waiting on nothing. The bridge never creates, kills, or transfers a PTY; the child's own ownership rules do that, and the client's readiness-aware recovery above is what turns a refusal into an occupied/ended/retry verdict.

Clipboard crosses the client/server boundary in two directions, both ending at `navigator.clipboard` — which is the **host** clipboard even when the uatu server runs in a container, because the browser is on the host. Paste reads it and forwards down the PTY (`clipboard.ts` shortcut handlers). Copy has two paths: xterm-owned selections go through the Windows-Terminal-parity shortcuts, while mouse-mode TUIs (Claude Code, opencode) emit OSC 52 up the PTY, which `client.ts` bridges via `term.parser.registerOscHandler(52, …)` → `createOsc52Handler` in `clipboard.ts`. The bridge is write-only by construction (read queries get no response — no exfiltration path), caps decoded payloads at 100 KB, and reports every accepted write through a pane-scoped toast in `panel.ts` so clipboard poisoning is always visible — the notify behavior is fixed, not configurable. A gestureless `writeText` rejection (Firefox/Safari) promotes the toast to its Copy-button form, which performs the write inside the click.

> **Upgrade hazard.** The terminal is constructed with `allowProposedApi: true`
> because the search addon's decoration options are still proposed API in xterm
> 6 — calling them without it throws rather than degrading. Proposed APIs can
> shift across xterm minors, so read their changelog when bumping the dependency.

## Follow mode

uatu is a single-mode app. There is no Author vs. Review distinction; the only behavioral toggle is **Follow**, surfaced as a switch in the sidebar header. The full contract is specified in `openspec/specs/follow-mode/spec.md`; the four rules are summarized in the State lifecycle section above.

| Aspect | Behavior |
|---|---|
| Default `Follow` at boot | on at `/`; forced off when arriving via a direct document URL (e.g. `/guides/setup.md`) |
| `--no-follow` child flag | flips the default at `/` to off (source runs only; the hub never passes it) |
| User clicks a tree row | selection moves; follow turns off (Rule A) |
| User clicks the Follow switch | flips state; turning on jumps to the newest-mtime file (Rule B) |
| File changes on disk + follow on | selection moves to the changed file (Rule C) |
| File changes on disk + follow off | current file reloads in place if it's what changed; otherwise tree refreshes silently (Rule D) |
| Single-file root (a source run such as `bun run src/cli.ts serve some-file.md`; hub workspaces are folders) | Follow switch disabled — nothing else to follow |
| Sidebar panes available | Change Overview, Search, Files, Git Log, Usage — all always available; toggle via the per-pane visibility menu. Fresh clients start with Change Overview and Files visible (Git Log, Search, and Usage hidden); stored arrangements always win. Usage is chat-fed (`src/chat/usage-pane.ts` paints it; the sidebar owns the chrome) |

The `withProgrammaticUpdate(fn)` helper in `src/sidebar/tree-view.ts` is what makes Rule A reliable: it suppresses the `@pierre/trees` library's `onSelectionChange` callback during initial mount and `resetPaths`-driven refreshes so library-fired selections aren't mistaken for user clicks. That single helper is the root fix for the historical flake on `tests/e2e/preview-renderers.e2e.ts` (issue #45) and the `follow-mode auto-switch` test.

## Find and the active surface

⌘F is owned by the page, not the host. No engine — not Chrome, not
`WKWebView.find` — can scope native find to a subtree, so a browser's ⌘F
matches the tree, the git log, and the terminal scrollback alongside the
document you were reading. Owning find is the only way to scope it, and it
closes the desktop gap for free, since WKWebView ships no find bar at all.

Routing is one line: **⌘F searches the active surface.**

| Active surface | What ⌘F searches | Mechanism |
|---|---|---|
| `preview` | the current view's visible text | `find/` — text-node index + CSS Custom Highlight API |
| `terminal` | the focused pane's scrollback | `@xterm/addon-search` |
| `browser` | the split browser's page | native, in the macOS wrapper |

`appState.activeSurface` is owned by `src/find/active-surface.ts` and is
**deliberately not derived from `document.activeElement`**. Clicking a file in
the tree leaves focus inside `@pierre/trees`' shadow root, so a literal focus
rule would search the sidebar when the user has just declared interest in a
document. Sidebar interaction therefore resolves to `preview` — directing the
sidebar is an act about the document it is directing.

The surface is written only by pointer and focus listeners, which is what makes
follow mode inert: a file event (Rules C/D) changes the selection and the
preview, but cannot move focus or relocate the user's working context. There is
no code path from the watcher to the setter, and
`find/active-surface.test.ts` asserts that structurally.

The flat text the matcher sees keeps inline elements contiguous — that is what
lets a query match across the `<span>`s syntax highlighting inserts — but breaks
at block boundaries: `<p>foo</p><p>bar</p>` indexes as `foo\nbar`, never
`foobar`, so a hit is never reported for text the reader does not see as one
phrase. The separator is backed by no text node, and `locateSpan` refuses spans
that cross the gap, so a regular expression cannot sneak across it either.

One find bar serves both page surfaces via a pluggable engine (`find/engine.ts`);
the xterm search addon happens to take the same three options and report the
same index/total pair the preview matcher does. Highlighting never mutates the
preview — it paints `Range`s through `CSS.highlights`, so rendered output,
mermaid diagrams, anchors, and code-block decorations are untouched by
searching. Because the preview is replaced wholesale on live reload, the
preview engine holds no DOM references across a swap and re-indexes on a scoped
`childList` observer.

### Project search (⇧⌘F)

⌘F is scoped to a surface; **⇧⌘F is not**. That asymmetry is deliberate and
matches VS Code: the tree is not a surface you can be "in", so project search
means the same thing pressed from the document, the terminal, or anywhere else.

The corpus costs almost nothing to assemble. `getSession().getRoots()` already
holds every watched document, ignore-filtered (`.gitignore` + `.uatu.json`),
binary-classified, and kept current by the watcher — so `/api/search` reads that
list and matches. There is no index to invalidate and no second walker whose
ignore rules could drift from the tree's. Passing `allRoots=1` swaps in
`getUnscopedRoots()`, which is the escape hatch for a scope narrowed so far that
search would otherwise look broken.

Results stream as NDJSON rather than arriving in one batch: on a docs tree the
difference is invisible, but pointed at a repository it is the difference
between a pane that fills and one that hangs. The sweep is bounded on three
axes — minimum query length, a total match cap, and a per-document time budget
so a slow pattern costs one skipped file instead of the sweep.

Both budgets are checked *between* match attempts, never during one, because a
single `RegExp.exec` is not interruptible from JavaScript. The honest bound is
therefore "deadline plus one attempt". Measured on Bun's JavaScriptCore, runaway
backtracking plateaus around 460 ms per attempt rather than growing without
limit, so that overshoot is bounded in practice — but by the engine, not by us.

Running the sweep in a terminable worker would make the bound ours, and was
built and reverted: `bun build --compile` does not embed the worker module, so
the guarantee held from source and silently fell back in the shipped binary. A
guarantee that only applies in development is worse than a weaker one that
applies everywhere. Every bound that trips is disclosed in the pane; a silently truncated
list would read as "that is everywhere it appears", which is the wrong
conclusion for a reviewer to draw.

Activating a result routes through follow-mode Rule A — it is a user
navigation — then reveals the match with `find/reveal.ts`, which reuses the find
bar's own text index and highlight registry rather than growing a second
painting path. The awkwardness worth knowing about: the corpus is **source**
text while the reading surface is often **rendered**, and matches inside link
syntax, heading markers, or code fences exist in the file but not in the
rendered DOM. So the result lands in whatever view the reader is already using
and falls back to Source only when the match cannot be found there — Source
being where the searched text always exists.

## How to extend

### Add a new sidebar pane

1. Add the pane's id + label to `ALL_PANE_DEFS` in `src/shell/state.ts`. The `PaneId` union widens automatically.
2. Add a `<section data-pane-id="your-id">…</section>` to `src/index.html` inside `.sidebar-panes`.
3. Add an entry in `src/sidebar/panes.ts` (`paneId → renderer`) and create the renderer in a new file under `src/sidebar/`.
4. Add a test in `src/sidebar/your-pane.test.ts` (colocated) and an e2e test in `tests/e2e/sidebar.e2e.ts` (or a new feature file if you're starting a separate concern).

### Support a new file kind

1. Update `src/document/classify.ts` to recognize the extension or content signature.
2. If the file type renders to HTML, add a renderer in `src/render/` (mirror the shape of `markdown.ts` or `asciidoc.ts`).
3. Update `src/server/render-dispatch.ts`'s `renderDocument` to dispatch to your renderer.
4. If the file type has a custom preview shape (image, binary, etc.), add it under `src/preview/` and route it from `src/preview/mount.ts`'s `loadDocument`.
5. Cover the new path in `tests/e2e/preview-renderers.e2e.ts`.

### Add an HTTP route

1. Add the route to `src/server/routes.ts` inside the `buildRoutes(deps)` function. Use `deps` for anything the handler needs (the watch session, the metrics snapshot, e2e helpers, etc.) — do not reach into module-level state from inside the handler.
2. If the route is prod-only or e2e-only, place it inside the appropriate `mode === "prod"` / `mode === "e2e"` branch and add the required dep to the corresponding `ProdRouteDeps` / `E2ERouteDeps` shape.
3. Both `src/cli.ts` and `tests/e2e/server.ts` will pick up the new route automatically — they each `Bun.serve({ routes: buildRoutes(...) })`.

### Break the client/server API contract

Two separate revision families live in `src/shared/version.ts`; bump the
one that matches what actually broke.

1. **Bundled web client vs. its own server** — if a change renames/reshapes
   state-payload fields or endpoint semantics the shipped SPA depends on,
   bump `BUNDLED_WEB_REVISION` in the same change. The client-freshness
   handshake (`src/shell/freshness.ts`) compares the server's
   `build.bundledWebRevision` (riding every state payload) against the
   client's embedded value, next to the version/commit comparison that
   catches every build mismatch anyway. The revision only adds intent —
   "this break was known" — and forces the stale PWA bundle to reload.
2. **The public wire contract** — if the break is visible to independent
   clients (anything documented in `api/openapi.yaml` / `api/streaming.yaml`),
   bump `HUB_API_REVISION` and/or `WORKSPACE_API_REVISION` for the affected
   domain instead, mirror the pair in `api/contract.json` and the OpenAPI
   `x-uatu-revisions` block, and add a changelog entry to `api/CHANGELOG.md`
   with migration guidance, headed `Unreleased` until the release that ships
   it — CI's compatibility gate (`scripts/api-contract/compatibility.ts`)
   rejects breaking contract diffs that arrive without the bump and the
   guidance.
   A product or bundled-web change alone is NOT a public API break; the
   families move independently.

### Add an e2e test

1. Pick the right feature file under `tests/e2e/` (look at the existing file names — they mirror the `src/` folder taxonomy). If your test doesn't fit any existing file, create a new one named after the feature.
2. Import the shared setup: `import { standardBeforeEach } from "./fixtures";`.
3. The harness reset (`/__e2e/reset`) is in `tests/e2e/config.ts`; the workspace fixture lives at `testdata/watch-docs/`.

## Run and test

```bash
bun run dev               # dev hub on :4702 with testdata/watch-docs (user dev / dev)
bun test                  # unit + integration suite (~18s)
bun run test:e2e          # Playwright (~5min, workers: 1, serial)
bun run build             # compile single-file dist/uatu binary
bun run check:licenses    # audit npm dependencies
bun run bench:render      # informational render baseline
```

For tighter loops:

- `bun test src/sidebar/git-log.test.ts` — single file
- `bun x playwright test tests/e2e/mermaid.e2e.ts:127` — single e2e test
- `bun run dev --no-open` — start the dev hub without opening a browser
