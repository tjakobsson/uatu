# Tasks

This checklist records implementation progress and remaining review corrections. Planning artifacts were added retrospectively; checked items refer to observed implementation and test results, not an earlier planning phase.

The original checks and review completed before PR preparation. Tasks 4.1 and 4.3 were reopened for the user-approved integration of upstream `389221a`; earlier checked test counts remain historical evidence. The integrated full unit run passed 8,354 tests with 16 skipped and zero failures; typecheck, build, smoke, and strict OpenSpec validation also passed. Authenticated iPhone/live-SSE and the full E2E suite remain unexecuted.

PR review subsequently reproduced two additional P2 bugs. Section 5 tracks their correction; tasks 4.1 and 4.3 are reopened again for the corrected code on upstream `ffd92c36` with the approved isolated Claude SDK 0.3.316 restore. Earlier test counts are not acceptance evidence for those new corrections.

The section 5 corrections passed 8,373 unit tests with 16 skipped and zero failures on the isolated SDK 0.3.316 dependency state. Typecheck, build, compiled version/smoke, the 593-package license check, dependency audit, and all 58 strict OpenSpec items passed. The audit retains the existing low KaTeX advisory, with no moderate-or-higher advisories. Fresh parallel Sol Standards and Spec re-reviews found no actionable issues after the nested stale-completeness correction; the Spec reviewer independently passed 17 focused tests. Bun 1.4.2 was used rather than CI's pinned 1.4.4; full E2E and authenticated iPhone/live-SSE recovery remain unverified.

The user subsequently approved a third reproduced P2: a fallback result notice retained during unavailable ownership survives a later native revert after ownership recovers because its exclusion identity changes. Section 6 tracks this correction, and tasks 4.1/4.3 are reopened for its final verification and fresh review. The section 5 results remain historical evidence rather than acceptance for section 6.

Section 6 verification passed 8,376 unit tests with 16 skipped and zero failures, plus 3,109 affected tests and all three new fallback-visibility regressions. Typecheck, build/version/smoke, the 593-package license check, dependency audit, and all 58 strict OpenSpec items passed. Fresh parallel Sol Standards and Spec reviews of the full corrected PR found no actionable issues. Runtime, advisory, E2E, and authenticated mobile/SSE limits above remain unchanged.

The user approved a fourth reproduced P2 after reviewing the latest comments: visible fallback notices and completed workers can duplicate the same native result across degraded and recovered history. Section 7 tracks explicit same-result supersession and subscriber removal; final verification and review are reopened. CI for `a07fd377` passed both E2E legs, performance tests, contracts, specs, and CodeQL, but its unit job timed out in the reversible-history browser integration wrapper, causing `validate` to fail. This CI failure is under separate diagnosis; a passing local suite does not establish green CI.

Section 7 passed 13 focused tests, 3,152 affected tests, and a final full local run of 8,389 passed / 16 skipped / zero failures. A preceding full run had one timeout in the unchanged file-observer overlap test; its isolated 34-test suite and the subsequent full rerun passed without assertion or timeout changes. Typecheck, build/version/smoke, the 593-package license check, audit, and all 58 strict OpenSpec items passed. Fresh parallel Sol Standards and Spec reviews of the complete change were clean. Fresh GitHub CI remains a separate post-push check; authenticated iPhone/live-SSE recovery remains unverified.

CI attempt 2 for `5f2d5d30` passed the earlier three failures but failed the unchanged oversized-worker history/subscription regression with an unexpected `retention-gap` resync (8,388 passed / 16 skipped / one failed). Thirty local focused repetitions and forced-clock/delayed-subscription probes did not reproduce it. The user approved fixing this remaining failure in this PR, starting with deterministic event ordering rather than assuming flakiness or weakening replay limits. Section 8 tracks that correction; final local verification and independent review are reopened.

Section 8's controlled schedule reproduced the failure eight times while accounting was genuinely pending. The test-only synchronization correction passed 100 focused repetitions, 3,124 affected tests, and a full local run of 8,391 passed / 16 skipped / zero failures. Typecheck, build/version/smoke, licenses (593 packages), audit, and all 58 strict OpenSpec items passed; fresh parallel Sol Standards and Spec reviews were clean. No product code, replay budget, or original no-resync assertion changed. Fresh CI remains pending under task 8.4; the controlled reproduction does not by itself establish CI's exact triggering event sequence.

## 1. Preserve the verified recovery baseline

- [x] 1.1 Separate optional provider child enrichment from required parent reads, with regression coverage for lookup saturation, hung ownership/execution history, required parent failures, and later retry; verified by the completed provider/adapter run of 2,115 passing tests.
- [x] 1.2 Give whole-history recovery its bounded 25-second window while retaining cancellation and stream fences; verified by the healthy 5.2-second read reproduction and adapter expiry/cancellation tests.
- [x] 1.3 Preserve visible-prefix and hidden-settled revert behavior under asymmetric or unavailable child enrichment; verified by provider/adapter regressions and the completed independent visibility review.
- [x] 1.4 Document the existing recovery behavior and validation limits in `docs/CHAT.md` and the capability spec; verified by the inspected six-file diff and clean documentation review.

## 2. Bound optional accounting reconstruction

