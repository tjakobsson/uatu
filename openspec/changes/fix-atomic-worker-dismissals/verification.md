# Verification

Results below are chronological. The latest correction section gives the current affected-check results; earlier broad runs are not claims about later edits.

## Reproductions and regression loops

- Baseline `ea18b6e9`: `UATU_EXPECT_DISMISSAL_SUCCESS=1 bun test ../dismissal-probes.test.ts --test-name-pattern '20-page'` failed: expected 200, received 503. The baseline characterization suite had five passing tests; a 285-worker/three-page batch made 858 child-page reads and 285 intermediate visibility states. The external probe is retained as a historical old-protocol fixture, not a current regression suite.
- Before implementation, `bun test src/chat/adapter.test.ts --test-name-pattern 'compact worker evidence'` failed because the compact seam did not exist.
- Before implementation, `bun test src/hub/worker-dismissals-batch.test.ts` failed on the atomic-save and storage-failure assertions because arrays were rejected as invalid mutations.
- Current `bun test src/chat/adapter.test.ts --test-name-pattern 'compact (worker evidence|evidence|V2|fallback)'`: five passed, including a real V2 complete-source read with more than 2400 display messages and a greater-than-four-MiB worker result, changed-source retry and retained fallback-page currentness guards.
- Current `bun test src/hub/worker-dismissals*.test.ts src/chat/worker-dismissal-*.test.ts src/server/routes.test.ts tests/e2e/chat-service.test.ts`: 200 passed, 1121 assertions. Includes atomic read/rename/invalidation counters, 285 finished plus five unresolved, stale/active/foreign target refusal, storage failure, account isolation, admission release, late activity retirement, malformed/partial/capacity evidence, total client alias budget and client selection/observation fences. DTO validation at the child preserves the validation previously supplied by the Hub display-snapshot parser; malformed active rows cannot disappear beside terminal aliases.
- `bun test src/chat/agents.test.ts src/hub/worker-dismissals-api.test.ts src/hub/worker-dismissals-batch.test.ts src/chat/worker-dismissal-evidence.test.ts`: 72 passed, including owner-only dispatch and bare-conversation identity checks.

## Browser and contract checks

- `bun run test:e2e tests/e2e/worker-dismissals-hub.e2e.ts --project=e2e --grep '285 finished workers'`: passed. A mounted client behind the authenticated Hub issued one 285-target POST, changed visibility directly from 290 rows to five, and preserved dismissal after reload.
- Three focused dismissal browser files, four workers: first run 16 passed/one native-request convergence failure; the same Chromium test then passed three consecutive isolated serial runs. A second four-worker run passed that scenario but failed two WebKit cases during login, before dismissal code ran. These remain concurrency-sensitive verification limits, not claimed fixes or dismissed findings.
- `bun run test:e2e tests/e2e/worker-dismissals-hub.e2e.ts tests/e2e/worker-dismissal-recovery-feedback.e2e.ts tests/e2e/worker-dismissal-guidance.e2e.ts --project=e2e --workers=1`: all 17 passed twice; the final run after strict compact-source DTO validation took 51.7 seconds.
- The first broad adapter/agents/V2-provider run overlapped browsers, hit two existing-scenario failures and the command's 120-second execution limit. A fresh `bun test src/chat/adapter.test.ts src/chat/agents.test.ts src/chat/opencode/v2/provider.test.ts` without overlapping browsers completed: 3910 passed, zero failures, 40961 assertions, 425.12 seconds. Later fallback-guard and malformed-source additions are covered by the current focused loops. No product timeout was changed.
- `bun run api:validate`: passed, with the pre-existing `WorkspaceConflict` single-element `allOf` lint warning.
- `bun test api/contract.test.ts api/route-coverage.test.ts`: 36 passed, 719 assertions.
- Strict OpenSpec validation and `git diff --check`: passed.
- `bun run typecheck`: passed after retaining all fallback page guards.

