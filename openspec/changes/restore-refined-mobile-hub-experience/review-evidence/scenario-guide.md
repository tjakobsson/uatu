# Synthetic frontend scenario guide

2026-09-10. **Mock backend; do not enter real credentials. Awaiting user review.**
This reconciles every H01–W03 screen and R01–R11 journey in `screen-map.md` with
the implemented frontend. P = pictured, D = derived, E = unpictured extension.
Those letters describe provenance, not approval. All E designs and exceptions
below remain open review items. Tests demonstrate synthetic intent/presentation,
not live authentication, cryptography, Git, filesystem, provider or PTY behavior.

## Entry, fixture and controller

Local-only reviewer: `http://127.0.0.1:4703` when explicitly started.
Product `/`, separate `/review/controller`, evidence `/review/evidence`.
Private review access details were removed. This scenario record predates the
connectivity-only phone confirmation in `handoff.md`; it does not verify current
remote access. An optional public origin requires explicit local runtime configuration.
Simulation login is **reviewer / review-only**. Use disposable opaque key text,
passphrases and tokens only (for example `disposable-review-only`). Generated
public strings say `SYNTHETIC-PUBLIC-ONLY` and are unusable keys. No secret is
stored/compared by the model; unlock success is a controlled outcome, not proof
of a correct passphrase. Management File transport sends size only and creates
a zero-filled placeholder; Chat uploads exercise the actual File/client owner.

The controller has exactly nine reset scenarios:

| Scenario | Review purpose |
|---|---|
| `mixed` | Default running Atlas (`atlas`), stopped Notes (`notes`), full catalog, no assignments. |
| `empty` | No registrations/credentials; tools and browse tree remain. |
| `signed-out` | Login; protected reads fail without disclosing metadata. |
| `branches` | Named, unborn, detached, non-Git, loading, unavailable; duplicate labels with distinct paths/ids. |
| `credentials` | Atlas projected `token-github`; Notes locked SSH auth and OpenPGP signing. |
| `nested` | Running `nested-parent` and `nested-child` under `/synthetic/group`. |
| `unavailable-tools` | Missing tools and incompatible Git. |
| `all-running` | One running group. |
| `all-stopped` | One Ready to start group. |

Reset replaces synthetic state, jobs, faults, clock and pending gates; old calls
cannot commit into the new model. Reload the product to start a fresh journey.
The separate controller shares this server model, not a second browser fixture.
Select a **Control** and paste its **Arguments JSON array**, not an object/RPC:

| Control | Argument array / use |
|---|---|
| `hold` | `["readCredentials"]` (then open Settings); `["submitClone"]` or `["cancelClone"]` for admission/cancel races. |
| `settle` | `["readCredentials",false]` releases successfully; `["generateSsh",true]` releases a synthetic failure. |
| `fail` | `["signIn",{"kind":"rate-limited","retryAfterSeconds":30}]`; `["renameWorkspace","indeterminate-after"]`; `["submitClone","indeterminate-before"]`; `["readCredentials",null]` clears that fault. |
| `advance` | `[1000]` advances stable model time; not browser animation time. |
| `setKeyState` | `["ssh-locked","unlocked"]`; enums locked/unlocked/unprotected/unavailable. |
| `setCredentialAvailable` | `["ssh-locked",false]`, independent of enabled. |
| `setCredentialFactsUnknown` | `["ssh-locked",true]`; no diagnostic inference. |
| `setOpenPgpUserId` | `["pgp-locked",null]` means unknown; a disposable string supplies a known ID. |
| `setToolState` | `["git","missing"]`; ready/missing/incompatible/runtime-unavailable. |
| `setToolConfigurationUnknown` | `["git",true]`; saved override is not detected path. |
| `setDeviceInventory` | `["multiple"]`, `["empty"]`, `["current-only"]`. |
| `setStopFailure` | `["notes",true]`; cancellation/partial-stop review. |
| `setUnlockFailure`, `setImportFailure` | `[true]`, then `[false]` for recovery. |
| `setFolderAvailable` | `["/synthetic/denied",false]`; saved-default fallback remains explicit. |
| `setFolderFault` | `["before-mutation"]`, `["after-stop"]`, `[null]`. |
| `setOnboardingFault` | `["needs-init"]`, `["credential"]`, `["git-init"]`, `["register-failed"]`, `["retained-checkout"]`, `["committed-recovery"]`, `["start-failed"]`, `[null]`. |
| `setCloneCleanupFailure` | `[true]` for cancellation with retained checkout. |
| `cloneOutput` | `["ACTUAL_ACCEPTED_JOB_ID","progress"]` or `"prompt"`; no arbitrary output injection. |
| `clonePhase` | `["ACTUAL_ACCEPTED_JOB_ID","registering"]`; cloning/registering/starting, subject to valid progression and original Start intent. |
| `finishClone` | `["ACTUAL_ACCEPTED_JOB_ID","succeeded"]`; clone-failed/register-failed/start-failed/cleanup-failed/cancelled/timed-out are distinct outcomes. |
| `disconnectClone`, `expireClone` | `["ACTUAL_ACCEPTED_JOB_ID"]`; disconnect is not cancellation. |
| `expireCloneAttempt` | `["ACTUAL_ORIGINAL_ATTEMPT_ID"]`; pending/expired/unavailable never authorize blind retry. |
| `invalidateAuthentication` | `[]`; protected retention is revoked immediately. |

