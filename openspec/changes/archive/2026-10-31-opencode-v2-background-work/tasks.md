## 1. Preserve the integration baseline and pin the contract

The later authoritative UX audit is tracked additively in `../opencode-v2-steering/ux-audit-tasks.md`. It tightens visible-blocker gating, control presentation, confirmation and settlement feedback without replacing the historical evidence below.

- [x] 1.1 Before implementation, record dirty paths/content hashes and the current `opencode-v2-steering` status; confirm this change is applied on top of its retained work, not by resetting it. Verify no existing completed task or UX test is removed, and record the actual API revision for coordinated increment.
- [x] 1.2 Add source-shaped V2.0.29 background fixtures under `tests/fixtures/opencode-v2/` with provenance to design evidence 3 and the installed 2.0.28 client contract. Cover native launch/progress/success, converted foreground call, child execution terminal, pending/delivered/stored synthetic result, shell metadata, and background 204. Verify fixtures contain no credentials/private prompts and no fabricated job endpoint or generation field.
- [x] 1.3 Write failing contract/normalization tests for completed launcher plus running child and completed/error/cancelled worker results before implementing the fold. Verify these fail for the current false-finished/raw-notice behavior, using `bun test src/chat/opencode/v2/normalization.test.ts src/chat/tool-detail.test.ts` and recording the red result.

## 2. Build the V2 worker projection at the existing provider seam

- [x] 2.1 Implement the shared live/history V2 worker fold described in D1–D2 after its failing tests. Verify a successful launcher stays successful, an independent running task appears, metadata-authenticated results map to completed/failed/stopped, and launch instructions are never the final report.
- [x] 2.2 Add failing identity/order tests, then implement occurrence-aware correlation: notification before launch, duplicate enqueue/delivery/history, repeated child continuations, overlapping calls sharing one worker, stale progress after terminal, and ambiguous repeated-child notification. Verify one live worker count, retained per-task launcher rows, stable result identity, and uncertainty rather than settling the wrong occurrence.
- [x] 2.3 Add failing safety tests, then restrict completion classification to structured provider-authored metadata with valid identity/state and verified parent linkage. Verify human envelope lookalikes, malformed metadata, unknown states, HTML/script/unsafe URLs, and foreign child references cannot create unsafe output or mutate task state; existing unknown-event diagnostics still count only event types.
- [x] 2.4 Add failing complete-history pagination tests, then apply the fold before V2 history slicing. Verify a launch and result on different pages converge, live tasks remain in the first snapshot, old result bodies are not duplicated, and existing model/usage attribution and V1 foreground extraction pass unchanged.
- [x] 2.5 Add failing shell fixtures, then normalize native background shell launches/results through the same task seam. Verify a converted foreground shell with no `input.background:true` is tracked, nonzero exit/signal/timeout is not shown as success, and ordinary user-shell/foreground transcript notes do not become duplicate background tasks.

## 3. Reconcile lifecycle and workspace activity without false terminal states

- [x] 3.1 Add failing provider tests for scoped reconciliation, then implement `reconcileBackgroundTasks(sessionId)` from complete history, all pending inbox entries, verified child sessions/current active evidence, and owned shell records. Verify the installed client 2.0.28 calls only real V2 methods; no missing-active or failed-read case produces an invented completed/stopped outcome.
- [x] 3.2 Add failing adapter snapshot tests, then integrate evidence-bearing V2 reconciliation without applying the old missing-live-list-means-stopped rule to V2. Verify an idle parent, projection eviction, a pending synthetic notification, and an out-of-page launcher all retain correct worker state; Claude's existing authoritative live-list behavior remains passing.
- [x] 3.3 Add failing provider-disconnect and stale-read race tests, then establish connected-before-read buffering/generation fences and reconcile on provider reconnect. Verify terminal-during-snapshot wins, failed reads retain marked last-known state, retry clears uncertainty, and a new stream generation neither loses nor duplicates a worker. Test retained Uatu cursor replay and expired-cursor fresh-snapshot recovery separately.
- [x] 3.4 Add failing cold-inventory/unselected-parent tests, then recover candidate background parents for an already initialized adapter and update `backgroundWork`/activity coherently. Verify work launched outside Uatu becomes visible, parent completion alone never marks workspace finished, request needs-answer priority survives, and `ChatService.activity()` still starts no runtime.
- [x] 3.5 Add request-count tests before bounded recovery scheduling. Verify at most one in-flight read per parent, bounded concurrent parents, failure backoff, cache reuse, no history reread per child text delta, and disposal cancels pending recovery without starting or stopping provider work.
- [x] 3.6 Add failing notification tests, then ensure native child results and hydration never become successful top-level-turn push events. Verify one in-app result, provider-owned parent resume remains visible, no synthetic/resume mutation is emitted by recovery, and an actual later completed parent turn retains normal notification behavior.

## 4. Add explicit background-all and scoped stop operations

