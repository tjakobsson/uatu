## Review round 12 — explicit desktop auto-expansion (2026-10-23)

The user chose **desktop auto-expands**, with touch initially collapsed and
deliberate current-batch collapse preserved. This supersedes the implementation's
both-collapsed default, not the canonical worker card, independent scrolling,
measured reading budget or touch disclosure contract. Historical task/evidence
entries below remain unchanged.

- [x] Restore desktop new-active-worker and nonempty-pending batch auto-expansion in CompactDisclosure/public initChat, preserving per-conversation/mode isolation, manual collapse until batch empty, null refresh, deferred native toggle handling, finished-only history and unchanged touch defaults. Align affected docs/main/delta/design/proposal, retain meaningful closed geometry/action/anchor tests, and verify focused units, Chromium/WebKit desktop/touch/coarse-desktop, typecheck and strict affected specs. No publication, installation or live services.

Unified final verification: all 415 selected Chromium/WebKit cases pass (the
original 403 identities plus all 12 header cases), including all six disclosure
policy cases, stable replacement warnings, side-reader links and exact native
scroll isolation. Fixture corrections preserve existing input and exact geometry
assertions; no production changes followed the green core run. Full core passes
5,618 tests with 16 skips, compact policy 13/13, API 209/209, strict specs 60/60,
typecheck and build/smoke. Evidence: approved review-loop scratch
`round-12-fixes/validation/final-broad/`. Independent review and publication remain
lead-owned; unrelated historical pending tasks below remain unchanged.

Earlier implementation-only handoff, before the unified fixes and final green
verification (retained as historical evidence):

Implementation and policy verification are complete; clean integrated acceptance
remains blocked, so this task stays unchecked. Evidence is in approved task
scratch `round-12-fixes/desktop-disclosure/` (`handoff.md`). Genuine worker and
pending arrival RED checks fail closed before the fix. Final units pass 129 UI,
22 compact/view, 27 budget/viewport/gesture and 208 renderer cases; typecheck,
strict compact/main-chat validation and diff hygiene pass. All six final native
Chromium/WebKit desktop/touch/coarse-desktop policy cases pass, including delayed
toggle notification, mode isolation and finished-only hydration; public initChat
units also cover rapid pending activation before paint. Actual desktop and touch
renders were inspected in two bounded rounds.

The broader run is 397/403, not clean: two touch side-reader link failures also
reproduce on unchanged `81b9d2f`; two new coarse-desktop setups were corrected to
respect the existing split-width guard and now pass. Final focused verification
is 17/18: WebKit's short-desktop replacement warning still detaches during browser
scrolling after a worker update. That case passed once on unchanged HEAD, so its
cause is not established and is not labelled a baseline defect. The broader
WebKit phone sibling-offset failure also passed in the final focused run without
relaxing its exact assertion; its intermittent cause is likewise unestablished.
Preserve these tests and resolve the remaining warning/side-reader blockers in
lead follow-up before claiming complete clean acceptance. No full-root CI,
publication, deployment, API/revision changes, installation or live services.

## Review round 4 — approved fixed Steer default (2026-10-22)

The user chose **Use fixed Steer default**, explicitly removing the configurable
default requirement. This supersedes historical keyboard-preference tasks below;
personal Hub automatic-background preferences and explicit API/dock delivery
remain unchanged.

- [x] Reproduce legacy saved Queue at existing public UI/shortcut seams, implement fixed desktop Enter / touch Ctrl/Command+Enter Steer and Alt/Option+Enter Queue where offered, and remove the unused preference helper/tests. Preserve touch newline, tap/hold timing and armed-release cancellation, command/attachment queueing, idle dispatch, staged configuration and unknown/no-replay safety. Align CHAT and governing active/main specs, run focused browser/unit checks, typecheck and strict validation; record evidence without publication or live services.

Evidence: `~/.cache/opencode/scratch/review-loop-20261022/round-4-fixes/fixed-default/`.
`red-delivery.log` shows legacy Queue producing a Queue request for Enter;
`red-browser.log` shows the reversed hint. `green-browser-final.log` passes
16 focused browser cases; `touch-hold-confirm.log` passes six further checks,
including expanded Chromium/WebKit legacy-touch idle/busy/command-candidate
newline and Ctrl/Command/Alt shortcuts after reload, exact 2500ms holds, and the
existing idle/busy touch newline cases. The initial green attempt retained a
new-test mistake: it expected an idle response to report Steer instead of the
existing immediate dispatch's Queue result; the corrected test separately checks
the requested delivery and immediate acceptance without changing the backend.
`unit-complete.log` passes all 87 UI tests (509 assertions), including staged
configuration, slash-path loss and uncertain/no-replay coverage; the 15 focused
input/configuration cases also pass separately in `unit-focused.log`.
Typecheck, all three active changes' strict validation, main opencode-chat strict
validation and diff hygiene pass. Strict output retains the already-synchronized
steering ADDED-header archive advisory; no archive was attempted. Impeccable's
mechanical check reports no findings; final synthetic desktop and mobile renders
were inspected. No new controls, layout height, storage deletion, API/revision
changes, dependency installation, real Hub/model activity or publication. The
four parallel-owned backend files were not edited by this worker. Full-root CI,
physical-device acceptance and independent validation are not claimed here.

## Same-row touch conversation header (2026-10-22)

- [x] Keep touch picker, Rename and New conversation on one row with a shrinkable paint-contained selected title, external focus ring, full native option strings/popup and 44px action targets; preserve desktop's text button and omit replacement menus.
- [x] Contain short-landscape transcript navigation so Latest cannot obstruct header or sibling controls; verify all 12 Chromium/WebKit light/dark 320×844, 390×844 and actual 844×390 header cases, including long titles, 100%/200% text and keyboard activation. Align CHAT/proposal/design/specs and run typecheck and strict change validation. Preserve unrelated historical acceptance tasks.

Evidence: `~/.cache/opencode/scratch/review-loop-20261022/round-3-fixes/ui/`.
`landscape-red.log` reproduces a failed header-action hit in actual 844×390 at
200% text: bottom-anchored Latest escapes its short transcript over the header.
Touch-only transcript overflow containment fixes that paint/hit escape without
changing z-index, reading allocation or header clipping. `landscape-confirm.log`
passes **12/12** focused header cases with center and block-edge action hits,
44px targets, long titles, text enlargement, native focus/popup and keyboard New
conversation activation; its retained synthetic landscape captures were inspected.
The fixture now reapplies and asserts the actual landscape viewport after seeding.
Strict change validation and diff hygiene pass. The UI worker's initial typecheck
reported two parallel-owned adapter fixture errors; after their correction, lead
validation passes typecheck, 5,447 unit tests (16 skipped), 209 API tests and all
59 strict OpenSpec items. Lead's header rerun passes all 12 cases, plus four
focused steering cases; build and compiled smoke pass. The initial lead header
run had one connection-setup timeout before geometry assertions; that isolated
case and the unchanged full matrix then passed. This is local verification,
not remote CI, physical iPhone or independent acceptance. Historical broader
acceptance tasks remain unchanged.

## Expanded-card capacity amendment (2026-10-18)

Current device acceptance (2026-10-19): **user-reported iPhone acceptance**; the user owns physical-device testing, so no additional agent physical-iPhone check is required. This supersedes the outstanding native-iPhone caveats in the historical run notes below without changing those runs' evidence. Automated WebKit acceptance remains a separate open item below. No agent physical test is claimed.

Fresh automated WebKit diagnosis (2026-10-19): an application-free page containing one button reproduces the activation stall. Chromium fires `requestAnimationFrame` and accepts a native tap; WebKit's frame callback does not fire within one second and its native tap times out after three seconds waiting for stability. This isolates a local WebKit runtime blocker, not a passing application check or a proven OS-level cause. No forced activation, assertion relaxation, browser installation, or host-runtime change was used. Evidence: `~/.cache/opencode/scratch/upstream-merge-fixes-20261019/blank-browser-probe.log`.

