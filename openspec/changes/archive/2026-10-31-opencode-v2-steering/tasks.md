Each slice is written test first: write the named test and watch it fail, implement until it passes, then run the module's test file. The design references (D1–D17) point to design.md.

## PR519 inline-review follow-up — 2026-10-24

This ledger adds acceptance for D14–D17 while preserving historical completed work and verification limitations. Checks require implementation, relevant verification and independent review, unless the user explicitly removes the requirement. The user removed the unperformed real-agent manual pass from delivery acceptance on 2026-10-25.

- [x] R1. Unknown admission: verify adapter, HTTP and rendered-UI local discard with fresh admission-only tokens, exact target/receipt fencing, retained original unknown receipts/native evidence, no provider mutation or replay, and unchanged resume/withdrawal restrictions. Cover stale reads, late acknowledgements and confirmation cancellation. Durable visible feedback passed fresh independent review and all four desktop/touch Chromium/WebKit cases in the green full local run.
- [x] R2. Keep queued: verify discard invalidates pre-existing deferred drains, preserves unrelated drafts/held entries, and leaves explicit Send now and later genuine idle transitions usable. Failed-action status rollback and derived recovery completion must not release kept input.
- [x] R3. Duplicate delivery: reproduce reconciliation replacing the queue during dispatch, then verify exact-object removal from the current queue for automatic delivery and non-steering Send now, preserving FIFO without replay.
- [x] R4. Recovery amplification/starvation: verify three unchanged successful-inconclusive reads per external cycle, real-error backoff, throttled dirty-burst progress, monotonic discovery-budget extensions, reconnect timers and structural/revert/deletion/generation fences. Preserve saturation discovery without reconnect.
- [x] R5. Settlement retention: verify bounded unowned history plus pinned queue/in-flight owners across projection eviction; report the actual `max(2,048, currently owned settled conversations)` bound. R1–R5 implementation verification reached 530 adapter tests; the final fresh independent Sol High review passed 48 focused/adversarial checks without new findings. Full integrated acceptance remains R12.
- [x] R6. Provider event verification/history reuse: verify bounded parentage reuse, concurrency/deadline/cancellation, unrelated event preservation on failed child lookup, fresh dynamic/revert metadata and lifecycle/generation invalidation. Ownership revocation preserves terminal evidence, notice tombstones and recovery-only saturation state. Fresh affected reviews verified current live-worker visibility separately from reverted history, five-second cancellation races, guard cleanup and actual-settlement SDK slots; the full local suite passed.
- [x] R7. Definitive refusals: test actual-SDK-shaped connection refusal and undeclared 403 as not applied, while timeout/disconnect/5xx remain unknown without replay. Focused actual-SDK regressions and independent provider reviews confirmed classification; ongoing Stop-fence work remains R6/R12.
- [x] R8. Background shell/report folding: verify correctly typed output-inspectable placeholders, bounded prelaunch buffering, native-clock/reused-ID uncertainty and superseded upserts; undated old reports must not settle a newer occurrence. Focused implementation checks and fresh independent Sol High review confirmed the corrected cases, including 24 background tests in independent review.
- [x] R9. API31 and Hub integration: align strict schemas, validators, contract, examples and changelog while retaining Hub11/web3. Verify authenticated caller/workspace request-identity isolation, cookie-origin protections and production verified-principal handoff for discard. Actual Hub red/green coverage and independent transport/service reviews passed; the local-only service path does not require runtime startup.
- [x] R10. Browser evidence: verify real-adapter discard on desktop/touch Chromium and WebKit, approved readable warning, keyboard/focus/touch behavior, draft preservation, kept queue and no native writes. All four full-run cases passed. Seven committed-source capture cases produced 19 current images from `3cf4b69`; independent privacy review and user approval preceded publication as PR attachments, with anonymous downloads verified against every image hash. No generated PNGs are tracked.
- [x] R11. Documentation/spec alignment: reconcile approved proposal/design/delta/tasks, canonical chat requirements, `docs/CHAT.md` and affected architecture notes; preserve historical evidence and manual-verification limitations. Fresh independent reviews confirmed the per-target control policy, live-worker versus reverted-history distinction, read-recovery editing and Rename readiness. Strict canonical/change/API validations passed. Existing already-synced archive collision and unrelated OpenAPI lint warning remain disclosed; no archive was attempted.
- [x] R12. Integrated delivery: freeze the combined diff, run appropriate focused/cross-module/full checks without weakening limits, obtain fresh independent Sol High reviews, review publication safety, then commit/push normally. Implementation `3cf4b69` passed full local checks before its normal push; CI run `40203317503` and CodeQL passed. The complete PR body, 19 images/captions and finding-by-finding response were shown in chat and approved before publication. Readback preserved title/ready status and verified approved text and all attachment hashes. Native/manual, physical-device and speech checks remain unverified; no merge or deployment occurred.
- [x] R13. Bounded per-target control proof (D17): verify retained healthy targets remain stoppable after projection saturation and read-only recovery without reconnect; missing/revoked/overflowed targets are uncertain with Stop withheld consistently in live/history/reconciliation. Check exact 1 MiB/2,048-entry control and 4 MiB/8,192-entry aggregate accounting, target-isolated overflow/stubs, revocation through progress/stale reads/reconnect, provider-lifetime limits and no silent readmission. Cold/pre-Stop/replay safety matrices and meaningful assertions were preserved; fresh independent Spec and Standards/bounds reviews and full local verification passed.