Use **Refresh public state** for actual accepted job/attempt ids and sanitized
method/outcome logs. Placeholder ids above must be replaced. `upload-hold`,
`upload-settle`, `upload-fail`, `chat-output`, `terminal-output` are separate
protocol buttons. Invoke them while the actual Chat/xterm clients are mounted;
they do not execute a provider or shell. All controls are explicitly allowlisted;
unknown workspace contracts return **501**, never a generic successful fallback.
Exact enums/semantics: `tests/mobile-hub-review/backend-guide.md`, `controller.ts`,
`backend.ts`, `management-model.ts`, `protocols.ts` and the two protocol models.

## Route/action and design inventory (complete screen map)

Canonical Hub routes are `/`, `/settings`, `/clone`. Focused destinations use
`?detail=KIND` and, only for credential/workspace, `&id=STABLE_ID`. They are safe
frontend history context, not new public backend endpoints. Sheets are actions
within their owning view, not invented addressable routes. Identity is a sheet.
Tests below are under `tests/mobile-hub-review/` unless stated otherwise.

| ID / provenance | Actual route, actions and state/model scenario | Verification / explicit review treatment |
|---|---|---|
| H01 E | Signed-out `/` or protected destination: masked login, submit, invalid/rate-limited/unavailable and retry; public username retained, password cleared, safe return context. | `management.e2e.ts`, `exceptional.e2e.ts`, responsive: compact grouped login; keyboard/autofill are browser semantics, not physical-device certification. No signed-out version/workspace disclosure. |
| H02 P/D/E | `/`: loading, empty, mixed, all-running/all-stopped, unavailable/retry; host/count and Running/Ready groups. | `frontend.test.ts` in `src/hub/mobile/`, visual/responsive, controller nine scenarios. Reference 01/30; empty/loading/error are E. |
| H03 P/D/E | Dashboard folder/branch rows; Open/Start, name/path/id disambiguation; information sheet includes auth/signing summaries, shell attached/detached/loading/unavailable and restart requirement. | `exceptional.e2e.ts` branch variants; backend model shell/readiness states. Ref 01; subordinate facts are D/E, not omissions or new branch probing. |
| H04 D/E | Ellipsis → information → workspace actions (`/?detail=workspace&id=atlas`): rename display name, assignments, Start/unassigned confirmation/masked unlock, pending/error/unknown check-status, Stop and Forget. | management, exceptional, lifecycle/adversarial suites. Stop is not Forget; Forget removes registration, never files. Cancel has no operation; partial-stop results remain visible. Ref 01/30/31 grammar, destructive sheets await review. |
| H05 P/D/E | Hub/Settings docks; Return appears only after genuine Open and targets stable opened id, not last managed row. Renamed/stopped/missing/unavailable/auth-lost recovery and Back/Forward. | continuity and crossworkspace suites. Refs 08/15/30. Same A detour retains realm; opening B is a new document, not multi-residency. |
| S01 P/D | `/settings`: identity, credential catalog/Add, Workspace settings, Account, More settings, sign out; independent section loading/empty/error; late facts preserve row/focus/form. | credential-clone-contract, visual, responsive. Refs 15/22. More settings placement and density are explicit review extensions. |
| S02 D/E | Settings identity card → Hub identity sheet: authenticated user, host, version. Connecting/unavailable handled by authentication/refresh presentation; not editable identity or invented diagnostics. | frontend unit/management/continuity tests; ref 15-derived grouped read-only sheet. No dedicated reconnect-status detail route. |
| S03 P/D/E | Settings credential group → `?detail=credential&id=…`; `?detail=add-credential` chooser. SSH/OpenPGP/token summaries, enabled, locked/unlocked/unknown; shared-UID advisory/dismissal. | management, exceptional, credential-clone-contract; backend facts. Ref 15; full catalog E. Protection independent of lock; assignment is not readiness. |
| S04 D/E | SSH detail: layered readiness/protection/lock, public key/fingerprint, copy/download, purposes/assignments; generate/import/file-or-secondary-paste (exclusive, 1 MiB), unlock/lock/enable/disable/test/delete and task errors/cancel. | management, exceptional, credential-clone-contract; `flows.test.ts`, `backend.test.ts`. Ref 31-derived detail/task sheets. Original secret nodes cleared, not merely hidden; public material only. |
| S05 E | OpenPGP detail: explicit known/unknown user ID, protection/lock, signing/readiness/tools, generate/import/public/unlock/enable/disable/test/delete. | management imports, exceptional generation/tool errors, facts tests. Same grouped detail grammar; **no individual OpenPGP lock** or SSH purposes. |
| S06 E | Token add/detail: host, username, capabilities, readiness/assignments, test/disable/enable/delete; masked creation and running projected-dependency confirmations. | management, exceptional first-stop/second-failure, lifecycle and CLI-only retained-auth tests. No redisplayed token, public key, lock or passphrase unlock. HTTPS Git versus GitHub/GitLab CLI are separate capabilities. |
| S07 E | `/settings?detail=tools`: tool path/layered readiness, saved override known/null/unknown, absolute synthetic override, Test and clear; retain missing selection. | management, credential-clone-contract; tool sheet pending/rejection/indeterminate regressions. Effective path never seeds an unknown saved override; changing path does not magically repair a binary. |
| S08 P/D/E | `/settings?detail=assignments` or workspace assignments: current edit versus assign-new, authentication/host and signing, role choice, review/Back/Apply, no-op and coordinated removal. | management, lifecycle, exceptional, backend model. Ref 31. Stops precede catalog changes; failed second stop preserves catalog but reports earlier stop. High-risk confirmation is unapproved E. |
| S09 D/E | `/settings?detail=default-folder`: current saved default, browse/edit/save/clear, invalid/unavailable/pending/retry and fallback elsewhere. | exceptional default-folder, responsive/onboarding and model tests. Ref 15 row, E body; display/folder/parent identity remain separate. |
| S10 P/D/E | Settings Preview File Controls / Navigation Handle / Auto-hide sheets: current draft, Cancel/Escape/backdrop, Done, side/vertical/reset, Automatic seven seconds/Keep Open. | frontend/preferences units, motion, responsive/visual. Refs 22/33; storage-denial/other-tab shared owner; unchanged Done preserves exact saved ratio. New/reset face calibrated ≈588px, existing .72 values unmigrated. |
| S11 D/E | `/settings?detail=devices`: label, issued time, current marker; empty/loading/error; revoke other/current, pending/failure and logout consequence. | exceptional/continuity; device inventory controls. Ref 15 row; no “last active” invention. |
| S12 D/E | `/settings?detail=security`, sign-out sheet: existing session and shared-UID explanations, dismissal, failure/focus recovery, expiry/revoke/logout. | exceptional, continuity, adversarial old-auth-response regression. Ref 15-derived; no password rotation, biometric lock or new isolation claim. |
| A01 P/D/E | Plus-led Add Workspace → `/?detail=add-workspace`: existing, create, clone, Back/Cancel. Not a third permanent tab. | management/onboarding units, visual ref 01; chooser is E. |
| A02 E | Add Workspace browse: default parent, breadcrumb/up/elsewhere, loading/empty/denied/retry, selected path, registered/nested markers and folder actions. Existing checkout configuration: distinct name, auth/host/signing, Add stopped or explicit Add and start. | management, exceptional, model tests; `/synthetic/existing`, `/synthetic/denied`, `nested`. No real filesystem access. Registered-folder admission is idempotent, not rename/reassign/start. |
| A03 E | Create folder versus Create workspace with Git-init consent; parent/folder/display/assignments; rename and empty removal, nested registration warnings, invalid/collision/pending/after-stop/partial failure. | management, exceptional nested rename/removal, backend tests. Grouped browse/detail and task sheets; no simulated shell command execution. |
| A04 D/E | `/clone`: remote, destination, folder/display name, one-time identity versus retained auth/host/signing, requested Start. Review/Back/dirty-exit keep/discard and Settings detour retain non-secret draft. | management, credential-clone-contract, clone-monotonic, flow units. Ref 32 recovery only; full form E. Embedded URL secrets cleared before retention, including malformed SSH URIs. |
| A05 P/D/E | Clone locked selection → separate masked unlock/error/cancel → unchanged form; authorized continuation once with a fresh attempt after requires-unlock. Disabled/missing/incompatible is not “none”. | management, credential-clone-contract; ref 32. No demo-passphrase policy, independent unlock creates no job. |
| A06 E | Attempt pending/accepted/not-accepted/expired/unavailable; accepted job stream, sanitized progress, any-prompt masked input, clear-on-send, cancel pending, disconnect/replay/reconnect/expiry. | credential-clone-contract, clone-monotonic, exceptional, model tests. Owner-bound reload hint contains no secrets; stale lookup cannot regress accepted state. Navigation is not cancellation; Send only in authoritative cloning, and input uncertainty blocks duplicates. |
| A07 E | Clone-failed/register-failed/start-failed/cleanup-failed/cancelled/timed-out; retained checkout versus configured stopped workspace; terminal wins held cancel; onboarding needs-init/credential/git-init/registration/committed recovery faults. | management + exceptional terminal/race cases, backend/flow tests for exhaustive model branches. Grouped terminal outcome/recovery actions; browser reachability does not imply every validation cross-product is exhausted. No absent registration → safe retry inference. |
| W01 P/D | `/s/<registered-running-id>/<fixture-document>`: actual Files tree/panes/filter/search, Preview rendered/source/diff/layout/find/siblings, Chat draft/File/stream/queue/attention, Terminal panes/keybar/scroll/output. | clients, continuity, workspace-interactions, crossworkspace. Actual Chat Send/queue/cancel/new conversation and xterm new/close supported synthetically. Extensive search/diff corpus, other providers and full client capability matrix are **not fully fixture-verified**; see limits below. Refs 02–07/09–10/16–17 preserve interiors, not prototype replacement. |
| W02 P | Existing selector expanded/Close/collapsed, seven-second interaction-aware idle, held-pointer/focus, outside dismissal/Keep Open, drag/keyboard/right/clamp/attention, reversed local fade, reduced motion. | motion, visual, continuity and existing navigation-owner tests; refs 04/07/09–14/16–17/33. 44px targets, reference-calibrated fresh default, no stored-position migration. |
| W03 P | Preview-only Files/Previous/Next pill left/right, selector raised/lowered, first/middle/last/single, index pending/error, timeout/missing target/retry and Files reveal. | visual and sibling/load-generation units; refs 18–27. Synthetic extended corpus and explicit index/document errors; absent outside Preview. Boundary SVG reference interiors replaced by current Markdown, not painted replicas. |

