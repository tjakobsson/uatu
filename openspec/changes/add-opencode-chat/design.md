## Context

See `proposal.md` for motivation and the delta specs for observable behavior. UatuCode currently has one `uatu serve` process per running workspace, a single route table shared by production and E2E, a browser SPA that is also hosted by the macOS `WKWebView`, and a hub that authenticates and reverse-proxies workspace HTTP, SSE, and WebSocket traffic under stable base paths. The workspace process already owns long-lived subprocess resources through the embedded-terminal subsystem, and the terminal uses the canonical first watch root as its working directory.

OpenCode offers two integration surfaces. ACP is a portable JSON-RPC-over-stdio agent protocol, but its history and provider-specific controls are capability-dependent. The JavaScript SDK is generated from OpenCode's server contract and exposes session inventory/history, asynchronous prompts, event subscription, cancellation, permissions, questions, model metadata, and provider-native part types. T3 Code independently chose the SDK for its OpenCode adapter even though it has an ACP framework; other agent chat clients demonstrate the alternative generic ACP approach.

OpenCode owns provider credentials and durable session history under the daemon user's environment. Uatu must not proxy the OpenCode service itself to browsers: doing so would expose a broad filesystem and process API, couple clients to provider payloads, and bypass Uatu's workspace and authentication boundaries.

## Goals / Non-Goals

**Goals:**

- Deliver the complete chat behavior through the existing web application so browser, PWA, and macOS clients share one implementation.
- Preserve OpenCode session fidelity while publishing a small, normalized Uatu workspace contract.
- Fix the execution directory at the workspace boundary and prevent cross-workspace session access.
- Make prompt retries, stream reconnection, and client projection deterministic.
- Keep provider lifecycle and failures isolated to one running workspace.
- Establish a narrow internal seam that can host another provider adapter without designing a multi-provider product now.

**Non-Goals:**

- ACP support, Claude Code, Codex, or provider selection in this change.
- Agent, variant, session fork/revert, sharing, voice, image attachment, or push-notification UI.
- Choosing among the models OpenCode already has configured, and invoking OpenCode's own slash commands, are in scope; neither introduces a provider or credential of its own.
- Running agents after their Uatu workspace server is stopped.
- A native SwiftUI/AppKit chat renderer or an iOS application target.
- Importing source or visual assets from other agent chat clients; they remain behavioral references only.
- Exposing OpenCode's HTTP server or SDK wire types as Uatu's public API.

## Decisions

### 1. Use the OpenCode SDK transport behind a Uatu-owned adapter

Add `@opencode-ai/sdk` as a runtime dependency and isolate all imports and provider event mapping under `src/chat/`. The adapter exposes Uatu domain operations and normalized events; routes and UI depend only on those types.

The SDK gives the first version reliable access to OpenCode's existing session inventory, message parts, asynchronous prompts, event stream, permissions, questions, and abort operation. ACP remains a future adapter option but is not a useful abstraction to impose on the first implementation: its optional session-loading behavior would either reduce the required history experience or force OpenCode-specific extensions immediately.

Alternatives considered:

- **ACP first:** more portable, but weaker guaranteed history/session fidelity and still requires a normalization layer.
- **Terminal parsing:** rejected because ANSI output cannot reliably represent structured parts, permissions, questions, identities, or replay.
- **Expose OpenCode directly to the browser:** rejected because it leaks a provider-specific, high-authority API and defeats Uatu's workspace gate.

### 2. Own one lazy OpenCode server per workspace process

Create a workspace chat service beside, not inside, `WatchSession`. `cli.ts` constructs it with the canonical first root and passes it to the shared route builder. The service starts lazily on the first status/inventory operation so ordinary document-preview use does not spawn OpenCode. It is disposed in every normal and startup-failure shutdown path before the workspace exits.

Startup resolves the user's `opencode` executable, allocates a loopback port using the existing port-probe conventions with bounded retry for bind races, generates an ephemeral random server password, and spawns without a shell:

```text
OPENCODE_SERVER_PASSWORD=<ephemeral>
opencode serve --hostname 127.0.0.1 --port <allocated>
```

The service polls the authenticated health endpoint to readiness with a bounded timeout and retains bounded startup stderr for an actionable unavailable result. The SDK client uses a private fetch wrapper that supplies Basic authentication. Neither the endpoint nor password leaves the workspace process.