## Limits and handoff

The compact read removes transcript pagination/output transport and per-worker amplification; it does not eliminate provider normalization, existing source/identity/storage bounds or bounded legacy fallback failure. Native covered reads retain the existing runtime lifetime. One coalesced live-invalidation reconciliation can follow a successful explicit bulk operation so another device's later update is not discarded.

Stored version-1 records and singleton first-admission semantics are unchanged. Auth/config/safety settings and live state were not changed. #581 diagnostics remain deferred; live #592/reconnect attribution is not established by these tests. Reconnect work belongs to the separate worker. Existing architecture diagrams are unchanged; no new diagram was introduced.

Fresh independent review remains required and lead-owned. The future fix PR needs the poststable-feature Release Please chore override; no changelog, commit or publication was made here.

Full-repository CI, dependency audit, binary build/smoke and generated-client smoke were not run in this scoped verification.

## Independent-review corrections

The first fresh independent review found two medium blockers. Both were reproduced before correction; a new independent review is still required, so task 4.3 remains unchecked.

1. **Abandoned first batch lost activity during persistence.**
   - Red: `bun test src/hub/worker-dismissals-batch.test.ts --test-name-pattern 'abandoned first batch'` failed both before/after-abort activity orderings: persisted state remained `dismissed:true, revision:0` instead of retired `false, 1`.
   - Cause: request abort released the only target observation reference before the first staged record existed; subsequent activity also had no retained observation owner.
   - Correction: the sole atomic batch write retains independent bounded target observation references until publication or I/O failure. If request admission was already released, commit-owner release schedules captured positive activity against the published records. No new mutation authority or higher capacity is granted.
   - Green: both original regressions pass, disk reload confirms retirement, and a failed abandoned rename releases all commit-owned targets so a fresh group fits the original capacity. The complete batch file has 14 passing tests.

2. **Fallback pagination discarded source-scoped provenance.**
   - Red: `bun test src/chat/adapter.test.ts --test-name-pattern 'older page.s association contradiction'` showed a complete source withholding the contradictory worker while the equivalent paginated source incorrectly authorized dismissal.
   - Correction: bounded fallback is explicitly row-only, preserving all page currentness guards. Any association/origin/hidden-result/fallback/revert/accounting or other opaque metadata requires complete-source coverage; the fallback fails unavailable instead of silently dropping or naively unioning it. All three production providers already supply `completeItems` and keep their existing complete-source reconciliation.
   - Green: the cross-page contradiction refuses with the expected provenance error, and 20 first/older-page metadata cases verify fail-closed behavior. The compact adapter subset has 26 passing tests, including real V2 large-source/currentness controls.

Post-correction checks:

- `bun test src/hub/worker-dismissals*.test.ts src/chat/worker-dismissal-*.test.ts src/server/routes.test.ts tests/e2e/chat-service.test.ts src/chat/agents.test.ts`: **234 passed**, 1231 assertions.
- `bun test src/chat/adapter.test.ts --test-name-pattern 'compact (worker evidence|evidence|V2|fallback)'`: **26 passed**, 40 assertions.
- `bun run typecheck`, strict OpenSpec validation and `git diff --check`: passed.
- The same three browser files with `--project=e2e --workers=1`: **17 passed**, 55.8 seconds, including the 285-plus-five atomic save/reload case.

Only dismissal product/tests/docs were changed for these corrections. No reconnect-owned files, settings, live state, publication or dependency changes were made.

## Subsequent-review fence-ownership correction

A subsequent fresh review accepted the previous two corrections but found that conditional validation allocated fences for staged records before persistence. Ten distinct first-save attempts with `maxEntries: 1, maxBytes: 1` all failed byte capacity yet retained ten unpublished fences, with zero records, authorities or pending admissions.

