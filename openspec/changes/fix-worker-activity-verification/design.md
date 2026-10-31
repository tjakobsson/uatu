# Design

## Context

See `proposal.md` for motivation and the three capability deltas for acceptance. This change started at `9e23c34` on `fix/worker-activity-verification`; merge commit `36f4f11` incorporates upstream `727d892` without rewriting history. The earlier merged correlation work and its separate worktree remain intact.

Observed seams:

- `src/chat/opencode/v2/background.ts:494–503` applies launcher-before-birth rejection to both parent and child births. `executionStarted():694–698` marks projected tasks uncertain; `foldLaunch():824–825` returns an existing task without binding its late initial start.
- `provider.ts:590–623` reads history, inbox, active sessions and owned shell records, then projects control uncertainty onto the returned task. `worker-state.ts` maps any uncertainty to Unknown before considering status. `compact-work.ts` and task inspection inherit that reading.
- `ui.ts:1123–1138` dismisses only settled rows through browser presentation storage and reference IDs. Those IDs cannot simply become durable session-wide marks: a child can execute more than once.
- Hub personal workspace state is a closed, scalar navigation schema. Personal chat preferences demonstrate a separate private, serialized, atomically saved store. `live-endpoint.ts` knows each stream's authenticated user and stable workspace, whereas ordinary child-topic broker fanout is shared across users.
- `docs/CHAT.md:446–477,539–562` and the existing Stop-proof specification couple uncertain control to uncertain activity. The deltas explicitly change that coupling while preserving control safeguards, result correlation, recovery budgets and main-session request ownership.

Diagnostic evidence is local and sanitized in `~/.cache/opencode/scratch/worker-verification-20261030/`. The public-provider matrix has 15 cases: 3 positive baselines and 12 expected-Working failures, not twelve distinct bugs. Independent diagnosis review isolated child-birth rejection and confirmed late-initial-start uncertainty. Persisted native timelines support newborn-during-launch and start-after-response shapes. Actual Uatu SSE envelopes, inventory and in-memory ledger were not captured: event-envelope clocks must not be equated with persisted session clocks. Success-before-content delivery is a schema-valid regression candidate, not a proven native incident cause.

## Goals / Non-Goals

**Goals**

- Make positive activity evidence independently inspectable and testable through the public provider interface.
- Preserve stricter exact-occurrence control checks and fail closed when activity or identity cannot be established.
- Give every approved label a single shared classification, including counts, timing, task inspection and workspace activity.
- Make personal dismissals durable and race-safe without adding provider mutations or another live connection.

**Non-goals**

- Proving an exclusive cause for historical screenshots without authorized runtime capture.
- Clearing control tombstones, increasing evidence budgets, promising atomic native interruption, or turning session activity into task ownership.
- Changing model/provider defaults, existing automatic-background policy, authentication modes, credentials, deployments or service lifecycles.
- Redesigning the work dock, introducing Restore/manual status actions, or migrating legacy browser marks into account-wide state.

## Decisions

### 1. Repair positive first-execution association, not every rejected record

Treat parent birth and child birth as different facts. A parent must exist for its invocation; a child may be created during that invocation. Admit the newborn relationship only with native own-workspace/parent evidence, a compatible accepted launcher and a uniquely attributable first execution. Preserve native event identity, semantic fingerprints and durable ordering where available; compare compatible clocks without assuming event timestamps equal session metadata timestamps.

Represent an accepted new-child launch awaiting its initial start as pending association, not irreversible revocation. Bind the first compatible start whether it arrives before or after the completed launcher. Enrich a known launch monotonically when content arrives later; conflicting immutable fields remain contradictions. No competing invocation, prior execution boundary, reused child, foreign ownership or observation gap may be erased by this enrichment. The equal-birth late-start regression must pass independently of the childbirth correction.

Alternative rejected: remove all birth checks or clear unavailable records on a successful active read. That would revive stale Stop targets and conceal actual reuse. Correct admission prospectively; do not rehabilitate genuinely revoked runtime records.