Upstream-merge automation follow-up (2026-10-19): full unit CI passes **5,338 / 16 skipped / 0 failed**; API tests pass **208/208**, typecheck/build/API validation pass, and strict OpenSpec validation passes **60/60**. The first broader Chromium run completed **539 passed / 3 skipped / 10 failed** (552 total). Corrections retain native interaction, exactly-once/no-replay checks and clipping checks while selecting fixture Git config explicitly, awaiting painted disclosure state, and asserting the approved independent scrollers, desktop/touch reading budgets, responsive composer rows and current uncertainty text. All **11 focused regressions** and **11 Chromium performance checks** pass. The final broader run completed natively with exit 0: **549 passed / 3 skipped / 0 failed** (all 552 selected cases, no retries, 8.7 minutes); evidence is `~/.cache/opencode/scratch/upstream-merge-fixes-20261019/browser-broad-final.log`. The three skips are the existing opt-in gallery writers, not disabled regressions. The lead reports independent review clear for both the merge/fixture changes and subsequent six browser-test corrections. Only this final-count note changed afterward. Historical wider-suite failures below are not a claim of current results; automated WebKit remains separately blocked as documented above.

The user's explicit choice to keep a small conversation area while expanded
cards use most available height supersedes the earlier universal 40% reserve
only when either card is expanded. Historical acceptance counts below remain
historical, not evidence for this amendment.

- [x] Measure remaining panel pixels after in-flow chrome/composer/notices/safe areas; reserve 20% bounded to 32–96px, yielding to whole actions down to min(16px, 10% of remaining space). Keep independent scrolling, content-sized short lists and the existing collapsed policy.
- [x] Update both active designs/specs and CHAT documentation with the explicit collapsed/expanded distinction; retain meaningful action, disclosure, focus and anchor tests.
- [x] Verify the implementation with focused units, Chromium layout/action/anchor cases, an actual 005cb41 baseline comparison, typecheck/build and strict specifications; hand off evidence and runtime blockers without publication.
- [x] Reconcile WebKit acceptance and independent review for archival. The 2026-10-23 follow-up records 14 Chromium/WebKit desktop/touch browser passes, two clear independent reviews and passing remote CI for `6522fe5`. These scoped results do not establish that the earlier expanded-card WebKit acceptance completed: its worker-count and activation-stall limitations remain recorded. Further acceptance work is not required for archival under @addiberra's 2026-10-31 direction linked below; no blocked check is claimed to have passed.

Evidence lives in `~/.cache/opencode/scratch/expanded-panel-budget-20261018/`.
`baseline-red.log` runs archived **005cb41** product source with the focused
capacity assertion (the unrelated viewport matrix is omitted): the expected
increase fails at **360px**. `browser-acceptance.log` passes both final Chromium
reference cases, including normal/200% disclosure combinations, native independent
scrolling and keyed offset restoration; its following audit fixture failed only
because five entries now fit without overflow. That fixture now fills the
supported 20-message inbox, and `browser-pending-final.log` passes **10/10**
target/density/enlarged-warning/image/action cases. `browser-final.log` additionally
passes **15** Chromium safe-area/keyboard/tablet/anchor/motion cases before its
intermediate reference-test failure. Together these are **27 distinct Chromium
passes**, not an all-green aggregate or cross-engine run. Earlier reference-test
failures exposed final flex shrinking and test scheduling assumptions; the final
tests preserve scroll isolation, wait for applied disclosure/settled anchor state,
and exercise desktop's existing insufficient-space sheet rather than hiding it.

Final 20+20 geometry is **544.25px cards / 96px conversation** from a 640.25px
remaining desktop region, versus the actual baseline's **360px / 280px**. Phone
uses **508.47px / 96px** from 604.48px remaining; its reconstructed prior CSS-cap
capture is 275.78px, not a second untouched-source baseline run. In the tested
230px band, 44px header plus 46px composer leave 140px: the expanded policy keeps
a truthful **14px** conversation region and gives cards **126px**, prioritizing
the selected whole action while retaining both headers. Closed cards still leave
the documented 68px in that band.

`chat-units.log` passes **1,736 / 9 skip / 0 fail**; the new budget unit's missing
implementation is recorded in `unit-red.log`. `typecheck-final.log` and
`build-final.log` pass (existing highlight-selector build warnings remain).
`specs-final.log` records the final strict check. No API behavior changed, so API
contract suites were not rerun. The mechanical detector reports existing style
warnings outside this change; no unrelated redesign was applied. Real-device,
assistive-technology and paid/live-provider checks remain unperformed. Source
and native test-server jobs are not left running; independent review/publication
remain lead-owned.

## Independent-review side-reader link correction (2026-10-18)

- [x] 14.1 Reproduce the reported README link reload in both engines at the real reader click seam; retain page identity, draft, originating conversation and exactly one native generate as meaningful outcomes.
- [x] 14.2 Reuse normal chat decoration/resolution and pointer/Enter/Space interaction wiring; guard current reader/conversation, close the modal before normal preview navigation, preserve reopening/focus behavior and leave safe external/rejected-reference policy unchanged.
- [x] 14.3 Verify desktop/touch Chromium/WebKit relative, encoded and qualified/line-number references, external-tab behavior, unsafe/forged/traversing references and Hub-prefix navigation; run final relevant browsers, clean units, API/type/build/strict-spec checks and inspect retained renders. Return evidence for lead re-review without publication or live-Hub/model activity.

Correction evidence is retained in approved scratch `opencode/side-reader-links-20261018/`.
`red.log` reproduces the actual app reload in both engines through changed document
time origins; `green.log` passes afterward. `browser-acceptance.log` passes
**121/121** affected Chromium/WebKit browser cases with no retries, including the
four desktop/touch link cases and the Hub-prefixed case. They retain the original
document, conversation, draft and answer through pointer/Enter/Space file actions,
reopening and an intercepted external-tab action; exactly one native generate
occurs, with no extra prompt/interrupt/background call. Closed-reader retained
markup cannot trigger a file action. Unsafe/forged attributes and rejected paths
are not promoted; normal shared URL/resolution policy is unchanged.

`ci-acceptance.log` passes **5,277 / 17 skip / 0 fail**; `api-acceptance.log` passes
**208 / 0 fail**. Typecheck, build, API/schema and all **60** strict spec/change
items pass, and final product hashes match. One preceding unchanged watcher
timeout passed **22/22** in isolation and in final full CI; its intermittent
cause remains unestablished. Earlier new-test fixture mistakes (hidden touch-tab
and hidden-role lookup) were corrected without increasing timeouts or weakening
outcome checks. Actual desktop/mobile reader and qualified-file preview renders
were inspected. This closes the implementation response to the independent MED
finding; independent re-review remains lead-owned. The prior broad-suite baseline
bottom-pin limitation remains documented and was neither altered nor claimed fixed.

## Current screenshot UX refinement (2026-10-18)

- [x] 13.1 Reproduce silent-success/worker-row/side-notice regressions at existing seams; remove successful send/dock/automatic-background confirmations while retaining operation-scoped failure/unknown guidance and unchanged API outcomes.
- [x] 13.2 Remove all manual Continue/help chat UI without replacement menus; keep backend contracts, authenticated automatic policy and explicit question answering unchanged; migrate manual-background UI tests to their existing HTTP API seam while retaining native call/receipt/lifecycle assertions.
- [x] 13.3 Use two-line active worker title/reported-agent/model/cumulative usage and short Stop with semantic worker names, 44px targets and 8px gaps; retain dense settled rows, canonical counts/dismissal and bottom in-flow dock across keyboard/viewport changes.
- [x] 13.4 Finish mobile safe-Markdown side-reader, large-table/URL/XSS, visual-viewport/pan/safe-inset, selection/reading-anchor and stale-conversation regressions; inspect actual Chromium/WebKit screenshots against supplied symptoms. The original attachment files were not mounted in this worker; direct comparison to those originals remains part of lead review, not a claimed pixel comparison here.
- [x] 13.5 Complete clean CI, relevant browser suites, API/type/build/strict-spec checks and final documentation/artifact parity; record exact evidence, failures and limitations. Independent review/publication/deployment remain lead-owned. Browser acceptance retains the separately reproduced baseline failure below; this is not an all-green browser claim.