## R01–R11 walkthrough and evidence ledger

| Journey | How to exercise / tests and observed scope |
|---|---|
| R01 | Reset signed-out; reject login, recover with simulation login; reset empty/mixed/branches and inspect hierarchy/info. `management.e2e.ts`, `exceptional.e2e.ts`, visual and responsive pass. |
| R02 | Open Atlas, use each Files/Preview/Chat/Terminal surface, Hub → Settings → detail → Return twice. `continuity.e2e.ts` asserts exact real scroll owners, one boot and same sentinel/surface; motion tests cover interruption. |
| R03 | `upload-hold`, attach harmless File and type unsent Chat text; detour, then `upload-settle`/`upload-fail`. clients/continuity assert actual File identity, draft, one upload and transport—not copied filenames. Credential-import clearing tested separately. |
| R04 | While Hub visible press `chat-output`/`terminal-output`, Return; use real Send, queue another message, cancel turn, New conversation; Terminal switcher New terminal and confirmed Close pane. clients/continuity/workspace-interactions verify synthetic streams and actual owners; pending Preview uses existing selection generation. No provider/PTY execution. |
| R05 | Open A, manage B, Back/Forward, rename/Stop/Forget/revoke/401; hold old reads/Start/unlock. continuity, lifecycle-regression, adversarial-lifecycle, clone-monotonic and crossworkspace pass. Any known registered running B opens with a **new document, own protocol and personal state**; newly registered started ids supported; stopped/missing direct entry never starts. Reload is a boundary. |
| R06 | Traverse every S01–S12 destination/action above; use credentials/unavailable-tools, hold/fail, current/other revoke. management, exceptional and credential-clone-contract pass, including formerly missing browser cases (OpenPGP generate, SSH lock/unlock failure, projected-token partial stops, rate limit/devices). Exhaustive model validation is not exhaustive browser permutations. |
| R07 | Traverse A01–A07 with nested/denied/empty/collision/default fallback; clone independent unlock, masked prompt, disconnect, terminal outcomes, expiry and finish/cancel races. management, exceptional, clone-contract/monotonic and model tests pass. Recovery is simulated, never live filesystem/journal proof. |
| R08 | Compare named expanded/collapsed/Return/pill images; change both preference sheets, drag/keyboard/reset/no-op Done, Keep Open, focus/held input and rapid Return. motion/visual/navigation tests pass; current optical differences remain review items. |
| R09 | Responsive matrix 320×740, 390×844, 844×390, 820×1180 × both engines × light/dark × 100/200% scoped text stress; login, sheets, credential error, assignment, onboarding recovery, keyboard-height/focus and media checks. 1102 pass, 0 fail, 0 untested, 1 unsupported WebKit reduced transparency. Not physical keyboard/Dynamic Type/VoiceOver. |
| R10 | Production-entry bundle and desktop/standalone checks; desktop Hub routes, native web inset +72px; hidden input/geometry and same base path tested. `isolation-*`, `compatibility.ts`, continuity pass within scope. Exact dirty pre-change all-four-interior parity remains a named gap (task 7.4), not accepted omission. |
| R11 | Controller separate from product; inspect sanitized logs/capabilities, unsupported routes 501, traversal/host/origin rejection, reset stale gates. backend/protocol/server/transport/hosting/manage tests and emitted production-bundle isolation audit pass. No live cookies/proxy/privileged fallthrough. Remote serving remains pending. |

