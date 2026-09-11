# Frontend implementation progress

## 2026-09-11 — focused folder picker published

Full-page Cancel/current folder/Choose now separates read-only directory selection
from Add Workspace → Manage folders. The actual picker module is also available
in `/review/design-system`; the hosted guide documents its restricted backend
capability, draft behavior and remote Hub filesystem scope. See
`folder-picker/verification.md` for design sources, workflow evidence and limits.

Final focused checks: **384 tests / 3772 assertions**, both typechecks pass;
**10/10 picker cases** across Chromium and WebKit (20.5s, no retries/skips), plus
**2/2 Chromium reference cases** (4.2s). The earlier assertion/type adapter issues
are reconciled. Browser JSON now uses an explicit repository evidence path rather
than a config-relative duplicate tree. These scoped passes do not certify the
broader current full-app matrix, physical iOS behavior or approved pixel goldens.

Scoped restart stopped only prior review PID **90418**, then verified new PID
**89753**, instance **1c84eea3-59af-4ebf-9cb8-618472826b28** on loopback 4703.
Frontend fingerprint:
`sha256:950c3438aa9847910394485417cf27e112eb80241ed4be887f4b8265e7fc86bc`.
Independent reference fingerprint:
`sha256:411392257fd588f01fc0ca38555e8798c64b8790e3b3e3c65ffd2614ad6bacb0`.

Local HTTP returned 200 for product, Settings, `/?detail=folders`, reference,
guide, evidence, acceptance, handoff and picker verification routes. All **20**
allowlisted picker artifacts (18 PNGs, verification and browser JSON) were fetched
and matched the served manifest's sizes and SHA-256 values. Evidence snapshot:
**2026-09-11T10:08:49.754Z**. Served browser JSON confirms 10 expected, zero
unexpected/flaky/skipped. Tailscale mappings remain unchanged at 443→4700,
8443→4701, 8444→4702 and review 8445→4703. Phone connectivity was confirmed for
the earlier review; no fresh physical-device validation is inferred here.

**60/66 tasks complete.** Still open: 7.1, 7.4, 8.3, 9.6, 10.4 and 11.4.
No dependency installation, commit/push, live integration, spec sync or archive.
The isolated candidate is ready for renewed user visual/interaction review;
approval and accepted exceptions remain unrecorded.

## 2026-09-11 — shared design system and reference published

The approved small Web design system is documented at
`design/hub-mobile/design-system.md` and implemented through shared semantic
primitives, `tokens.css`, consolidated recipes and existing lifecycle owners.
Actual frontend callers use those primitives. The separate reference page is
available at `/review/design-system`, with its source guide at
`/review/design-system/guide`; neither is product Settings or a backend mutation UI.

**372 tests passed / 3566 assertions**, both typechecks pass. A Chromium reference
interaction/responsive run passed; the latest follow-up failed during page setup
before actions. Full current cross-engine/physical-device/golden gates remain
open. Details and independent fingerprints are in `design-system.md`.

Scoped restart stopped only review PID 85093 and started PID **90418**, instance
**918746ec-614c-457d-b618-6849cf5af1c8**. Product fingerprint:
`sha256:b0f0e5a6ed242178693a57480648f7c0e8f8d85a676812b40b44209975205d1c`.
Reference fingerprint:
`sha256:8031124423f37240b7b43e2393fba177d0e2af018f49cca0c00f070fb2fc151c`.
Settings, reference, guide, manifest and evidence report returned HTTP 200.
Existing Tailscale mappings and other services were unchanged.

**56/62 tasks complete.** No new dependency, framework, commit/push, live integration,
spec sync or archive. The user-approved design-system direction is not visual
approval of every state; current review and historical verification limits remain.

## 2026-09-10 — checkpoint pushed, readability pass published

Before new UX work, committed/pushed **c259efb** to
`https://github.com/addiberra/uatu.git`, branch `design/hub-mobile-navigation`.
The checkpoint excludes private `.local` data, the separate worktree, unrelated
tooling deletions and raw browser outputs. It was not amended. New readability
changes remain uncommitted, as the request was for a pre-work checkpoint.