Final evidence is retained in approved scratch `opencode/screenshot-ux-20261018/`.
`ci-closed.log` passes **5,277 / 17 skip / 0 fail** and `api-closed.log` passes
**208 / 0 fail**. Typecheck, fresh build, API/schema validation and all **60**
strict spec/change items pass in their `*-closed.log` files. Product hashes in
`product-acceptance.sha256` were verified after the checks. The earlier disposable
compiled Hub/child smoke passes; existing build/OpenAPI warnings remain.

The final nine-file Chromium/WebKit browser run (`browser-closed.log`) reports
**327 pass / 1 fail**, including all revised reader, worker, question, steering,
hold, safe-area/keyboard/landscape/short-desktop and trusted/degraded receipt
cases. Its only failure is the existing WebKit bottom-pin assertion ending
24px short. An untouched archive of **3d28b86**, using its original test and
source with existing dependencies and isolated ports, reproduces the identical
failure **6/20** times (`baseline-anchor.log`). Shared scroll-owner code and the
meaningful anchor assertion remain unchanged; no blanket clean-browser claim
or heuristic scroll override is introduced. The underlying native/layout cause
is not established and remains a separate lead decision, alongside the earlier
wider-suite baseline issues recorded below.

Final side-reader fixes were red-capable in both engines: safe-inset bounds
(`reader-safe-red.log`, then six passing reader checks) and a ready button active
during a delayed selection snapshot (`reader-loading-red.log`, then **12/12**
repeated mobile/stale-conversation checks). The original form question remains
pending with active or settled workers, without automatic reply/cancel requests.
Pinned native v2.0.29 evidence and hashes are in `native-evidence.md`; no model
was called. Actual final phone/pan/landscape, question/no-worker, small-notice,
two-line/dense-row and enlarged-safety renders were visually inspected.

Intermediate failures remain in the diagnostic logs: obsolete success waits,
the real safe-area reading-budget gap, reader Escape/focus/inset/loading fixes,
one unchanged PTY cleanup timeout and one fixture port collision. No timeout,
40% standard reading threshold or meaningful warning/anchor assertion was
weakened. Temporary scroll instrumentation was removed after baseline comparison.
Physical-device, assistive-technology and paid/live-model checks remain
unperformed. No user Hub, configuration, dependency, commit or deployment was
changed. Additional redundancy candidates were recorded, not removed.

Earlier sections below are historical completed-work/evidence ledgers, not a
request to restore their superseded Continue/success notices or touch overlay.

## Previous explicit refinement: unified dense worker overview