- [x] 4.1 Write failing provider method tests, then add `backgroundBlockingWork(parentId)` using `session.background` and the positive `background-blocking-work` capability. Verify exact parent-scoped request with no type/child filter, accepted empty no-op, provider errors, and zero prompt/interrupt/inbox mutations. Declare `background-tasks` only alongside implemented lifecycle/recovery/stop support.
- [x] 4.2 Add failing adapter/service/agent-dispatch/route/client tests, then expose receipt-keyed `POST /api/chat/conversations/:id/background {requestId}` with `{accepted:true}` for known acceptance. Implement D4's internal retained unknown result and external `operation_outcome_unknown`/409 rather than letting ambiguous dispatched calls reject through the receipt helper. Verify auth, origin, confinement, base paths, capabilities and input validation; separately test browser-response loss and upstream application followed by response loss/SDK rejection, with newer blockers and exactly one native call while the receipt remains retained.
- [x] 4.3 Add failing ordering tests, then serialize background-all with existing parent admission/abort operations. Verify both background-before-stop and stop-before-background outcomes, retained draft/attachment/configuration/delivery state, no automatic background on Send/Alt+Enter, and no direct queue flush or pause by the background action.
- [x] 4.4 Write failing child-stop tests, then implement V2 `stopTask(parent, taskId)` resolving verified current occurrence to `session.interrupt(child, resume:false)`. Verify only the selected child is called, siblings/parent are untouched, known superseded or foreign targets are refused, and duplicates/ambiguous upstream failures are deduplicated only while their accepted/unknown receipt is retained. Verify delayed acknowledgement never optimistically overwrites a confirmed completed result; record the upstream absence of atomic generation-conditional interruption.
- [x] 4.5 Add failing shell ownership/output/removal tests, then implement V2 task output and shell stop through `shell.output`/`shell.remove`. Verify workspace/parent ownership and no arbitrary paths; record/output deletion and failed waiter; removal-before-exit, exit-before-removal-but-capture-pending, completed-capture-before-removal, and already-missing 204. Assert missing capture produces the source-shaped error notification and truthful failed/output-unavailable UI, not forced cancelled; retain confirmed completed reports and locally available output only within existing retention. Test upstream-response loss with a retained unknown receipt and no duplicate removal while retained.
- [x] 4.6 Add failing mixed-stop tests, then retain parent abort semantics with `resume:false`: still-blocking foreground work follows native cancellation, detached children remain live, pending steers stay paused and held queue stays dormant. Verify a later native completion may wake the parent without a Uatu resume call, and API failure leaves actionable state rather than a fictitious stop.
- [x] 4.7 Add failing bounded-receipt tests for background and V2 worker-stop operations using the receipt clock/capacity seams, then verify retained accepted/unknown outcomes, up-to-15-minute settled TTL, early count/byte eviction, and fresh-adapter loss. Verify rejection before dispatch does not falsely claim application, the UI never automatically replays unknown operations on reconnect/reload, and old IDs beyond retention have no at-most-once guarantee. Add no persistent storage and preserve unrelated operations' existing error policy.

## 5. Present one consistent worker state with accessible controls

- [x] 5.1 Add failing renderer/helper tests, then extend `subagentEntries`, `background-tasks.ts`, `tool-detail.ts`, and settled task rendering to correlate terminal as well as running outcomes. Verify launch success plus worker failure reads failed, one canonical result body is reachable from each correlated surface, shared worker counts are deduplicated, and existing one-row-per-task/distinct-subagent counts and cost attribution remain intact.
- [x] 5.2 Add failing `task-inspection.test.ts` and UI tests, then keep child task strips attached across settlement and open exact qualified child IDs independent of picker membership. Verify running and completed transcript navigation, parent/draft/reading restoration, transient-open Retry, unavailable child explanation, and no direct child composer. Preserve open shell-output state and layered Escape behavior.
- [x] 5.3 Add failing UI tests, then add Continue while workers run in the task area with all-eligible explanation, capability gating, in-flight suppression, accepted-no-op and unknown-outcome feedback. Verify it never submits/clears a draft or replaces steering's separate Send/delivery/Stop controls; unsupported Claude/V1 views have no Continue action.
- [x] 5.4 Add failing UI tests, then label parent and worker Stop distinctly, retain Stopping until confirmed settlement, and surface `stateUncertain` without an unverified stop. Verify a background-only parent has disabled parent Stop, confirmed worker Stop remains usable, shell Stop explains destructive output removal and possible failed outcome before activation, and later failed/output-unavailable versus completed/report-retained states are truthful. Verify late provider parent wakeup preserves the draft and receipt uncertainty never triggers automatic replay.
- [x] 5.5 Add failing accessibility/layout tests, then ensure keyboard navigation, visible focus, polite deduplicated announcements, reduced motion, focus return, and at least 44px targets/8px adjacent-action gaps at narrow desktop and touch widths. Verify no lifecycle-induced overlap, hover-only action, accidental gap-tap mutation, focus stealing on worker updates, or loss of parent/sibling request access.

## 6. Exercise the complete stack through the existing scripted V2 server