OpenCode's persisted sessions survive service restart. An active turn does not survive workspace shutdown, matching the existing workspace lifecycle.

The provider event pump is supervised rather than started once. Its stream ends whenever OpenCode restarts or the SDK errors, and an unsupervised pump fails silently in the worst possible way: HTTP still answers and SSE keepalives still flow while agent events never arrive again. The service restarts the pump with capped exponential backoff until disposal, resetting the backoff after a long healthy run.

Per-conversation projections are bounded by a least-recently-used cap, skipping any conversation with a live subscriber. An evicted conversation loses its replay ring, so a returning cursor resolves to a retention-gap resync — already a supported path. Without this, browsing back through history grows workspace memory for the life of the process.

Alternatives considered:

- **One OpenCode server per hub:** would keep turns alive independently of workspace children, but introduces cross-workspace routing, hub-owned agent lifecycle, and a larger failure/security domain.
- **One OpenCode process per conversation:** stronger process isolation but wasteful and harder to coordinate with OpenCode's session inventory.
- **Eager startup:** simpler status state, but imposes process and startup cost on users who only preview documents.

### 3. Treat the first canonical watch root as the immutable chat directory

The service resolves `rootEntries[0].absolutePath` to a canonical real path once and creates its SDK client with that directory context. It never accepts a directory from a route body or query. Session inventory is filtered by canonical directory, and every operation that receives a conversation ID fetches and revalidates that session before reading or mutation. Missing and foreign IDs share a non-revealing not-found response.

This matches terminal behavior and gives direct multi-root serving a deterministic rule. The hub's registered folder remains the first and normally only root.

An implementation must account for equivalent spellings and symlinks: compare canonical real paths when available and normalized absolute paths only as a fallback for a path that no longer resolves. A session whose directory changed is not silently adopted or forked in this first version.

### 4. Keep OpenCode authoritative and normalize at the workspace boundary

Uatu stores no duplicate transcript database. Conversation list and history are read from OpenCode and transformed into stable Uatu types:

```text
ConversationSummary
ConversationSnapshot { generation, cursor, items, olderCursor }
ConversationItem
  user_message | assistant_message | reasoning
  tool | permission | question | turn_status | notice
ChatEvent { generation, sequence, conversationId, type, payload }
```

Provider IDs remain opaque identity fields where needed for continuation and deduplication, but raw provider objects are not returned. Normalization keys message parts and tool calls by their OpenCode identities and computes text deltas against the last emitted text, handling both cumulative part updates and incremental delta events.

History pages use opaque cursors derived from stable provider message boundaries rather than browser-visible numeric offsets. The server may need to fetch a larger OpenCode history window before slicing because the initial SDK history API exposes a limit but not a before cursor; that inefficiency stays behind the API and can improve without changing clients.

### 5. Use HTTP commands plus a bounded replayable SSE stream

Follow Uatu's established split between POST mutations and server-to-client SSE rather than introducing another WebSocket protocol. Planned workspace operations are:

```text
GET  /api/chat/status
GET  /api/chat/conversations
POST /api/chat/conversations
GET  /api/chat/conversations/:conversationId
GET  /api/chat/conversations/:conversationId/events
POST /api/chat/conversations/:conversationId/prompts
POST /api/chat/conversations/:conversationId/cancel
POST /api/chat/conversations/:conversationId/permissions/:requestId
POST /api/chat/conversations/:conversationId/questions/:requestId
```

Exact request and response schemas are defined in the OpenAPI and streaming contracts during implementation. All client URLs use `appUrl()` and all routes participate in the existing base-path builder.

Each workspace-server generation receives a random generation ID. Each conversation has a monotonically increasing sequence and a byte-bounded replay ring. A snapshot is assembled against the current projection and returns its generation and latest sequence. The SSE endpoint accepts the generation/sequence cursor (including `Last-Event-ID` where practical), atomically subscribes, replays retained later events, then sends live events. A generation mismatch or retention gap emits a typed `resync` terminal event and closes. This avoids a snapshot/subscription race and makes recovery explicit.

The browser reducer is idempotent by item identity and sequence. It discards duplicates, detects sequence gaps, and fetches a fresh snapshot on `resync`.