### 2. Add an evidence-derived activity projection beside control authorization

Introduce a shared task activity DTO in `src/chat/types.ts`, carried through normalization, provider events, adapter/replay and client validation. Its presentation states are `working`, `needs-answer`, `checking`, `session-active`, `unavailable`, `ended` and confirmed terminal outcomes. Carry bounded provenance: stable execution identity when established, observation generation/source, last verified observation time, occurrence-specific end time when known, and machine-readable reason. Expose Stop availability/reason separately; never serialize the private authorization basis as a client capability token.

The evidence owner is the provider/correlation layer, not DOM code. Current scoped ownership plus unambiguous execution evidence can verify task activity even when its Stop ledger is revoked/overflowed. An active reused session with unresolved attribution supplies only `session-active`. Failed/incomplete inventory supplies no positive activity. Historical `status: running`, idle alone and aggregate session outcome supply neither current task activity nor result success. A shell record's existence/ownership alone is not proof its process is still executing: use available native execution evidence and distinguish execution end from later result capture.

Keep `stateUncertain` as a conservative compatibility field while consumers migrate, but remove it as the universal activity override. Stop handlers continue to revalidate retained private proof on every action. Providers without the new DTO retain their existing authoritative live/terminal behavior; uncertain legacy rows stay Unresolved. Add adapter tests so absence of new V2 fields neither disables supported Claude/V1 work nor upgrades uncertain history.

Alternative rejected: treat all `status: running` rows as Working whenever Stop is disabled. That makes stale metadata indistinguishable from observed execution.

### 3. Use one classifier for rows, counts, clocks and attention

| Activity | Summary | Execution presentation | Dismissible |
| --- | --- | --- | --- |
| Verified task activity | Working | Working; live clock only with a valid start | No |
| Positively linked pending request | Working | Needs your answer; waiting is not productive-running animation | No |
| Initial/recovery verification | Unresolved | Checking status…; no growing execution clock | No |
| Active session, ambiguous task | Unresolved | Session active · task unverified; no task-running glyph/clock | No |
| No current task observation | Unresolved | Status unavailable · last seen … | Yes |
| Proven task execution end, missing outcome | Unresolved | Ended · result unavailable; fixed known end/duration | Yes |
| Correlated completed/failed/stopped | Finished | Actual outcome and existing report-clock provenance | Existing finished dismissal |

Use this classifier in `worker-state.ts`, `compact-work.ts`, `background-tasks.ts`, `compact-workers-view.ts`, `task-inspection.ts` and workspace activity aggregation. Omit zero counts; apply deduplication and personal visibility before summary counts. Preserve the existing flat row layout, responsive density, independent scrollers and disclosure ownership rather than inventing another history disclosure.

Bound Checking presentation to 10 seconds per genuine recovery cycle, independent of repeated repaint or unrelated events. Existing recovery read deadlines, three-successful-inconclusive-probe budgets, throttling, failure backoff and generation cancellation remain. The presentation deadline may show unavailable while an already-authorized bounded read completes; a late valid result can recover automatically. Reconnect, selection/resume and genuinely new worker evidence rearm recovery, not a new Check again control. No silence-only timeout may turn a continuously covered quiet execution into a fabricated end.

Last-seen means the server's last positive observation of that task, not the launch clock or the latest unrelated child message. Render an explicit unknown time when none exists. Growing execution clocks and running animation stop when task activity is unverified or ended; a relative last-seen caption may still age. Unresolved rows must not manufacture a workspace-finished transition or successful push notification.

### 4. Link requests to the existing canonical interaction

Preserve provider request IDs and owning agent-qualified conversations through `provider.ts`, `agents.ts`, adapter and projection. Link the row using verified child/parent ownership plus execution/tool-call evidence, not child ID alone in reused sessions. Carry references to canonical pending permissions/questions, not cloned request objects with new IDs. The row reveals/focuses the existing main-session card; all replies still use its existing handler. A request with no occurrence match stays visible in the main session and existing attention notification even when no worker can claim it. Dismissal never filters interaction items.

