## 1. Document Stream Liveness

- [x] 1.1 Add 15-second SSE comment keepalives to the document event response, clean up the timer on cancellation and watch-session stop, and verify focused watch-session tests observe keepalives without state events or leaked subscribers.
- [x] 1.2 Replace the document client's native-EventSource retry dependency with an owned capped-backoff reconnect cycle guarded by a connection generation, and verify unit tests cover repeated failures, superseded callbacks, success reset, and page disposal.
- [x] 1.3 Confirm document connectivity only after the current generation's state payload is parsed and applied, and verify connection-state tests keep the indicator reconnecting until authoritative state arrives and return it to connected immediately afterward.

## 2. Page Lifecycle Recovery

- [x] 2.1 Coalesce `pageshow`, transition-to-visible, and `online` indications into one document-state reconciliation that installs a fresh stream and rejects stale completions; verify unit tests cover simultaneous signals and out-of-order fetch/stream completion.
- [x] 2.2 Extend Chat lifecycle handling to reconcile inventory and ensure the selected conversation and inventory streams are current after page or network restoration while preserving presentation state; verify Chat UI tests cover suspended-page recovery without draft, content, or scroll-state loss.

## 3. Chat Recovery Status

- [x] 3.1 Observe successful `open` for conversation and inventory EventSources, reset each stream's consecutive-failure count on open, and verify client tests show an idle successful reconnect starts a later interruption from the first-failure state.
- [x] 3.2 Give Chat connection interruption messaging dedicated ownership so successful stream open clears only stale reconnect messaging, and verify UI tests preserve unrelated provider or turn errors while removing `Chat connection interrupted; reconnecting` without waiting for a Chat event.
- [x] 3.3 Verify Chat SSE comments remain presentation-inert and that cursor replay/resync still owns projection correctness by running the focused Chat client, route, and UI suites.

## 4. Hub Cancellation And Isolation

- [x] 4.1 Tie child-facing streaming fetches to idempotent downstream request/body cancellation without buffering responses, and verify proxy tests cover downstream cancel, upstream completion, fetch failure, and simultaneous cleanup.
- [x] 4.2 Add a real Hub integration test with two concurrent clients that cancels one proxied document stream, verifies its child subscriber is released within a bound, and verifies the other stream continues receiving state.
- [x] 4.3 Extend concurrent-client integration coverage to conversation and inventory streams, verifying one client's interruption and recovery neither closes nor delays the other client's streams.

## 5. Diagnostics

- [x] 5.1 Add fixed-cardinality counters for document and Chat stream opens, active subscriptions, cancellation/completion, reconnect success, and upstream failure, and verify metrics tests assert the expected transitions.
- [x] 5.2 Add Hub proxy lifecycle diagnostics using only fixed transport classes and outcome categories, and verify tests reject raw URLs, query values, payloads, cookies, authorization values, and brokered tokens from diagnostic output.

## 6. End-To-End Verification

- [x] 6.1 Add deterministic browser coverage for a document stream interruption followed by page resume, verifying current sidebar/preview state and the `Reconnecting` to `Connected` transition without reload.
- [x] 6.2 Add deterministic browser coverage for an idle Chat stream reconnect, verifying the interruption message clears on successful open before another application event arrives.
- [x] 6.3 Run `bun test`, the affected Hub integration tests, `bun test:e2e`, and `bun run build`; verify all pass and that the compiled binary preserves document SSE keepalives and proxied cancellation behavior.