## Open UI exceptions and coverage boundaries (not accepted omissions)

1. **Unpictured design families:** login/loading/error; identity/readiness/catalog;
   credential/tool/assignment/default-folder/device/security details; destructive
   stop/revoke/delete confirmations; browse/create/clone/recovery; responsive,
   contrast and keyboard stress. All use grouped read-only facts, focused detail
   pages, scrollable task sheets, explicit primary/Cancel and contextual outcome
   messages. This describes implemented candidates, not preapproved designs.
2. Settings puts handle/tools/assignments in **More settings**; credential/shell
   facts live in details/information rather than crowding dashboard rows. Identity
   has a read-only sheet, not an editable profile or separate reconnect page.
   Review this information placement explicitly; no capability is silently waived.
3. Visual review-ready evidence: **50 reference comparisons + 6 extensions**,
   400 earlier files preserved. Settings Workspace group remains **+7.52px**;
   minor dock/icon/font/material differences and visible WebKit focus ring remain
   presented for review. Current branding/synthetic data substitution is not a
   blanket geometry tolerance. Pixel percentages are measurements, not acceptance.
4. Source images include historic SVG/other interiors; current Markdown and
   synthetic metadata are intentional comparison substitutions. Preview current
   standalone/integrated pixels are identical in both engines; upper Preview and
   Terminal comparisons to earlier current captures have no channel deltas >16
   but Chromium is not exact equality. Files/Chat and exact pre-change all-four
   interior comparison remain unproven. Baseline has only an aggregate of dirty
   source, not recoverable per-file pre-change snapshots.
