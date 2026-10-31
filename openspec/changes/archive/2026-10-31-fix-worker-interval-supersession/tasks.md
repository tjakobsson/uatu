# Tasks

## 1. Historical supersession correction

- [x] 1.1 Add provider-level regressions for all three-launch content permutations and combined/split assistants with pending reports; verify the reproduced newer / older / newer-alias case fails before implementation, then check exact two-occurrence result mapping, stable tool order and read-only API use.
- [x] 1.2 Fence historical supersession using proven interval separation while preserving ambiguous and live behavior; verify the new regression matrix and existing missing/tied-clock, delayed-old-result and no-explicit-report cases pass, and rerun the original reviewer probe.
- [x] 1.3 Align `ARCHITECTURE.md` with the implemented historical boundary and inspect its claims against the positive and negative tests.
- [x] 1.4 Clarify the accepted initial retrospective-record deviation and subsequent prospective planning in the two archived proposals; verify the text preserves truthful chronology and grants no future waiver.
- [x] 1.5 Add permission-delayed admission regressions before correcting historical grouping/report selection; verify calls at 13/15 spanning idle 17 with acceptance at 16/23 cannot let result 18 settle the later generation, for running and completed later work and ambiguous/missing clocks.
- [x] 1.6 Bound historical occurrence proof by reliable launcher admission evidence and align architecture documentation; verify new regressions, original interleaved-history probes, existing alias/result safety cases and the reviewer delayed-admission probe pass without inventing correlation for ambiguous evidence.
- [x] 1.7 Add failed-first-inventory then transcript-read regressions for removed and still-running targets before correcting cross-caller admission; verify transcript-only reads cannot grant missing proof while healthy sibling controls survive and fresh valid recovery succeeds.
- [x] 1.8 Preserve outstanding fresh-verification requirements across read callers and align architecture documentation; verify the reviewer inventory probe and existing inventory retry, retained-control, gap, ownership, revocation and capacity tests pass within existing evidence budgets.

## 2. Integration and independent review loop

- [x] 2.1 Run provider, background/control and normalization suites, `bun run typecheck`, `bun run audit`, `bun run check:licenses`, build, smoke, strict OpenSpec validation and diff checks; record actual commands/results and disclose any verification limits.
- [x] 2.2 Run the full unit suite and distinguish introduced failures from the two already reproduced baseline failures without modifying unrelated tests.
- [x] 2.3 Run fresh independent standards and spec/correctness reviews of the complete PR against `512290b5a6dbe1e6944b7deea4e341c651c34dbe`; reproduce and correct actionable findings, renewing affected verification/review until both fresh reports have no unresolved actionable findings.
- [x] 2.4 Reconcile task/review records and inspect the full publication diff for secrets or unrelated changes before committing.
- [x] 2.5 Present the updated PR description for approval, publish verified corrections to #559 while preserving ready-for-review status, and verify new-head CI, including the full `bun run test:e2e` coverage split across both browser legs and performance job; use CI as the final full-suite gate per `CONTRIBUTING.md`, and report the precise remaining blocker if any check cannot complete.
- [x] 2.6 Restore this change to its active path while #559 remains open; preserve completed implementation and verification evidence, and verify OpenSpec discovers the active change and strict validation passes.

Keep this change active while #559 is open. Archival belongs to the repository's normal finalization workflow, not completion of the review loop.

## 3. Follow-up PR review comments

- [x] 3.1 Clarify order-independent execution history, name the existing inventory-close predicate, and alias the numeric field parser without changing behavior; verify typecheck, affected provider/control tests, and the focused diff.
- [x] 3.2 Add public rejected-read and overlapping-transcript counterexamples as failing regressions, then preserve outstanding verification for rejected reads and all unconfirmed running targets, including foreign shells and agents absent from active listings; verify connected/standalone callers, removed/running/foreign targets, healthy retained siblings, safe fresh recovery, capacity/gap/revocation bounds, and independent probes before documenting the invariant.
- [x] 3.3 Confirm existing `ran === completed` regression coverage and record each review observation's disposition with precise test/source references; verify the cited cases run successfully.
- [x] 3.4 Obtain independent review of the follow-up delta, publish the verified correction while keeping the change active, and observe new-head CI before reporting its result.

## 4. Fail-safe read capability default

- [x] 4.1 Add failing omitted-inventory regressions for connected and standalone partial scopes, then default control reads to transcript-only and make inventory-oriented test callers explicit; verify healthy retained controls, explicit fresh recovery, all control/provider/normalization tests, and typecheck.
- [x] 4.2 Align architecture notes, obtain fresh independent review of the hardening delta, and verify strict OpenSpec validation and diff checks without changing interval semantics or unrelated tests.
- [x] 4.3 Publish the reviewed correction, update approved PR evidence with accurately scoped verification, and observe new-head CI; preserve ready-for-review status and keep this change active.