Current changes/evidence: `readability-update.md` and `readability/final/`.
**359 tests passed / 3030 assertions**; product and review typechecks pass.
Targeted native Chromium checks verified heading-only entry focus, no opening
change/commit events, draft switches, explicit picker selection, structured
review, canonical Devices navigation and notice dismissal. Final capture has
**8 passing supplemental checks / 6 manually inspected images**. Current full
WebKit/physical-device/golden verification remains open, not inherited.

Scoped restart stopped old review PID 84505 and started PID **85093**, instance
**347cc685-7983-46b3-b07f-1c5c029c28ee**. Health matches
`sha256:d9d6b47fa2c48dcd28ac9a17ef376705446dc11cb28cd6168da9636fa9d4b4c9`.
Product Settings/Clone and current evidence/report/images returned HTTP 200.
No live Hub or other Tailscale endpoint was changed.

**52/58 tasks complete.** Existing approval and full-matrix/evidence gates remain
pending. No dependency installation, additional commit, live integration,
spec sync or archive followed the checkpoint.

## 2026-09-10 — direct Settings/full-page editors published

The user explicitly chose full-page editors after rejecting drawers, More menus
and embedded Troubleshooting. Current behavior and verification limits are in
`page-based-settings.md`; older presentations and captures are historical.

**342 tests passed / 2851 assertions**, product and review typechecks pass. Targeted
Chromium task/history/pending-operation checks passed, and a visual-polish run
completed nine checks/four captures. The latest attempted recapture failed during
page creation; it is retained as a failure, not a current full-browser pass.
Cross-engine/current-matrix and human approval gates remain open.

Scoped publication stopped only old review PID 73657 and started PID **84505**,
instance **c469810b-0ca5-4eb7-a1a5-8ca95bc90fee**. Health matches:
`sha256:5ed20838d9c8813222b8a0ffd972efbb916cc698d95611b85c4317a778671d65`.
Settings, credential entry, current report and selected full-page screenshots
returned HTTP 200. Existing Tailscale mapping and other services were unchanged.

**47/53 tasks complete.** Pending: 7.1, 7.4, 8.3, 9.6, 10.4 and 11.4. No live
integration, dependency installation, commit, spec sync or archive. Refresh the
review page for this candidate; no visual acceptance is inferred from the chosen
interaction model.

## 2026-09-10 — Settings conventions and cold-entry refinement published

The user's examples superseded blanket lower-half placement in Settings.
Conventional top Back, grouped editing, purpose-led credential/tool status and
the reproduced initial-navigation defect are addressed. See
`settings-refinement.md` for current changes, screenshots and verification limits.

Latest lead checks: **312 tests passed / 2605 assertions**, product and review
typechecks pass; **6 targeted Chromium browser cases passed** across Settings,
credential/tool behavior and actual delayed cold entry. Full current WebKit and
two-engine matrix remain pending; older green matrices are not inherited.

Scoped restart stopped only owned review PID 52738 and started PID **73657**,
instance **2a4efdcf-f36e-4645-817f-9ba37641dbee**. Served fingerprint matches the
prebuilt candidate:
`sha256:5f6115996f542903e293e7f6d575b381eef2a7a43c02a3ce20c9752c7862bd41`.
HTTP product/Settings/workspace entry and current report/screenshots all returned
200. Tailscale 8445 mapping and all other services were left unchanged.

**43/48 tasks complete.** Outstanding: 7.1 approved goldens, 7.4 exact historical
interior evidence, 8.3 human approval, 9.6 prior corrective matrix and 10.4 current
integration verification. Source and captures are review candidates, not approved
native iOS behavior or live-backend validation. No dependencies, commits, spec
sync or archive. Refresh the phone page to load this version.

## 2026-09-10 — corrected iOS UX published with verification pending

The user explicitly authorized **“Update review now”** after disclosure that full
browser verification is blocked/incomplete. **39/43 tasks complete**; 7.1, 7.4,
8.3 and corrective full-matrix 9.6 remain open. Publication is not visual approval
or a waiver of the verification work.

The current candidate implements single-home lower actions, compact folder/tool/
device lists, progressive readiness diagnostics, preserved picker/task Back,
reachable contextual errors, clearer clone continuation/cancellation and safe
subordinate fact recovery. See `ios-ux-correction.md` for exact results/limits.
Current unit command passed **253 tests / 2118 assertions**; both typechecks pass.
Full Chromium/WebKit post-correction verification is **not claimed green**.