- [x] 6.1 Extend `tests/e2e/opencode-v2-fake.ts` and its existing `/__e2e/chat` control path with deterministic background child/shell histories, execution state, pending synthetic inbox, parent-wide backgrounding, stop acknowledgement/settlement separation, and no-replay reconnect. Add separate browser-loss and upstream-applied-response-loss controls. Model pinned shell removal as record/output deletion plus failed waiter, and missing plugin capture as error; expose exit/capture/removal ordering instead of synthesizing cancelled with preserved output. Verify request counters and source provenance; preserve current steering semantics and run its existing suite unchanged.
- [x] 6.2 Add `tests/e2e/chat-opencode-background.e2e.ts` using the real `ChatAdapter` and `OpenCodeV2Provider`, with failing assertions before UI implementation. Verify native launch, all three terminal outcomes, mixed foreground/background, one-result correlation, continued parent prompting, and worker transcript/results before and after settlement using `bun run test:e2e --project=e2e tests/e2e/chat-opencode-background.e2e.ts`.
- [x] 6.3 Add E2E continuation/stop race cases to the new suite. Verify two children plus one shell background on one action, no-op after finish, browser-response loss, upstream application/response loss followed by same-ID retry while retained, and no automatic replay after reconnect. Verify Stop parent versus Stop worker, confirmed-completion-before-stop, delayed settlement, shell removal-before-capture yielding error/output loss, captured-completion-before-removal retaining its result, and no implicit background/cancellation from Send/Alt+Enter/selector changes. Assert outbound calls and visible outcomes; bounded receipt expiry/eviction/recreation are additionally covered by 4.7.
- [x] 6.4 Add E2E navigation/recovery cases: child absent from picker, rapid open/back/reopen, transient child read failure, multi-session/workspace return, hidden-page resume, oldest-page launch, completion during provider disconnection, and terminal event racing snapshot. Verify exact child identity, retained draft/reading state, no extra long-lived child HTTP connection, no duplicate results, and workspace working/needs-answer/finished behavior.
- [x] 6.5 Run the new accessible-control cases with the existing `withEngineBrowsers` helper for Chromium and WebKit touch, plus desktop keyboard/narrow-panel/reduced-motion coverage. Verify target geometry/raw-touch edge and gap behavior, software-keyboard reachability, output/child Escape layering, focus restoration, and console/network errors. Record screenshots/traces as evidence, not as a substitute for assertions; request permission rather than install missing browsers.

## 7. Align contracts, documentation, and regression evidence

- [x] 7.1 Add strict parse/schema tests before extending `ChatCapability`, task uncertainty fields and related shared contracts, including the stable unknown-operation error and bounded receipt lifetime documentation. Update `types.ts`, `validation.ts`, `api/openapi.yaml`, route coverage/exclusions, API changelog and the next coordinated `WORKSPACE_API_REVISION`. Verify `bun run typecheck` and `bun run test:api` pass and older unsupported-agent payloads still parse; do not hardcode a second revision 25 over steering.
- [x] 7.2 Update `ARCHITECTURE.md`, relevant user-facing behavior documentation, and `src/chat/opencode/sdk-coverage.ts` for implemented operations, notification recovery, stop scopes, all-eligible effects, and limitations. Include the approved optional independent-work backgrounding tip, not an unconditional policy. Verify `bun run coverage:agents` and review its diff; preserve existing dirty architecture content and make no project/agent instructions or config changes.
- [x] 7.3 Run focused normalization/provider/adapter/projection/service/agents/client/validation/rendering/task-inspection/background/notification unit suites, then repository unit/type/API checks. Verify existing Claude background work, OpenCode V1 foreground subagents, usage attribution, permission/question mirroring, steering/queue/revert, and snapshot pagination regressions pass; report baseline failures separately without weakening tests.
- [x] 7.4 Run the new E2E suite plus existing `chat-steering`, `chat-opencode-v2`, `chat-queue`, `chat-reversible-history`, `chat-touch`, `chat-claude-polish`, and shell-output/scrollback regression suites through their existing projects/helpers. Record commands, counts, failures, browser coverage, and untested platforms; verify no existing assertions were deleted to obtain a pass.

## 8. Authorized real-provider acceptance and final review

- [x] 8.1 Request explicit authorization before an isolated real OpenCode 2.0.29/client 2.0.28 acceptance run that creates test sessions or incurs model work. Once authorized, verify native `subagent background:true`, foreground-to-background conversion of all eligible jobs, child transcript/result, parent/child stop distinction, pending completion waking parent, and disconnect recovery. Record actual versions and observed wire outcomes with safe fixture data; never mutate existing user sessions or restart their service. If not authorized, leave this task open and report that validation limitation.
- [x] 8.2 Compare the final implementation to every scenario in `specs/opencode-chat/spec.md` and the preserved steering change; verify strict OpenSpec validation, API/schema alignment, evidence links, and a baseline diff/hash audit for unrelated work. Report any residual correlation/interrupt-generation or service-version limitations and obtain a separate implementation review; do not describe self-review or scripted mocks as independent real validation, and do not commit/push without separate authorization.

## Implementation evidence reconciliation (2026-10-15)

Checked tasks mean all of that task's criteria, not just code presence. Evidence logs are in the preserved `background-work-baseline.AYO1Ed` directory under the approved temporary root.