## 5. Predicate readability

- [x] 5.1 Replace dense alias matching and interval-separation conditions with named local checks while preserving evaluation order and short-circuits; verify provider/control/normalization suites, typecheck and focused equivalence evidence.
- [x] 5.2 Obtain fresh independent standards/correctness review and validate strict OpenSpec and diff checks while keeping this record active. Report publication and source-commit CI results separately so recording delivery status does not require another CI-triggering bookkeeping commit.

## Verification evidence

- Round 1 reproduced and corrected historical supersession across interleaved intervals; documented the user-accepted one-time initial planning deviation without claiming retroactive compliance.
- Round 2 reproduced and corrected permission-delayed admission miscorrelation and transcript-only admission after incomplete inventory. Each corrective expansion was planned before implementation, with red regressions first.
- Round 3 fresh, independent native Luna/high standards and Sol/high spec/correctness reviews reported no actionable findings on the complete PR and current corrections. These are review results, not a proof of bug-freedom.
- Before the follow-up review corrections: `bun test src/chat/opencode/v2/provider.test.ts` passed 1,512 cases, control/V2 normalization passed 186, and shared normalization passed two. The PR then added 114 regression/safety cases; current follow-up totals are recorded below.
- Independent review executed 112 focused repository tests, all 720 six-launch/three-interval content permutations, and twelve additional admission-window safety cases. Real-provider synthetic stubs assert read-only requests; captured original-history replay also passed.
- `bun run test:ci`: 7,281 passed, 16 skipped, two unchanged failures previously reproduced on baseline: the 150 ms backend startup-progress test and the state-dir unsafe-mode fixture under inherited umask `077`. An earlier round also timed out the hub chat-retry test; the entire hub file then passed 80/80 in isolation, and that timeout did not recur in the final full-suite run. No unrelated test was modified.
- Typecheck, build, compiled-binary/browser smoke, license audit (597 installed packages), all 61 strict OpenSpec checks, and diff checks passed. Dependency audit passed its moderate-or-higher gate while disclosing existing low-severity KaTeX advisory GHSA-238p-pmpm-9mq7.
- Local checks used installed Bun 1.4.2; no runtime or dependency was installed. Correction `04e3a5c` was pushed to #559 and [CI run 40616093739](https://github.com/tjakobsson/uatu/actions/runs/40616093739) passed, including unit, both functional browser legs, performance, both contract jobs, strict spec validation and final validation; CodeQL also passed. The approved PR-description correction reports the observed successful result, not an unfinished run. Ready-for-review status is preserved. Independent provider checks used scripted stubs, not live-provider execution. Neither running hub was upgraded or restarted.
- The reviewer's initial two-completed-generation probe demanded an unproved exact mapping; the reviewer confirmed that assertion was overstrict. The permanent safety matrix instead requires uncertain unproved assignments and readable, deduplicated explicit results. Notification-first multi-alias reachability remains unestablished and is not claimed fixed.

### Follow-up review dispositions

