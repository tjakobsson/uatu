## Context

See proposal.md, “Why”. This is a planning-only successor to the two active OpenCode changes, not a new implementation baseline. Discovery used HEAD `cb3079764601dd55366c4cddea87f7d49b68f7b2` (five commits after `32e6d73`) plus 26 pre-existing modified/untracked files. Their SHA-256 baseline was verified before planning; no existing file is part of this proposal's writes.

### Observed seams and evidence

- `src/index.html:821–938` has separate task/Continue/subagent/pending sections and composer rails. `ui.ts:1092–1102` already distinguishes running blocking evidence from pending tools and detached/uncertain launchers. `running-work-disclosure.ts` automatically expands new running work; `background-tasks.ts` folds launcher aliases but the pinned list currently includes running background tasks only. Completed history and task inspection already exist: consolidate their presentation, do not create a second worker lifecycle store.
- `tests/e2e/chat-mobile-layout.e2e.ts` preserves controls at 390px width / 380–450px visual heights and 844px landscape / 230px visual height; loaded layouts require 40% phone / 35% tablet transcript space. The existing active designs cap the aggregate dock at 35% visual height, 25% at width ≥48rem, and 24% during hardware-keyboard editing. Existing audit tests cover safe insets, outside-menu tap consumption, replacement warnings, focus, remote reading and bottom pinning.
- `src/hub/preferences.ts:1–6` explicitly stores Hub-wide host preferences, not personal state. `personal-state.ts` keys user plus workspace and serves per-workspace browser state; it is not an account-level setting. `auth.ts:35–40` supplies stable configured user names through cookie/bearer sessions. `server.ts:1622–1653` demonstrates server-selected `session.user`, closed patch validation and serialized writes. There is no observed account-level chat-preference API to reuse unchanged.
- Settings (`pages.ts:684–709`) mixes clearly machine-wide agent accounts, workspace defaults and devices. Add a separately labelled personal section. The workspace Hub menu (`shell/hub-nav.ts:679–686,864–877`) currently links dashboard/sign-out, not Settings; add a stable Settings link through its existing keyed reconciliation/focus behavior.
- The authenticated Hub workspace branch checks origin before proxying (`hub/server.ts:1592–1689`). `proxy.ts:75–95` currently copies most caller headers verbatim and shapes Host/Origin; it carries no trustworthy per-user policy to the child. Child chat routes require the workspace credential and origin (`server/routes.ts:498–509`), then dispatch agent-qualified IDs through `service.ts`. A browser-selected user, shared adapter flag, or unsigned copied header would be an unsafe authority for personal preference.
- Independent review identified that `hub/backend.ts:27–38` permits `RunningSession.token:null` and has no child-instance identity. The local backend currently discovers endpoint/token from a stdout URL and retains stdin as a lifetime/orphan backstop. Workspace credentials therefore cannot seed policy authority: a holder could forge principals, and null provides no secret. The proposed private bootstrap and required per-spawn identity below are additions, not existing guarantees. Installed Bun types support additional stdio descriptors; preserve the existing lifetime stdin and stdout URL contract.
- Adapter `prompt`, `changeDelivery`, `sendNow`, cancellation and explicit backgrounding share `enqueuePromptAdmission` with receipt keys. `admitSteer` awaits provider admission before installing/publishing the pending handle (`adapter.ts:1193–1226`); `steerHeld` admits before removing the held message (`:1347–1355`). `sendNow` may call `interrupt({resume:true})` for one paused steer, thereby waking the whole paused batch, rather than admitting another prompt (`:1293–1320`). A replacement submission uses the same admitted-steer path; Undo/revert staging alone does not send it.
- V2 `provider.ts:749–779` awaits `session.prompt` with a stable supplied message ID and `resume:true`; command admission's short optimistic window is a separate path and is not confirmed steer acceptance. Backgrounding calls `session.background({sessionID})` (`:900–903`). Current `interrupt` discards the upstream `{interrupted}` result (`:894–897`); any acceptance evidence needed for the resume path must be preserved without claiming message delivery or worker settlement.
- `receipts.ts:14–36` deletes rejected receipts. Existing explicit backgrounding catches `OperationOutcomeUnknownError` inside the receipt, retaining a tagged unknown result, then maps it outside (`adapter.ts:2305–2314`). Defaults are bounded (1,000 entries, 512 KiB, 15 minutes after settlement); eviction, process restart or adapter recreation end deduplication.
- V2 [API reference](https://opencode.ai/v2/docs/api/) exposes separate prompt, interrupt and background operations. Re-read pinned [v2.0.29 session.ts](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session.ts) and [job.ts](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/job.ts): `Session.background` calls `backgroundAll({sessionID})` with **no type filter**; it affects running, not-yet-backgrounded jobs actually blocking that session, including shells, and returns immediately if none exist. The native synthetic explanation is added after detaching jobs. The previously inspected server handler returns 204 with no affected IDs/count. There is no combined admit-and-background transaction or job-generation conditional mutation. Installed client 2.0.28 already exposes the operations; current online docs are unversioned, not proof of every 2.0.29 detail. No live service/model validation was authorized or performed.

## Goals / Non-Goals

**Goals:** Make touch density a presentation change over canonical chat state; resolve personal policy at the authenticated Hub boundary; carry it per request into the existing admission lane; preserve accepted primary actions independently of best-effort background outcomes.

**Non-Goals:** No instruction/configuration/policy edits, new launcher preference, automatic job-start watcher, deferred background-on-next-job subscription, queue-policy change, general identity propagation framework or persistent mutation journal. No new permission to mutate an existing Hub or run a paid/real-agent acceptance test. See proposal.md for product scope.

## Decisions

### D1. Touch has two compact disclosures, not smaller action targets

Use a single pending disclosure with aggregate counts and ordered steer/queue details, and a single worker disclosure folding foreground/background subagent and native shell occurrences. Hide empty summaries. Both start collapsed on touch; new jobs, settlement and hydration update text without opening them. Explicit expansion/collapse is retained per conversation for the current page, survives repaint/reselection/viewport transitions and does not leak between conversations. Desktop keeps established auto-disclosure and task/subagent presentation.

The worker summary and keyed rows consume the same canonical execution projection, not separate desktop widgets re-parented into touch. Ordinary foreground shell tools/commands are not workers; background shell tasks are. `finished` means confirmed terminal (completed/failed/stopped), not necessarily successful. Expanded rows show one flat list: live/unknown work first, then newest-first finished work, with single-line inspection, state-specific glyphs, 14px names/11px metadata and separate Stop worker targets. Historical launch/cost distinctions remain in the timeline and inspection. Unknown state is separately named and never included in confirmed working/finished counts. Use retained projection/history, not an all-history fetch per repaint or a new lifecycle store; older paged results remain reachable in the timeline.

Keep replacement warnings, paused-batch consequences/action and actionable unknown/failure text outside hidden detail. Only known successful automatic acknowledgements clear on a status transition or complete settlement; uncertainty and failures remain persistent. All dock contents share its one scroller. At software-keyboard/short-landscape budgets keep the compact worker summary: closed portrait summaries share a band with pending controls, while the closed wide/short summary shares the conversation header. Deliberate expansion overlays the transcript above the composer rather than hiding worker Stop, with content-sized height so short/empty lists do not reserve unused space. Preserve draft/focus without forced keyboard blur. Explicit Continue retains its existing constrained-state suppression. Do not add an always-visible multi-line Continue explanation.

The touch composer keeps Send and Stop distinct and supported delivery selection discoverable/operable; less-used configuration/context/help/actions move to one touch options menu. Configuration still opens the existing single adaptive picker after the options layer closes. Explain the personal preference and all-jobs effect in Settings and concise help; explicit Continue remains reachable when supported and blockers are evidenced, including when automatic backgrounding is OFF or has failed. Menu contents are viewport-bounded and scrollable, with no empty capability entries.

Composer and worker Stop targets remain ≥44×44px with ≥8px separation between adjacent mutation actions; worker header, Dismiss finished and inspection targets use the explicitly approved compact density exception. Preserve device-specific Enter/Ctrl+Enter/Alt+Enter behavior, aria-expanded/controls, keyboard navigation, visible focus, reduced motion, one-layer Escape, invoker restoration and first-tap reliability during composition. Outside taps consume activation rather than clicking through. Reuse measured dock/composer geometry and final-height reservation: 35% / 25% / 24% caps above, ≥40% phone / ≥35% tablet transcript in the existing standard-size matrix. At extreme text enlargement prefer scrollable secondary content and reachable primary actions, not clipped warnings or shrunken targets. Preserve safe areas, user reading anchors and bottom-pin intent on disclosure/worker changes.

Alternative rejected: shrinking rows/buttons or leaving two auto-expanded worker lists; either sacrifices touch safety or keeps the original density problem.

Desktop keeps its existing tracks/disclosure defaults inside one aggregate budget based on measured panel height, capped at 40%/25rem while the transcript reserves min(12rem, 35%). Non-empty work reserves max(52px, 3.25rem) for a complete action and visible focus ring; long transcript content yields to that floor rather than proportionally crushing the work viewport. If fixed chrome makes that minimum infeasible, Show work opens a non-modal sheet above the composer, with Close work/Escape restoring the entry and existing modal/inspection Escape precedence preserved. Focus correction scrolls only work ancestors; new replacement consequences reveal once after composer layout settles, without overriding subsequent deliberate scrolling.

### D2. Dedicated personal Hub preference, synchronized without client authority

Add a small `PersonalChatPreferencesStore` under `src/hub/`, with a dedicated state-dir path, not `hub-preferences.json`, per-workspace personal records, provider config or localStorage. Proposed version-1 record: per-user `{autoBackgroundOnSteer:boolean, revision:number}`, with absent records resolving to ON/revision 0. Expose authenticated `GET /api/hub/settings/chat-preferences` and `PUT` accepting only version, expected revision and boolean; select the account exclusively from the session. Responses are no-store and contain only that account's effective setting/revision. Unsupported versions, malformed bodies, foreign identity fields and unknown fields are refused.

Serialize compare-revision → mutate → atomic owner-only save → commit, reusing established 0700 state-root / 0600 file and rollback-before-rename conventions. Concurrent stale writes return conflict and current own state; never overwrite another device silently. Preserve unrelated user records, including safely keyed unusual names; no client-chosen file paths. Missing initial file/record means default ON without rewriting operator configuration or old stores. Explicit OFF survives migration/restart. Corrupt/unreadable/unknown-version persisted data is unavailable, not permission to reset OFF to ON or overwrite it; show an error and skip automatic side effects until repaired/read successfully, while retaining steering itself. Future version migration must be explicit and tested, not a lossy downgrade. A setting write failure does not become optimistic saved state.

Settings gets a **Personal chat preferences** section explicitly scoped to “your account on this Hub, across devices and workspaces; not other users”, distinct from machine-wide Agent accounts. Label the setting **Automatically background blocking work when steering** and disclose all-eligible jobs including shell commands. Add Settings to the existing workspace Hub menu, not another global toolbar.

Read fresh on Settings open, visibility/focus return, reconnect, and after save; concurrent devices see the committed value on refresh/re-entry. No always-on polling or new live topic is required: every eligible action resolves the current server value independently, so stale displays cannot apply stale policy. In-flight actions use their first resolved snapshot; disabling is not retroactive cancellation. Signing out/changing Hub or user clears page caches; browser storage never supplies authoritative policy. Standalone does not show an account toggle and retains explicit Continue/current behavior.

Alternative rejected: extend Hub-wide defaults, reuse notification enrollment (per device), or keep a browser-only preference; none satisfies personal cross-device semantics.

### D3. Authenticated, request-local policy crosses Hub → child, never shared adapter state

Resolve the initiating account's policy in the authenticated workspace proxy branch, only for prompt, delivery-change and send-now mutations. Carry a compact versioned internal policy envelope through `proxyHttp` and child routes into optional service/adapter action context. The Hub strips caller-supplied reserved headers before supplying its own. Authenticate the envelope using HMAC with a **distinct random per-spawn policy secret**, never a workspace/terminal credential or a key derived from one; bind principal receipt scope, policy decision/revision, workspace ID, required child-instance identity, method, canonical base-path URL and body digest/request ID. Validate it at the child in addition to current workspace credential/origin/ownership checks. A caller holding a valid workspace credential still cannot sign a different Hub principal. Never expose the policy secret, MAC, principal or another account's settings to browser JSON, logs or shared replay. Do not infer Hub context from the HTML meta marker or a bare boolean supplied by a client.

#### Private bootstrap and lifecycle

- For every backend start attempt, generate a fresh cryptographically random instance ID and independent ≥256-bit policy secret before spawning. Extend the server-only running-session contract with a required instance identity and an explicit `ready`/`unavailable` policy-trust state; missing identity never defaults to a workspace ID, PID, URL, terminal token or previous instance. Keep secret/signing access in private backend/proxy state, not serializable session/dashboard DTOs.
- Bootstrap the local child using a bounded, versioned, one-shot message over a dedicated inherited private stdio descriptor, separate from lifetime stdin and stdout/stderr. Transfer workspace/base-path binding, instance ID and secret there, not in argv, URLs, operator configuration, persisted preference files or ambient environment. Read/close it during early CLI initialization before any provider, terminal, tool subprocess or environment projection can inherit it. Preserve/explicitly pass that private descriptor only across trusted Uatu supervision/re-exec layers until consumption; close unused parent/child ends and never include payloads in startup error tails. This is a focused backend/bootstrap extension, not a rewrite of ordinary credential provisioning.
- Before publishing policy trust as ready, require a bounded startup proof that the actual listening child holds the bootstrap secret and the expected workspace/instance: use a fresh Hub challenge and a domain-separated HMAC acknowledgement over the instance/workspace/base path/challenge. Proof is not the secret; do not log it. A generic stdout URL is not proof. Install the verified pair atomically for that exact running child before attaching signed policy to requests; no key/instance mixing during concurrent starts.
- Require a non-secret readiness marker over the private descriptor before transferring bootstrap material, so an old/non-consuming child never receives a secret it could leave inherited. Both endpoints close after the bounded exchange; lifetime stdin/stdout remain independent.
- `token:null` does not prevent successful private policy bootstrap and never authorizes a fallback key. With verified bootstrap, policy verification works independently of terminal availability, subject to all unchanged primary-route access/origin checks. A backend/old child that cannot establish the private channel, malformed/missing identity, failed/timeout proof or bootstrap failure has explicit policy-trust `unavailable`: send no automatic authority, surface “Automatic backgrounding unavailable for this workspace”, and retain explicit Continue/ordinary steering only where existing gates allow them. Do not mislabel this as the account choosing OFF or fail open to default ON. Existing workspace-start failures keep their current failure behavior.
- On stop, exit or failed start, withdraw policy trust and release descriptors/key references with backend cleanup. Every replacement spawn rotates **both** identity and secret; no previous-key grace window or reuse on the same workspace/port. Reject old-instance envelopes/proofs even if the workspace credential happens to be unchanged. A Hub restart establishes a fresh pair with newly spawned children; do not reconstruct trust from endpoint/token metadata or adopt an existing child without a fresh authenticated bootstrap. In-flight/unknown receipts still follow D5's bounded-lifetime rules; key rotation must not replay mutations.

The threat boundary is an ordinary workspace-credential holder, not an operating-system administrator or arbitrary same-UID memory inspection. No stronger process-isolation guarantee is introduced.

This is narrow authenticated preference propagation, not a change to who may access shared workspaces. Direct standalone/workspace-token requests without valid Hub policy get existing explicit behavior; malformed supplied envelopes are refused, not trusted as defaults. Unknown policy versions fail closed for the side effect. Verified Hub requests with unavailable bootstrap trust receive neutral unavailable feedback without inventing account identity at the child; this is not an authorization to accept unsigned policy. A stale/foreign workspace or child-instance envelope must not work elsewhere. Proxy body handling must preserve bounded validation, attachments and base paths; do not buffer unrelated traffic/SSE or propagate policy to child inspection/worker stop.

Namespace the affected composite receipts by authenticated initiating account plus action/conversation/request ID; standalone uses its own scope. Same-account devices share the operation key, but another user's reused ID cannot inherit a personal result or chosen policy. Capture the first policy inside the retained receipt: retries after preference changes return the first action/outcome without reevaluating or adding backgrounding. Different users viewing one shared workspace do not set a workspace-wide or conversation-wide flag. Parent work remains collaborative: A's ON action can detach shared blockers; this does not alter B's OFF preference. Include this distinction in help/tests.

#### Independent-review correction: degraded receipt identity is not policy authority

Missing private policy trust must not disable unknown retention or merge authenticated accounts' operations. The authenticated proxy strips all caller-reserved headers, then supplies an opaque `x-uatu-hub-operation-receipt` identifier only on the three eligible mutation paths when it cannot sign policy. Derive it with an independent random Hub-private per-running-child key over the authenticated account, method, canonical action path and original request ID. The original body/request ID remains untouched for pending-input correlation. The key is not a workspace credential or private bootstrap fallback and never leaves Hub memory.

The current child accepts the opaque identifier solely as an ordinary, untrusted idempotency-key namespace after its unchanged credential/origin/ownership gates. Carry it separately from `ChatActionContext`: it asserts no principal, never enables automatic backgrounding, and cannot override a verified policy context. Direct workspace callers can choose ordinary request identifiers already; guessing a format-valid opaque identifier does not create Hub authority. Other accounts cannot choose or recover another account's token through the Hub or shared replay. Unrelated traffic receives no token authority, and no token/principal is serialized in conversation state.

Keep the first degraded feedback decision in a bounded Hub receipt cache (1,000 entries / 512 KiB / up to 15 minutes from the first proxy decision), keyed by the opaque operation identifier, so ON/OFF changes do not relabel a retained retry. Adapter primary/outcome receipts keep their existing settled TTL/capacity bounds; losing either cache ends the composite replay promise. Per-running-child key/cache state is memory-only and discarded with the running-session object/process. This adds no persistent journal, unsigned identity, policy-key fallback, or public body/response field. It is a focused internal protocol correction to D3/D5, not a new authorization mechanism.

Alternative rejected: browser makes a second background request after send, or Hub performs it after proxying the response. Both lose the adapter admission ordering, couple behavior to page lifetime and risk policy leakage/duplicate effects. Unsigned internal policy/principal headers are rejected: caller headers cannot establish that authority, even with reserved-header stripping. The degraded opaque operation identifier above establishes no such authority. Deriving a policy key from the workspace/terminal credential, substituting a default for null, or reusing instance/key state across restarts is rejected because workspace access is not authority to impersonate a Hub account.

### D4. One post-acceptance follow-up inside the original admission/receipt operation

Pass request context explicitly, not through mutable adapter configuration. Keep the original primary action and follow-up within its outer receipt and the existing per-conversation admission lane. Do **not** recursively call public `backgroundBlockingWork` from inside that lane (it would enqueue behind itself). Extract an internal capability/eligibility/background helper used directly while holding admission; retain the existing explicit route's behavior.

| User action | Primary confirmation before considering follow-up |
| --- | --- |
| New composer steer while busy | Native prompt/inbox admission acknowledged under its stable message ID, not optimistic UI or a command timeout |
| Queue → Steer | New steer admission acknowledged and held-to-steer transition committed; no-op “already steer” does not qualify |
| Send now of held input | Same confirmed held-to-steer path |
| Send now of paused steer/batch | Native resume operation acknowledged; it can wake **all** paused steers, no new prompt is sent; one follow-up for the action, not one per resumed message |
| Submitted Undo/revert replacement | Replacement actually acknowledged as a steer; staging Undo/revert, restore, or editing alone does not qualify |

Do not label an ordinary idle prompt a steer just because its selected delivery is steer. Unsupported delivery falls back as before with no backgrounding. Resolve actual action result, not button text. Retain batch warnings and existing paused/dormant queue semantics: no forced queue flush, no mutation of attachments/model/mode/delivery choice, and no extra resume/interrupt beyond the original Send now/steer contract.

After primary acceptance/transition, inspect fresh scoped adapter/provider evidence for running blockers. Require both steering and background-blocking-work capabilities and verified parent ownership. Reuse/extract the current blocking predicate: running tools/commands or confirmed foreground worker evidence qualify; pending tools, detached/settled/uncertain workers or merely generating parents do not. If evidence is absent, no background call and no deferred watcher. If reads fail, preserve the accepted action and report follow-up unavailable. An eligibility check is conservative evidence, not an exact native job inventory. One native background-all may race to an accepted no-op, or affect jobs newly blocking that same parent before it runs; Uatu cannot atomically target a snapshot's generations.

Upstream prompt/resume and background are separate calls. Steers remain subject to native next-step/batch delivery boundaries; backgrounding may release a block but does not ensure immediate delivery, extra agent launch, or a particular worker count. Resume can cancel native still-blocking work before a post-resume background call has a chance to detach it; document this ordering instead of moving background before acceptance or promising preservation of every foreground worker. Parent Stop queued after this action runs afterward; external clients remain outside Uatu's lane.

Alternative rejected: background before sending (violates accepted-only intent), or on every job start (changes launch policy and continues indefinitely after an action).

### D5. Composite results preserve accepted messages and uncertainty

Extend affected normalized action responses with optional `automaticBackground` outcome: `not-needed`, `accepted`, `unavailable`, `failed`, or `unknown` (absence when policy is OFF/outside scope). Accepted primary response still returns its existing message/delivery/configuration fields. `accepted` means the background request was acknowledged, not “workers finished” or proof that anything detached; `not-needed` means no qualifying evidence was observed. Sanitize reason codes/text. Shared worker state continues to come from provider evidence, not optimistic response rewriting.

Commit the primary queue/inbox transition before attempting backgrounding. Catch every follow-up failure inside the outer receipt, including definitive refusal, unavailable evidence, bounded timeout and transport ambiguity. Resolve/cache the accepted primary result plus follow-up outcome; never reject it into the client's draft-restoration/resend path. Show concise neutral text outside collapsed details, for example “Steer accepted; automatic backgrounding could not be confirmed. Refreshing status.” A definite refusal can say unavailable/failed without implying the steer failed. Do not call accepted steer “delivered” until native evidence says so.

Where primary admission/resume itself is ambiguous, cache a tagged primary-unknown outcome inside the affected composite receipt and translate it outside; skip backgrounding. Preserve the existing stable prompt ID and pending-message identity, reconcile read-only, and retain text/attachments as an explicitly unconfirmed action, not an auto-resubmittable failed draft. Do not introduce automatic mutation retries or regenerate IDs after a timeout. Send now ambiguity leaves the paused/batch outcome unconfirmed until reconciliation, not “all delivered”. Native steer/resume ambiguity retention and bounded admission apply independently of automatic policy availability, including standalone and degraded Hub dispatch; unrelated command/ordinary queue retry policy is unchanged.

Browser-response loss after Uatu knows the composite result differs from upstream-response loss after either native mutation applied. Retained same-ID receipts replay the same accepted/partial/unknown result without either call happening again, even if preferences change or new blockers appear. Use bounded timeouts with in-flight/unknown receipts retained; late provider completion may reconcile visible state but never initiate a delayed follow-up after a timeout. The native client has no background request ID: do not imply durable exactly-once behavior. Expiry, capacity eviction, adapter recreation/restart end receipt protection. Clients never automatically replay uncertain mutations on reconnect/reload; explicit Continue after refreshed evidence is a fresh user action, not a resend of the accepted steer.

For Queue → Steer and held/paused Send now, a fetch failure with no HTTP status or a server 5xx is ambiguous just like composer response loss. Capture the initiating action's steering eligibility before dispatch; keep per-conversation unconfirmed guidance through read-only refresh and later paints without restoring/changing the unrelated composing draft. Definite 4xx refusals keep their existing handling. No automatic mutation retry or persistent client journal is introduced.

Alternative rejected: propagate background failure as prompt failure, roll back an admitted steer, or let a rejected receipt disappear and repeat the whole sequence.

### D6. Contract integration and test-first evidence

The new `opencode-chat` additions explicitly narrow two active-change contracts: the earlier blanket “sending SHALL NOT implicitly background work” excludes the approved Hub automatic-steer case; touch automatic task expansion is replaced by collapsed summaries. Existing desktop behavior, queue/admission, worker lifecycle, stop/output safety, strict validators and API freshness remain. Prerequisite changes must be synced/archived before this successor, then their contradictory sentences/scenarios reconciled to these explicit scoped exceptions without dropping unaffected clauses. This is recorded now; do not edit their dirty artifacts during this planning workflow.

Implement in vertical test-first slices: persistence/auth; authenticated context and policy isolation; composite action ordering/receipts; then compact presentation and geometry. Extend existing Hub integration/proxy/auth tests and `tests/e2e/opencode-v2-fake.ts` through the real provider/service/adapter, not only UI mocks. Script both transport-loss boundaries, resume batch/cancellation races, delayed acceptance, no eligible jobs, changing blockers, partial failure, late settlement, receipt expiry/eviction/recreation and two accounts sharing a workspace. Add direct child spoofing/base-path/foreign-parent tests. Preserve all meaningful mobile audit assertions; change only expectations explicitly replaced by collapsed touch defaults.

Browser acceptance uses desktop plus Chromium/WebKit touch matrices: 390×844, visual 450/380; 844×390 with visual 390/230; 667×375; 768×1024/700 and 1024×768/500, safe insets, hardware/software keyboards, light/dark, reduced motion and enlarged text. Capture geometry and screenshots through existing evidence helpers; check hit-testing and gaps, collapsed and expanded states, menu bounds, pending edit/replacement/batch, worker settlement while inspecting, focus restoration, child/output Escape, first-tap composition, reading anchors and bottom pinning. Scripted tests validate Uatu contracts, not independent native service semantics.

### D7. Approved inline B refinement (2026-10-17)

Worker disclosure/row dimensions below are superseded by D10; D8 removes the older Options, Restore and delivery-menu controls.

This explicit implementation revision supersedes D1's hidden configuration/attachment controls and 44px worker inspection rows only. Keep attachment plus a two-line model/mode/effort and actual context pill inline, opening the existing chooser. Show measured occupancy and known limit, never cumulative usage as context. Keep less-used actions in header options. Send taps steer while busy regardless of saved keyboard delivery; Enter/Alt+Enter retain device preference and touch Enter remains newline. A continuous two-second press queues once (idle Queue dispatches normally, not fake pending). Release at 250ms–2s cancels, as do drag-out, pointer cancellation/lost capture, Escape, blur, hidden page and stale selection/draft/configuration. A non-layout-shifting extension rises 84px above the original Send target, filling bottom-to-top with countdown above the finger. Split-menu Queue is an immediate accessible alternative, with 44px targets and separate Stop. Commands and attachments retain queue semantics and truthful labels. Existing primary locks and authoritative per-account background policy remain unchanged.

The user explicitly accepts 29px worker inspection rows for a denser overview; mutation controls remain 44px with existing safeguards. Preserve canonical deduplication/status and model rendering. Finished disclosure stays compact and inspectable; Dismiss finished hides only local view using the existing per-conversation persistence seam, with Restore finished and counts based on visible occurrences. No provider history deletion. Persistent unknown/failure and replacement warnings remain outside collapsed details.

Native /btw must use verified V2 session generation without admitting history, interrupting foreground work or executing agent tools. Unsupported providers must honestly refuse rather than submit /btw as a prompt. No live provider/model acceptance is authorized.

Pinned verification: [V2.0.29 TUI handler](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/tui/src/feature-plugins/prompt/btw.tsx) invokes `session.generate` with concise/no-tools/no-actions instructions and explicitly documents that a returned tool call yields empty text rather than execution. [SessionGenerate](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session/generate.ts) previews history and makes one `llm.generate` call, without invoking the prepared executor or session runner/admission. [Model request preparation](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session/model-request.ts) advertises definitions and exposes a separate executor that this path never calls. Native plugin hooks still run; arbitrary installed plugin code is not newly sandboxed. Installed client 2.0.28 exposes the endpoint; the local CLI symlink was observed at 2.0.32, not the earlier 2.0.29. No runtime was changed or invoked. Personal side answers stay page-local rather than entering workspace-shared receipts, avoiding cross-account same-ID disclosure.

### D8. Approved removal of redundant controls (2026-10-17)

This refinement supersedes D1/D7's Options panel and split-menu fallback, and
the earlier composer/steering requirements' visible delivery selector clauses.
Remove their triggers, layers, relocation wiring and dead styles. Keep one real
inline picker with model/mode/effort and actual context; omit the duplicate touch
context circle. Attach, Send and Stop remain separate. Pointer hold keeps its
two-second upward indicator and all cancellation guards. Space on focused Send
uses the same hold; Enter activates quick Send. A concise aria-describedby names
hold/cancel and existing message-field shortcuts, without adding visible menus.
Account usage remains outside the removed panel and explicit Continue/help stays
in the work dock, including standalone. No delivery, worker or server authority
changes are introduced.

Remove Restore finished without a replacement control. Dismiss finished retains
existing per-conversation view persistence and visible/hidden counts; provider
results and timeline inspection remain intact. Other redundancies are candidates
for user review, not permission for further removal.

Personal Settings uses a compact 44px switch labelled **Keep workers running when
I steer**, helper **Applies to your account on this Hub.**, and compact explicit
**Save**. The existing save/conflict/failure/pending semantics remain unchanged;
this is not autosave. All-jobs/shell, account scope, default ON, shared-workspace
and non-atomic native-resume caveats stay in collapsed **Learn more**.

### D10. Approved unified dense worker overview (2026-10-17)

Supersede earlier worker header/Finished-disclosure dimensions with one compact
main header and one flat active-first list. Use a small CSS chevron, not native
triangles. Keep meaningful working/unknown/finished/hidden counts once and
Dismiss finished on the right of that same header, without a footer or Restore.
Settled rows and inspection targets are at most 28px at default text size;
glyph, name, real model and cumulative tokens occupy one line. Worker Stop
retains its own 44px target and 8px action gap; it need not inflate inspection.
Short and empty lists, including constrained overlays, use content-sized height.
Dismissal remains persisted view-only state; timeline history stays inspectable.
No provider, API or hold-delivery semantics change is part of this refinement.

### D11. Approved dense pending cards and visibly growing hold (2026-10-17)

Supersede D8/D10's visible hidden-count wording: summaries count only visible
working, unknown and finished occurrences, with the whole worker card absent
when every settled occurrence is dismissed. Persisted dismissal and provider
history/inspection stay unchanged; no Restore or replacement menu is added.

Touch pending summaries omit zero categories and redundant totals: `1 queued`
or `2 steers · 1 queued`. A 32px header and 32px inline pending actions are the
approved density exception; maintain an independent 8px gap before Remove and
existing confirmations. Compact delivery labels share the message line when
space permits, instead of requiring three rows. Send/Stop remain separate 44px
targets. Do not remove other information without user review.
Pending message leading scales with root text size: 0.875rem type with 1.25rem
leading preserves the default 14px/20px appearance and yields 28px/40px at 200%.
Multiline and image-containing cards grow naturally within the existing dock
scroller; enlarged glyph lines must not overlap.
Footers/action groups have shrinkable minimums and bounded widths; action labels
wrap rather than retaining an overflowing nowrap minimum. The 32px target minimum
and 8px gaps remain. A named inline-size container uses a 12rem threshold so an
enlarged paused-batch header scrolls away rather than leaving too little visible
space for a whole wrapped action; standard-size sticky behavior is preserved.
No confirmation, paused-batch admission or other delivery logic changes.

The previous implementation placed a static 84px envelope above Send and animated
only its internal fill. The approved refinement visibly grows the envelope from
56px to 104px above the original button across the two-second hold, with the
countdown above the finger from the first frames and bottom-to-top progress.
Mount that pointer-transparent visual at the viewport, outside composer/dock
clipping; the target and layout never move. Reduced motion retains a full static
extension and changing countdown. Dispatch/cancellation and personal automation
semantics are unchanged. Chromium trusted touch and WebKit pointer tests are
browser evidence, not native iOS gesture/callout verification.

## Risks / Trade-offs

- [ON for existing accounts changes behavior] → Clearly scoped personal setting, explicit all-jobs disclosure, OFF retained across devices, action-time server resolution, no job-start automation.
- [Shared workspace effects are visible to other users] → Initiator's snapshot applies only to their action; explain collaboration and test concurrent ON/OFF users without changing workspace access policy.
- [Native operations are non-atomic and resume may cancel blockers] → Accepted-only ordering, one attempt, evidence-based eligibility, explicit caveats and no guarantee of immediate delivery or foreground-worker preservation.
- [204 or lost synthetic explanation hides partial application] → Treat background failures after dispatch conservatively, retain unknown outcome and reconcile; never infer that every worker detached or completed.
- [Workspace credential grants unintended principal-signing authority or nullable tokens break trust] → Independent per-spawn private secret and required instance identity, verified bootstrap even with null terminal token, explicit unavailable fallback, key/identity rotation and forged-principal/restart tests; never weaken primary access gates.
- [New personal authority could leak through copied headers/shared adapters or subprocess inheritance] → Strip reserved headers, independently authenticated request envelope, early private-descriptor consumption/closure, account-scoped receipts and no secret/identity in logs, serialized DTOs or shared replay.
- [Unreadable preferences could accidentally re-enable OFF] → Default ON only for absent records; persisted invalid state is unavailable and never silently overwritten.
- [Collapsed tracks conceal urgent consequences] → Keep replacement/batch warnings and failures outside disclosure; retain request-answer UI; name uncertain/failed worker state and provide inspection.
- [Touch compaction regresses completed audit work] → Preserve source hashes and meaningful tests, reuse geometry/focus seams, compare evidence in every tested viewport rather than approving by screenshot alone.

## Migration Plan

Apply only after a separate implementation request, on top of the preserved baseline/prerequisite work. Add the versioned personal store lazily with absent records ON; do not migrate Hub-wide defaults or device/workspace delivery preferences into it. Ship private per-spawn bootstrap/instance/trust readiness, preference API, trusted internal context, composite response types/strict validators/OpenAPI and coordinated API revision/freshness updates together, taking the actual current revision rather than guessing a number. Existing/unsupported children remain explicitly automation-unavailable until fresh trusted bootstrap; no public credential or operator configuration migration is required. Update CHAT/architecture/API documentation and applicable SDK coverage only for actual behavior.

Rollback removes the personal UI/context producer and automatic follow-up, restoring explicit Continue; retain the separate personal file so saved OFF values survive re-upgrade. Rollback must not alter OpenCode inbox/history, cancel workers or resend messages. No real-service acceptance claim is made: a disposable OpenCode 2.0.29 run with model activity requires fresh explicit authorization, and unavailable browser tooling requires installation approval. No blocking product questions remain after the user's all-steer-actions and standalone decisions.