- Red: `bun test src/hub/worker-dismissals-batch.test.ts --test-name-pattern 'repeated first-save capacity'` failed with expected fence count zero, received ten.
- Correction: conditional validation now reads `fences.get()` without allocating. First-record positive activity remains captured by the unchanged admission/independent commit ownership; fences are created only once a record is retained or published.
- Green: the same regression passes, including ten failed distinct first saves and zero retained fence/record/authority/admission ownership.
- `bun test src/hub/worker-dismissals-batch.test.ts src/hub/worker-dismissals.test.ts`: **67 passed**, 320 assertions, including activity before/after request abort during first rename and abandoned I/O failure cleanup.
- `bun run typecheck`: passed. Heavy suites were deliberately not repeated while the lead's full unit suite was running against the previous version.

Task 4.3 remains unchecked pending another fresh independent review. No source-fallback, reconnect, live-state, settings, dependency or publication changes were made for this correction.

## Subsequent-review strict source-identity correction

Review found that conflicting same-ID worker rows could collapse inside adapter normalization before final evidence validation. The strict validation seam now precedes liveness normalization and row indexing, rather than merely inspecting the surviving compact rows.

- Red: `bun test src/chat/adapter.test.ts --test-name-pattern 'contradictory same-ID rows before dedup'` failed all four initial cases (fallback and complete source, each in both lifecycle row orders): the read resolved instead of refusing contradictory working/ended observations.
- Correction: validate DTOs, row identity/occurrence/association/lifecycle facts and shared exact execution aliases before deduplication. Complete coverage must agree with supplemental visible rows. Validate independently owned recovery arrays before their own index, legacy live inventory before membership collapse, and retained rows before the final source-reconciliation map. Unsettled/id-withheld rows participate in contradiction checks even if they produce no dismissible evidence.
- Compatible duplicates coalesce before later owned recovery is applied. Display text/background display clocks/observation clocks and alias order or primary rotation within one complete proven alias set do not invent contradictions. Existing launcher suppression, legacy terminal alias enrichment and distinct executions sharing a child remain supported. Later owned recovery remains temporally authoritative; no unrelated provider lifecycle precedence was changed.
- Green: the adapter matrix now covers fallback, complete source, recovery and supplemental page conflicts in both orders, plus compatible-history duplicates followed by newer positive recovery. The compact adapter subset has **35 passing tests**, 49 assertions; shared evidence validation has **15 passing tests**, 28 assertions.
- Focused dismissal/routes/agents command: **247 passed**, 1267 assertions. `bun run typecheck` passed.

The source seam validates normalized provider arrays available to the adapter; provider-internal facts already discarded before that interface remain protected by existing provider coverage/currentness requirements, not reconstructed by guesswork.

### Requested existing correlation-test investigation

`bun test src/chat/adapter.test.ts --test-name-pattern 'real V2 lost steer acknowledgement.*covered-with-eviction.*newer native row'` passed both composer and held variants initially and in five further independent invocations (ten additional case executions). The reported missing-requestId failure did not reproduce deterministically. The new validation branches run only for worker-evidence reads; ordinary correlation reads are unchanged. No unrelated correlation product fix or weakened assertion was made. A stable-tree full rerun is still required before calling the earlier concurrent-write full-suite failure resolved.

### Lead-reported broader checks (not final stable-tree claims)

- `bun run check:licenses`: passed, **593 packages**.
- `bun run build && bun run smoke`: passed, including compiled Hub/SPA/worktree/live tests; emitted CSS highlight warnings. This build overlapped duplicate-source correction work and is not verification of the final corrected tree.
- `bun run test:ci`: **9551 passed, 16 skipped, 3 failed**, 465 seconds, during concurrent writes. Two failures were the Hub black-box dismissal fixture still serving the old endpoint plus dependent operation coverage; the lead updated only `src/hub/hub.integration.test.ts` and owns its rerun. The third was the correlation case investigated above. Do not interpret this as a stable final-version suite result.