Provider updates are coalesced in a short window (~50 ms) before they reach the replay ring, so one sequence number covers a batch rather than a token. Consecutive text deltas for the same item concatenate, repeated tool upserts for the same id replace in place, and urgent updates — conversation status, interactions, user messages, terminal tool states — flush immediately so nothing user-visible waits on a timer. Workspace confinement is still resolved per event as it arrives, never at flush time, so a session that moves out of the workspace stops publishing from that moment. Coalescing before the ring means every client benefits: fewer sequence numbers, fewer SSE frames, fewer client renders, and a replay ring that holds more conversation per byte.

A malformed event on the wire is treated as a lost projection: the client closes the stream and reloads from a snapshot rather than continuing from a state that may have silently diverged.

Alternatives considered:

- **Fresh full snapshot on every reconnect:** simpler but expensive for long conversations and disruptive to reading position.
- **WebSocket:** unnecessary for low-volume commands, duplicates request/response semantics, and increases hub bridge complexity.
- **Persist Uatu's event log:** stronger restart replay but duplicates OpenCode history and adds migration/storage scope; a fresh snapshot is sufficient across workspace generations.

### 6. Make mutations retry-safe at the Uatu boundary

Every prompt and request-response mutation carries a cryptographically random client request ID. The chat service keeps bounded operation receipts keyed by authenticated operation scope, conversation, and request ID. Concurrent duplicates join the first operation; later duplicates return its accepted identity or terminal result without calling OpenCode again. Receipts live for the workspace generation and are size/time bounded.

For prompts, use an independently generated stable provider message ID where the installed SDK supports one, further reducing ambiguity if a response is lost. A restart changes generation and forces clients to reconcile from OpenCode history before offering a retry. The UI keeps a draft until the server confirms acceptance and then correlates the resulting user message by the returned identity.

### 7. Reuse the existing workspace credential and origin boundary

Chat lifecycle and mutation routes require the same child credential gate used by terminal control routes plus same-origin enforcement for mutations. Under the hub, the hub authenticates the user and brokers the child credential while proxying. Under direct serve, the startup URL promotes the token to the existing path/port-scoped HttpOnly cookie before chat control is available. The implementation may rename internal helpers from terminal-specific terminology, but it preserves the shipped cookie/token behavior so existing terminal sessions do not require a migration.

Read endpoints reveal conversation content and therefore use the credential gate too, not only mutations. The OpenCode service remains loopback-only and Basic-authenticated as defense in depth. Error responses do not distinguish a foreign conversation from an unknown one.

### 8. Add Chat as a persistent web surface, not a native view

Create a `src/chat/` feature domain containing API client, normalized model/reducer, timeline, rendering, composer, interaction cards, file-link routing, and scroll controller. The HTML contains one Chat surface that remains mounted when hidden, preserving drafts, loaded history, expansion state, and scroll state.

Desktop adds a compact Preview/Chat main-surface switch in workspace chrome. The sidebar and terminal retain their current roles. Touch extends `TouchTab` to `files | preview | chat | terminal`, adds the fourth tab, and maps the desktop main-surface selection when entering or leaving touch mode. Chat availability does not hide the tab: an unavailable OpenCode installation is actionable product state, not a layout mutation.

The existing macOS wrapper needs no feature-specific UI; its WebView receives Chat automatically. Native work is limited to regression verification of links, dialogs, keyboard shortcuts, and titlebar inset.

### 9. Model scroll anchoring explicitly

The timeline uses semantic anchors rather than unconditional `scrollTop = scrollHeight`:

- Track whether the user is pinned within a small end threshold.
- While pinned, apply streamed changes and settle to the end after layout.
- While unpinned, capture the first visible item ID and its viewport offset before DOM mutations, then restore that offset after updates or prepend.
- Anchor an explicitly expanded/collapsed activity item during its layout change.
- Use `ResizeObserver` to account for late code highlighting and expanded tool content.
- Show an accessible latest-content button with unseen state whenever unpinned updates arrive.
- Persist a per-client conversation anchor in presentation storage; fall back to the end if the item is no longer in the loaded page.

Start without DOM virtualization. Correct anchoring and paginated bounded DOM are simpler to validate first; add virtualization only after measurements demonstrate a need. This differs from mature implementations elsewhere but preserves the key behavioral lesson without importing their code.

### 10. Render streaming Markdown safely and route file references through the document model

Assistant text is accumulated by item and re-rendered from the complete current Markdown source on coalesced animation-frame updates; partial Markdown is never appended as trusted HTML. Build a browser-safe chat Markdown renderer from the repository's existing micromark/HAST sanitization dependencies and policy, with code highlighting deferred/coalesced to avoid one highlight operation per token.

