## 1. Establish regressions and observation semantics

- [x] 1.1 Add failing regressions for a catalog limit changing while the usage item is unchanged, a failed read remaining retryable, and an unknown id receiving no invented 200k limit. Verify each failure exercises its identified main-branch defect before changing product code.
- [x] 1.2 Extend promptless real-CLI evidence to capture selection, resolved model, `maxTokens`, `rawMaxTokens`, and any explicit capacity/compaction distinction. Verify no prompt is sent, no transcript is created, and settings are unchanged; record separately whether the original Opus 5.5 incident is reproduced.

## 2. Carry window knowledge through chat state

- [x] 2.1 Define source/freshness metadata and the limit-only `context_window` item, including model/window-variant attribution. Extend strict validation and data-only rendering exclusions. Verify valid values round-trip, malformed values are rejected, and legacy input remains readable in validation and renderer tests.
- [x] 2.2 Retain bounded conversation window observations in the Claude provider and seed them into snapshots without consuming transcript pagination or replacing occupancy. Verify adapter/projection tests cover missed live updates, projection eviction, replay duplicates, and reopen during a running turn.
- [x] 2.3 Implement source precedence and execution-bound matching in the readout. Verify tests cover session over catalog over estimate, fresh reductions as well as increases, cached labels, unchanged occupancy, ambiguous aliases, and staged model changes preserving the preceding usage's denominator.

## 3. Discover from the actual Claude session

- [x] 3.1 Start a bounded summary-window read after a query's configuration is applied and before its first prompt is queued, for new and resumed sessions and authorized model changes. Verify provider tests prove a healthy answer precedes prompt delivery without a paid model call or an unrelated model switch.
- [x] 3.2 Separate startup grace from the read deadline and accept eligible late answers without blocking the stream pump. Verify held-read tests cover prompt delivery after the grace, cancellation, incoming usage during the read, and correction before a terminal result.
- [x] 3.3 Bind startup, catalog, and post-turn observations to query/selection/account epochs and read order. Verify delayed responses after a model switch, query replacement, newer report, or account change cannot overwrite current state, while a fresh smaller limit is accepted.
- [x] 3.4 Normalize explicit window and compaction information using the response's model and verified field semantics. Verify tests preserve reported policy boundaries above their limit and do not invent a hard capacity from an ambiguous report.

## 4. Recover discovery failures and label fallbacks

- [x] 4.1 Replace attempted-row completion with confirmed, pending, retryable, and unsupported states. Add bounded single-flight backoff and fresh-probe recovery after a timed-out switch. Verify deterministic provider tests cover transient failure then success, concurrent reads, retry exhaustion, missing controls, late switches, and disposal cleanup.
- [x] 4.2 Remove the unconditional unknown-model 200k return and attach estimate provenance to known manifest/id-derived limits, including default and "More models" descriptions. Verify model/provider tests cover unknown typed ids, unresolved defaults, known 200k and 1M models, and estimates never overwriting observations.
- [x] 4.3 Add discovery diagnostics through the existing diagnostic mechanism using selected/resolved ids, phase, source, epoch, and failure category. Verify a failed-read fixture yields enough information to distinguish a fallback from a rejected or stale answer without containing prompt text or credentials.

## 5. Deliver and render live corrections

- [x] 5.1 Add coalesced, agent-scoped catalog invalidation to the existing inventory/Hub live transport and refresh banked models through `LatestRefresh`. Verify provider-to-client integration tests cover discovery without user interaction, stale in-flight fetches, agent isolation, and reconnect without another browser stream.
- [x] 5.2 Include effective limit and provenance in the context indicator's paint key and invoke its sync after catalog installation. Implement estimated, cached, and unavailable-limit presentation in the indicator and picker. Verify UI tests cover changed-limit and source-only updates with the same usage object, consistent tooltip/breakdown/warning state, and no redundant repaint on text-only frames.
- [x] 5.3 Add focused Playwright scenarios in the existing chat suites for a running turn crossing a wrong estimate, live correction to 1M without a new usage message, and reconnect recovery. Verify desktop and touch layouts, including unknown-limit text; write screenshots through the existing evidence helper into test results.

## 6. Verify integration and document the final behavior

- [x] 6.1 Update any published Hub live DTOs, revision declarations, contract tests, and generated consumers affected by the new item or invalidation. Verify `bun run api:validate`, the relevant API contract tests, and required generated-consumer checks; document fields that remain internal under the existing contract.
- [x] 6.2 Run `bun run typecheck`, the affected Claude/model/readout/validation/adapter/projection unit tests, and the focused chat Playwright suites. Verify all pass and shared OpenCode context readouts retain their reported limits; run broader required CI checks once integration is complete.
- [x] 6.3 Update the relevant architecture guidance and SDK coverage annotations, rerun the promptless CLI window check, and record the observed behavior and release classification. Verify the final evidence distinguishes demonstrated fixes from the unreproduced original session, and run `openspec validate claude-context-window-truth --strict` with every completed task accurately marked.
