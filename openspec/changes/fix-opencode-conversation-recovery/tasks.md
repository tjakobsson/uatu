# Tasks

This checklist records completed uncommitted work and the review corrections still pending. Planning artifacts were added retrospectively; checked items refer to observed implementation and test results, not an earlier planning phase.

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

Archiving and publication remain later lifecycle actions, not claims of completion here. Do not commit, push, publish, deploy, restart agents, or change authentication as part of these tasks without the required separate authorization.