No Hub integration fixture, reconnect-owned files, live state, settings, dependencies or publication were changed by this correction. Task 4.3 remains pending fresh independent review.

## Latest review: retained-source strength and immutable alias cohorts

The lead froze worktree edits for a stable full run. During that freeze, scratch-only `../dismissal-review-residuals.test.ts` reproduced both findings without modifying product/test files. Implementation resumed only after the lead sent completion/proceed.

### Before these corrections

- Lead stable `test:ci`: **9576 passed, 16 skipped, zero failed**, across 327 files in 463.45 seconds. This run predates the two corrections below and needs a final rerun after review.
- Lead Hub suite after its fixture correction: **81 passed**. The Hub integration fixture remains lead-owned and was not edited here.
- Red repository regressions: the current working source plus older retained terminal cache returned `active:false, dismissible:true`; six shared-exact-alias task/child/launcher/launch-ref/result/task-type conflict cases did not throw.

### Lossy-boundary audit and corrections

1. **Current source vs retained recovery input:** compact reads now process current rows before retained projection rows. Empty/failed recovery may unverify an old retained observation, not current positive, checking or session-active source evidence.
2. **Weak launcher/result supersession:** matching these weak references cannot delete a current protected source row; refusal precedes projection removal.
3. **Late retained-terminal overwrite:** a pre-existing terminal cache row cannot replace current source evidence. The existing covered-read change fence remains required for that overwrite; it is not by itself permission to hide current source activity.
4. **Every final merge/publication path:** a prepublication source-strength assertion compares the final view against captured current-source witnesses. It refuses lost active/nondismissible evidence, changed exact identity/binding, native-to-bare identity fallback or generation loss. Mixed newer/weaker information fails unavailable instead of authorizing dismissal. A subsequent coherent complete source read can establish terminal state; the regression verifies that recovery path. Ordinary chat-history and global event-pump behavior are unchanged.
5. **Source/recovery id indexes and final evidence collapse:** existing strict pre-dedup validation remains in place. Shared exact-alias groups now accumulate compatible immutable association facts, rather than storing only lifecycle signatures. Known facts survive unknown intermediate rows and alias-group bridges. Strong known launcher sets and task/child/result/launch-reference facts must agree; explicitly supported legacy call/result alias enrichment remains available. Cohort knowledge cannot resurrect an unqualified task anchor established to be only a child id. A shared child alone never joins executions.

Native regression fixtures finish independent stream/bootstrap recovery before seeding retained state. This isolates read-owned merging from independent producer publication instead of relying on timing.

### Renewed verification

- Scratch repro: **13 passed** (current working/checking/session-active source over retained terminal state with empty, failed or matching recovery, and four immutable shared-alias conflicts).
- `bun test src/chat/worker-dismissal-evidence.test.ts`: **31 passed**, 56 assertions. Covers immutable shared facts in both orders, unknown intermediates, alias-group bridges, legacy enrichment/child-anchor refusal and the generic non-weakening guard.
- Compact adapter subset: **51 passed**, 70 assertions. Includes 12 retained-state cases, four weaker-recovery paths, unchanged protected projection on refusal, and successful fresh-source settlement after a refused mixed read.
- Focused dismissal/routes/agents command: **263 passed**, 1295 assertions. Prior admission/atomicity/account/fence regressions remain green.
- `bun run typecheck`: passed.
- Three dismissal browser files with `--project=e2e --workers=1`: **17 passed**, 50.7 seconds, including atomic 285-plus-five save/reload and native request recovery.

Source counts, transport bounds, timeouts and stored format are unchanged. No live state, auth/settings, reconnect-owned files, installs or publication were changed. Fresh independent review is still required; task 4.3 remains unchecked. The stable full-suite/build evidence above predates these edits and is not a final-tree release claim.

## Actual normalized replay: native canonical launcher alias enrichment