- Latest aggregate: `bun test src/chat api/contract.test.ts src/server/chat-routes.test.ts`: **1683 pass, 9 skip, 0 fail** (74 files), `latest-chat-aggregate.log`; `bun run typecheck` passed.
- 2.1: initial lifecycle RED retained in baseline evidence; live tool-success/content tests retain completed launcher and independent task; all three authenticated terminal states pass. Provider complete-history tests and renderer canonical-result test pass in the aggregate. This closes the basic fold, not the separate identity/recovery criteria below.
- Earlier scripted browser evidence: one test passed (`background-browser-3.log`) using the real provider/adapter with test-only capability opt-in. This is not completion of section 6 or real-provider acceptance.
- 2.3–2.5 closure: `safety-shell-red.log`, `correlation-order-red.log`, `launcher-page-red.log` reproduce malformed identity/exit facts, provisional duplicate and missing launcher defects. `fold-contract-green.log`: **556 pass, 5 skip, 0 fail** across OpenCode V1/V2, renderer/tool-detail and contract suites; hostile report text stays inert, shell outcomes and exclusions pass, active launcher references ride the first page. No existing assertions removed.
- 7.1 closure: alias/result identity parse/schema parity added; typecheck passed; `contract-final-api.log`: **205 pass, 0 fail**, including route coverage and revision alignment. Production capability declaration remains gated by 4.1.
- 2.2/3.1 closure: `alias-recovery-red.log`, `bounded-fold-red.log`, earlier ordering/reconcile RED logs; `recovery-mutation-green.log`: **370 pass, 0 fail** across adapter and V2 provider/normalizer. Live/history alias identity converges; older notices cannot settle later launches; ambiguous notices remain independent. Stream correlation retains at most 8,192 entries / 4 MiB then falls back to scoped read recovery until reconnect (never keeps a partial occurrence/tombstone set). History folds are finite and discarded. Scoped history/inbox/active/shell evidence remains read-only and missing evidence stays uncertain. Typecheck and the three background/V2 browser scenarios pass (`background-v2-browser.log`).
- 4.7 closure: accepted/unknown TTL, count/byte eviction, adapter recreation and pre-dispatch refusal: **14 pass** in the targeted adapter run. Both response-loss boundaries for Continue pass in the scripted matrix. Unknown child/shell Stop now survives read-only refresh; both tests pass in `unknown-stop-green.log`, including retained 409 on same-ID retry and no automatic replay after reload. No persistence added. Typecheck passed.
- 3.2 closure: `evicted-recovery-red.log` exposed stale background activity after snapshot settlement. Synchronizing activity after snapshot seed fixes both retained and evicted projection cases. `resumed-chat-aggregate.log`: **1711 pass, 9 skip, 0 fail** across all chat suites, routes and contracts, including unchanged Claude live-list behavior.
- 3.4/3.6 closure: original cold-inventory recovery RED plus `activity-notification-green.log`: **251 pass** across adapter, service and notification lifecycle. New regressions confirm child request mirroring/awaiting priority while detached work survives parent completion, no success notification for recovery/child completion, one result, and a later real parent turn still notifies. No extra execution mutations. Service no-start activity tests pass. The new notification regression required no additional production change.
- 7.2 closure: architecture, `docs/CHAT.md` and SDK coverage updated, preserving steering text. The optional workflow tip is advice only. Docs explicitly label the disabled production preview and pending real-provider acceptance. `coverage-agents.log` generated successfully; annotation diff reviewed (shell registry events no longer misleadingly described as unrelated terminals). Existing coverage gaps remain 26 Claude / 30 OpenCode; this does not claim all SDK coverage. Typecheck passed.

## Final automated acceptance (Sol continuation, 2026-10-15)

**35/37 tasks verified.** Sections 1–7 are complete. Production V2 now declares both background capabilities; the test harness hides them only for its explicit negative-capability case. Earlier preview/gating notes above describe intermediate evidence, not the final configuration. No automatic backgrounding, child composer, provider defaults, instruction/configuration edits, or persistent receipts were added.

All logs below live in the original approved evidence directory. Commands completed natively; none was left running.

| Check | Final evidence |
| --- | --- |
| Repository unit suite in clean tool environment | `sol2-final-unit.log`: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$TMPDIR" /opt/homebrew/bin/bun run test:ci` — **5,165 pass, 17 skip, 0 fail**, 285 files. Clean environment avoids inherited projected Git wrappers; no auth settings changed. |
| API suite in the same clean environment | `sol2-final-api.log`: `bun run test:api` — **205 pass, 0 fail**. |
| Type/build/schema/SDK | `sol2-final-type.log`, `sol2-final-build.log`, `sol2-final-coverage.log`, `sol2-api-validate.log`: typecheck, build, coverage generation, API validation and strict OpenSpec validation pass; `git diff --check` passes. Existing CSS `highlight` build warnings and one OpenAPI composition warning remain. |
| Browser acceptance and required regressions | `sol2-final-browser.log`: `bun run test:e2e --project=e2e tests/e2e/chat-opencode-background.e2e.ts tests/e2e/chat-opencode-background-hub.e2e.ts tests/e2e/chat-steering.e2e.ts tests/e2e/chat-opencode-v2.e2e.ts tests/e2e/chat-queue.e2e.ts tests/e2e/chat-reversible-history.e2e.ts tests/e2e/chat-touch.e2e.ts tests/e2e/chat-claude-polish.e2e.ts tests/e2e/chat-shell-output.e2e.ts tests/e2e/chat-shell-scrollback.e2e.ts --workers=2` — **248 pass, 0 fail**. Includes 21 native-stack background cases, one isolated test-hub cross-workspace case, Chromium/WebKit touch and existing output/Escape regressions. |
| Shell performance regressions | `sol2-shell-perf.log`: `bun run test:e2e --project=perf tests/e2e/chat-shell-output.e2e.ts tests/e2e/chat-shell-scrollback.e2e.ts --workers=1` — **4 pass** (both engines, both agents). |
| Baseline preservation | `sol2-baseline-audit.log`: all four dirty steering artifacts and all eleven dirty pre-existing E2E files remain **byte-for-byte identical** to their captured baseline hashes. Seven shared implementation/documentation files were extended for this feature. HEAD remains `bd580d6`; no commits or publication. |