- Source: [follow-up review on #559](https://github.com/tjakobsson/uatu/pull/559#issuecomment-6464184970). Its rejected-read observation reproduced through public provider calls and is addressed by task 3.2 rather than a comment-only explanation.
- Review observation 1: rejected reads now preserve negative coverage in the bounded scope ledger without taking an active-read slot. Public regressions hold sixteen unrelated reads and check removed, running and foreign shells. Subsequent independent review also reproduced foreign-shell ownership, absent-agent active-list and ownership-filtering races; the common positive-verification fence now covers these paths, connected and standalone callers, older in-flight transcripts, and healthy retained siblings.
- Review observation 2: `BackgroundWorkers` documents that execution-history boundaries are order-independent because consumers use predicate scans; no sort or interval semantics change is needed.
- Review observation 3: `provider.test.ts` already includes `permission-delayed admission stays uncertain: tied-window` cases, setting `ran` and `completed` to 15 across running/completed, forward/reversed and combined/split histories. Rerunning the eight cases passed; no duplicate regression was added.
- Review observation 4: named the existing `endRead` condition `closesInventory` and aliased the numeric parser as `numberField`. Admission-window caching was not added for an unmeasured performance concern.
- Review observation 5: the Codex comments report review-infrastructure errors, not an actionable code diagnosis. The PR separately records independent native reviews and successful CI; no external review service was retriggered by this follow-up.

### Follow-up verification

- The follow-up adds 19 permanent regression/safety cases, bringing this PR to 133 cases added. Full provider suite: 1,525 passed. Control and shared/V2 normalization suites: 194 passed. Typecheck, build, compiled-binary/browser smoke, 61 strict OpenSpec checks and diff checks passed.
- Full local unit suite after the final common-fence correction: 7,300 passed, 16 skipped, two unchanged baseline failures (startup-progress timing and unsafe-mode fixture under umask `077`). A previous run also hit a macOS code-signing subsystem error in an untouched helper test; that case passed in isolation and did not fail in the final run. No unrelated test was changed.
- Fresh native Sol/high independent safety review found no actionable issues after 192 control/normalization tests, 51 focused provider tests and twelve independently authored public-provider probes. The probes cover agent/shell, connected/standalone, negative/positive/terminal evidence, overlapping reads, healthy siblings and refused unsafe Stop. Renewed independent Luna/high standards review also found no issues. Source/test hashes remained unchanged during safety review.
- The lead independently reran the previously failing public-provider probes and tested older child history against newer idle-boundary evidence. These scripted checks used no live-provider accounts or hub mutations. No destructive Stop bypass was demonstrated in the reported defects.
- Correction `c181498` passed [CI run 40748776864](https://github.com/tjakobsson/uatu/actions/runs/40748776864), including unit, both functional browser legs, performance, contracts, strict specs and final validation. The approved [reviewer reply](https://github.com/tjakobsson/uatu/pull/559#issuecomment-6492258372) was published after success. Earlier intermittent UI-wrapper failures are separately reported in #560; the cause remains unconfirmed and no harness change is included here.

### Fail-safe default follow-up

- Source: [review at `c181498`](https://github.com/tjakobsson/uatu/pull/559#issuecomment-6496210261). Only the opposite `inventory` defaults warrant a source change. Equal-clock coverage and conservative same-start handling remain unchanged; dense-predicate cleanup and bot retries are not required by this hardening.
- Two omitted-argument regressions failed before the default changed, then passed in the complete 196-case control/shared/V2 normalization suites. All 1,525 provider tests also passed, for 1,721 targeted passes. This adds two cases to the prior 133, bringing the PR total to 135 added regression/safety cases.
- Fresh independent native Sol/medium standards and correctness review of the hardening delta reported no findings and independently reran all 196 control/normalization cases. The provider wrapper explicitly forwards its capability, so existing production callers are unchanged; inventory-oriented test callers now opt in explicitly without dropping assertions.
- Typecheck, build, compiled-binary/browser smoke, 61 strict OpenSpec checks, diff checks and the moderate-or-higher dependency-audit gate passed. License checks audited 597 installed packages. The existing low-severity KaTeX advisory GHSA-238p-pmpm-9mq7 remains disclosed; no dependency or runtime was installed.
- Final local full suite: 7,302 passed, 16 skipped, the same two baseline failures (startup-progress timing and unsafe-mode fixture). No unrelated test was changed.
- Correction `dce56cf` passed [CI run 40910889917](https://github.com/tjakobsson/uatu/actions/runs/40910889917), including unit, both functional browser legs, performance, contracts, strict specs and final validation. The initial attempt hit the unchanged adapter fixture's recovery-read assertion before fake-timer cleanup; the exact test passed locally in isolation and the failed-job rerun passed without source changes.
- After CI success, the user-approved PR evidence was updated to 135 added regression/safety cases, 1,721 targeted passes and 7,302 local passes, and the [hardening reply](https://github.com/tjakobsson/uatu/pull/559#issuecomment-6503231105) was published. Readback verified the counts, CI link, release override and ready-for-review status. This change remains active while #559 is open; neither hub was changed.

### Predicate readability verification

- Named the alias candidate's worker scope, certain running occurrence, same-interval and intervening-idle checks; early returns preserve the original evaluation order. Named the proven-separate-interval supersession guard. No interval helpers, boundaries, mutations, tests or control policies were changed.
- All 1,525 provider and 196 control/shared/V2 normalization tests passed (1,721 total). Typecheck, build, compiled-binary/browser smoke, 61 strict OpenSpec checks and diff checks passed. No new regression cases were needed for the behavior-preserving refactor; the PR total remains 135 added cases.
- Fresh independent native Sol/medium standards/correctness review reported no findings. Differential checks extracted the actual baseline/current predicates and matched 22,544 cases for candidate identity or separation decision, property-access order, helper calls/arguments, shell bypasses, empty launches and idle boundaries. The source hash stayed unchanged during review and lead verification. These controlled-helper probes do not replace the existing tests of interval mathematics.
- Full-project unit and functional-browser evidence for the readability commit is reported separately through CI; the local refactor checks above do not claim a new full-suite run. The change stays active while #559 is open.