## PR519 second-review follow-up — 2026-10-25

The user approved these scoped acceptance clarifications and implementation. Earlier completed tasks remain historical evidence, not acceptance of the newly reported regressions. Deferred follow-ups are [#552](https://github.com/tjakobsson/uatu/issues/552) (shared lookup lifetime/batch cleanup), [#551](https://github.com/tjakobsson/uatu/issues/551) (never-settling admission retirement), and [#550](https://github.com/tjakobsson/uatu/issues/550) (failed interaction-read policy). The removed real-agent manual gate remains removed.

- [x] R14. Reconnect controls: admit genuinely new agent/shell occurrences only with positive post-gap native birth and matching invocation proof; preserve old revocations, replay refusal, in-flight fences, capacity closure and all evidence accounting. Verify through the real provider/fake transport and obtain fresh independent review.
- [x] R15. User-shell retention: separate typed user-command shell notes from background-worker reports, bound unpublished prelaunch payload, preserve command rendering, real notification-before-launch correlation and reused-ID safety. Verify both large-output and many-note pressure without closing unrelated worker controls; independently review bounds and proof preservation.
- [x] R16. Truthful pending state: mark the held suffix actually blocked by an unconfirmed admission as paused in snapshots and live updates, with truthful wording. Preserve the non-blocking pending-map case and avoid a new public reason field.
- [x] R17. Cross-cycle recovery: retain bounded parked exhaustion state; unrelated events cannot restart it within 30 seconds, and quiet sessions do not poll. Preserve immediate genuinely new worker evidence/refresh/reconnect recovery, independent-result progress, error backoff and lifecycle cleanup; verify deterministic active-session read bounds.
- [x] R18. Explicit Queue after discard: a newly accepted user submission resumes FIFO only after validation/admission. Rejected submissions, cached retries, discard itself, stale drains, failed-action rollback and derived recovery completion cannot release the barrier. Align confirmation/guide wording and test Stop → Discard → Queue without replay.
- [x] R19. Route documentation: move the Send now comment to its handler and describe discard as local-record removal with no native cancellation or resend. Lead byte-preservation checks and fresh independent affected review confirmed that only the two comments changed.
- [x] R20. Integrated second-review delivery: obtain fresh independent affected reviews, run the full local suites with unchanged limits before push, verify publication safety and normally commit/push. Refresh affected current screenshot evidence from committed source. Present any proposed PR-body/comment updates for approval before publishing; report actual CI and unchanged native/device/speech limitations.
- [x] R21. Confirmation ownership: retain dialog ownership through close completion so canceled invocations cannot inherit later consent and stale close events cannot settle a new owner. Preserve caller token/eligibility/in-flight guards, Cancel-first focus, invoker restoration and native keyboard/touch behavior. Add rendered-UI/action and native-input/HTTP regressions; obtain fresh independent review. The user explicitly requested focused verification only for this follow-up, not another full-suite run.

Fresh independent Sol High reviews and the full local gate passed on 2026-10-26: 7,155 unit tests (16 skipped), 211 API tests, 60 strict specification items, and 1,384 browser/performance cases (three opt-in documentation captures skipped), including all 23 performance cases. Normal worker limits, budgets and zero retries were preserved; the browser utility used an explicitly approved temporary display/idle-sleep assertion. Two approved test-only corrections correlate the actual steering request's receipt and reap the clone fixture's child before parent exit; production Hub and provider ownership loading remain unchanged in this round. Historical frame, script-parse, row-count and descendant-PID failures were not all causally established. Current live-native emission/order, physical-device and screen-reader speech acceptance remain unverified. At that checkpoint, R20 remained open for committed-source capture and approved publication.

The full-gate evidence above belongs to implementation `8d621b1`. R21 is a separately authorized follow-up: its focused results must be reported independently rather than presented as a full-green result for the later source.

R21 focused acceptance: 28 rendered-UI cases (275 assertions) and eight native-input/HTTP browser cases passed across desktop/touch Chromium and WebKit, with four workers, 30-second test timeouts and zero retries. Fresh independent Sol High review found no blocking issues and independently reran all 28 UI cases. Final-tree typecheck and diff checks passed; the mechanical UI scan reported no findings. No full suite ran for this follow-up. Controlled old-close redispatch is untrusted and does not establish the earlier capture timeout's cause. The throwing `showModal()` cleanup path was inspected, not directly fault-injected; replaced-DOM/focus-reentry cases use rendered-UI stubs. Live-native, physical-device and screen-reader speech acceptance remain unverified.

R20 publication closure: eight focused Chromium capture cases passed at `0615913` with one worker, existing budgets and zero retries. Fresh independent Sol High text and image/privacy reviews preceded user approval of the complete PR body, 19 images and captions. Publication uploaded 17 images and reused two byte-identical attachments; GitHub readback matched the approved text, and all 19 anonymous PNG downloads matched the reviewed source bytes. The screenshot index records that committed source; PNGs remain untracked. The latest inspected CI at `0615913` had a unit failure in `exhaustedRecoveryFixture` (`src/chat/adapter.test.ts:4964`, expected three reads, received two), with one browser leg still in progress; the cause remains unproven. This closes delivery/publication tracking, not CI or merge acceptance. No merge or deployment occurred.

## Approved review-round-4 intent revision — 2026-10-22

The user chose fixed Steer, removing the configurable-default requirement.
Historical 6.1/9.1 preference tasks below record earlier work, not current
acceptance. Desktop Enter and touch Ctrl/Command+Enter now steer; Alt/Option+Enter
queues where offered. Legacy saved Queue is ignored, not deleted. Touch newline,
tap/hold timing, mandatory command/attachment queueing and explicit HTTP/dock
delivery remain unchanged. Implementation and verification are tracked in the
successor `compact-chat-background-steering/tasks.md` review-round-4 ledger.

The completed tasks below retain historical implementation evidence. The later authoritative UX audit revises per-entry paused Send now to one dock batch action, named Undo warnings to counts, and responsive/menu presentation. Its additive criteria and verification live in `ux-audit-tasks.md`; current behavior is in the updated design and delta specs.

## Mobile UX parity and independent-review closure — 2026-10-16

- [x] Keep desktop submission keys and delivery semantics; make touch Enter a newline idle/busy, with explicit Send or Ctrl/Command+Enter and accurate menu hints. Retain cancellation/command/queue assertions.
- [x] Bound short-desktop queues by actual panel height; share touch track budgets (35%, tablet 25%, hardware editing 24%) and retain safe-area padding. Compact keyboard/short-landscape layouts preserve submission targets, pending counts, paused-batch Send and replacement warnings while hiding routine chrome/worker tracks.
- [x] Reproduce the animated dock bottom-pin race, then reserve final layout height before the reduced-motion-aware reveal. Retain remote reading anchors and deliberate send-to-latest behavior; do not relax positioning assertions.
- [x] Complete ordered clean CI, four-file browser acceptance, type/build and strict validation; reconcile the independent review and actual screenshots. Evidence and physical-device gaps are recorded in `ux-audit-tasks.md` below its historical checkpoints.

Latest implementation acceptance: **5,183 pass / 17 skip / 0 fail** in documented clean-tool CI; **139 browser pass** across steering, queue, background and mobile layout suites; typecheck/build pass. Lead-confirmed independent Sol High re-review closes both mobile P2s and reports **244 focused unit passes**; its fresh browser evidence verifies actual-panel budgeting, hardware transcript space, keyboard/pan geometry and twelve zero-distance pin cycles. This does not claim real-device or assistive-technology acceptance. All test artifacts remain outside OpenSpec; no product edits or publication accompany this parity update.

## 1. Wire contract and capabilities

- [x] 1.1 Add tests in `src/chat/validation.test.ts`:
  - `QueuedMessage` with `delivery` (`steer`/`queue`, required) and optional `paused: true` is accepted, and an unknown key is still rejected;
  - `conversation.queue` accepts the change kinds `steered`, `switched`, `paused`, and `resumed`, and still rejects an unknown kind.

  Then extend `src/chat/types.ts` (`QueuedMessage`, the `conversation.queue` change kinds) and `parseQueuedMessages` and the queue-event case in `src/chat/validation.ts` until the tests pass.
- [x] 1.2 Add `"steering"` and `"send-now"` to `ChatCapability` (`src/chat/types.ts`) with comments. Add tests asserting the provider descriptors:
  - 2.x declares both (`v2/provider.test.ts`);
  - Claude declares `send-now` only (`claude/provider.test.ts`);
  - 1.x declares neither (`v1/provider.test.ts`).

  Implement the descriptor changes until the tests pass.
- [x] 1.3 Bump `WORKSPACE_API_REVISION` from 24 to 25 in `src/shared/version.ts`. Verify that `bun test src/shared/api-revisions.test.ts` passes.
- [x] 1.4 In `api/openapi.yaml`, add `delivery` (required, `steer`/`queue`) and `paused` to the `QueuedMessage` schema, and add the change kinds `steered`, `switched`, `paused`, and `resumed` to the `conversation.queue` event schema. Verify that `bun test scripts/api-contract` passes.
- [x] 1.5 Add a "Hub 11 / Workspace 25 - Unreleased" entry to the top of `api/CHANGELOG.md`, marked breaking (workspace). List the `QueuedMessage` and queue-event changes, and add migration guidance for strict live-payload consumers. Verify that the compatibility check in `bun test scripts/api-contract` accepts the breaking diff with the revision bump and changelog entry.

## 2. OpenCode 2.x inbox normalization

- [x] 2.1 Add tests in `src/chat/opencode/v2/normalization.test.ts`:
  - `session.inbox.enqueued` (type `user`) yields a pending-inbox delta (id, text, attachments, delivery, time) and **no** `user_message` upsert;
  - `synthetic`, `compaction`, and `move` entries yield no pending delta, and synthetic keeps its current timeline behavior;
  - `delivered` yields a settled delta plus the remembered `user_message` upsert, with the same `message:<id>` id and `requestId` and the delivery time as `createdAt`;
  - `cancelled` yields a settled(cancelled) delta and no timeline item;
  - `delivery.changed` yields a delivery delta.

  Implement the new provider update kind and the memory keyed by inbox id. Remove the events from `IGNORED` until the tests pass.
- [x] 2.2 Add a test in `v2/provider.test.ts`: a `/command` still converges on the inbox id the server minted, both inside the admission window and as a late admission, now that `enqueued` carries no timeline row. Re-key `reportEnqueuedUser` to the pending delta (D4) until this test and the existing command tests pass.
- [x] 2.3 Add tests in `v2/provider.test.ts` against the scripted `fetch` stub:
  - `prompt(delivery: "steer")` sends `delivery: "steer", resume: true` and does **not** call `switchModel` or `switchAgent`;
  - a queue-delivered prompt still applies its model and mode first;
  - `interrupt(id, { resume: false | true })` passes `resume` through;
  - `listPendingInbox(id)` maps `session.inbox.list` to pending user steers only;
  - `cancelInbox(id, inboxId)` calls `session.inbox.cancel`.

  Widen the seam in `src/chat/provider.ts` (`prompt` delivery `"steer" | "queue"`, `interrupt` options, optional inbox operations) and implement these in the 2.x provider until the tests pass. Verify the 1.x and Claude provider tests still pass unchanged.

## 3. Adapter: pending steers and admission

- [x] 3.1 Add tests in `src/chat/adapter.test.ts`, with a fake provider declaring `steering`:
  - a busy prompt with `delivery: "steer"` reaches `provider.prompt` as a steer and is published as `steered`, listed before held messages;
  - a busy steer-delivery command, skill, or `/reload` is held;
  - a busy steer to an agent without `steering` is held;
  - an omitted delivery is held.

  Implement the D6 decision table and the pending-steer map until the tests pass.
- [x] 3.2 Add tests: pending deltas from the provider update the map and publish queue events; a settled(delivered) steer leaves the dock with `delivered`. Snapshot `queued` lists steers first, then held messages, each with its `delivery`. Attach and reconnect replace the map from `listPendingInbox`. Implement until the tests pass.
- [x] 3.3 Add tests for the bound: steers and held messages count together against 20 messages and 256 KiB, a steer raised by another client counts, and an over-bound submission throws `ChatQueueFullError` with the dock unchanged. Implement until the tests pass.
- [x] 3.4 Add tests for the paused state:
  - a steer enqueued before the latest idle, interrupted, or completed transition reads `paused: true` in the snapshot and publishes `paused`;
  - a new steer, or a wake, publishes `resumed`;
  - held messages read `paused` while `deliveryPaused()` is true.

  Implement the derivation (D3) until the tests pass.
- [x] 3.5 Add tests for cancel: `abort` calls `interrupt(id, { resume: false })`, held messages go dormant as today, pending steers stay pending and paused, and nothing is delivered. Implement until the tests pass.
- [x] 3.6 Add tests for undo on a steering agent: the replacement under a staged revert goes out as a steer with `resume: true`, held messages stay held, paused steers are delivered with it oldest first, and on a non-steering agent the path is unchanged. Implement until the tests pass.

## 4. Adapter: per-entry operations

- [x] 4.1 Add tests for withdrawing a steer (remove, edit, or switch to queue):
  - `inbox.cancel` followed by a `cancelled` delta removes the steer, or holds it at its submission-order position with the session's current configuration frozen;
  - a `delivered` delta arriving first throws `SteerAlreadyDeliveredError` and leaves nothing held and no second delivery;
  - with no event before the bounded wait, the outcome is decided from `listPendingInbox` and history;
  - retries with the same request id apply once.

  Implement D7 in the admission lane until the tests pass.
- [x] 4.2 Add tests for switching a held message to steer, or Send now on a steering agent: the message leaves `heldQueues` (`switched`) and goes to `provider.prompt` as a steer with its attachments, and a dormant queue stays dormant for the other entries. Send now on a paused steer calls `interrupt(id, { resume: true })`. Commands are refused a switch to steer. Implement until the tests pass.
- [x] 4.3 Add tests for Send now on a `send-now` agent without `steering` (Claude-shaped fake): it is refused while a turn is active. When dormant or idle, it dispatches that message under its frozen configuration ahead of the others, publishes `delivered`, and leaves the rest held in order. An agent without `send-now` refuses it. Implement until the tests pass.

## 5. Service, routes, and client API

- [x] 5.1 Add tests in `src/server/chat-routes.test.ts`:
  - the prompt route accepts and validates `delivery`;
  - `PATCH …/queue/:messageId {requestId, delivery}` and `POST …/queue/:messageId/send-now {requestId}` are origin-protected and idempotent, and map `SteerAlreadyDeliveredError` to 409 with a distinct code and unsupported operations to their refusal;
  - `DELETE` withdraws a steer.

  Add the operations to `WorkspaceChatService` (`src/chat/service.ts`), register the routes once in `src/server/routes.ts`, classify them as internal exclusions in the contract coverage, and add the calls to `src/chat/client.ts` until the tests pass. Verify that the contract route-coverage check passes. If the changelog entry from 1.5 lists routes, add the new internal routes there.

## 6. Composer and dock UI

- [x] 6.1 Add unit tests for a delivery-preference helper: it is stored per device in `presentationLocalStorage()`, defaults to `steer`, and unknown values fall back to `steer`. Implement until the tests pass.
- [x] 6.2 Add `QueueDockRenderer` tests in `src/chat/timeline-renderer.test.ts`:
  - steers render before queued entries with "Steer" and "Queue" labels and a paused note;
  - the model note shows only while a steer is pending;
  - actions depend on capability and state: Remove and Edit always; Steer or Send now on queued entries; Queue on steers; "Send now (all paused steers)" on paused steers; no Steer action on commands.

  Implement until the tests pass.
- [x] 6.3 Wire the composer in `src/chat/ui.ts`:
  - Enter and ⌥Enter choose the delivery while a `steering` conversation is busy;
   - the original inside-footprint menu is superseded by the approved separate delivery/Send/Stop controls in section 9 (`src/index.html`, `src/styles.css`);
  - dock actions call the new client operations;
  - Edit loads the composer only after a successful withdrawal;
  - a 409 already-delivered answer shows "Too late — already delivered";
  - when Undo succeeds while steers are pending, the undo confirmation names those steers and says they go out with the replacement.

  Verify with the e2e tasks in section 7 and the existing composer rail-stability e2e test.

## 7. End-to-end harness and scenarios

- [x] 7.1 Build `tests/e2e/opencode-v2-fake.ts`: a scripted fake OpenCode 2.0.28 HTTP and SSE server implementing the routes the 2.x provider calls, including the inbox list and cancel, prompt with delivery and resume, and interrupt with resume. It is controlled through `/__e2e/chat`. Register it in `tests/e2e/server.ts` as an agent served by the real `ChatAdapter` and `OpenCodeV2Provider` (D13). Verify with a smoke test: a conversation is created, a prompt answers, and history reloads.
- [x] 7.2 Add `tests/e2e/chat-steering.e2e.ts` against the fake with these scenarios:
  - Enter steers and the steer delivers at a scripted step boundary, entering the timeline only then;
  - ⌥Enter queues;
  - switch queued → steer, and steer → queue;
  - remove and edit a steer;
  - the too-late race shows the notice and one timeline row;
  - cancel pauses steers;
  - Send now wakes the paused steers;
  - commands always queue;
  - reload keeps the dock;
  - the menu on a touch viewport.

  Capture screenshots through `tests/e2e/evidence.ts`. Verify that `bun run test:e2e -- chat-steering` passes.
- [x] 7.3 Extend `FakeE2EChatService` with `send-now`, and add a Claude Send now scenario to `tests/e2e/chat-queue.e2e.ts`: cancel leaves the queue dormant, Send now delivers the chosen message, and the others stay held. Verify that a running Claude conversation shows no Send now and no steer choice. Verify that the whole `chat-queue` suite passes.

## 8. Coverage, docs, and final verification

- [x] 8.1 Update `src/chat/opencode/sdk-coverage.ts` (D12) and run `bun run coverage:agents`. Verify that the report lists the inbox events and operations as mapped, with `session.inbox.update` as deliberately unused.
- [x] 8.2 Update `ARCHITECTURE.md` where it describes the chat queue (steer ownership, dock), and the `src/chat/` entry in `CLAUDE.md` if the module map changes. Verify by review.
- [x] 8.3 Run `bun run test:ci`, `bun run test:e2e`, and `bun run build`. All must pass.

  Latest verification (2026-10-25): the frozen combined review corrections
  passed 7,066 unit tests (16 skipped), 1,375 full browser/performance tests
  (three opt-in documentation captures skipped), all 23 performance cases,
  211 API tests, 60 strict OpenSpec items, typecheck, audit, 597-package
  license checks, build and exact-binary smoke. No retries or test-setting
  changes. All 54 source/test/documentation hashes remained unchanged.
  Earlier intermittent login, scroll and timeout failures are not claimed
  causally fixed by this green run. Live native-service, physical-device and
  screen-reader speech acceptance remain unverified. Evidence is retained in
  the task-owned `integration-checks/phase1-rename-final-20261025T140903Z` and
  `integration-checks/final-browser-rename-final-20261025T141658Z` runs.

  Historical verification (2026-10-15 continuation): installed the project's
  approved WebKit 26.6 (Playwright build 2359). Clean-tool-environment full
  CI passed: 5088 passed, 16 skipped, 0 failed across 285 files. Build,
  typecheck, and strict OpenSpec validation passed. Full E2E completed with
  941 passed, 4 failed, and 6 not run (the serial inventory suite stopped
  after its failure). All steering, OpenCode fake-stack, and queue scenarios
  passed in that run, including WebKit performance scenarios elsewhere.
  The four failures were remote conversation creation, variant-without-model
  validation (401 instead of 400), lazy chat startup (one status call instead
  of zero), and desktop worktree live-inventory message count. Repeating
  those tests three times (including the worktree touch counterpart) passed
  14/15; variant validation again received 401 once. Authentication behavior
  and test assertions were not weakened or changed. A subsequent complete
  inventory-file recheck passed 17/17, including the six previously not run.
  This was not a passing
  full E2E run, so the task remained open at that checkpoint. Logs in the approved temporary
  `opencode/` directory: `steering-continuation-ci.log`,
  `steering-continuation-e2e.log`, `steering-continuation-rechecks.log`, and
  `steering-continuation-build.log`; the inventory recheck is recorded in
  `steering-continuation-inventory.log`.

  Earlier verification (2026-10-15): the final steering/queue/panel browser selection
  passed 49/49, including Undo and rail stability; build and typecheck passed.
  The clean-tool-environment full CI run had 5087 passed, 16 skipped, and one
  native file-observer deletion timeout (its isolated file recheck passed
  14/14). Full E2E had 876 passed and 75 failed: 72 lacked the installed
  WebKit executable; the other three (AsciiDoc nested TOC, chat lazy startup,
  and document-tree Follow navigation) passed an isolated six-test recheck.
  These rechecks did not constitute a passing full run or close this task.
  Logs: `steering-targeted-conclusive.log`, `steering-test-ci-clean.log`,
  `steering-full-e2e.log`, `steering-file-observer-recheck.log`, and
  `steering-e2e-failure-recheck.log` in the session's approved temporary
  `opencode/` directory. No browser installation was attempted.
### Historical manual verification — not a delivery requirement

The user removed former task 8.4 on 2026-10-25. No manual pass was performed;
this removal does not claim real-agent acceptance. The former scope was a pass
against OpenCode 2.0.29 (`bun run dev`; target approved 2026-10-15):
  - steer mid-turn;
  - steer → queue before the boundary;
  - the already-delivered race;
  - cancel, then Send now;
  - undo with a pending steer.

  Target update (2026-10-15): the installed `opencode --version` reports
  `opencode v2.0.29`, now the approved real manual target. The SDK and fake
  server remain pinned to 2.0.28. No alternative binary was installed, and
  scripted fake-server checks do not satisfy this manual pass.

  Manual verification blocker (2026-10-15 continuation): `bun run dev
  --no-open` started the real dev hub and registered `watch-docs`, but the
  interactive browser tool could not navigate because its separate
  `chrome-for-testing` executable (`chromium-1246`) is missing. Only the
  project's WebKit installation was approved and installed; no additional
  browser was installed. The dev hub was stopped. None of the five real
  manual scenarios above was exercised. This remains a verification limitation,
  not an open delivery task.
  Startup evidence: `steering-continuation-dev.log` in the approved temporary
  `opencode/` directory; browser navigation returned the missing-executable
  error directly.

## 9. Approved composer safety and discoverability revision (2026-10-15)

- [x] 9.1 Test first and implement persistent visible Send, selection-only Steer/Queue, and separate Stop. Preserve idle submission, Enter/Option+Enter, attachments, draft recovery, prior dock fixes, and non-steering busy enqueue. Keep capability gating and device preference.
- [x] 9.2 Verify desktop and installed Chromium/WebKit touch browsers: 44px targets, 8px gaps, no mutation from selection or gap taps, explicit Send/Stop actions, focus/keyboard behavior, and stable geometry at 320px/390px and desktop widths. Adapt existing cancellation and rail tests without dropping their behavioral coverage.
- [x] 9.3 Update proposal/design/delta specs and architecture; run focused unit and browser regressions, typecheck, build, and strict OpenSpec validation. Record results without closing outstanding full-suite or real-agent verification tasks.
- [x] 9.4 Refresh only the approved parallel hub on 4703 and its workspace child after ownership/configuration checks; preserve auth/state/Tailscale routes and verify the served bundle locally and through 8443. No paid prompts.

  Verification: the first new behavior test failed on the missing Stop control
  (`send-stop-red.log`) before implementation, then passed. Touch gap tests
  exposed native tap retargeting onto Send; raw-touch bounds checking fixed
  that behavior in both installed Chromium 1243 and WebKit 2359. The final
  affected browser selection passed 196/197 tests. The sole failure was the
  previously recorded lazy-chat-startup assertion (`statusCalls` 1 instead
  of 0), also failing an isolated recheck; its assertion remains unchanged.
  All steering, queue, touch, panel, history, attachment, inventory,
  OpenCode-v2 and Claude-polish scenarios passed. Focused unit tests passed
  505/505 across seven files. Typecheck, build, strict OpenSpec validation,
  and `git diff --check` passed. Build emitted the existing unsupported
  `highlight` selector warnings. This was not a full-suite or real-agent pass.
  Evidence in the approved temporary `opencode/` directory:
  `send-stop-e2e-final.log`, `send-stop-unit.log`, `send-stop-typecheck.log`,
  `send-stop-build.log`, and `send-stop-screenshots/` (desktop plus 320px/390px
  Chromium/WebKit captures).

  Initial refresh blocker (resolved below): preflight verified the isolated hub, its sole registered
  workspace, and a completed conversation with zero pending messages.
  Graceful SIGTERM stopped the workspace child and listener, but the hub
  reported failed workspace-session cleanup and retained its state-root
  lease. The restart script stopped rather than sending a forced second
  signal. The deployed binary remained unchanged, with a backup retained;
  the new build remained in `dist/uatu`. The parallel service was unavailable
  pending bounded recovery; production processes were not signalled.
  See `send-stop-restart.log`.

  Recovery completed after lead confirmation: revalidated the exact retained
  hub PID, no remaining children or workspace process, and no listener before
  sending its documented second SIGTERM. Preserved the original environment
  only in memory and restarted the same config/state with the verified build.
  New isolated hub PID 79094 and workspace child PID 80113 are running. The
  authenticated workspace-start API returned 200. Authenticated hub state,
  workspace shell, JavaScript, and CSS returned 200 both locally on 4703 and
  through the existing tailnet 8443 route. Both endpoints serve identical
  JS/CSS hashes with separate Send/Stop, the delivery selector, touch-gap
  guard, responsive large targets, and the prior replacement-warning fix.
  Config, auth-session and registry file hashes and all Tailscale routes
  remained unchanged. Production hub PID 17245 was untouched. No prompts
  were submitted. Logs: `send-stop-recovery.log` and
  `send-stop-hub-verify.log` in the approved temporary `opencode/` directory.

- [x] 9.5 Close the independently reviewed cancellation-lock bypass at the shared submit handler. First reproduce delayed-cancel Enter and Alt+Enter submissions; verify both preserve the draft, send no prompt, and cannot leak an Alt override into the next submission. Run focused regressions, typecheck/build, then safely refresh only the isolated hub/workspace and verify its new served assets.

  Both new tests first failed with the draft cleared during a held cancellation
  request, then passed with the shared cancellation guard and synchronous
  one-shot override consumption. Focused steering/queue/attachment/history
  browser suites passed 59/59, including Chromium/WebKit touch; unit checks
  passed 505/505. Typecheck, build, strict spec validation and diff checks
  passed. This does not replace the outstanding full-suite/real-agent checks.
  After confirming no active or pending work, the supported workspace-stop
  API returned 200 and the isolated hub restarted gracefully without a forced
  signal. Current hub PID 98776 and workspace child PID 98876 serve identical
  corrected JS hashes locally on 4703 and through tailnet 8443; authenticated
  shell/assets/state checks returned 200. Served code includes the shared
  cancellation guard and consumes the override before that guard. Config,
  auth-session and registry hashes and Tailscale routes remained unchanged;
  production PID 17245 was untouched and no real agent prompts were sent.
  Logs in the approved temporary `opencode/` directory:
  `cancel-lock-red.log`, `cancel-lock-green.log`, `cancel-lock-e2e.log`,
  `cancel-lock-unit.log`, `cancel-lock-typecheck.log`, `cancel-lock-build.log`,
  `cancel-lock-stop.log`, `cancel-lock-restart.log`, and
  `cancel-lock-hub-verify.log`.
