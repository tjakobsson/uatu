## 1. Existing implementation recorded retrospectively

- [x] 1.1 Recover reconnect/resumed-worker activity without restoring Stop; verified by worker-recovery.test.ts and the background-worker Chromium/WebKit suite before review round one.
- [x] 1.2 Attribute explicit child outcomes conservatively without invented reports; verified by worker-idle-outcome.test.ts, worker-terminal-recovery.test.ts and the 12 outcome browser cases before review round one.
- [x] 1.3 Align the Hub evidence deadline and document dismissal ownership; verified by the authenticated 10.2-second delayed-evidence regression and four dismissal browser checks before review round one.

## 2. Review corrections

- [x] 2.1 Add a deterministic public-provider regression that consumes a child outcome, processes a child revert while publication is held, and fails against the current implementation.
- [x] 2.2 Fence consumed child-history dependencies until publication; verify the new regression passes, fresh read reflects the revert, and unrelated conversation mutations do not revoke independent reads.
- [x] 2.3 Consolidate duplicated stream connection and cleanup in worker-recovery.test.ts; rerun that file without weakening scenario assertions.
- [x] 2.4 Align architecture documentation with child-history publication fencing and verify every changed behavior has a matching delta requirement and regression.

## 3. Verification and independent review

These results describe the initial PR publication; verification of subsequent review corrections is tracked below.

- [x] 3.1 Run the full affected OpenCode suite against frozen source, dismissal/evidence tests, V1/shared safeguards, and both worker browser suites; record actual results and any unexecuted checks. Final full CI covers all affected unit/integration files: 10,038 passed, 16 skipped, zero failures. Both worker browser files passed all 79 cases with one worker. The final source manifest was unchanged throughout verification.
- [x] 3.2 Run documented core checks using installed dependencies: typecheck, audit, test:ci, check:licenses, build, smoke and strict OpenSpec validation; resolve failures or report genuine blockers without installing tools or changing settings implicitly. Final CI, fresh build/smoke, typecheck, diff check and strict validation (61 items) pass. Audit/license checks pass with unchanged dependencies (one low-severity KaTeX advisory; 593 packages audited). Earlier failures and disk exhaustion remain recorded; final passes do not establish every earlier failure's cause. Checks used installed Bun 1.4.2; package manager declaration is 1.4.4. No runtime upgrade or live deployment verification was performed.
- [ ] 3.3 Synchronize the three capability deltas and archive the completed implementation record before merge; verify strict validation and an accurate task state.
- [x] 3.4 Repeat full-change Standards and Spec reviews using fresh independent Astra contexts until both axes have no actionable findings or unresolved escalations. Round six independently inspected all 24 changed/new files and found no actionable findings on either axis after the visibility-reread race was reproduced and corrected. Execution verification remains separate.

## 4. Publication

- [x] 4.1 Inspect the target repository's candidate issues and latest stable release, review public content and Git identity, and obtain approval for PR text, issue associations and draft/ready state. Approved as ready for review with non-closing references to #589, #555 and #592; the Release Please override records unreleased-feature stabilization.
- [x] 4.2 Commit and publish the approved branch and PR into tjakobsson/uatu main; verify the resulting URL, head commit, base branch and draft state. Published [PR #625](https://github.com/tjakobsson/uatu/pull/625) as ready for review from `addiberra:fix/unresolved-opencode-tasks` to `tjakobsson:main`; GitHub confirmed the implementation head and non-draft state. Deployment and live screenshot confirmation remain separate follow-up work.

## 5. Published-review corrections

- [x] 5.1 Reproduce and fix historical outcome recovery starvation from later append-only child output, preserving invalidation of changed outcome/interval evidence and existing Stop safeguards. Public covered-history and worker-evidence regressions now finish while later child output continues; restoring blanket invalidation makes both fail.
- [x] 5.2 Reproduce and fix stale terminal publication when a fresh child lookup observes changed revert visibility before the corresponding native event arrives. Scoped record observations now invalidate prior outcome sources on boundary changes, without adding ownership lookup awaits.
- [ ] 5.3 Verify the corrections through public-boundary regressions and repository checks, publish the fixes, and obtain a clean Codex review of the updated head without unresolved actionable findings.

Correction checks: all 16 outcome-race tests, 79 worker browser tests, build/smoke, typecheck and strict validation pass. Full CI passed 10,044 tests with 16 skipped and one lost-steer-acknowledgement correlation failure; its complete adapter file subsequently passed all 802 tests. The full-suite result remains a failure, not replaced by the isolated pass. Publication and Codex re-review remain pending.
