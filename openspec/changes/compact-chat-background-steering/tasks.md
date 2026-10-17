## Current explicit refinement: unified dense worker overview

- [x] Replace nested Finished/history/footer with one compact chevron header, right-aligned Dismiss finished and one keyed active-first list; retain canonical counts, model/Σ usage, persisted hiding and timeline inspection.
- [x] Verify 28px settled rows, independent 44px Stop controls, one scroller and content-sized short/empty cards across phone/keyboard/landscape/short-desktop matrices, with screenshot comparison.
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

- [x] 7.1 Test and implement fixed-target tap-to-steer / two-second automatic Queue with early-hold cancellation, lifecycle/draft/selection guards and accessible split-menu fallback; retain keyboard delivery preferences and authoritative Hub policy.
- [x] 7.2 Test and implement inline attachment and actual model/mode/effort/context pill using the existing chooser and occupancy readout; verify phone, keyboard, landscape, tablet and desktop budgets.
- [x] 7.3 Test and implement dense canonical worker rows with real model/cumulative usage, active-first ordering and persisted view-only Dismiss/Restore finished using the existing dismissal seam.
- [x] 7.4 Verify pinned native V2 side-generation and TUI /btw semantics, implement a capability-gated side answer if it cannot execute agent tools or mutate foreground/history; otherwise report the specific blocking decision.
- [x] 7.5 Align approved mock (remove redundant still-frame footer), specs and CHAT documentation; run clean CI, type/build/API/strict-spec checks and relevant Chromium/WebKit browser evidence. Independent review/publication/deployment remain lead-owned.

## 8. Approved redundant-control cleanup (2026-10-17)

- [x] 8.1 Remove top Options trigger/panel, relocation wiring and dead styles; keep the real inline picker, attachments, standalone Continue/help and unique account usage reachable without duplicate touch context/model presentation.
- [x] 8.2 Remove Send delivery dropdown; preserve two-second pointer Queue, cancellation guards, existing keyboard preference/Alt+Enter and touch newline, adding described Space-hold Queue with native quick Enter on Send.
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
  short keyboard/landscape, desktop, enlarged text, light/dark, two-second hold,
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
- [x] 10.4 Grow the viewport-owned pointer-transparent envelope from 56px to 104px with bottom-up fill and an above-finger countdown. Preserve fixed target, two-second exactly-once dispatch, all cancellation guards and reduced-motion information.
- [x] 10.5 Run all 202 steering/worker/hold/mobile-layout browser checks successfully, including all prior 47 hold checks. Capture light/dark phone, 380/450px portrait and 230px landscape frame/occlusion evidence; retain existing 480px desktop, safe-area, focus and anchor coverage.
- [x] 10.6 Validate clean isolated unit CI (5,278 pass / 16 skip), API (208 pass), typecheck, build, contract structure and strict specs (60 valid). Native macOS watcher timing failures in intermediate runs passed isolated and in the final owned-temporary-directory CI run; no observer tests or product behavior were changed.
- [ ] 10.7 Resolve wider-suite pre-existing blockers before declaring the entire chat suite green: 637 functional passes / five failures reproduced on unchanged c2641ce (desktop configuration-details expectation; two hidden-child responsiveness cases; two touch-child shell cases). Performance adds 16 passes / four touch-child setup failures using the same unchanged hidden desktop-worker selectors. Preserve these tests; lead review decides their separate correction. Native iPhone/Safari hold/callout verification remains unperformed.

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