### Scenario audit and task closure evidence

| Spec requirement / scenarios | Primary assertions and implementation evidence |
| --- | --- |
| Distinct conversation state: live list, settlement, reopen, mixed parent, unavailable state | Adapter snapshot/eviction/activity tests, `background-tasks.test.ts`, provider active/inbox reconciliation, and browser native-outcome/mixed-parent cases. Unknown/missing evidence stays running-but-uncertain; Claude's existing authoritative live-list rules remain passing. |
| Independent worker lifecycle: launcher success, terminal overrides, reused child/duplicates, unchanged foreground default | V2 normalization ordering/safety fixtures, joined-launcher renderer/cost assertions, provider repeated-child history boundaries, and historical-result inspection after child reuse. |
| Correlated notifications: pending/delivered result, native parent wake, inert lookalikes, ambiguity, no child push | V2 normalization/provider inbox/history tests plus adapter notification lifecycle tests. Canonical result links/render counts assert one report; hostile text stays inert. Browser parent-wake case asserts no Uatu resume mutation. |
| Read-only recovery: disconnect, snapshot race, navigation/pagination, other-client launch, inconclusive restart | Connected-before-read, per-generation stale-read, retained/expired cursor, four-parent scheduling/disposal and cache tests in adapter/provider. `sol-cache-red.log` reproduced missing history reuse; connected-generation cache and event invalidation pass. Browser paused-provider, hidden return, oldest-page snapshot race and isolated test-hub scenarios pass without execution mutations. |
| Explicit Continue: mixed children/shells, no-op, browser/upstream response loss, receipt boundaries, draft/input preservation, foreign/unsupported requests | Native request shape/provider error tests; adapter receipts and both admission orders; service/agent dispatch; route auth/origin/base path/confinement; browser mixed-shell/child action, staged attachment/model/delivery/draft preservation, no-op and both response-loss boundaries. |
| Separate Stop scopes: mixed parent, selected child, completion race, unknown response, shell removal/capture order, pending acknowledgement, superseded target, later native wake | Provider occurrence/ownership/stale-read tests; accepted/unknown TTL/count/byte/recreation tests; browser delayed Stop response completing successfully, mixed parent cancellation, shell running/exit/capture-before-remove matrix, unknown child/shell Stop retry and reload cases. Already-missing 204 is tested as acknowledgement only. |
| Inspection/accessibility: exact hidden child, Retry, keyboard/touch separation, owned shell output | `sol-focus-red.log` and `sol-occurrence-inspection-red.log` reproduced focus-return and wrong-historical-occurrence defects. UI restores the invoker and passes source-row identity into task inspection. Browser exact-child retry/open/back/reopen, narrow keyboard/visible focus, reduced-motion 44px targets/8px gaps and reduced viewport checks pass. Existing shell output/Escape layering remains passing. |
| Workspace activity: unselected parent, worker needs input, final settlement/failed recovery | Adapter child-request mirroring and needs-answer priority tests; `ChatService.activity()` no-start tests; native-stack test-hub case observes working→finished across workspaces, zero hidden-page EventSources, one brokered stream with the child open, and preserved parent draft/semantic reading anchor on return. |

The test-hub reader check waits for intrinsic-size transcript geometry to settle before capturing its row/offset; it does not relax the preservation threshold. Desktop keyboard focus assertions run in the desktop case, not WebKit touch's platform-specific Tab policy. Native touch adjustment may choose harmless inspection for a narrow gap; tests still require **no mutation** and check request counters. Touch tests accept exactly the unchanged generic unsupported usage probe's HTTP 409 and corresponding resource-console diagnostic, and no other errors. Screenshot evidence is attached under Playwright `test-results/`; it is not substituted for assertions.

### Remaining gates and limitations

- **8.1 remains open:** no authorization for paid/native real-provider acceptance, session creation, or user-service operations was requested through implementation tools or assumed. No live user conversations or existing hubs were touched. Source-shaped scripted acceptance is not real-provider validation.
- **8.2 remains open:** scenario/spec/schema and baseline self-audits above are complete; the lead must perform the separate independent implementation review. No publication is authorized for this subagent.
- Pinned behavioral evidence remains OpenCode **2.0.29**, installed client **2.0.28**. Native interruption lacks atomic occurrence/generation preconditions. Ambiguous reused-child results remain uncertain rather than guessed. Receipt TTL/capacity/adapter-lifetime and shell-output deletion limitations remain explicit in user docs.
- Browser coverage is automated Chromium and WebKit on macOS, including reduced viewport software-keyboard simulation. Real iOS/Android keyboards, assistive technology, and isolated real-provider execution remain unverified; no tools/browsers were installed. Earlier inherited credential failures, one watcher timeout, and initial WebKit panel failures were reported and not weakened; the final clean runs above pass.