The lead supplied `../live-worker-source-sanitized.json`, a local sanitized display snapshot containing 745 worker/tool rows. Prompt/output text was removed and tool input replaced by stable hashes; identity/activity/task/launcher facts were retained. This is an **actual live normalized-source replay**, not full covered-provider validation or a successful live dismissal operation. No credentials, live state or browser CLI were accessed here.

### Rejection cause and producer proof

The replay failed first at shared-alias authority-signature comparison, before immutable task-key comparison. There were 41 distinct overlapping-alias pairs: 37 completed/ended/generation-1 canonical rows versus running/unavailable/no-generation shadows, one running/unavailable/generation-1 canonical versus such a shadow, and three completed/unavailable/generation-1 canonical versus such shadows. All were independently inactive/dismissible, same-child, with nested exact aliases and fully contained launcher sets. None had positive activity, a child mismatch, nonnested aliases or uncovered launcher calls.

`BackgroundWorkers` supplies the counterexample to treating every task-key difference as an immutable occurrence conflict: `nativeLauncherTaskId(parent, call)` is call-scoped, but `foldLaunch()` can coalesce calls when complete child execution history proves they share one interval. `workerExecutionIds()` preserves one immutable launch-derived alias per proven launcher. A synthetic repository regression builds both incomplete-history rows and their complete-history canonical row using this actual producer. The old second-call key legitimately becomes a subset-alias shadow under the first-call key. Both this native regression and the actual replay were red before the correction.

### Bounded correction

Same-row, DTO/type and supplemental-coverage validation still runs first and remains strict. Before shared-alias cohort checks, discard only native running/unavailable, result/request/end-free abstentions whose exact native parent/call task recipes, child/agent scope, fully anchored launcher counts, launcher containment, alias containment and known generation/launch-reference facts certify a strictly larger canonical row. Both rows must independently permit dismissal. Known member subagent type cannot be lost. Separately validated recovery can perform the same certified enrichment, including at the canonical call's existing row key; contradictory duplicates within either source still refuse. Alias indexing retains the existing evidence capacity limit.

Positive, checking and session-active evidence on either side still refuses. Arbitrary different task keys, shared-child-only matches, uncovered launchers, incomplete anchoring, incompatible outcomes/results and conflicting known scope/binding/generation facts still refuse. Remaining canonical cohorts must pass the existing strict checks; abstentions cannot bridge them. No completion attribution, native control, Stop proof, lifecycle product code or transport bounds changed.

### Replay and lifecycle limits

- Actual normalized replay: **745 source rows → 704 retained worker/tool rows → 343 compact alias entries**, zero active, all 343 independently dismissible. Entries count aliases, not distinct workers. Exact live identifiers were not copied into repository tests/docs.
- Scratch native producer plus replay test: `../worker-native-alias-replay.test.ts`; the replay remains local sanitized evidence, not a repository fixture.
- Scratch lifecycle characterization: `../worker-unresolved-characterization.test.ts`, **3 passed**. Hypothesized child idle boundaries plus delayed child-only notifications reproduce five unresolved groups, including a two-call canonical group. These boundaries are explicitly synthetic, not facts recovered from the real session.
- `prepareNotification()` currently retains source/child/outcome/summary, not hypothetical call/execution fields. The fixture demonstrates that projection behavior, but post-normalization evidence cannot establish whether the original producer actually supplied such fields. Missing original envelopes and verified child execution boundaries prevent causal attribution of the five real unresolved groups. Launcher completion is still only a background-running acknowledgement, never a worker completion or Stop witness.
- Lead-reported live GET 507 / oversized display response and POST 503 / failed save are separate observed transport failures; this replay does not establish their full resolution or connect them causally to lifecycle attribution.

Task 4.3 remains unchecked. Fresh independent review and a stable final-tree full run are still required. A broad `test:ci` was started during this iteration, before subsequent source-strength-enrichment/capacity refinements; any result from that run is supplementary, not stable final-tree evidence. Its log is `../worker-alias-test-ci.log`. Build completed successfully (`../worker-alias-build.log`); affected checks are being renewed after the final edits.