- [x] 2.1 Add a public adapter regression with successful parent/ownership reads and hanging child accounting, and witness its failure before applying the correction; verify that the test distinguishes unavailable optional accounting from a required parent read failure.
- [x] 2.2 Bound child paging and nested reconstruction with explicit read ownership, cancellation, and late-result/completeness fences; verify parent history succeeds with available accounting, later retry restores verified values, and expired reads cannot bank stale results.
- [x] 2.3 Cover shared callers, nested accounting, stream replacement, cancellation, and late settlement through the public adapter seam; verify targeted accounting and existing eviction/revert/live-arrival tests pass without weakening their assertions.
- [x] 2.4 Align the main capability spec and chat documentation with the bounded accounting behavior; verify consistency with the delta's accounting scenario and the implemented retry/unknown-value semantics.

## 3. Keep worker identities consistent

- [x] 3.1 Share pure native launcher/notification identity construction between emitted worker rows and exclusion-only candidates without changing string formats or validation; verify existing canonical, alias, reused-child, and hidden-result tests pass.
- [x] 3.2 Add or retain coverage that ties exclusion identities to actual emitted worker identities while keeping ownership and Stop authorization separate; verify the focused provider/worker suites and typecheck pass.

## 4. Complete integrated verification and review

- [x] 4.1 Run `bun run typecheck`, affected provider/adapter/worker tests, `bun run test:ci`, `bun run build`, and a compiled binary version check after the corrections; verify results and report any runtime or unexecuted-check limits.
- [x] 4.2 Validate the OpenSpec change with the existing project-local CLI and `--strict`, reconcile this task list, and verify the main capability spec contains the approved delta without losing existing scenarios.
- [x] 4.3 Repeat fresh parallel Sol Standards and Spec reviews of the complete updated change until both axes have no actionable findings; verify fixes receive a new independent round and report unresolved live-browser validation limits.

## 5. Address validated PR review findings

- [x] 5.1 Isolate shared provider message-read ownership from individual waiter deadlines, with bounded collective cleanup and existing cache/generation fences; verify a permanent public-provider regression fails before correction and a required reader survives expiry of a concurrent optional reader, without duplicating a healthy shared fetch or breaking legacy reuse.
- [x] 5.2 Carry internal visible-child-enrichment incompleteness into accounting reconstruction without changing the public wire contract; verify transient grandchild ownership failure retains known own cost, prevents a false completeness stamp, and a same-adapter refresh restores nested cost immediately after recovery, while hidden-suffix-only enrichment failures do not poison visible completeness. Include previously complete nested trees whose expired reconstruction becomes incomplete, so old descendant completeness cannot renew an ancestor's completeness.
- [x] 5.3 Validate the review's originless-row and nested-deadline hypotheses before changing visibility rules; verified by the insertion/update invariant, seven focused provider visibility tests and three accounting-owner tests. Retain positive-origin safeguards and defer optional optimization suggestions.
- [x] 5.4 Align the design, capability delta/main spec, and chat guidance with shared-read cancellation and descendant-completeness behavior; verify the main recovery requirement exactly matches the approved delta and retains all existing scenarios.

## 6. Remove reverted fallback result identities

- [x] 6.1 Add a same-adapter public history/subscription regression and witness failure before correction: a delivered result initially retained as a fallback notice must disappear from both history and the next subscription snapshot after a native revert, whether child ownership remains unavailable or recovers.
- [x] 6.2 Include possible fallback notice identities in authoritative hidden-suffix removals without broad absence-based adapter deletion; verify visible-prefix origin vetoes, canonical/alias exclusions, independently live work, and ownership/Stop safeguards remain intact.
- [x] 6.3 Align the design, capability delta/main spec, and chat guidance with enrichment-independent fallback identity removal; verify main and delta recovery requirements match exactly without losing scenarios.

## 7. Supersede duplicate visible fallback results

- [x] 7.1 Add permanent public provider/adapter regressions and witness failure before correction for healthy → degraded reconnect → recovered history and cold degraded → recovered history; verify one presentation of each native result in history and subscription snapshots.
- [x] 7.2 Supersede a fallback notice only when a retained or recovered verified worker represents the same native result; remove the duplicate from returned history and retained projection, publish removal to existing subscribers, and preserve notices without matching verified workers, unrelated notices/results, canonical aliases, stream fences, ownership/Stop, and live/revert safeguards.
- [x] 7.3 Align design, capability delta/main spec, and chat guidance with explicit same-result supersession; verify the main and delta recovery requirements match exactly without losing scenarios.

## 8. Make oversized-result history/subscription handoff reliable

- [x] 8.1 Establish and minimize a deterministic public-seam reproduction of the CI retention-gap failure by gating native step/usage events around history/subscription handoff; witness the exact assertion fail and identify whether a redundant publication or legitimate pending progress invalidates the cursor.
- [x] 8.2 Correct the confirmed cause with regression coverage, preserving the replay byte budget, no-resync assertion for unchanged snapshots, meaningful event/progress assertions, and all stream, accounting, ownership/Stop, and live/revert safeguards; remove temporary diagnostics and rerun the original scenario.
- [x] 8.3 Align design, affected capability acceptance, and chat guidance with the proven correction; preserve existing scenarios and distinguish a test synchronization correction from a production behavior change.
- [ ] 8.4 Verify the published correction's fresh CI results, including the unit/validate gates; report any actual remaining failure or access/runtime blocker rather than treating local success or a rerun as proof of its cause.

Archiving and publication remain later lifecycle actions, not claims of completion here. Do not commit, push, publish, deploy, restart agents, or change authentication as part of these tasks without the required separate authorization.