## Independent-review corrections (Sol continuation)

The independent SolHigh review found four actionable gaps despite its passing focused suite. Each was reproduced before correction; the preceding automated checkpoint is historical, not independent approval of these corrections. **At this checkpoint task 8.2 remained unchecked pending independent re-review**, and 8.1 remained the separately authorized real-provider gate, for **35/37** tasks. The subsequent closure and native acceptance below supersede that pending status.

| Finding / affected tasks | Test-first correction and primary evidence |
| --- | --- |
| HIGH: an old unresolved background occurrence could Stop a newer foreground child run (4.4, 3.3) | `review1-red.log` reproduces active-child evidence incorrectly authorizing the old occurrence after child idle 40 / prompt 50 while the newer launcher is still running. Background history now reads execution boundaries even for a single unresolved launch; an idle boundary marks that occurrence uncertain independently of later launcher completion. Missing child history also withholds certainty. Stop invalidates parent **and child** history caches before revalidation. Provider regressions cover both a still-running foreground launcher and an external child continuation with no new parent launcher, assert refusal and **zero interrupt calls**. Existing stale-read test now correctly expects uncertainty once its independently observed child boundary is known. |
| MEDIUM: unselected inventory recovery missed pending child requests (3.4) | `review2-red.log` reproduces zero permission/question reads and missing needs-answer activity without opening a parent. The bounded recovery lane now reads pending permissions/questions alongside task evidence, applying them only under the same stream-generation/dirty fences. Failed reads preserve pending requests and back off; successful reads revoke absent requests without removing a newer live announcement. Recovered child ownership is retained for existing mirroring/answer routing. Adapter tests cover cold permission and question discovery, child-resolution races with stale reads, failed-read retention and successful retry; no history selection or execution mutation is needed. |
| MEDIUM: sibling list updates discarded keyboard focus (5.5) | `review3-red.log` reproduces focused A Inspect becoming body when B settles. Before list replacement, the UI captures the owned worker/action and restores its surviving logical equivalent without scrolling; a removed/disabled action falls back to inspection or the timeline. Browser assertions retain A Inspect after B settles and A Stop across C launching/settling, with **zero interrupt calls**. Draft focus outside the list remains untouched. |
| MEDIUM: settled inspection duplicated the full report (5.1, 5.2) | `review4-red.log` reproduces a full canonical report in the strip. The strip now renders outcome only plus a 44px `View worker result` control. Explicit activation closes the child layer, opens the owning parent result/group and focuses that canonical row. Unit tests assert the report is absent and link identity exact; native reused-child browser navigation verifies the correct historical report. The shared Claude presentation assertions were deliberately updated to require outcome-only strips **and successful navigation to the unchanged full report**; their streaming/output/stop assertions remain intact. This is the only pre-existing E2E file changed after the earlier byte-hash checkpoint. |

### Post-correction verification

All logs are under the original `background-work-baseline.AYO1Ed` evidence root:

- `review-chat.log`: `bun test src/chat api/contract.test.ts src/server/chat-routes.test.ts` — **1,734 pass, 9 skip, 0 fail** (74 files).
- `review-final-unit.log`: documented clean credential/tool environment + `bun run test:ci` — **5,173 pass, 17 skip, 0 fail** (285 files).
- `review-final-api.log`: same clean environment + `bun run test:api` — **205 pass, 0 fail**.
- `review-final-type.log`, `review-final-build.log`: typecheck and build pass; existing CSS `highlight` warnings remain. Strict OpenSpec validation and `git diff --check` pass. No wire/schema changes were needed for these corrections.
- `review-final-browser.log`: the exact ten-file `--project=e2e --workers=2` command from the earlier table — **249 pass, 0 fail**, including 23 background/native-stack/test-hub cases and existing steering, V1/Claude, queue, history, touch and shell regressions.
- `review-mixed-submit-sync.log`: the mixed parent Stop browser case passes **5/5**. An earlier broad run (`review-browser-before-submit-sync.log`) revealed test setup pressing Alt+Enter before the previous steer's submission guard released. The case now waits for enabled Send before starting the next admission; no cancellation, draft, queue or outbound-call assertion was removed or relaxed.
- `review-shell-perf.log`: the two shell suites under `--project=perf --workers=1` pass **4/4**, covering both engines and agents. Final OpenSpec apply progress (`review-final-apply.json`) confirms **35/37**, with only 8.1 and 8.2 open; `review-final-status.log` records the retained dirty tree. HEAD remains `bd580d6`.

These are self-verification results, not independent approval or real-provider acceptance. No publication, live-user session/service operations, dependency installs, authentication/settings changes, or instruction/configuration edits were performed.

## Independent re-review closure

The separate Sol High reviewer rechecked all four corrections and surrounding
paths, independently passing 607 unit tests, three targeted browser tests,
typecheck, strict OpenSpec validation and diff checks. All four findings are
closed with no new actionable findings. This supersedes the earlier pending
review notes: task 8.2 is complete, for **36/37 tasks**. Task 8.1 is now
explicitly authorized, but remains unverified for the preflight blocker below.
The user authorized commit/push when done; no publication has occurred yet.

## Authorized native acceptance preflight — blocked

The user explicitly authorized isolated real OpenCode 2.0.29 acceptance,
including paid model calls, while forbidding existing-conversation/hub changes,
configuration/authentication/global-policy changes, installations and publication.