- [x] Replace nested Finished/history/footer with one compact chevron header, right-aligned Dismiss finished and one keyed active-first list; retain canonical counts, model/Σ usage, persisted hiding and timeline inspection.
- [x] Verify 28px settled rows, independent 44px Stop controls, independently scrolling sibling content panes and content-sized short/empty cards across phone/keyboard/landscape/short-desktop matrices, with screenshot comparison (the user's independent-pane decision supersedes the earlier single-scroller contract).
- [x] Investigate the reported hold animation on the real scripted provider stack: distinguish reproduced failures from passing supported cases, verify native Chromium touch plus Chromium/WebKit pointer/keyboard cancellation and exactly-once Queue, and report native WebKit long-touch tooling limits.
- [x] Run full unit CI, typecheck/build, API contracts and strict OpenSpec validation plus affected browser regressions; report remaining failures without weakening tests.

Evidence for this refinement is retained in approved scratch
`opencode/compact-ui-6c2fa84/`. The flat-list unit regression failed before the
fix (`workers-red.log`); the oversized card came from native summary padding,
nested Finished details and a footer Dismiss action. Flattening the list also
exposed the old dock budget's 48px reading reserve: it did not guarantee the
required 40% phone transcript band. The measured budget now reserves that band
(35% on tablet) without changing desktop layout.

Hold was not removed or reproduced as broken: the unchanged HEAD baseline passed
44 Chromium/WebKit cases (`hold-baseline.log`). The 17-case focused refinement
run passed (`final-targeted.log`), including native Chromium trusted touch
down/up/cancel/capture, early release/drag-away, live provider repaints and
exactly-once Queue; native event evidence and visually reviewed phone/keyboard/
landscape screenshots are in `screenshots-final/`. WebKit native taps and real
pointer holds pass, but Playwright's WebKit public API does not expose native
long-touch down/up: that on-device behavior remains unverified. Existing
capability gates exclude OpenCode V1/Claude and bypass /btw/local history actions;
no hold-delivery implementation or provider/API contract was changed.

Clean-environment unit CI passes: **5,276 pass / 17 skip / 0 fail**
(`unit-ci-clean-alone.log`), with system Git/SSH rather than inherited Hub
credential wrappers. The inherited-environment run had four credential-test
failures; the first clean run, concurrent with browsers, had one unrelated
tracked-but-ignored filesystem-watcher timeout. That unchanged file passes all
23 checks in isolation, and full clean CI passes without concurrent browsers;
the timeout's cause is not established. No watcher assertion or timeout changed.
Typecheck/build and the disposable compiled Hub/child smoke pass; API contracts
pass 208/208 and schema validation passes (one existing lint warning). Strict
change validation and all 56 main specs pass. The first 348-case browser run
passed 342 and failed six obsolete inspection-height expectations; those were
updated to the explicit density requirement, retaining 44px Stop and 8px gaps.

Final frozen-product evidence: `unit-ci-acceptance.log` again passes **5,276 /
17 skip / 0 fail**. `browser-verified.log` passes **359/360**, including all
47 hold and eight worker-overview cases and the phone/keyboard/landscape/short-
desktop and Hub-switcher checks. The remaining failure is WebKit staying on
`/login` during the unchanged Hub sign-in fixture, before reaching Settings or
the changed chat UI. The unchanged preferences file then passes **12/12** in
three traced isolated repeats (`hub-preferences-diagnostic.log`); its login
failure cause remains unestablished. This is not a blanket clean-browser claim.
The full report is retained at `browser-report/` and the failure context at
`hub-login-failure/`. The known performance-project baseline was not rerun or
modified. Independent lead review remains required before publication.

The final native-touch fixture waits for the completed-creation announcement
before filling its initial draft: an earlier run typed before asynchronous
conversation selection completed and stalled on an empty, disabled Send, before
any hold. No timeout was increased. A separate intermediate run mixed an earlier
count-span label assertion with the later accessible-summary markup; all final
worker checks use the native summary's label/expanded state. Final native taps
and pointer holds also verify that feedback paints above an expanded 12-worker
keyboard sheet and still queues once, not just that its rectangle exists.
`typecheck-final.log`, `build-final.log` and `compiled-smoke-final.log` pass.

## 1. Preserve the integration baseline

- [x] 1.1 Before implementation, record HEAD/status and hashes of pre-existing dirty files in task-owned approved scratch, compare with the planning baseline and identify any intervening work; verify changes are confined to this feature and preserve completed steering/background audit tests and artifacts.
- [x] 1.2 Add failing scenario fixtures to the existing real-provider E2E fake and focused adapter tests for accepted composer steer, Queue → Steer, held Send now, paused-batch Send now and replacement submission; verify fixtures distinguish admission/resume from background calls and do not mock away provider/service ordering.

## 2. Personal Hub persistence and API

- [x] 2.1 Test first, then add versioned per-account chat preferences and state-dir/main wiring separate from Hub-wide/default-workspace/device state; verify absent-file/account ON, saved OFF, restart, multiple accounts, unusual account keys and preservation of existing stores in colocated store tests.
- [x] 2.2 Add failing atomicity/version/permission cases, then implement serialized compare-revision writes with 0600 temporary files and atomic rename/rollback; verify stale conflicts, write failures, corrupt/unreadable/unsupported persisted formats, explicit OFF retention and no silent overwrite in store tests.
- [x] 2.3 Test first, then expose authenticated no-store GET/PUT personal chat preferences using server-selected session identity and closed versioned input; verify cookie/bearer authentication, revoked sessions, origin rejection, malformed/foreign identity fields, unsupported versions and only-own-state responses in Hub integration/API tests.
- [x] 2.4 Add failing Settings/menu tests, then implement the separate Personal chat preferences section, all-eligible-shell disclosure and stable workspace Hub-menu Settings link; verify save/conflict/error text, reload/focus/reconnect synchronization and keyboard/touch navigation without changing machine-wide Agent accounts or workspace defaults.

## 3. Authenticated request-local dispatch policy

- [x] 3.1 Test first, then extend the backend/early CLI bootstrap with a dedicated one-shot private descriptor, independently generated per-spawn ≥256-bit policy secret, required fresh instance identity and bounded challenge proof; verify source/compiled/supervised starts preserve lifetime stdin/stdout URL behavior, null terminal token can establish trust, missing/invalid/timeout bootstrap yields explicit unavailable, and secret/descriptor material never reaches logs/URLs/argv/environment/tool subprocesses.
- [x] 3.2 Test first, then bind and clean up policy trust with start/stop/exit/failure/replacement lifecycle; verify concurrent start isolation, both secret and identity rotate on child/Hub restart, old envelopes/readiness proofs fail even with an unchanged workspace token/port, and failed bootstrap never falls back to workspace credentials, previous trust or default-ON automation.
- [x] 3.3 Test first, then add the narrowly scoped Hub policy resolver and independently signed per-child envelope described in design D3; strip caller-reserved headers, bind policy/principal scope to workspace/required instance/action/body and verify tampering, foreign scope and forged principal signed using a valid workspace credential fails in backend/proxy/route tests, including null-token trusted versus unavailable cases and unchanged primary access gates.
- [x] 3.4 Test first, then thread optional verified action context through normalized routes, agent-qualified service dispatch and adapter operations without shared mutable policy; verify standalone/direct-token fallback, base-path handling, foreign parent refusal, neutral Hub-side unavailable feedback without unsigned identity propagation and that inspection/worker-stop/unrelated traffic receive no automatic policy authority.
- [x] 3.5 Add concurrent two-account/same-workspace and same-account/two-device tests, then scope composite receipt keys to initiating account and snapshot first policy under the receipt; verify opposing ON/OFF values, same client IDs, preference changes between retries and absence of private policy/identity in shared replay or another account's result.

## 4. Acceptance-gated background follow-up

- [x] 4.1 Test first, then extract/reuse the verified blocker-evidence predicate and internal background helper without recursive admission-lane entry; verify pending/generating/detached/settled/uncertain work makes no call, evidence-unavailable preserves the steer, and native race-to-empty is an accepted no-op.
- [x] 4.2 Test first, then integrate a single follow-up after acknowledged new steer, held-to-steer conversion and replacement submission transitions; verify primary-before-background ordering, stable message/attachment IDs, held removal only after admission, no-op conversion exclusion and no background for idle/queued sends, slash commands, staging or delivery selection.
- [x] 4.3 Test first, then integrate acknowledged Send now resume with preserved native acceptance evidence; verify one follow-up per paused batch, no extra prompts/interrupts, full batch consequence text, native blocker-cancellation/no-eligible ordering and serialized parent Stop without promising an upstream transaction.
- [x] 4.4 Add failing response/validator/client cases, then publish optional normalized automatic-background outcomes and handle accepted partial failures independently of primary failure; verify accepted message/delivery/configuration survives refusal/evidence failure, UI never restores/resends the accepted draft and background acceptance never implies completion or affected counts.
- [x] 4.5 Test first, then retain composite primary-unknown/follow-up-unknown results inside receipts with bounded waits and read-only recovery; verify upstream response loss after application at both primary and follow-up stages, browser response loss, late completion, same-ID retries with newer blockers and no delayed follow-up after timeout.

- [x] 4.6 Extend receipt boundary tests for TTL, capacity eviction, adapter recreation and process-restart-equivalent loss; verify bounded protection is documented, no reconnect/reload auto-replay occurs and a fresh explicit Continue does not resend the accepted steer.
- [x] 4.7 Run focused provider/adapter/service/route/client tests covering all actions with ON/OFF, unreadable personal preferences, standalone, V1, Claude and missing capability gates; verify ordinary queue dormancy, native steer boundaries, worker lifecycle/stop/output safety and no-start activity behavior remain intact.

## 5. Compact touch presentation over canonical state

- [x] 5.1 Test first, then add touch-specific per-conversation collapsed pending/worker disclosure state and canonical summary folding; verify steer/queue counts, launcher-alias deduplication, repeated worker occurrences, terminal failure/stop wording, separate uncertainty, retained finished inspection and unchanged desktop counts/default expansion.
- [x] 5.2 Add failing pending/batch/replacement UI tests, then consolidate touch detail regions while keeping warning/batch-action and partial/unknown feedback outside collapse; verify edit/remove/convert/Send now ordering, attachments/drafts and all existing confirmation/result/child inspection behavior survive repaint, reselection and settlement.
- [x] 5.3 Test first, then implement the compact touch composer/options layer with existing single configuration picker and supported explicit Continue/help access; verify distinct Send/Stop, delivery accessibility/shortcuts, absent unsupported entries, first-tap composition reliability, outside-tap consumption, one-layer Escape and surviving-invoker focus restoration.
- [x] 5.4 Add failing geometry assertions, then integrate touch density with measured dock/composer layout and final-height reservation; verify 44×44px targets, 8px adjacent mutation gaps, 35%/25%/24% dock caps, safe areas, keyboard worker suppression, warning/batch reachability, reading anchors and explicit bottom pinning without weakening existing audit assertions.

## 6. Integrated verification and documentation

- [x] 6.1 Extend/run the scripted real-provider steering/background/queue E2E suites with authenticated Hub cases for all trigger paths, mixed shells/subagents, partial failures, unknown receipts, account isolation and cross-device stale displays; verify exact outbound native calls and retained messages/state, not only UI labels.
- [x] 6.2 Run desktop and Chromium/WebKit touch geometry/evidence checks for design D6's phone/tablet/keyboard matrix, both collapsed/expanded, safe insets, light/dark, reduced motion and enlarged text; verify transcript minima, hit regions/gaps, options bounds, first-tap and Escape behavior, remote reading/bottom pin and settlement during child/output inspection. Save screenshots/metrics through the existing test-results evidence helpers and report unavailable browser coverage without installing tools automatically.
- [x] 6.3 Update `docs/CHAT.md`, `ARCHITECTURE.md`, normalized API/OpenAPI contracts, strict validators, coordinated API revision/changelog and applicable SDK coverage; verify examples describe personal scope, default ON, all steer actions/batch resume, shell effects, standalone, non-atomic ordering and bounded unknown receipts using `bun run typecheck`, `bun run api:validate` and `bun run test:api`.
- [x] 6.4 Run `bun run test:ci` and focused chat/Hub/mobile E2E regressions after integration; verify no meaningful pre-existing test was removed or weakened outside explicit touch-default exceptions and report failures/environment limitations precisely. Real OpenCode 2.0.29/model validation requires separate authorization; record it as unperformed unless authorized and actually executed in disposable sessions.
- [x] 6.5 Reconcile this successor's scoped no-background-on-Send and touch-disclosure exceptions after prerequisite spec synchronization, preserving unaffected requirements/scenarios; verify resulting spec coherence and `openspec validate compact-chat-background-steering --strict`, final diff scope and preservation of unrelated/completed work. Do not archive or publish without a separate request.

## 7. Approved B composer revision (2026-10-17)

- [x] 7.1 Test and implement fixed-target tap-to-steer / automatic Queue (now 500ms arming plus two-second countdown) with early-hold cancellation and lifecycle/draft/selection guards; the later revision removes the split-menu fallback. Retain keyboard delivery preferences and authoritative Hub policy.
- [x] 7.2 Test and implement inline attachment and actual model/mode/effort/context pill using the existing chooser and occupancy readout; verify phone, keyboard, landscape, tablet and desktop budgets.
- [x] 7.3 Test and implement dense canonical worker rows with real model/cumulative usage, active-first ordering and persisted view-only Dismiss/Restore finished using the existing dismissal seam.
- [x] 7.4 Verify pinned native V2 side-generation and TUI /btw semantics, implement a capability-gated side answer if it cannot execute agent tools or mutate foreground/history; otherwise report the specific blocking decision.
- [x] 7.5 Align approved mock (remove redundant still-frame footer), specs and CHAT documentation; run clean CI, type/build/API/strict-spec checks and relevant Chromium/WebKit browser evidence. Independent review/publication/deployment remain lead-owned.

## 8. Approved redundant-control cleanup (2026-10-17)

- [x] 8.1 Remove top Options trigger/panel, relocation wiring and dead styles; keep the real inline picker, attachments, standalone Continue/help and unique account usage reachable without duplicate touch context/model presentation.
- [x] 8.2 Remove Send delivery dropdown; preserve pointer Queue (now 500ms arming plus two-second countdown), cancellation guards, existing keyboard preference/Alt+Enter and touch newline, adding described Space-hold Queue with native quick Enter on Send.
- [x] 8.3 Remove Restore finished without a replacement control; retain persisted view-only Dismiss, hidden counts and provider/timeline results.
- [x] 8.4 Present the personal Hub setting as a compact labelled switch, one-line scope helper, collapsed Learn more and explicit compact Save; preserve existing default ON/account/save/conflict/error policy.
- [x] 8.5 Complete clean CI, type/build/API/strict-spec checks and chat/Hub Chromium/WebKit geometry, theme, keyboard and history evidence; inspect actual renders and report additional redundancy candidates without removing them. Independent review/publication/deployment remain lead-owned. Full browser coverage retains the separately reproduced baseline failures below; this does not claim an all-green suite.

### Cleanup verification (2026-10-17)

Implementation self-verification, not independent review. Evidence is retained in
approved scratch `opencode/composer-cleanup-20261017/`; nothing was committed,
pushed, installed, deployed or changed on a user Hub. The pre-existing untracked
`tmp/chat-ui-options/` remains untouched and excluded from publication.

- `ci-acceptance.log`: **5,275 pass / 16 skip / 0 fail** across 298 files.
  Typecheck, fresh build, API validation and strict change validation pass;
  `api-tests-acceptance.log`: **208 pass / 0 fail**;
  `source-compiled-acceptance.log`: **16 pass / 0 fail**. Existing highlight
  selector and OpenAPI composition warnings remain.
- `browser-acceptance.log`: **610 pass / 5 fail** across the full 615-case
  non-performance chat/Hub suite, Chromium/WebKit and desktop/touch. All five
  failures reproduce on an untouched archive of `50da1e8`, using existing
  dependencies and isolated test ports: `baseline-browser.log` reproduces the
  desktop picker-details assertion and two old touch subagent-list selectors;
  `baseline-shell-browser.log` reproduces two more old touch-list selectors.
  These unrelated test files/assertions were left unchanged.
- `perf.log`: **16 pass / 4 fail**. All four failures time out on the same
  hidden desktop subagent-list selector before measuring touch-child work;
  `baseline-perf.log` reproduces all four on untouched `50da1e8`. Full browser
  acceptance is therefore not green: baseline test migration/desktop-width
  diagnosis needs separate lead scope, not relaxed assertions in this cleanup.
- `browser-corrections.log`: **15 pass / 0 fail** for the last targeted
  corrections; every case also passes in the final 615-case run. Coverage
  includes Space hold/cancellation, saved keyboard delivery, truthful context,
  real picker focus restoration, and retained timeline report/child inspection
  after persisted Dismiss with no Restore control. Touch returns composing
  focus after a tap; keyboard activation restores the actual inline picker.
- `screenshots-acceptance/` and the Playwright report retain phone/tablet,
  short keyboard/landscape, desktop, enlarged text, light/dark, armed two-second countdown,
  model picker, known-context and compact account-switch evidence. Selected
  actual phone/tablet/desktop renders were inspected against both supplied
  screenshots. Physical-device, assistive-technology and live/paid-model
  validation remain unperformed.
- Earlier diagnostic failures remain in the logs. One unchanged file-watcher
  test timed out during the first concurrent CI/browser run; its file then
  passed 22/22 unchanged and both subsequent full CI runs passed. Its intermittent
  cause is not established. Cleanup corrections preserve the non-steering
  desktop rail, cancel raw touch-gap holds, keep touch picker Done at 44px,
  and test the actual picker backdrop/focus ownership rather than the removed
  Options layer. No timeout or acceptance threshold was relaxed.

## 9. User-approved summary text simplification (2026-10-17)

- [x] 9.1 Test first, then change successful personal-setting status to **Saved**, retaining the scoped helper, visible switch state, explicit Save, pending locks and separate conflict/read/write-failure messages.
- [x] 9.2 Test first, then omit zero-count worker summary segments while retaining working/finished/unknown/hidden counts, terminal failure/stop distinctions, a hidden-only count and a nonblank **No workers** fallback for empty conversations.
- [x] 9.3 Run targeted unit and Chromium/WebKit Settings/worker/disclosure checks, inspect updated renders, and pass typecheck/diff checks without repeating the known baseline-failure matrix or changing unrelated behavior.

Follow-up evidence: approved scratch `opencode/composer-labels-20261017/`.
`red.log` records **5 pass / 4 expected regression failures** before implementation;
`unit.log` records **11 pass / 0 fail** afterward. `browser.log` records
**12 pass / 0 fail**, including switch state, persistence, conflict/unavailable
handling, both touch engines, hidden-only/empty accessibility labels and the
existing mixed-worker viewport/theme matrix. Typecheck and `git diff --check`
pass; `screenshots/` retains the simplified Saved status and zero-free summaries.
Full CI and the separately confirmed baseline failures above were not rerun for
this bounded text follow-up. No commit, deployment or live-Hub change was made.

### Approved B revision verification (2026-10-17; historical, before cleanup)

All 32 implementation tasks are complete. This is implementation self-verification, not independent review. Final evidence is retained in approved scratch `opencode/composer-b-finish-20261017/` (under the environment's approved temporary root), with exact paths, corrections, native-source references and limitations in `handoff.md`. The inherited dirty implementation and untracked `tmp/chat-ui-options/` mock were preserved; the latter remains excluded from publication.

- `ci-acceptance.log`: **5,275 pass / 16 skip / 0 fail** across 298 files. `api-tests-acceptance.log`: **208 pass / 0 fail**. `source-compiled-acceptance.log`: **16 pass / 0 fail** against the fresh build. Typecheck, build, API validation and SDK coverage generation passed; existing highlight-selector and OpenAPI composition warnings remain.
- `browser-acceptance-clean.log`: **329 passed / 0 failed in 4.2 minutes**, two workers, Chromium/WebKit and desktop/touch matrices; native shell exit 0 observed. This includes the 40 B-composer cases, original steering/background/queue/attachment/configuration/replacement checks, personal Settings and trusted/degraded receipt regressions. Screenshots and measurement JSON are retained in `screenshots/` and attached to the Playwright report. Physical-device, assistive-technology and paid/live-model validation remain unperformed.
- Corrected dense-row mutation spacing/height, preserved worker text enlargement, invalidated holds when the original target moves, and retained failed side questions without changing newer drafts. Browser tests cover cancellation, changed selection, exact-once automatic Queue, accessible fallback, side-request concurrency/focus/failure, non-cumulative context and persisted view-only Dismiss/Restore. The exact history-prepend anchor assertion remains; its baseline now waits for the actual settled click position.
- Earlier failures remain in the evidence, not erased: concurrent CI/API startup failures and projected-tool contamination; an offscreen anchor baseline; one WebKit fixture login refusal (unchanged preferences file subsequently 12/12 in traced diagnostics); one attachment fixture creation failure (unchanged scenario subsequently 5/5 with traces). Those two intermittent fixture causes remain unestablished. A later 327/329 run exposed a test selecting an inspection-only foreground row for a mutation-row assertion; final tests separately enforce 29px inspection-only and 44px mutation-bearing targets. No timeout or acceptance threshold was relaxed; the final full browser run reduced concurrency rather than skipping cases.
- Pinned OpenCode `v2.0.29` TUI/session-generation/model-request sources are retained as `native-*` with hashes. They prove one-shot context generation without calling the advertised agent-tool executor or foreground admission/history mutation; native plugin hooks still run. No real runtime/model was invoked. Historical missing-module and boot/port failures are not presented as behavioral red-green proof; genuine worker-projection and side-generation red evidence is identified in the handoff.

Independent review, publication, archive and deployment remain lead-owned; no commit/push, installation, user-Hub mutation or model/provider fallback was performed. No owned jobs remain ongoing.

## Evidence ledger (implementation, not independent validation)

Evidence root: approved scratch `opencode/compact-chat-apply.wm0ubT/`.
Independent Sol High review reproduced three acceptance gaps after the original aggregate below. Tasks 3.4, 3.5, 4.5, 5.2, 6.1, 6.3, 6.4 and 6.5 were reopened and are now completed against the correction evidence below, not the historical aggregate. Review evidence is retained in approved scratch `opencode/compact-independent-review/`. Real-model and physical-device validation are not claimed.

### Review-correction handoff status

Final documentation-only reconciliation passed `openspec validate compact-chat-background-steering --strict`, `git diff --check` and `bun run typecheck`; the ledger count is 27 completed / 0 unchecked. No full test suites were repeated for this reconciliation and no product code was changed.

The three corrections and their regression tests are implemented. Evidence is retained in approved scratch `opencode/compact-review-fixes.qjuzp8/`: `ci-acceptance.log` (5,253 pass / 17 skip / 0 fail), `api-final.log` (208 pass), `source-compiled-acceptance.log` (18 pass), typecheck/build/schema/SDK coverage and strict change/all 56 main-spec validation. The original combined browser run in `browser-acceptance.log` finished with 284 pass / 1 fail: the WebKit touch Undo-replacement test's final harness finish request returned non-success; the fake returns 409 when no turn is running. The complete steering file passed unchanged (31/31) in `steering-diagnostic.log`; the intermittent cause is not established and no assertion or timeout was weakened.

Primary final browser evidence is the completed Playwright report in `compact-review-fixes.qjuzp8/browser-acceptance-rerun.log`: **285 passed / 0 failed in 4.2 minutes**, directly checked by the lead, who also confirmed no Playwright process remained. The native exit notification/code for owned job `sh_1446811fa001XFRPpPWT6VnOnm` is unavailable; no observed native exit code is claimed. The report includes all 20 new trusted/degraded receipt regressions alongside the preserved 265-case browser acceptance. All eight reopened tasks are checked; all 27 implementation tasks are complete. The earlier WebKit harness 409 remains unexplained; rooting that intermittent failure is not an additional acceptance criterion, and the unchanged passing rerun does not explain it away. Independent Sol High has closed all three fixes after 347 unit checks, the three original reproductions and 20 targeted browser cases, with no new issues reported (lead-supplied review evidence, separate from implementation self-review). See `compact-review-fixes.qjuzp8/handoff.md` for exact implementation paths and bounded retention limits. No jobs remain ongoing.

| Tasks | Actual evidence / remaining work |
| --- | --- |
| 1.1 | `baseline.json`, `compact-scope-audit.log`: HEAD retained; all 26 original files retained, 15 byte-identical and 11 feature-touched. Original prerequisite artifacts remain byte-identical. |
| 1.2 | `automatic-real-stack-red.log`, `automatic-all-triggers.log`: five real-provider/bootstrap Hub trigger paths; adapter ten ON/OFF transitions. |
| 2.1–2.3 | Personal store/API tests and operation ledger, included in `compact-ci-final.log` / `compact-api-clean-final.log`. |
| 2.4 | `prefs-browser-final.log`: Settings/menu Chromium/WebKit touch checks and pane tests. |
| 3.1–3.2 | `trust-source-compiled-final.log` and fresh-build `compact-source-compiled-final.log` (18/18): private bootstrap/source/compiled/lifecycle checks; Hub E2E uses production bootstrap. |
| 3.3–3.4 | `reconcile-policy-routes.log`: 72 policy/proxy/route tests; `automatic-all-triggers.log`: qualified service/adapter dispatch. Direct/standalone gates covered by route/provider regressions. |
| 3.5 | `automatic-isolation-unknown.log`, `automatic-devices-loss.log`: concurrent opposing accounts, shared IDs, same-account devices/stale displays, changed preference and retained first receipt. |
| 4.1–4.2 | `reconcile-focused.log` (661 tests), `automatic-boundary-exclusions.log` (3 scenario matrices): eligibility/exclusions, accepted no-op, attachment/native identity and parent Stop ordering; five-trigger E2E ledger above. |
| 4.3 | Adapter ON/OFF batch-resume and native-result tests; real-stack native-cancel/no-eligible case passed in `compact-browser-integration-2.log`, preserved in final rerun. |
| 4.4 | Revision 27 contract/schema/client parsing; `compact-api-clean-final.log` 208/208, lost/refused background browser cases in `automatic-isolation-unknown.log`. |
| 4.5 | Adapter bounded primary/follow-up unknown tests; native prompt/resume loss and browser response loss in `automatic-isolation-unknown.log` / `automatic-devices-loss.log`. |
| 4.6 | `composite-receipt-boundaries.log`: 12 accepted/primary-unknown/follow-up-unknown cases across TTL, count/byte eviction and recreation; read/subscribe makes no mutation, fresh Continue makes no prompt. CHAT/architecture describe limits. |
| 4.7 | `compact-ci-final-2.log`: 5,246 pass / 17 skip / 0 fail, including V1/Claude/capability/no-start and queue/worker/output regressions. Real model tests intentionally skipped. |
| 5.1–5.3 | `compact-browser-acceptance.log`: 265/265 across ten chat/Hub suites; pure fold/pending safety/unit tests plus deliberate state, first-tap, options/picker handoff, attachments, child/output inspection and settlement checks. |
| 5.4 | `compact-browser-acceptance.log`: collapsed/expanded phone/tablet/keyboard matrix, 200% text, 44px/8px hit regions, 35/25/24% caps, options bounds and existing reading/bottom-pin assertions pass. Earlier focused expanded matrix also passed 24/24. |
| 6.1 | `compact-browser-acceptance.log`: all trusted five-trigger/mixed-worker/native-cancel/unknown/account cases plus steering/background/queue regressions passed with exact native call assertions. |
| 6.2 | `compact-browser-acceptance.log`: combined 265/265 preserves screenshot/metrics evidence together in `test-results/` through existing helpers. Selected standard/enlarged Chromium/WebKit renders inspected. No real-device or assistive-technology claim. |
| 6.3 | CHAT/architecture/SDK comments updated; `compact-api-final-2.log` 208/208, typecheck/build, schema and coverage pass. Schema has one pre-existing composition warning; build has existing `highlight` selector warnings. Earlier retry timeout passed unchanged in clean-environment reruns. Unchanged Mermaid blocks were not edited/re-rendered. |
| 6.4 | `compact-ci-final-2.log`: 5,246 pass / 17 skip / 0 fail; `compact-browser-acceptance.log`: 265 pass / 0 fail in 3.6 minutes (owned job exited successfully); API 208/208, type/build/source-compiled checks pass. `compact-test-preservation.log` reconstructs baseline test files and confirms only approved touch-default scenario replacements. Real model validation unauthorized/unperformed. |
| 6.5 | Main specs synchronized in prerequisite order, with only approved Hub/touch exceptions reconciled. All original and delta scenario names retained; 56 main specs validate, all three active changes validate strictly, `git diff --check` passes. `compact-scope-audit.log` records preservation. No archive/publication. |

## 10. Current screenshot corrections (2026-10-17)

- [x] 10.1 Reproduce first: both engines fail dense pending geometry (60px header, 109px card), outward growth (constant 84px extension), and hidden-only worker-card removal.
- [x] 10.2 Compact touch pending text to nonzero categories without redundant totals; measured single-entry header/card become 32px/64px. Keep 32px inline pending targets, 8px gaps, existing confirmations and 44px composer/paused-batch Send/Stop.
- [x] 10.3 Remove dismissed-count wording and hide the entire worker card when no visible workers remain, preserving persisted dismissal and timeline inspection.
- [x] 10.4 Use the latest fixed-height viewport-owned pointer-transparent envelope: silent 500ms arming, then a full 104px extension with bottom-up green fill and an above-finger two-second countdown. Preserve fixed target, 2500ms exactly-once dispatch, all cancellation guards and reduced-motion information; this supersedes envelope growth.
- [x] 10.5 Run all 202 steering/worker/hold/mobile-layout browser checks successfully, including all prior 47 hold checks. Capture light/dark phone, 380/450px portrait and 230px landscape frame/occlusion evidence; retain existing 480px desktop, safe-area, focus and anchor coverage.
- [x] 10.6 Validate clean isolated unit CI (5,278 pass / 16 skip), API (208 pass), typecheck, build, contract structure and strict specs (60 valid). Native macOS watcher timing failures in intermediate runs passed isolated and in the final owned-temporary-directory CI run; no observer tests or product behavior were changed.
- [x] 10.7 Reconcile the historical wider-suite blockers against later verification. The 2026-10-19 upstream-merge note records 549 Chromium passes / 3 existing gallery skips / 0 failures and 11 performance passes, with independent review clear; the 2026-10-23 follow-up records passing remote CI and CodeQL for `6522fe5`. The earlier 637-pass/five-failure functional run and 16-pass/four-failure performance run remain historical evidence, not current blockers or an aggregate clean-suite claim. The later user-reported iPhone acceptance supersedes the earlier native-iPhone caveat within its reported scope. Supplementary native hold/callout checks are not required at @addiberra's request; no additional physical-device pass is claimed.

Evidence is retained under the task-owned scratch directory
`/private/var/folders/kd/gws6pqw92ss4lfbdk23n0jxc0000gn/T/opencode/currentfixes-evidence/`:
`before/`, `chat-final-results/`, `baseline-results/`, `perf-results/`,
`chat-e2e-final.log`, `baseline-failures.log`, `chat-perf.log`,
`ci-owned-temp-final.log`, `api-tests.log` and `specs.log`.
No commit, publication, dependency installation or user-Hub mutation was performed.

## 11. Independent-review enlarged pending text correction

- [x] 11.1 Reproduce the reported 200% multiline overlap first: four Chromium/WebKit light/dark cases fail glyph-rectangle separation with 28px text, 20px leading and approximately 13px overlap.
- [x] 11.2 Use proportional 1.25rem leading: default text remains 14px/20px and the simple header/card remain exactly 32px/64px; 200% becomes 28px/40px with at least 7px between glyph rectangles. The long-message example grows naturally from 184px to 356px rather than using a fixed card height.
- [x] 11.3 Cover 320px and 390px, light/dark and both engines, including real 640×320 mixed/image-only attachments, unbroken wrapping, independent 32px mutation targets and 8px gaps. Contain pending attachment rows/thumbnails so those cards and their dock have no horizontal overflow. Check replacement-warning lines and batch actions through actual clipping/occlusion hit tests after deliberate scrolling.
- [x] 11.4 Verify 238 browser checks, 203 targeted unit checks, clean full CI (5,278 pass / 16 skip), typecheck, build, strict active-change validation and diff hygiene. Visually inspect final enlarged multiline, narrow real-image/action, replacement-warning and unchanged default-density captures.

Evidence is retained under
`/private/var/folders/kd/gws6pqw92ss4lfbdk23n0jxc0000gn/T/opencode/currentfixes-scaled-pending/`:
`red.log` / `before/`, `browser-verified.log`, `unit-verified.log`,
`ci-verified.log`, `results/` and selected `frames/`.

The standard-text 40% conversation checks remain intact and pass in constrained
viewports; enlarged ordinary pending work also retains that floor. Additional
200% replacement-warning measurement reports 227px of an 844px band (about 27%),
identical with the old and corrected leading; safety text and actions are
reachable by scrolling. At 320px/200%, WebKit's separate conversation header
reports 328px scroll width; the pending cards/dock no longer overflow. These
other enlarged-chrome issues are recorded, not silently folded into the pending
text fix. The earlier wider-suite blockers and native-iPhone caveat still apply.

## 12. Independent-review post-replacement action wrapping correction

- [x] 12.1 Reproduce after replacement, not just before: all four 320px/200% light/dark Chromium/WebKit cases fail with a 328px scroll width in the 320px dock. `Send now + paused steers` forces a 286.89px footer/action into 238px of card content.
- [x] 12.2 Remove footer/action-group automatic minimum-content floors, bound widths to the card and wrap long action labels without truncation. Preserve 32px target minimums and independent 8px gaps. Keep proportional pending text leading and normal 32px/64px header/card density.
- [x] 12.3 Use a named inline-size container with a 12rem threshold to let enlarged paused-batch headers scroll away rather than consume nearly the entire action viewport. Normal-size sticky counts remain unchanged; no transcript-budget or conversation-header correction is included.
- [x] 12.4 Verify post-replacement dock/card widths and zero horizontal panning, then expose every pending mutation target completely within every clipping ancestor. Check focus, full rectangle intersections and five on-target hit points, with captures clear of the dock fade. Test 320px/390px, 200%, light/dark and both engines.
- [x] 12.5 Exercise the long action's real confirmation: unchanged paused-steer/other-queued-message warning; Cancel makes no send-now request, changes no pending entries and preserves the replacement draft; confirmation sends exactly once, resumes the paused steer and leaves the other two queued messages held.
- [x] 12.6 Verify 238 browser checks, 203 targeted unit checks, clean CI (5,278 pass / 16 skip), typecheck, build, strict active-change validation and diff hygiene. Visually inspect final wrapped-action/focus captures in both engines and unchanged default-density captures.

Evidence is retained under
`/private/var/folders/kd/gws6pqw92ss4lfbdk23n0jxc0000gn/T/opencode/currentfixes-wrapped-actions/`:
`red.log`, `before/`, `browser-final.log`, `unit-final.log`, `ci-final.log`,
`results/` and selected `frames/`. Replacement width and per-action intersection
JSON accompany the screenshots. The corrected 320px dock is 320px wide with
320px scroll width; the long action/footer are 238px wide, and the wrapped
238×62px action is completely visible and unobstructed when exposed.

No user-Hub mutation, commit or publication was performed. The separately
recorded enlarged replacement transcript budget and conversation-header overflow
remain outside this correction; no universal enlarged-text 40% guarantee is claimed.

## 13. Hold coordinate and sparse expanded-queue regressions

- [x] 13.1 Reproduce the fixed/client-origin displacement and focused, keyboard-hidden one-to-two-entry clipping before fixing them. Restrict the hardware-editing cap to collapsed work and calibrate the hold portal against its painted origin; preserve existing gesture invalidation.
- [x] 13.2 Check one/two/five-entry growth and collapsed space return; synthetic nonzero fixed origins, pan/scale, single admission (now at 2500ms after silent arming), keyboard opening/closing, viewport pan and toolbar movement cancellation. Chromium passes; local WebKit stalls before tab activation, not native iPhone verification.
- [x] 13.3 Preserve and run the existing hold/side-reader and reference-workdock checks: 31 Chromium cases, including desktop/phone, short bands, themes, 20+20 lists, 200% text and independent scrolling. The two new Chromium regression cases pass.
- [x] 13.4 Add 13 privacy-reviewed, actual-rendered desktop PNGs and an indexed synthetic-fixture disclosure under `docs/screenshots/opencode-chat/`; retain opt-in capture tests, covering configuration, workers, queue, hold progression, inspection, questions, side reader, personal preference and uncertain/replacement feedback.
- [x] 13.5 Verify chat unit suite (1,736 pass, 9 skip), typecheck, build, strict change/spec validation and diff hygiene. Build retains existing unsupported `::highlight` warnings. No API/auth behavior changed; no live Hub, paid generation, dependency installation or publication was used. Native iOS reproduction remains outstanding.
- [x] 13.6 Address independent-review P2: replace per-frame envelope reset/read with a stable inert zero-size fixed-origin sibling, sampled before paint writes. Keep dynamic-origin/translated-containing-block calibration and gesture guards; remove both nodes on pagehide and restore on retained-page return or a subsequent gesture. Four 650ms Chromium desktop/mobile light/dark traces reduce the review's 42–45 `paintHold` Layout events to zero, with zero direct calibration style flushes. Frame-entry style resolution remains (39–40 events), not a claim of no browser style work. Re-run 22 targeted units, 37 browser cases, typecheck, build, strict changes and diff hygiene; keep the 13 reviewed PNGs unchanged because geometry and appearance are unchanged.
## Desktop density and minimisable side window (2026-10-19)

- [x] Address independent P2 mode-transition review: minimise an open reader through the existing shell UI-mode subscription in both directions, retaining answer/offset; verify native `:modal`, released inertness, chosen-mode overrides, no duplicate inference/timeline mutation and no shell focus theft on fine/coarse Chromium contexts.

- [x] Apply desktop-mode + primary fine-pointer/hover density with container-based composer/worker reflow; retain comfortable/touch targets and all safety actions.
- [x] Reserve a preferred 35%/200–280px desktop expanded conversation band with measured short-window yielding; retain the comfortable/touch budget unchanged.
- [x] Show preference-derived desktop Enter/Alt+Enter guidance without altering hold timing or pointer delivery.
- [x] Open a larger nonmodal desktop side reader; offer Minimise on desktop/mobile, retaining answer identity/offset and conversation ownership without inference/history mutation.
- [x] Cover density, reverse keyboard preference, explicit comfortable mode, outside compose/queue/Stop interaction, retained reading position and scoped Escape in focused Chromium regressions; refresh affected synthetic documentation captures and add mobile examples.

Verification is scoped, not a blanket clean-suite claim. The focused density +
Chromium hold/side-reader selection passes 37 tests, and the opt-in desktop/mobile
gallery passes two. Relevant unit tests, typecheck, build and strict change
validation pass. No backend/API contracts changed; earlier API evidence below
was not rerun. WebKit desktop/mobile attempts stall at initial native panel/tab
activation before reaching the feature, as in prior local checks; native iPhone
verification remains outstanding.

Three additional mobile checks fail identically on an isolated `afdd26a` source
archive and this change: the 200%/230px independent-panel case clips the Pending
header by 5px after worker prioritisation, and both mixed-worker theme cases
expect a 337.6px expanded transcript despite the existing approved 96px reserve.
Their tests/requirements were preserved, not weakened. Baseline failure artifacts
are in task scratch `desktop-density-btw-20261019/baseline-evidence/`.
Mechanical design detection reports incumbent/global warnings, not a clean scan;
no unrelated design system changes were made. Fresh independent review cleared
the mode-lifecycle correction: both native modality directions, retained answer
and 350px reading offset, one generation, released inertness and preserved draft
and outside focus. Its focused checks passed 5 density/reader cases, 10 reader
ownership cases and 11 units; these are separate runs, not an aggregate suite.

## PR-hosted screenshot evidence (2026-10-23)

The user moved screenshot ownership to the [PR #519 description](https://github.com/tjakobsson/uatu/pull/519). Earlier completed capture tasks record historical work; they do not require keeping PNG copies in the current repository tree. Preserve the original captions and capture/privacy limitations without presenting these historical frames as current-head renders.

- [x] Transfer all 15 original feature screenshots to GitHub PR attachments, verify their downloaded bytes against the reviewed originals, and remove the tracked PNGs without rewriting published history.
- [x] Keep opt-in capture assertions and timing intact while writing future captures to ignored Playwright artifacts/report attachments; align the text-only guide and independently review the migration.

## Mobile picker and release-critical critique follow-up (2026-10-23)

The user confirmed that the iPhone model list was clipped and approved rendered WebKit/Chromium regression coverage, including reduced-height and restored viewports, scrolling and model selection. The subsequent independent design critique selected only the two release-critical follow-ups below; side-answer history and control typography remain outside this correction.

- [x] Restore usable model-list space after Chat's deferred viewport layout and in short touch viewports, preserve complete touch targets, and independently review the browser regression and fix. Physical-iPhone acceptance remains user-owned.
- [x] Make active versus next-turn configuration explicit before steering without changing native admission semantics, staged configuration, or the fixed keyboard delivery contract; verify through rendered UI and actual fixture admission.
- [x] Report unsaved personal chat preference changes accurately and preserve/reconcile dirty choices during refresh, Save and conflicts; verify with isolated Hub UI fixtures while preserving account and revision protections.
- [x] Remove the upstream-inherited generated Impeccable report and ignore future critique snapshots, keeping intentional project rules and unrelated local artifacts intact.
- [x] Recheck feature screenshots against the final reviewed source, show only current captures in the PR as subsequently requested, and obtain approval before publishing the refreshed description and images.

Two fresh independent Sol reviews found no Standards breaches or Spec violations
in the correction delta; an optional local-variable rename was not a release
blocker. Final combined checks passed typecheck, 554 focused unit/API/policy
tests, 14 browser cases across Chromium/WebKit desktop/touch with zero retries,
and all 60 strict OpenSpec checks. Separate implementation runs covered adjacent
configuration, delivery, picker, header and touch cases; they are not added to
the combined count. The native viewport-restoration regression reproduced a
stale 304px picker after Chat returned to 648px; the fix restored 648px and seven
complete rows. This is browser evidence, not physical-iPhone acceptance.

The user approved the current-only description shown directly in chat. The PR
now contains 17 current captures from `6522fe5`, including restored-picker and
next-turn-configuration frames, without a separate historical gallery. All 17
anonymous attachment downloads match the captured source bytes; one identical
preferences image reused its attachment. Independent publication review cleared
the images, captions, provenance and documentation. Title and ready status are
unchanged. Remote CI and CodeQL passed for `6522fe5`; the second browser leg first
timed out downloading Ubuntu dependencies before tests, then passed on a fresh
runner without changing tests, workers, retries or timeouts.

## Archive disposition (2026-10-31)

[@addiberra confirmed that both remaining changes are implemented and should be archived](https://github.com/tjakobsson/uatu/pull/571#issuecomment-6542184300). The two stale checklist entries above are closed by reconciling their historical blockers with the later results and this explicit archival decision. No new runtime, browser, physical-device or independent-review run was performed for this bookkeeping update.

Supplementary physical-device checks are not required at @addiberra's request. The user-reported iPhone acceptance remains limited to its original scope; it is not evidence that every later mobile correction, Android behavior, assistive technology or Dynamic Type was tested. Earlier WebKit activation stalls and uncompleted expanded-card acceptance remain testing limitations. Later scoped Chromium/WebKit passes and remote CI do not retroactively turn those blocked runs into passes. No additional audit or follow-up audit issue is required.