Rendering is keyed and incremental: the timeline keeps one persistent DOM node per item id, and a frame only touches the nodes whose items actually changed. Rebuilding the whole timeline per frame is prohibited — it destroys state the DOM owns rather than the projection: input typed into a pending question form, focus, text selection, and find-in-surface highlights. It also re-runs Markdown and highlighting for every message on every token. A streaming assistant message patches its own node in place; an item whose shape changes (an interaction resolving) is rebuilt alone.

File references are parsed into candidates, then resolved against the already loaded document tree. Only a matching watched document becomes an action. Activation calls existing document navigation, switches the main/touch surface to Preview, and applies a line reveal after mount. Absolute outside paths and traversal remain inert text. Tool output is always text unless a normalized field has an explicit renderer.

### 11. Treat software-keyboard geometry as a chat subsystem concern

Reuse the terminal visual-viewport lessons without coupling Chat to xterm. The Chat surface owns a small viewport controller that derives usable height from `window.visualViewport`, composer size, safe-area inset, and the visible touch tab-bar inset. It updates CSS custom properties and preserves the timeline anchor across keyboard transitions. The composer uses a real autosizing text area, semantic send/cancel buttons, and no fixed document-height assumptions.

### 12. Publish and validate the new public contract

Add every externally supported chat HTTP operation to `api/openapi.yaml` and the replayable SSE channel and event schemas to `api/streaming.yaml`. Add route-coverage classifications, representative contract fixtures, integration tests through the hub prefix, and consumer-facing API changelog material. Run compatibility tooling and increment `WORKSPACE_API_REVISION` only according to its result and repository policy.

## Risks / Trade-offs

- **[OpenCode SDK/event shapes change across installed versions]** -> Detect server version at startup, validate every external payload at the adapter boundary, report unsupported versions clearly, pin and audit the SDK dependency, and cover normalization with recorded fixtures plus real opt-in integration tests.
- **[A loopback OpenCode service is still a high-authority local API]** -> Bind only `127.0.0.1`, assign an ephemeral Basic-auth secret, never expose its endpoint, spawn without a shell, and terminate it with the workspace.
- **[Provider events are global to the OpenCode server]** -> Filter by validated conversation ID and canonical directory before projection or publication; never broadcast unclassified events.
- **[History pagination may require over-fetching]** -> Keep the inefficiency server-side behind opaque cursors, bound response and normalization work, and measure before adopting provider-specific undocumented APIs.
- **[In-memory replay cannot bridge workspace restart]** -> Generation mismatch forces a fresh OpenCode-backed snapshot; completed provider history remains durable.
- **[In-memory idempotency receipts cannot prove an ambiguous mutation across process death]** -> Reconcile from provider history after generation change, use provider message identity where supported, and never automatically retry an ambiguous draft across restart.
- **[Streaming Markdown and expanding tools cause layout churn]** -> Coalesce rendering, implement semantic anchor restoration, and test delayed layout and keyboard transitions explicitly.
- **[Four phone tabs reduce horizontal space]** -> Use concise labels/icons and existing equal-width tab behavior; four remains within standard mobile navigation density.
- **[Agent authority exceeds ordinary document preview]** -> Require workspace credentials for reads and writes, retain origin checks, show permission requests in context, and document that agent tools execute as the daemon OS user under the existing hub trust model.
- **[One provider now can bias the public model]** -> Keep normalized names provider-neutral where behavior is genuinely common, but do not erase OpenCode semantics or claim unsupported portability.

## Migration Plan

1. Add the SDK dependency and isolated adapter/lifecycle behind a chat service that is lazy and unavailable by default on startup failure.
2. Add normalized types, routes, credential/origin enforcement, OpenAPI and streaming contracts, and server/integration tests before exposing UI controls.
3. Add the mounted desktop Chat surface and validate snapshot, replay, prompt, cancellation, permission, question, and file-navigation flows.
4. Extend touch navigation to four tabs and add mobile viewport/scroll E2E coverage.
5. Verify the unchanged macOS WebView wrapper against the completed web capability.
6. Release as an additive workspace API capability; existing clients ignore the new state and routes.

Rollback removes the Chat entry points and stops creating the lazy service. OpenCode's own session history remains untouched, so rollback neither requires data migration nor destroys conversations. If the public API has shipped, its removal requires normal compatibility handling; during pre-release development, contract artifacts and revision move together.
