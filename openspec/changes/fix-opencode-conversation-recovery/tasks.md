# Tasks

This checklist records implementation progress and remaining review corrections. Planning artifacts were added retrospectively; checked items refer to observed implementation and test results, not an earlier planning phase.

The original checks and review completed before PR preparation. Tasks 4.1 and 4.3 were reopened for the user-approved integration of upstream `389221a`; earlier checked test counts remain historical evidence. The integrated full unit run passed 8,354 tests with 16 skipped and zero failures; typecheck, build, smoke, and strict OpenSpec validation also passed. Authenticated iPhone/live-SSE and the full E2E suite remain unexecuted.

PR review subsequently reproduced two additional P2 bugs. Section 5 tracks their correction; tasks 4.1 and 4.3 are reopened again for the corrected code on upstream `ffd92c36` with the approved isolated Claude SDK 0.3.316 restore. Earlier test counts are not acceptance evidence for those new corrections.

The section 5 corrections passed 8,373 unit tests with 16 skipped and zero failures on the isolated SDK 0.3.316 dependency state. Typecheck, build, compiled version/smoke, the 593-package license check, dependency audit, and all 58 strict OpenSpec items passed. The audit retains the existing low KaTeX advisory, with no moderate-or-higher advisories. Fresh parallel Sol Standards and Spec re-reviews found no actionable issues after the nested stale-completeness correction; the Spec reviewer independently passed 17 focused tests. Bun 1.4.2 was used rather than CI's pinned 1.4.4; full E2E and authenticated iPhone/live-SSE recovery remain unverified.

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

Archiving and publication remain later lifecycle actions, not claims of completion here. Do not commit, push, publish, deploy, restart agents, or change authentication as part of these tasks without the required separate authorization.
