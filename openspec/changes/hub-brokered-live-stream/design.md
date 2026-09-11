## Context

See proposal.md — Why. The facts the design rests on, all measured this week:

- Browsers cap HTTP/1.1 at six connections per host, shared across tabs; the hub (Bun.serve) is HTTP/1.1 only. A session page holds 1–4 long-lived SSE connections today (document, inventory, conversation, subagent). Two conversation tabs saturate a browser; reproduced in Chromium and WebKit against the real hub.
- Bun's outbound `fetch` is capped at 256 concurrent requests per process. Every proxied browser stream is one such fetch, so the hub's upstream count scales with tabs. The `v0.6.2` leak filled that pool; #334 fixed the leak, but the scaling remains.
- `resilient-live-connections` (#334, implemented, not yet archived) gave each of the three streams its own keepalive, backoff, generation guard, and lifecycle recovery. Its guarantees are kept; its per-stream machinery is what this change collapses.
- The child's SSE routes already have the right semantics for a broker to consume: the document route sends a snapshot on open; the conversation route has replay cursors and an explicit resync; the inventory route is an invalidation tick. None needs to change to be subscribed to by the hub.
- `serve` has been deprecated as a public command since #218 (`v0.5.0`) and `--local` was removed: the hub is the only trust boundary browsers cross. Removing public `serve` in this change is what lets the SPA have one transport with no fallback. The e2e harness builds child routes directly and does not go through `serve`.

## Goals / Non-Goals

**Goals:**
- Exactly one long-lived HTTP connection per session tab for live delivery, independent of what is open in it.
- Hub upstream connections bounded by watched topics, refcounted, released on last unsubscribe.
- Per-topic cursors so a reconnect resumes each topic independently and a stale conversation cursor never forces a document resync.
- Cross-workspace activity delivered on the same stream with a fixed, content-free shape.
- One client recovery path replacing three.
- One breaking API revision that draws the public/internal boundary once: Hub API public, workspace API internal, `serve` gone.

**Non-Goals:**
- Removing the child's SSE routes: they are the internal hub↔child protocol and stay.
- HTTP/2 on the hub. Bun.serve does not offer it; the design must work on HTTP/1.1, and one connection per tab makes the question moot for the app.
- Replacing the terminal WebSocket bridge; terminals have their own pool in every browser and are unaffected.
- Multiplexing across *origins*: the stream is per hub origin, which is already where all workspaces live.
- Push notifications or service-worker delivery; the activity summary is for open pages only.

## Decisions

### D1 — Hub subscribes to the child; the child stays request/response

The hub opens one internal fetch per `(workspace, topic[, conversation])` to the child's existing SSE routes and fans events out to client streams. The child does not learn the hub's address or hold a credential for it.

*Why:* the hub already owns the child's endpoint and brokered token, so no new trust relationship is needed, and the child's routes already carry the right semantics (snapshot on open, replay cursors, resync). *Alternative — child pushes to the hub:* every child becomes an outbound client needing a hub endpoint and an auth path handed over at spawn, plus reconnect logic in the child; nothing is gained that fan-out at the hub does not give. Rejected with the user.

### D2 — One SSE stream per page with a JSON envelope and per-topic cursors

`GET /api/hub/live` (hub origin, authenticated by the hub session) is a long-lived SSE response. Each event is `event: live` with a JSON envelope `{ ws, topic, key?, cursor, event }` where `topic ∈ {document, inventory, conversation, activity}`, `key` is the conversation id for conversation topics, and `cursor` is the topic-scoped position. The SSE `id:` field is not used for resume — it can carry only one cursor — so a reconnect sends its retained cursors explicitly (D3). Keepalives are comment frames on the existing 15 s cadence, and the response writes an opening comment immediately so the browser reports `open` before any event exists (the #350 lesson).

*Why one stream and not "one per workspace":* a tab views one workspace but the activity topic spans all of them, and the whole point is a constant per-tab cost. *Alternative — WebSocket:* bidirectional for free, but loses `EventSource`'s built-in retry semantics and the browser's understanding that this is a stream; and the terminal already proves the hub can bridge WebSockets, so nothing new would be learned. SSE plus a small control endpoint (D3) keeps the read path identical to today's mental model.

### D3 — Subscription control is a separate authenticated request bound to the stream

The stream is created with an initial subscription set in the query (`ws`, `document=1`, `inventory=1`, `conversation=<id>@<cursor>`…). Later changes go to `POST /api/hub/live/<streamId>/subscriptions` with add/remove operations and, for adds, the cursor to start from. `streamId` is an unguessable id the hub issues in the stream's first event; the request must carry the same hub session as the stream. Reconnect is a new `GET` presenting every retained cursor.

*Why a POST rather than in-band:* SSE is one-directional; a second, tiny request is the standard answer and lets the hub validate each change against the session. *Why bind by stream id + session and not session alone:* a user with two tabs must not have one tab's selection change the other's stream. *Alternative — reopen the stream on every selection change:* simple, but it is exactly the connection churn (and CONNECTING window) this change exists to remove.

### D4 — Refcounted upstream subscriptions with a short linger

A hub-side broker holds `Map<upstreamKey, { fetch, subscribers, lastCursor, buffer }>`. First subscriber opens the upstream; each event is stamped with the upstream's cursor and fanned out; the last subscriber leaving starts a short linger (a few seconds) before the upstream is aborted, so a tab reload or a quick conversation A→B→A does not thrash the child. Upstream cursors are the child's own (`Last-Event-ID` for conversations; generation for document) so a hub reconnect to the child resumes rather than restarts. The broker keeps a bounded replay buffer per upstream so a client reconnecting a moment later can resume from its cursor without a child round trip; beyond the buffer it forwards the child's own replay or resync.

*Why linger:* the measured pattern is rapid switching. *Why bounded buffer rather than relying only on child replay:* the child's conversation replay exists, but the document topic's "replay" is a fresh snapshot, and inventory is a tick; a small hub buffer gives all topics the same cheap fast path. *Alternative — no fan-out, one upstream per client stream:* removes the browser problem only; the Bun 256 cap and the child's subscriber count would still scale with tabs.

Two bounds keep this true when upstreams fail or clients fall behind. A subscriber joining a failed upstream is told at once and shares the attempt that failed; it brings the next retry forward to the retry floor rather than retrying itself, so tabs joining one after another never each restart a failing child request. And at most one child replay (catch-up) runs per upstream: a second subscriber behind the buffer while it runs takes a topic-scoped resync — one short snapshot request from its client — instead of a long-lived child request of its own.

### D5 — Activity is computed at the hub from a small child endpoint

Each child gains an additive internal endpoint that streams a workspace activity summary: `{ working: boolean, awaiting: boolean }` derived from live conversation statuses and pending interactions across agents. The hub subscribes to it for every running workspace the user may access (refcounted like any topic, but keyed by user rather than by tab) and merges with its own session state (`running`) into the `activity` topic. The summary carries no identifiers beyond the workspace id.

*Why at the hub:* only the hub knows which workspaces a user may see and which are running; a child knows only itself. *Why a dedicated child endpoint rather than deriving from the inventory stream:* the inventory stream is an invalidation tick with no status; deriving "working" would mean the hub subscribing to every conversation of every workspace, which is the opposite of bounded. *Alternative — poll `/api/chat/status` per workspace on an interval:* the dashboard already does something like it for shells with a 2 s bound; a 14-workspace poll every few seconds is load with no push semantics, and the badge would lag.

### D6 — The client becomes one `LiveChannel` with topic consumers

`shell/live-channel.ts` grows from "one EventSource with a generation" into the owner of the single stream: it opens `/api/hub/live`, dispatches envelopes to registered topic consumers, tracks per-topic cursors, drives the one reconnect with backoff and generation, and owns subscription changes. The existing consumers — `shell/events.ts` (document), the chat client's inventory and conversation handlers, the subagent drill-down — become topic consumers with the same callbacks they have today. `shell/recovery.ts` stays as the lifecycle coalescer but recovers one channel. The shell indicator confirms on the first applied `document` event of the current generation; chat's interruption ownership rule (#334 D4) is preserved by treating topic-scoped resync/unavailability as chat-surface status, never shell status.

*Why keep the consumers' callback shapes:* `ui.ts` is large and its stream handling is intricate (selection generations, child streams, recovery ordering); changing transport underneath it while keeping its contracts is the lowest-risk path and keeps #334's tests meaningful. *Alternative — a fresh chat client:* out of scope; `improve-chat-responsiveness` owns chat client performance.

### D7 — One breaking revision: Hub API public, workspace API internal, `serve` removed

The contract gains one SSE protocol definition (`live`) and two operations (`GET /api/hub/live`, `POST /api/hub/live/{streamId}/subscriptions`). The proxied workspace API is removed from the public contract and classified as an explicit internal exclusion — the child's routes, including its SSE routes and the new activity endpoint, are hub↔child protocol. The hub refuses the three per-stream SSE paths with a non-cached error naming the replacement rather than proxying them. Public `serve`/`watch` are removed from the CLI: a user-shaped invocation prints the hub bootstrap steps and exits non-zero; the hub's child invocation and the repository's source-run harness are unchanged. This is one revision increment with a changelog Migration section.

*Why remove now rather than deprecate-then-remove:* keeping `serve` public for one more release would require the SPA to keep its direct `EventSource` paths alongside the brokered channel — a second transport built to be deleted next release, in exactly the code (`ui.ts` stream ownership) that is hardest to change twice. The deprecation notice has shipped in three stable releases; removal is already licensed. *Alternative — additive first, breaking later:* rejected with the user for that reason.

### D8 — `bun run dev` becomes a dev hub

A checked-in `dev/hub.json` (one user `dev`, a documented password, `stateDir` under `.local/`) and a `scripts/dev-hub.ts` that starts `uatu hub` from source, registers `testdata/watch-docs` if absent, starts it, and opens the session URL. `bun run dev` points at it and no bare-child dev script remains — there is no mode it would exercise.

*Why now:* the SPA's only live transport after this change is the hub's. *Why from source:* running hubs from source is avoided for user-facing testing (Bun's dev overlay); the dev loop is the repository's own harness, which the source-run exemption in the CLI already covers.

### D9 — Coherence with `resilient-live-connections`

That change is implemented but unarchived and modifies `sidebar-shell`'s indicator requirement. This change's MODIFIED block for that requirement is written on top of that delta's text, and its new requirements for document, inventory, and conversation are ADDED rather than rewrites, so the two changes can archive in either order and converge. Its D5 (explicit hub stream cancellation) and D6 (fixed-vocabulary diagnostics) carry over verbatim into the broker.

### D10 — A page in the background releases its connection

One connection per tab still reaches the browser's six-connection cap at six tabs. A page hidden from view closes its stream and keeps every subscription and cursor; the return to the foreground — already a lifecycle wake-up — reconnects, and each topic resumes from its cursor or resyncs. A page opened in the background releases the connection boot opened. A regained network while hidden does not reconnect. There is no grace period: the recovery reconnects on every return to the foreground anyway, so holding the stream through a short absence would keep a socket without saving a reconnect. Nothing visible depends on live events in a hidden tab — the title and favicon come from the project, and there are no notifications or app badges.

*Alternative — one connection per browser, shared across tabs (a Web Locks leader relaying over BroadcastChannel):* removes the cap outright, but a frozen or throttled leader tab (mobile, background timer throttling) stalls every tab until leadership moves, and the tabs' differing subscription sets must be merged at the leader. *Alternative — keep one per tab and state a five-tab limit:* honest, but a limit users hit. Both rejected with the user.

## Risks / Trade-offs

- [Head-of-line blocking on one stream: a slow consumer of a chatty conversation topic delays document events on the same tab] → The stream is SSE over one TCP connection; the browser reads it as fast as the tab can. Consumers dispatch synchronously and defer rendering (the chat surface already coalesces). Measured event rates for a busy conversation are tens per second; the document topic is bursty but small.
- [Broker becomes a single point of failure for all live delivery] → It is in the hub process, which is already that. Broker errors are topic-scoped signals, never stream endings; a hub restart is a full reconnect, which the client owns. Integration tests hold real streams across a child restart.
- [Replay buffer memory: many workspaces × many conversations × a buffer each] → Buffers exist only for upstreams with subscribers, are byte-bounded, and are dropped with the upstream after linger. Bounded by watched topics, like everything else here.
- [Activity topic becomes a side channel for content] → The shape is fixed to three booleans plus workspace id and validated at the hub before fan-out; a test asserts no other field survives.
- [Two tabs of one user with different subscriptions] → Stream id binding (D3) keeps them independent; the broker refcounts per upstream so they still share one child subscription.
- [External clients on the removed streams or on `serve` break without warning] → The revision's changelog Migration section names the brokered stream and the hub as replacements; the hub's refusal for the three paths names the replacement in its body; the CLI refusal prints the bootstrap steps. The deprecation notice preceded this by three stable releases.
- [The `ui.ts` stream ownership rewrite regresses #334's recovery semantics] → Its lifecycle tests are kept and pointed at the topic consumers; the ordering invariant from #350 (close before fetch) becomes a broker-side non-issue but the test remains as a guard on the recovery order.

## Migration Plan

1. Land the broker, `/api/hub/live`, the SSE-route refusal, and the `serve` removal in one release marked breaking (`feat!:`); pages served by that hub use the brokered stream and nothing else.
2. Contract: add the `live` protocol and operations; remove the workspace API from the public contract and add its explicit internal exclusion; bump the revision in `contract.json`, the OpenAPI version/summary/`x-uatu-revisions`, and `version.ts`; write the changelog section with Migration; run CI's compatibility step locally before the PR.
3. Dev loop switches to the dev hub in the same PR so the change is developed and reviewed in the mode it targets.
4. Rollback is a release rollback; there is no persisted state. A hub running the new release with an old child (mid-upgrade) sees the activity endpoint 404 and reports that workspace as running with unknown activity — the switcher shows the dot without a badge.

## Open Questions

- Linger duration and replay-buffer byte bound: start at 3 s and 256 KB per upstream (matching the child's conversation replay bound) and tune from the diagnostics counters. Does not affect specs or tasks.