Verified scoped restart: old owned PID 77148 stopped; new owned PID **52738**,
instance **b2f4fe1c-70d2-433a-ad43-404623e4d0e2**. Health fingerprint matches the
prebuilt candidate exactly:
`sha256:b3027d2471609dc504b2f73bf91d70dc1c37f4626015853d031f878ff40cb0d6`.
HTTP checks returned 200 for product `/`, `/settings`, `/clone`, controller,
evidence index, the correction report and the preserved folder-after PNG.
The existing Tailscale 8445 mapping is reused; 443/8443/8444 and their services
were not modified. Only synthetic state resets with this explicitly authorized
review restart. User must refresh the page for the newly built frontend.

No commits, dependencies, live integration, spec sync or archive. Await renewed
visual/interaction review while keeping the failed/incomplete test evidence.

## 2026-09-10 — phone access confirmed, human review stop

User answered **“It opens”** to the explicitly connectivity-only phone question.
Task 8.1 is complete; no visual/interaction approval is inferred. **33/36 tasks
complete**, with 7.1 screenshot-golden approval, 7.4 exact pre-change interior
evidence limits, and human 8.3 still open. The isolated review remains running.
The scoped manager restart/stop/start/reset workflow was exercised successfully;
frontend fingerprint remained `5d068b5f83df1c1ab78e0d6ab98fc2655735fd81c9bb53bb376b6bbc47fd742e`.

## 2026-09-10 — running review candidate and delivered handoff

**32/36 tasks complete.** Remaining: 7.1 approved screenshot goldens, 7.4 exact
dirty pre-change full-interior proof, 8.1 remote/phone verification, and human
8.3 approval. No open item or visual exception is silently accepted.

Final lead run: `bun test ./src/hub/mobile ./tests/mobile-hub-review` **202 pass,
1602 assertions**; product and review typechecks pass; complete Playwright config
**172 passed in 10.5 minutes**, Chromium/WebKit including cross-workspace tests.
An earlier full-run discovery error in the Bun-only responsive runner was fixed
by making it inert on import; the final run includes that discovery correction.

`manage.ts start` launched owned loopback 4703. `tailscale serve --bg --https=8445
http://127.0.0.1:4703` added only that mapping; prior 443/8443/8444 JSON entries
are unchanged. `served-smoke.ts http://127.0.0.1:4703` passed against the running
instance in both browsers (controller, dashboard, HTTP/SSE, real Terminal
WebSocket, Settings sheet, same-document Return and evidence).

Frontend fingerprint:
`sha256:5d068b5f83df1c1ab78e0d6ab98fc2655735fd81c9bb53bb376b6bbc47fd742e`.
Self-HTTPS curl connected to this node's tailnet IP but stalled in TLS; the same
bounded check on existing HTTPS 443 also stalled. This does not establish a new
frontend fault or a remote pass. URLs/guide/evidence delivered with that limitation;
await user phone connectivity check. Existing services remain untouched.

No dependencies, commits, live backend integration, spec sync or archive.

## 2026-09-10 — documentation reconciliation before launch/handoff

Current task status: **31/36 complete, 5 pending**. Existing completed tasks are
preserved. Newly reconciled completion: 1.4–1.5, 3.1–3.5, 4.2–4.3/4.5,
5.1–5.7, 6.1–6.3, 7.2–7.3. These are scoped implementation/verification criteria,
not a declaration that all pixels, physical devices or live effects are approved.

Pending: **7.1** approved screenshot-golden comparison (reference/measured guards
exist, not approved pixel goldens); **7.4** exact dirty pre-change full interior
proof; **8.1** launch/remote verification; **8.2** actually delivered URL handoff;
**8.3** explicit user approval of served version/exceptions. Stop at the human
gate; no live authorization, production rollout, spec sync or archive.