OpenCode 2.1.2 emits ephemeral permission/form requests, so the request itself supplies no durable execution sequence. Its [native question-tool producer](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/tool/plugin/question.ts) supplies permission `source: {type:"tool", messageID, id}` and question-form `metadata: {kind:"question", tool:{messageID,id}}`. Match that exact tuple to retained durable child-tool proof already associated with the current execution. Do not fabricate request durability or infer provenance from arbitrary metadata. Recovery additionally confirms the same native request remains pending; otherwise keep it canonically answerable but unlinked.

Task details show activity evidence, last seen/end provenance and the disabled Stop reason as ordinary text available on mobile and keyboard navigation. Retain touch target separation, focus restoration, reduced-motion handling and parent/worker Stop distinctions.

### 5. Give dismissals a separate private Hub store and execution namespace

Create a dedicated personal worker-dismissal module rather than widening the scalar workspace-state patch. Scope records by authenticated username, registry stable workspace ID and agent-qualified parent conversation. Execution keys are versioned deterministic fingerprints of immutable provider task/launch identity and established occurrence boundaries, never child ID alone, display time, array index or an in-memory random key. A stable accepted launch can identify its recorded task while its current activity is unavailable. A distinct execution or contradictory reused launcher receives a different key. Proven aliases can resolve to the same execution; ambiguous aliases must not broaden a mark. Provisional notification-only rows use their structured result identity until positively correlated.

Expose Hub-intercepted `GET` and idempotent `POST` operations under the existing workspace-prefixed personal API, using `appUrl()` on clients. Derive identity from Hub authentication and workspace from registry routing, reject principal selectors, validate bounded identifiers/body size, use no-store responses and current cookie-origin protection. The workspace child cannot select an account or directly own these records. Use serialized per-entry additions/conditional retirements rather than whole-set replacement, so different devices cannot overwrite each other's dismissals. Use private no-follow load and atomic mode-0600 save patterns from personal preferences; acknowledge only after durable rename. Wire workspace forget into retryable cleanup for all accounts. Bound stored entries/bytes and reject excess writes explicitly; do not silently evict committed marks.

Marks include the dismissed evidence revision. Verified task activity or a positively linked request always overrides them immediately. Retire the stale mark durably after authoritative validation of that activity, with conditional revisions so a delayed old dismissal/response cannot re-hide work. A later unavailable state requires a fresh explicit dismissal, not reactivation of the old one. Activity-driven retirement changes personal presentation only, never provider execution. Persist identity/revision state needed for the race fence across restart; client timestamps are not authority. Stale conditional writes return conflict and re-read instead of overwriting newer activity.

Observe positively verified activity at existing Hub live-frame, replay and authoritative snapshot delivery boundaries, without new subscriptions or per-mark pollers. User-approved failure policy: chat availability takes precedence over personal dismissal persistence. A failed or unconfirmed retirement save must not withhold activity, transcript content or canonical requests; show personal-storage failure guidance instead. During that failure an old dismissal can reapply to an unavailable row after restart. This limited exception does not hide currently verified activity or pending requests, infer an outcome, or mutate provider work. Successful retirement remains durable and race-fenced. Keep observation/write queues bounded and avoid repeated writes for already retired marks.

Hub read/save failures leave or restore the row and show a save/read-specific error; never claim synchronized dismissal through a silent browser fallback. In the existing non-Hub source/test mode, device-local presentation remains explicitly local and does not import its legacy marks into a Hub account. In Hub mode ignore legacy `dismissedSubagents` as authority. No Restore control is added. Timeline history and inspection remain available through their ordinary paths.

Alternative rejected: share localStorage IDs or append marks to workspace-wide projection events. The former is not cross-device/account-safe; the latter leaks personal state and can hide unrelated reused executions.