- Read exact task 8.1 and pinned design evidence before execution.
- `opencode --version` reports **2.0.29**; installed `@opencode/client` is **2.0.28**. These verify installed versions, not a running server's version.
- Read-only model discovery identifies `openai/gpt-6.1-sol` with `medium`; no model or variant was invoked. No provider/model substitution, Luna call or Max variant was used.
- Created one empty workspace under the approved temporary root. Used the installed client's documented `Service.discover({version:"2.0.29"})`, which performs supported registration/health discovery without `ensure`, service startup, restart or stop. It returned no compatible healthy registered endpoint. The harness recorded **`CompatibleRegisteredServiceUnavailable`** and stopped before creating a client/session or dispatching a model call.
- This result does **not** establish a specific HTTP 401/403, a particular server-version mismatch, or a model-provider quota error; no such response was observed. The blocker is the absence of a discoverable supported authenticated 2.0.29 API connection in this execution context.
- Did not guess an explicit endpoint, construct substitute authentication, copy credentials into an isolated database, start a private server over the user's existing conversation database, or change service/global settings to bypass this boundary.

| Required native scenario | Actual result |
| --- | --- |
| Native `subagent background:true` launch/completion | Not executed: API connection preflight blocked. |
| Foreground-to-background conversion of all eligible jobs | Not executed: same blocker. |
| Child transcript and correlated result | Not executed: same blocker. |
| Parent Stop versus selected child Stop | Not executed: same blocker. |
| Pending native completion waking the parent | Not executed: same blocker. |
| Disconnect and read-only recovery | Not executed: same blocker. |

Primary evidence: `background-work-baseline.AYO1Ed/native-preflight.json` contains
only safe preflight metadata and cleanup counts, not endpoints, credentials,
headers or private prompts. Cleanup verified that the workspace was empty and
removed it. **Processes started: 0; sessions created: 0; paid calls: 0; existing
services restarted: 0.** No provider resources require cleanup. Existing hubs,
conversations and dirty implementation work remain untouched. Only this task
artifact changed in the repository; no code fix or renewed implementation review
is needed for this preflight result.

**Gate outcome: BLOCKED, not passed. Task 8.1 remains unchecked; 36/37 tasks.**
The next required input is a supported authenticated OpenCode **2.0.29** API
connection context supplied through the normal secure configuration/channel,
not credentials pasted into a report. Once available, acceptance can resume in
fresh confined sessions without substituting versions/models or operating hubs.
Prior automated checks and independent review remain as recorded; they are not
being represented as native real-provider acceptance. No commit/push occurred.

## Native acceptance completed through the supported private runtime

**This supersedes the discovery-only blocker above. Task 8.1 passed; 37/37 tasks
are complete.** The user correctly clarified that absent shared-service
discovery did not exhaust the authorized private startup path. No additional
connection credentials or user/global configuration changes were required.

### Startup, access and isolation evidence

- Checked `opencode --help`, `opencode serve --help`, `opencode service --help`, V2 CLI/client/troubleshooting docs, and Uatu's actual `src/chat/opencode/opencode-service.ts` startup/disposal path.
- Started unregistered private servers through **that existing `OpenCodeService` runtime**, using `opencode serve --hostname 127.0.0.1 --port <allocated>` in fresh temporary workspaces. The runtime generated a new in-memory password for each server. Neither `--service` nor shared-service `ensure/start/restart/stop/set/unset` was used.
- Actual authenticated private API readiness reported **OpenCode 2.0.29**; the client used throughout was installed **2.0.28**. Existing provider access worked through the supported runtime; no credentials were copied, emitted to evidence, or changed through authentication APIs.
- Read pinned `session/execution/restart.ts`: unregistered servers sharing the database do **not** run the managed-server orphan-recovery sweep. All explicit session mutations were additionally guarded to newly created acceptance session IDs. Existing user conversations and hubs were never mutation targets.
- The first agent-catalog read was transiently empty. After supported plugin/config initialization reads, existing `lead` and `worker` agents appeared; no agent definitions/settings were added or changed. All fresh parent sessions explicitly stored `openai/gpt-6.1-sol#medium`, overriding only those new sessions' selected model. Every observed model step used Sol medium. No Luna, Max, model/provider fallback or installation was used.
- `native-runtime-access.json` records successful authenticated catalog access and disposal. Checked shared registry/service-config/inherited profile-config hashes were unchanged across each runtime. No credential mutation events were observed during the paid runs.

### Actual native scenarios and outcomes