Renewed after the native-shadow correction:

- Evidence repository tests: **53 passed** (the focused command below includes them), including producer-generated native aliases, both source orders, separately validated recovery enrichment, 16 conflict controls, four protected-canonical controls, same-row/supplemental coverage and incompatible canonical outcome controls.
- Focused dismissal/routes/agents command: **285 passed**, 1352 assertions across 16 files.
- Compact adapter subset: **51 passed**, 70 assertions.
- Three scratch characterization/replay/residual files: **18 passed**, 48 assertions.
- Chromium/WebKit dismissal browser files, serial: **17 passed**, 51.1 seconds.
- Typecheck, strict OpenSpec validation, final build and diff checks passed.

No task completion is inferred from the supplementary full run; the parallel reconnect work and this iteration prevent calling that a frozen final-tree run. The lead must arrange fresh independent review and final stable verification. No commits, publication, dependency installs, live mutations, auth/settings changes or edits to lead/reconnect-owned product files were made by this correction.

Supplementary `test:ci` subsequently completed: **9631 passed, 16 skipped, zero failed**, 103673 assertions, 327 files, 480.77 seconds (`../worker-alias-test-ci.log`). As noted above, this run overlapped edits and is not stable final-tree evidence. Fresh independent review and the frozen final-tree run remain outstanding; task 4.3 stays unchecked.

## Final verification and handoff

This section supersedes the historical pending-review and pre-correction verification statuses above.

- Fresh independent review of the complete working-tree change found **no actionable findings**. The reviewer traced source validation/reconciliation, alias cohorts, atomic persistence, abort/activity ownership, client fences, account isolation and singleton compatibility, and independently ran **138 focused tests**, all passing. The Hub contract fixture and additive reconnect test were included.
- Final unchanged-product-tree `bun run test:ci`: **9608 passed, 16 skipped, zero failed**, 103611 assertions across 327 files, 465.58 seconds. The earlier correlation failure did not recur.
- Final `bun run typecheck`, `bun run api:validate`, `bun run build`, `bun run smoke` and `git diff --check`: passed. API lint retains the pre-existing single-element `WorkspaceConflict.allOf` warning; the build emits CSS `highlight` selector warnings.
- The latest corrected product tree passed the **17 serial Chromium/WebKit dismissal browser cases** recorded above. The entire browser suite and dependency vulnerability audit were not run. License checking passed for 593 installed packages.
- Task 4.3 is complete. All twelve dismissal implementation tasks are complete; publication and OpenSpec archival remain separate actions.

The reconnect regression is additional coverage of existing successful recovery, not a production reconnect fix. Live reconnect attribution and the reported five unresolved workers still require authenticated, sanitized session/network evidence. The live session was not modified. No commit or PR was published. The change is retained on `fix/worker-dismissal-reliability` for user review; it does not claim to close #581, #589, #590, #555 or every live manifestation of #592.

### Authorized live-browser follow-up

After the user returned, the lead used the explicitly requested installed browser CLI and user-approved local Hub login. No saved auth profile, cookie export, credential import or configuration change was made. The following observations are from the existing deployed build, not the patched worktree:

- The affected conversation's personal-dismissal GET returned **507**, `worker dismissal payload is too large`, after approximately **7420 ms**. This confirms the previously reproduced transcript-size failure category in the user's actual session.
- With separate explicit user approval, one **Dismiss finished** click returned **503** after approximately **11343 ms**; no dismissal success was confirmed. An earlier private-state GET was aborted by the client. The visible count returned to five unresolved and 298 finished workers after a transient increase during source reconciliation.
- The desktop browser did not display the reconnect banner during that attempt; the observed conversation stream continued delivering data. This does not establish the cause of the earlier mobile interruption or prove it resolved.
- The five unresolved entries have unavailable activity and background-running launcher acknowledgments, not worker completion results. Their child sessions are reused by multiple launch occurrences; completed notification-only rows also exist. Missing occurrence correlation must not be repaired by treating a shared child session as proof of completion.