5. Desktop Chromium login/dashboard differ by tiny counts at channel delta ≤5;
   stopped is exact. Settings/Add data/dimensions differ, SSH-expanded Settings
   not recaptured, and no pre-change WebKit golden exists. Native +72px inset is
   browser-tested, not SwiftUI/Keychain/native process validation.
6. All management operation families are implemented in the typed synthetic
   model and reached through forms/tests; full browser validation permutations
   are not exhaustive. Workspace search/global search, extensive source/diff/git
   corpus, rich rendering/binary/media, all Chat providers/models/permissions/
   questions/tools/attachments/replay branches and terminal pane/keybar edge cases
   are existing capabilities, **not claimed fully fixture-verified or live**.
   Provider archive/steer and terminal rename are not current client APIs; this
   review invents none. Unknown requests fail 501 rather than pretend support.
7. Historical visual post-Return pointer interception and HTTP/SSE idle/readiness
   stalls remain disclosed in original reports. Later motion/pointer regressions
   and successful recaptures pass; they do not prove every harness stall's root
   cause. Responsive final runner uses Connection: close and longer readiness
   waits, not a claimed product transport repair.
8. No physical phone keyboard, Dynamic Type, screen reader, OS eviction, live
   services or authorization correctness is certified. Full final browser rerun
   after cross-workspace expansion and remote access/version capture await lead
   update. **User approval and accepted exceptions remain entirely pending.**