The approved explicit credential/tool facts and owner-bound clone-attempt seam
are implemented with targeted regressions. Historical proposal/finding text in
earlier reports is superseded by `implementation-review.md`'s current disposition.
`scenario-guide.md` covers every H01–W03 and R01–R11 with routes/actions, actual
nine controller scenarios, model/test evidence, E designs and open exceptions.
`handoff.md` and `acceptance.md` are prepared, **not proof of remote delivery**.

### Latest supplied verification (lead/worker reports, not rerun by doc worker)

| Command / evidence | Result and scope |
|---|---|
| `bun test ./src/hub/mobile ./tests/mobile-hub-review` | Lead: **194 pass, 1471 assertions**. |
| `bun run typecheck` | Lead: PASS. |
| `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json` | Lead: PASS. |
| `bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts` | **168 pass**, Chromium/WebKit, **before final cross-workspace expansion**. |
| `bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts crossworkspace.e2e.ts continuity.e2e.ts` | **32 pass after expansion**. Any registered running known id gets own protocol/personal state in a new document; same-id detours retain realm. |
| Full final browser rerun after expansion | **PENDING lead update; do not inherit the earlier full-suite pass.** |
| `bun tests/mobile-hub-review/responsive.e2e.ts` | **1102 pass, 0 fail, 0 untested, 1 unsupported** WebKit reduced transparency; browser text/focus/viewport stress, not physical keyboard/Dynamic Type. |
| `bun tests/mobile-hub-review/visual.e2e.ts` | Latest review-ready 50 reference comparisons + 6 extensions, computed/mutation guards pass; 400 earlier files preserved. Not accepted goldens. |
| Isolation / compatibility scripts | Emitted production graph separation; desktop/browser-native inset; current Preview pixel-identical both engines; original-entry desktop/touch compatibility. See `isolation/README.md` for exact commands and limitations. |
| Motion/client/continuity and regression suites | Actual scroll/File/client ownership, reversible motion/input, saved handle placement, auth/Stop/clone races, credential/onboarding exceptions and Chat/xterm actions verified in reported browser runs. |

Counts above are separate scoped runs, not a combined total. Old README counts,
type blockers and “remaining browser matrix” lists are historical checkpoints;
exceptional/contract/lifecycle suites now reach those management families.
This does not turn model validation into exhaustive browser permutations.

Visual exceptions remain **unaccepted**: Settings +7.52px group rhythm and small
icon/font/material/dock differences; current branding/data/interior substitutions
and focus states are disclosed. Current Preview exact and earlier upper Terminal
comparisons do not recover the dirty pre-change four-surface baseline. Desktop
Chromium login/dashboard max channel difference ≤5, stopped exact; Settings/Add
fixture differences remain. Native +72px web inset is not SwiftUI validation.
Extensive search/diff corpus/other-provider capabilities are not fully fixture-
verified or live. Unknown requests fail 501, not fake success.

No service/port exposure is claimed by this documentation pass. Candidate URLs
and scoped manager commands are in `handoff.md`; served source version/frontend
fingerprint and remote access fields await the lead's post-launch record.

Documentation verification: `git diff --check` passed; explicit inventory counts
are **27 screen rows and 11 journey rows**; task count is **31 checked / 5
unchecked**. This worker edited exactly the five owned review documents and
`tasks.md`, with no code/spec/runtime changes or independent test rerun.

## Historical entries below

Earlier completion counts, blockers and “no URL yet” statements describe their
recorded checkpoints, not the current prepared candidate or implemented state.

## 2026-09-09 — integrated mock frontend, review findings pending

Overall **9/34 tasks complete**: foundations 1.1–1.3, runtime 2.1–2.4,
one-workspace core round trip 4.1, and ongoing Chat/File/terminal ownership 4.4.
Other frontend/flow/continuity tasks have substantial implementation but remain
unchecked pending corrections and full verification. See
[implementation-review.md](implementation-review.md).

Reusable views, all management flow families, synthetic model, coordinator,
actual workspace clients, typed test transport and separate controller now run
together. Optional foreground/history seams were added to existing workspace
owners; full default-entry non-regression verification remains outstanding.
Original references/archive remain unchanged. No live adapter is connected.

Latest lead-executed verification:

| Command | Result |
| --- | --- |
| `bun test ./src/hub/mobile ./tests/mobile-hub-review` | 119 pass, 0 fail, 993 assertions |
| `bun run typecheck` | Pass |
| `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json` | Pass |
| `git diff --check` | Pass |
| `bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts` | First attempt hit caller's 120-second timeout after 29 passes; not a suite pass. Verified and stopped only orphaned review launcher PID 78529. Rerun with 300-second allowance: **50 passed**, Chromium/WebKit, 3.0 minutes. |

Visual discovery captured 16 actual states/comparisons and caught three kinds of
deliberate regression in both engines, plus unresolved visual differences. This
is evidence, not approval. No review service is intentionally left running, no
Tailscale exposure configured, no dependencies installed, no live operations,
spec sync/archive or commits. Human task 8.3 remains unchecked.

Implementation pauses for the frontend-seam decision in the review, not live
integration authorization. In-scope correctness and visual fixes remain required;
no exception has been silently accepted. Earlier entries below are historical.

## 2026-09-09 — foundation, comparison normalization resolved

Completed task 1.2: `src/hub/mobile/backend.ts` defines a type-only reusable
frontend seam. Colocated tests cover unsupported credential actions, exclusive
import sources, branch facts, coordinated stop results, explicit Git-init
consent and partial clone/onboarding outcomes. A browser bundle of the contract
is empty: no fixture or privileged runtime imports.

Completed task 1.3: [integration-map.md](integration-map.md) records scoped
coexistence changes and current feature owners. This is an audit, not implemented
or browser-verified continuity.

Completed task 1.1 evidence: baseline preservation, all 49 state mappings and
user-approved comparison normalization are recorded in [index.md](index.md).
Installed Playwright iPhone 12/13 descriptors were verified as screen 390×844,
default browser viewport 390×664, DPR 3 (landscape screen 844×390). The approved
full-screen comparison dimensions are explicit overrides, not browser defaults.
780×1688 PNGs normalize to 390×844 / 2, 640×1480 to 320×740 / 2, 1688×780 to
844×390 / 2, and 390×844 images to 390×844 / 1; the six documented large-text
images remain at / 1. 320×740 is a stress viewport, not a named iPhone. The two
crops are historical preservation only, not viewport goldens. Exact historical
DPR is still unknown: approved 2× output scale does not assert native DPR 3.
Original `baseline.json` hashes are preserved. The lead owns the task checkbox.
No frontend visual comparison has passed; normalization approval is not frontend
implementation acceptance.

### Task 1.1 normalization follow-up verification

- `bun test ./openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.test.ts`:
  **3 pass, 0 fail, 215 expectations**, 1 file, 102ms (Bun 1.4.2).
- `git diff --check`: **pass**, exit 0. This checks tracked whitespace only;
  the focused test validates the evidence state rows.
- This follow-up edited only `index.md`, `baseline.test.ts` and `progress.md`
  with `apply_patch`; it did not edit `baseline.json` or `tasks.md`. The earlier
  preservation verification below remains historical, not a newly claimed pass
  over the lead's intentional task-checkbox changes.

### Verification executed by the lead (before normalization approval)

| Command | Result |
| --- | --- |
| `bun test ./src/hub/mobile/backend.test.ts ./openspec/changes/restore-refined-mobile-hub-experience/review-evidence/baseline.test.ts` | 6 pass, 0 fail, 201 assertions |
| `bun run typecheck` | Pass |
| `git diff --check` | Pass |
| `openspec validate restore-refined-mobile-hub-experience --strict` | Valid |

### Changes relative to the immutable baseline

- Added only the new `src/hub/mobile/backend.ts`, its colocated test, and this
  change's `review-evidence/` files.
- Updated only task 1.2/1.3 checkboxes in the pre-existing `tasks.md` after
  completion/verification. This intentional edit will fail the original
  preservation manifest; do not replace its hashes to hide that delta.
- Original references, archives and pre-existing product changes were not edited.
  The agent's preservation check before the task checkbox edit passed with only
  the explicitly new `src/hub/mobile/` directory excluded.

No services were launched, dependencies installed, live adapters connected,
production operations executed, specs synced, changes archived or commits made.
There is no frontend review URL yet. Tasks 2–8 remain pending; human approval
task 8.3 remains unchecked and cannot be completed by these test results.