Sanitized request/status/count metadata is retained outside the repository at the task scratch root as `live-dismissal-metadata.json`. Raw credentials, headers and transcript bodies are not included. Additional reconnect and lifecycle diagnosis is ongoing; these observations do not expand the completed dismissal implementation's claims.

### Reopened live-source compatibility gate

The lead exported 745 normalized worker/tool rows from that deployed conversation into the task-owned scratch artifact `live-worker-source-sanitized.json`, outside the repository. Tool text and descriptions were removed, tool inputs replaced by stable hashes, and identity/activity/association fields retained. A local replay through the patched `compactWorkerEvidence()` refused the source with `unavailable: ambiguous authoritative worker identity`.

This is a real normalized-source compatibility finding, not yet proof that the deployed snapshot is coherent complete provider evidence. Diagnosis must distinguish legitimate continuation aliases from actual contradictions before changing validation. The independently reviewed implementation and passing suites above predate this new evidence. Task 4.3 is reopened for affected fresh review; readiness is withheld pending diagnosis and any required correction/verification. The old deployed build remains in place; no patched service was started against live state.

### Live-source correction and renewed independent review

The source validator now supports certified inactive alias shadows produced by native history coalescing call-scoped task keys. It retains refusal for protected activity, lifecycle/outcome, immutable association, identity, generation and coverage conflicts. The same-row and supplemental-source checks remain in force.

- Lead replay of the sanitized normalized source: **745 rows → 343 compact alias entries**, **68362 bytes**. This does not establish covered-provider completeness or live save success.
- Fresh affected-area review found **no actionable findings** and independently ran **222 unique focused tests**, including the 51 compact adapter cases and scratch regressions. The reviewer also reproduced **745 rows → 704 retained rows → 343 compact aliases**, with none active and all individually dismissible. This does not establish terminal completion for the five unresolved historical occurrences; personal dismissibility is separate from lifecycle truth and Stop authority.
- Implementer renewed checks: **285 focused**, **51 compact adapter**, **18 scratch** and **17 serial Chromium/WebKit browser cases** passed.
- Lead renewed typecheck, API validation, both strict OpenSpec validations, build, binary smoke and whitespace checks passed. The same known lint/CSS warnings remain.
- A combined unchanged-product-tree full-suite run including the independently reviewed burst-recovery correction is in progress. Task 4.3 will be reconciled after that result.

An additional ad-hoc lead adapter replay harness timed out with an incomplete fake provider; it supplies no acceptance evidence and is not counted among passing checks. No production timeout was changed to accommodate it.

## Final combined-tree result

After the live-source correction and independently reviewed broker pacing fix, `bun run test:ci` completed on the unchanged product tree: **9635 passed, 16 skipped, zero failed**, 103646 assertions across 327 files, 470.32 seconds. Typecheck, API validation, both strict OpenSpec validations, build, compiled smoke and whitespace checks also passed. The latest corrected dismissal browser run remains **17 serial Chromium/WebKit cases passed**; full browser coverage and dependency vulnerability audit were not run.

Both affected-area independent reviews are clean. Task 4.3 is complete again, and all dismissal and burst-recovery implementation tasks are complete. OpenSpec archival and publication remain separate actions. The combined PR must retain a visible stable reconnect fix, as verified against the actual v0.8.0 broker; the earlier dismissal-only chore-override advice is historical and does not apply to the combined PR.

No patched build was deployed to the user's live Hub. The browser used for authorized investigation was closed, without saving an auth profile or exporting cookies. The authorized dismissal attempt failed; live dismissal success, original mobile reconnect attribution, and exact completion attribution for the five unresolved historical occurrences remain unverified. No commits or PR have been published.