### 6. Invalidate personal state on the existing single stream

Extend `src/shared/live-protocol.ts` and the live endpoint with a `personal` no-cursor invalidation topic for the stream's own workspace. Route it at the Hub endpoint by authenticated principal and workspace, bypassing the broker's shared child-topic cache/fanout. Payload names only `worker-dismissals`; the authenticated API supplies marks. Emit after committed changes and on attach/reconnect, coalesce redundant invalidations and detach on unsubscribe/sign-out. Preserve backlog/subscription limits and fixed-class diagnostics.

The browser's existing live channel subscribes while the worker surface needs it, coalesces reads and discards obsolete responses after account/workspace/conversation changes. No extra EventSource or periodic polling. Extend published OpenAPI/SSE examples, route coverage, validators and API revision declarations alongside the protocol. Other accounts must see neither marks nor personal invalidations.

Alternative rejected: add another SSE connection or put private data in the shared activity topic. Both violate established transport/privacy contracts.

## Risks / Trade-offs

- [Separating activity accidentally enables Stop] → Keep control authorization private, require explicit availability/reason, retain existing negative safety tests and independently review all changed admission paths.
- [Late start actually belongs to reuse] → Require positive newborn/first-invocation association; ambiguous starts remain session-active/unresolved, never guessed from timestamps alone.
- [Dismissal races with recovery or alias folds] → Stable execution namespace, conditional durable revisions, active/request visibility precedence and replay/restart/concurrent-device tests.
- [A quiet task becomes falsely stale or Checking never ends] → Generation-bound evidence, explicit failed/inconclusive states, a presentation deadline and fake-clock tests independent of repaint.
- [Private marks leak through shared broker data] → Endpoint-level principal filtering, minimal invalidations and two-account integration tests on the same workspace/topic.
- [Persistent-state limits or failures block dismissal] → Fail visibly without dropping prior marks or disguising the failure as task completion.
- [Large cross-cutting change] → Implement in independently verified vertical slices with permanent provider regressions first, then shared state/UI, then private persistence/live integration; keep one accepted contract across slices.

## Migration Plan

1. Obtain approval before restoring this worktree's dependencies; no new dependency is planned. Promote sanitized reproductions into permanent repository tests, removing absolute paths, local account data and synthetic instrumentation.
2. Land prospective association and evidence separation with compatibility tests before migrating UI consumers. New DTO fields are additive; update wire validation, replay and published API contracts together.
3. Introduce the versioned personal store lazily under the existing Hub state root, without credential/service changes. An absent file means empty marks; invalid/unwritable state disables saved dismissal with clear feedback, not destructive reset. Do not migrate old device-local marks.
4. Verify the full branch, mobile/desktop browser states and cross-device/account races with a disposable local test Hub and synthetic provider, not the running user's Hub. Request permission for any needed dependency/browser downloads.
5. Obtain fresh independent implementation review and sync capability deltas after acceptance. Per the user's explicit workflow correction, archive this change after merge, not as a pre-merge gate. Publication text and draft/ready status need approval. Deployment and live runtime verification require separate explicit authorization.
6. Rollback leaves provider history and execution untouched. Older builds ignore the separate personal file and new optional DTO fields; they do not delete marks. A later forward version can read its supported version again. Never roll back by clearing control revocations or deleting provider data.

## Release-note scope

On 2026-10-30, the upstream latest-release endpoint identifies stable `v0.8.0` (`f287663`, published 2026-10-13). That tag contains the V2 provider but not its worker correlation/control module or `reconcileBackgroundTasks`; these arrived in `5585b5b` on 2026-10-26. The first-launch verification correction therefore stabilizes unreleased functionality, not a demonstrated stable-release regression. Preserve a truthful fix title and account for the repository's Release Please override rule when preparing the PR. Private cross-device dismissal and the new activity vocabulary are additional user-visible behavior; describe them separately rather than claiming stable users already had them. Recheck the latest stable release before publication.
