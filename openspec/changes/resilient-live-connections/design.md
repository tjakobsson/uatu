## Context

See `proposal.md` for motivation. UatuCode exposes three browser-facing SSE classes: document state, conversation inventory, and selected-conversation events. The Hub forwards them to one loopback workspace child with `fetch()` response streaming. Chat emits 15-second SSE comments; document state can remain byte-silent indefinitely. The document client partly delegates retry to native `EventSource`, while Chat owns retries but treats receipt of an application event, rather than a successful open, as recovery.

Mobile browsers may suspend JavaScript, move between Wi-Fi and cellular, or retain an `EventSource` in `CONNECTING` after an intermediary path has disappeared. Tailscale Serve adds an HTTP/2-to-HTTP/1.1 reverse-proxy hop, but neither it nor Bun has a connection limit near the observed load. The design must therefore make each stream self-maintaining without introducing a global connection pool or coupling clients.

## Goals / Non-Goals

**Goals:**

- Keep idle SSE paths active through ordinary reverse proxies and mobile network state.
- Make reconnect completion observable even when no application event follows it.
- Ensure lifecycle wake-up converges state and transport without duplicate active streams.
- Propagate downstream cancellation through the Hub to child subscriptions.
- Produce low-cardinality lifecycle diagnostics that do not expose content or credentials.

**Non-Goals:**

- Guarantee connectivity while a device has no usable tailnet path.
- Add offline behavior or a service worker.
- Change terminal single-client ownership or WebSocket takeover behavior.
- Solve cold-start blank pages, split the JavaScript bundle, or add an inline bundle-load recovery shell.
- Change SSE application payloads, replay cursor formats, or API revisions.

## Decisions

### 1. Use SSE comments as transport keepalives

The document stream will emit a comment frame on the same 15-second cadence as Chat. Comments traverse every proxy hop and produce bytes on the connection, but native `EventSource` does not dispatch them to application listeners. The server will cancel its keepalive timer when the stream is canceled or the watch session stops.

Application heartbeat events were rejected because they would enlarge the public event protocol and tempt clients to treat liveness as workspace state. TCP keepalive alone was rejected because its defaults and visibility vary across operating systems and reverse proxies.

### 2. Let clients own reconnect scheduling after an EventSource error

On an error, the owning client closes that `EventSource` and schedules a new instance with bounded exponential backoff and a finite maximum delay. A monotonically increasing connection generation guards callbacks and asynchronous state reconciliation, so events from superseded attempts are ignored. The retry loop continues until success or page disposal; it never waits indefinitely for native `EventSource` to leave `CONNECTING`.

For document state, a connection becomes confirmed only when the current generation supplies a valid state payload and that payload is applied. This preserves the existing initial snapshot behavior while making the shell indicator truthful. For Chat, `open` is sufficient to prove transport recovery because cursor replay or an explicit resync event owns projection correctness; successful open resets failure accounting before any application event arrives.

Leaving native automatic retry in charge was rejected because browsers expose no bound on time spent in `CONNECTING`. Polling only `/api/state` was rejected because it would discard push delivery and create constant application-level work.

### 3. Treat page wake-up as an explicit reconciliation boundary

The document connection owner will listen for `pageshow`, transition to visible, and `online`. A coalescing recovery operation fetches authoritative state, applies it through the existing state reducer, and installs a fresh event stream. A generation token prevents a slower earlier fetch or stream from replacing newer state. Signals received while recovery is already pending coalesce rather than multiplying requests.

Chat will use the same lifecycle indications to reconcile inventory and verify or replace its inventory and selected-conversation streams. Existing presentation state remains owned by the UI and is not reset during transport recovery.

Always reconciling on a meaningful wake-up was chosen over trying to infer whether an SSE comment crossed the path: comments are deliberately invisible to JavaScript, and a browser may freeze timers while suspended.

### 4. Separate document and Chat status ownership

The shell connection chip continues to report only document-state connectivity. It enters `Connected` after current authoritative state is applied and remains `Reconnecting` between an error and successful replacement state. Chat maintains a dedicated connection interruption condition in its own status presentation. A successful Chat `open` clears that condition without clearing unrelated provider, validation, or turn errors.

A single global "online" state was rejected because independent streams can fail separately and a green aggregate would hide partial failure. Reusing the existing generic Chat announcement text without ownership was rejected because clearing it on reconnect could erase an unrelated actionable error.

### 5. Make Hub stream cancellation explicit

For proxied streaming responses, the Hub will tie the child-facing fetch to an abort controller driven by downstream request abort and response-body cancellation. Cleanup removes listeners and aborts at most once. Normal response completion remains distinct from downstream cancellation and upstream fetch failure.

Relying solely on implicit cancellation of a reused `Response.body` was rejected because it is runtime-dependent and currently lacks an integration contract. Buffering streams was rejected because it breaks SSE and NDJSON latency and increases memory use.

### 6. Diagnose lifecycle outcomes, not request contents

Workspace metrics will count current and cumulative stream opens, closes/cancellations, reconnect successes, and upstream failures by a fixed transport class. Hub diagnostics will use the same fixed classes for proxied stream completion outcomes. Route templates or fixed class names may be recorded; raw URLs, query strings, event data, cookies, authorization headers, and brokered child tokens may not.

Expected disconnects will be counters rather than warning logs to avoid routine mobile sleep producing noise. Unexpected upstream failures may be logged once with their class and status category.

### 7. Verify the complete proxy path with concurrent clients

Unit tests will use controllable EventSource, timers, visibility, and network events. Server tests will verify comment cadence and cleanup. Hub integration tests will hold multiple real proxied streams, cancel one downstream reader, and assert that the matching child subscriber disappears while the other continues receiving events. Browser coverage will exercise page resume and truthful status where deterministic lifecycle simulation is available.

The suite will not depend on a live Tailscale installation. Tailscale Serve uses standard streaming reverse-proxy semantics; exercising the Hub-to-child boundary and browser lifecycle deterministically gives a stable regression test.

## Risks / Trade-offs

- [Lifecycle signals can cause request bursts] -> Coalesce wake-up signals and guard all completions with one connection generation.
- [A 15-second comment creates continuous low-rate traffic] -> The payload is only an SSE comment and is substantially cheaper than recovering expired proxy and mobile paths.
- [Explicit retries may reconnect more aggressively than browser defaults] -> Use exponential backoff with a capped delay and reset it on confirmed success.
- [An `open` Chat stream can fail before replay completes] -> Treat open only as transport recovery; existing cursor-gap and resync handling continues to own projection correctness.
- [Aborting proxy fetches may expose Bun cancellation edge cases] -> Cover downstream cancellation and simultaneous completion with real Hub integration tests and idempotent cleanup.
- [More detailed metrics can create unbounded labels] -> Permit only predefined transport classes and outcome names.

## Migration Plan

Ship the server keepalive, explicit proxy cancellation, and client recovery behavior in one compatible release. Existing clients ignore SSE comments, and updated clients remain compatible with servers that have not yet emitted one during startup. No persisted state or API migration is required.

Rollback is a normal binary rollback. The only wire-level addition is standards-compliant SSE comments that old clients already ignore.