| Required scenario | Observed real-provider result |
| --- | --- |
| Native `subagent background:true` | A successful completed launcher retained `metadata.status:"running"` while its verified child was still executing a bounded semaphore fixture. Uatu reconciliation reported one certain running worker, independently of launcher completion. |
| Child transcript and correlated result | The native child transcript contained `BG_DONE`. Provider-authored `source:"subagent"`, `state:"completed"` notification metadata produced one completed task and canonical `resultId`; launch instructions were not used as the report. |
| Pending completion waking an idle parent | The parent first completed its launch response. Releasing the fixture caused a native completion notification and another actual parent turn, without a Uatu synthetic injection or resume operation. |
| Disconnect recovery | The Uatu provider stream was explicitly disconnected **before** releasing the child fixture. A separate native observer witnessed completion; read-only reconciliation recovered its terminal report. Reconnecting the provider preserved the same task/result identity without duplication. |
| Foreground-to-background, all eligible jobs | A fresh parent launched one foreground worker and one foreground native shell concurrently; the child was itself executing its bounded fixture. Exactly one parent-wide `POST /api/session/:id/background` returned **204**. Both parent launchers completed with running metadata, and Uatu reconciled **both** eligible jobs as certain live background tasks. |
| Parent Stop versus worker Stop | A new actual active parent control turn was interrupted with `resume:false` and `interrupted:true`. The detached child and shell remained running. Stopping the verified child through Uatu's provider targeted that child only; native metadata reported `cancelled`, normalized as **stopped**, while the sibling shell stayed running. Releasing the shell produced native `source:"shell"`, `state:"completed"`, normalized as **completed**. Native notifications subsequently woke the parent; no explicit Uatu resume call was made. |

Primary safe evidence is retained under `background-work-baseline.AYO1Ed`:

- `native-background-gate-attempt1.json` and its script: native background/transcript/wake/disconnect assertions passed. A later over-combined three-job prompt timed out before emitting tool calls; it is retained as an incomplete acceptance attempt, **not** diagnosed as a product failure or silently reported as a pass.
- `native-background-followup.json` and `native-background-gate.ts`: the smaller mixed worker/shell fixture passed every remaining assertion. It exercised both native job kinds in one parent-wide operation; the larger two-child-plus-shell combination remains covered by the automated scripted browser suite, not claimed as an additional successful live run.
- Reports contain versions, safe test markers, owned session/tool/result identities, operation paths/statuses, model selections, budget accounting and cleanup; no passwords, authentication headers, provider credential values or private user conversations were logged.

The explicit combined ceiling was 24 model steps, 10 minutes of native execution,
$2 of **reported** cost and 16,000 reported output/reasoning tokens. The follow-up
retained the first attempt's consumption and used a six-minute remaining deadline.
Actual combined observation: **13 model steps**, all Sol medium, **735 reported
output/reasoning tokens**, **$0 reported cost**. Zero reported cost is an upstream
accounting observation, not a claim that paid/cancelled requests were free or a
verified billing total. No fallback models or automatic retry prompts were used.

### Cleanup and final scope

Both paid attempts used only fresh sessions: **five owned session removals were
accepted with 204** across the attempts. Owned work was interrupted during
finally-cleanup; both private runtimes were disposed through Uatu's native
termination path, and both temporary fixture workspaces/FIFOs were removed.
Read-only startup probes also disposed their private runtimes and removed their
empty workspaces. Shared registry/config hashes stayed unchanged. No existing
service restart, hub operation, existing-conversation mutation, global policy or
authentication setting write occurred.

`native-cleanup-verification.json` additionally confirms **zero remaining owned
fixture processes**, removal of both paid workspaces, five accepted owned-session
removals, private-runtime disposal and unchanged checked registry/config files.
File-creation-to-completion timing gives a conservative combined elapsed upper
bound of **352,672 ms**, within the original ten-minute execution ceiling.
Strict OpenSpec validation and `git diff --check` passed after the documentation
update; `native-final-apply.json` reports **37/37 complete**. Prior unit/browser
and independent-review evidence is unchanged; no product code was edited here.

No product-code correction was needed. Repository changes for this acceptance
are this task artifact and the corresponding acceptance-status text in
`ARCHITECTURE.md` / `docs/CHAT.md`; temporary harnesses and safe evidence remain
outside the repo. Independent implementation review (8.2) remains complete.
Publication-safety review by the lead and separate commit/push execution remain
pending; **nothing has been committed or published**.

## Mobile UX parity and review closure — 2026-10-16

- [x] Preserve automatic/deliberate disclosure provenance with the retained DOM open state across A→B selection; detach B without duplicating automatic expansion or altering A's worker. Unit and both-engine regressions pass; the lead confirms independent closure.
- [x] Align touch background visibility with the shared work-dock budget: hardware-keyboard access through contained scrolling, hidden tracks/Continue under software keyboard or short landscape, pending safety information retained, and restored access on leaving compact mode.
- [x] Document touch parent-stop scope confirmation without changing native stop targets, detached-worker behavior, receipts, ownership or desktop cancellation. Preserve focus/first-touch behavior for visible controls and rail separation.
- [x] Close the independent short-desktop and loaded hardware-keyboard budget findings and animated bottom-pin race. Steering's `ux-audit-tasks.md` records RED/GREEN logs, ordered clean acceptance (**5,183 unit passes / 17 skips; 139 browser passes**), actual screenshot comparisons and the lead-confirmed independent re-review (**244 focused unit passes**, fresh Chromium/WebKit checks and twelve zero-distance pin cycles).

Current independent browser evidence is `uatu-independent-mobile-final/results.json` and its screenshots under the approved temporary `opencode/` root. Test/screenshot outputs remain outside OpenSpec. Physical iOS/Android keyboards, autocorrect, rubber-banding, assistive technology and Dynamic Type remain unverified; prior native-provider acceptance is historical and was not rerun for mobile UX. This documentation-only parity update adds no product edits, configuration/authentication changes, existing-hub operations or publication.
