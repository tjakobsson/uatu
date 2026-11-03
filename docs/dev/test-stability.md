# Test-stability investigation

## Objective and current status

Make test results trustworthy by establishing failure mechanisms and fixing their
causes, including product defects when implicated. The initial draft commit was
planning-only. Investigation outcomes below distinguish reproduction from fixes;
local passing runs do not establish GitHub CI acceptance.

The initial source baseline is `ffd92c36203dc47d1a6254e5aef319d0d8cc1453`.
The nine initial issues below remain investigation targets, not promises of nine
fixes. Newly discovered test-stability defects are also in scope, under the same
reproduction, review and GitHub CI acceptance criteria.

## Scope and sequence

Status describes investigation work, not issue closure or GitHub CI acceptance.

| Order | Issue | Investigation | Status |
| --- | --- | --- | --- |
| 1 | [#563](https://github.com/tjakobsson/uatu/issues/563) | Reproduce credential-test contamination from inherited Git/SSH projection; preserve the credential behavior under test. | completed (unreproduced; issue unresolved) |
| 2 | [#560](https://github.com/tjakobsson/uatu/issues/560) | Attribute the isolated chat UI wrapper timeout to child execution, output handling or shutdown. | in_progress |
| 3 | [#536](https://github.com/tjakobsson/uatu/issues/536) | Investigate the remaining clipboard rejection and native-watcher final-write timeout separately; account for the polling failures already addressed by #511. | completed (unreproduced; issue unresolved) |
| 4 | [#233](https://github.com/tjakobsson/uatu/issues/233) | Investigate the remaining macOS find-next shortcut failure; distinguish it from the document-tree case addressed by #462. | completed (unreproduced; issue unresolved) |
| 4 | [#253](https://github.com/tjakobsson/uatu/issues/253) | Map reported load-sensitive failures, including comments, against #462 before investigating the remaining mechanisms. | completed (unreproduced; issue unresolved) |
| 4 | [#438](https://github.com/tjakobsson/uatu/issues/438) | Distinguish the lost-click and WebKit connection failures from the personal-state race addressed by #462. | in_progress |
| 5 | [#538](https://github.com/tjakobsson/uatu/issues/538) | Separate expensive execution, contention and the workdock timeout; account for partition and trace-policy improvements in #519. | completed (historical timeout unreproduced; issue unresolved) |
| 6 | [#579](https://github.com/tjakobsson/uatu/issues/579) | Attribute the intermittent pre-bootstrap syntax error using sanitized script and exception diagnostics. | in_progress |
| 6 | [#580](https://github.com/tjakobsson/uatu/issues/580) | Attribute the WebKit login mismatch without recording credentials or weakening authentication. | completed (unreproduced; issue unresolved) |

Reorder when evidence identifies shared causes or prerequisites. Keep independently
reviewable changes per root cause rather than per issue number. Record new
stability defects separately from the initial issue list, including their status
and verification. General coverage, linting and CI-cost work unrelated to an
encountered stability failure is outside scope. #564 and #531 remain excluded;
minimal diagnostics inside an individual investigation are permitted. #565 concerns rerun
selection exhausting a shell deadline, while #551 and #552 concern product
transport deadlines; they become dependencies only if evidence establishes a link.

## Investigation and acceptance

1. Use focused reproductions in the relevant supported environment. Spend effort
   dynamically; when focused attempts cannot reproduce a described failure, move
   to another mechanism and report commands, attempts, results and limitations at
   the end. Passing reruns alone establish neither a cause nor a fix.
2. Call a mechanism fixed only with an attributable cause, a regression that fails
   before and passes after the fix, and repeated targeted checks. A controlled
   reproduction is sufficient when evidence ties it to the reported mechanism;
   recreating the exact historical CI run is not required.
3. Preserve meaningful assertions and test identities. Permit narrow timeout
   changes only when measurements explain the budget and genuine hangs still
   fail. Additional retries, skipped tests and arbitrary deadline increases are
   not stability evidence.
4. Require first-attempt stability of affected tests in repeated GitHub CI runs
   under the supported worker configuration, plus passing required CI on the
   final candidate. Identify exact commits, completed runs and retries. Affected
   tests passing only after retry do not meet acceptance; pending, interrupted,
   blocked or missing CI is not a verified pass.
5. Retain separate platform evidence: Linux CI cannot establish macOS-specific
   behavior, and Linux WebKit is not native Apple WebKit or physical-device proof.
   Local passes do not replace GitHub CI acceptance.
6. Review each root-cause change independently. Keep diagnostic-only milestones
   explicit and leave their issues unresolved. Obtain separate approval before
   issue closure or PR publication-text updates. Keep the PR draft until the user
   changes that choice.

Use existing approved dependencies and tooling. Request approval for installations
or restores, and report access or environment blockers rather than bypassing them.
Keep diagnostics bounded and sanitized: credentials, tokens, cookies, private
runtime paths and raw authentication-bearing traces are not publication evidence.

## Final report

For every initial issue and newly discovered stability defect, distinguish
verified fixes, diagnostic-only progress, unreproduced failures, remaining partial
fixes, unstarted work and blockers. Record
the baseline and final commits, before/after regressions, exact local commands,
targeted repetition results, independent review outcomes and GitHub CI links.
Disclose retry-assisted passes and untested platforms. Repeated passes provide
bounded evidence, not a guarantee that every future run will be stable.

## Local investigation outcomes

The initial runs below use macOS and existing Bun 1.4.2; later sections identify
the Bun 1.4.4 checks separately. Upstream main was fetched before the
locked dependency restore and remained at the initial baseline above. Dependency
lifecycle scripts were disabled; `bun.lock` and `package.json` were unchanged.

- **#563: unreproduced.** The ordinary credential-context suite passed 28/28.
  Actual credential projections generated with synthetic fixtures also passed
  28/28 for no assignments, a synthetic SSH assignment, projected PATH alone and
  a clean control. A separate probe confirmed that the test process resolved
  Git/SSH through the generated wrappers. No runner or product change is justified
  by these results. Historical failing assertions and projection differences
  remain needed; no GitHub CI acceptance or resolution is claimed.
- **#536: unreproduced.** The Keyboard Lock rejection case passed 20 repetitions;
  the complete clipboard file passed 940 tests across 20 repetitions. Successful
  runs also print the caught `error: policy` through `console.debug`; that text
  alone is not proof of an unhandled rejection. The native final-write case
  passed two batches of 10 repetitions. Neither result establishes a root cause
  for the historical failures. No test, product, retry or timeout change was made.
- **#438: reproduced, cause under investigation.** A mixed nine-case browser
  selection repeated three times with four workers and no retries passed 26/27;
  the failure was the reported iPad/WebKit `Connecting` timeout. Repeating only
  `webkit iPad desktop headers and composer` six times with the same worker/retry
  settings failed 3/6. Full sanitized page diagnostics attribute these attempts
  to external application-bundle parse errors after HTTP 200. Bundle generation,
  transformation, delivery and runtime behavior remain hypotheses, not proven
  causes. A connection to #579 has not yet been established.
- **#233/#253: unreproduced in the focused mixed selection.** The find-next case
  and its preceding rendered-find case, follow expansion, terminal round trips,
  transcript snapshot, personal-state resume and single-layout preference each
  passed three attempts with four workers and no retries. These bounded local
  attempts are not proof of full-suite or platform-independent stability.
- **#538/#579/#580: focused workdock, Hub and login matrix.** Eighteen attempts
  passed with four workers and no retries on Bun 1.4.2: four workdock variants,
  the native cross-workspace worker flow and four login/dismissal guidance cases,
  each repeated twice. Workdock durations ranged from 33.46 to 72.01 seconds.
  The baseline GitHub leg 2 finished in 16m29s, below its 25-minute budget, but
  other cases passed only after retry. Neither the historical workdock timeout
  nor the login-value mismatch was reproduced; no fix is claimed for them.

## Additional findings from baseline GitHub CI

[Run 41570952785](https://github.com/tjakobsson/uatu/actions/runs/41570952785)
tested the planning-only commit on Bun 1.4.4/Linux. The unit job reached its
20-minute limit and functional leg 1 failed; a green report-aggregation job did
not make the run successful.

| Finding | Status |
| --- | --- |
| Permission-test setup rejects filesystem-rounded mtime by 0.001 ms | Locally verified fix published as `6005f000`; [cause and regression evidence](test-stability-permission-mtime.md). Repeated GitHub CI acceptance pending. |
| Metadata-card persistence: first navigation remained on README | Original navigation failure unreproduced in 10 focused attempts on Bun 1.4.4. Eight reached and passed the test body; two instead failed during startup with SyntaxError. No navigation fix justified. |
| Three adapter steering tests timed out at five seconds | Each passed 111 local executions on Bun 1.4.4, including focused and surrounding-group repetitions. Cause unproven; no adapter change. |
| WebKit critique test: main-page offset moved from 0 to 125 after a remote update | Passed only on retry in two CI runs; 10 unchanged local attempts passed on Bun 1.4.4. No cause or fix established. |
| Queued `/reload` test waited 30 seconds for a prompt response | Passed only on retry in baseline CI; 10 unchanged local attempts passed on Bun 1.4.4. No cause or fix established. |
| UI wrapper's 60-second timeout followed by an eventual unit-job deadline | Original wrapper timeout reproduced in CI. Local child-lifecycle probes did not reproduce a leak. The later job-level hang remains unattributed. |

Task-local Bun 1.4.4 was subsequently downloaded from the official release and its
SHA-256 checked against the release asset metadata; the global Bun was unchanged.
The minimal WebKit case still failed 3/6 attempts. Independent direct/proxied
asset rebuilds produced identical syntax-valid JavaScript, but not the bytes of
an actual failing browser response. Ordinary Playwright traces omit script
bodies by design, so their absence is not evidence of truncation. No bundled-code
corruption or shared cause across the startup reports is yet established.

An isolated HAR probe at `6005f000` captured script bodies through Playwright's
public `recordHar` API. All 10 attempts passed, with four workers and no retries;
all captured scripts passed Node's module syntax check. Eager body collection
may have altered timing. This did not capture a failing response or establish a
cause; further identical repetitions were stopped.

## Candidate `6005f000`: first CI and full local unit run

[Run 41601591120](https://github.com/tjakobsson/uatu/actions/runs/41601591120)
completed with required validation failing. Functional leg 1 passed all 655
tests without retries. Its structured per-test records confirm that the original
permission case and the new fractional-mtime regression each passed on retry 0
(3,845 ms and 3,538 ms). This is one first-attempt CI pass, not the required
repeated acceptance or a passing final candidate.

Functional leg 2 passed only with retries: the same WebKit scroller case again
moved from `[2, 0, 0]` to `[2, 0, 125]`; a newly encountered variant-without-model
boundary test received 401 rather than its expected 400. The scroller cause
remains unproven; the boundary test now has a locally verified setup fix described
in [the authentication investigation](test-stability-variant-auth.md), with CI
acceptance pending.
The unit job finished in 3m31s with three failures: the original 60-second UI
wrapper timeout, a recovery Checking test observing zero reads instead of one,
and a large-worker snapshot test receiving a retention-gap resync. The two new
adapter cases each passed 130 focused local executions on Bun 1.4.4; neither
cause was established, and no adapter changes were made.

A separate first-attempt local full unit run used Bun 1.4.4 and four workers:

```sh
bun test --parallel=4 --timings=<TASK_OWNED_TIMINGS_JSON> --update-timings
```

It completed naturally in 185.52 seconds: **8,338 passed, 16 skipped, 1 failed**
across 321 files, with 84,752 assertions. It tested `6005f000` plus the pending UI
output and script diagnostics, not the exact CI commit. The failed lease-path
fixture expected an unsafe-mode rejection but received a resolved promise. It
has a locally verified umask-independent setup fix in `cf5d4db6`; see
[cause, regression and limits](test-stability-lease-mode.md). The UI child passed
all 186 tests locally in 37.47 seconds. No observed owned process survived the supervised run; no cleanup
signals were needed. Local success does not explain the Linux timeout.

After the fixture fix, a separate full local unit check completed naturally in
184.05 seconds: **8,339 passed, 16 skipped, 0 failed**, across 321 files and 84,755
assertions. It started at `cf5d4db6` plus pending diagnostics and the authentication
test changes. `04c95acf` was committed during execution without changing unit-test
source content. This is not a run started at that later commit. The UI file took
37.33 seconds; no observed owned process survived, and no cleanup signals were
needed. The first failed full run remains part of the record.

The separate [UI output diagnostic](test-stability-ui-output.md), committed as
`b5f889fa`, forwards child stdout/stderr while retaining the original exit assertion
and deadline. Fresh independent Sol review found no actionable findings. It is an
observability improvement, not a fix for the timeout. The
[startup-script diagnostic](test-stability-script-diagnostics.md) is committed as
`7d75eb95` after correcting independent review findings about response ownership,
listener safety and redirects. Its 18 focused cases passed three executions each;
a real-browser probe passed six scenarios across Chromium and WebKit. It is not a
parser-error reproduction or a root-cause fix. Final-candidate CI verification
of the diagnostic commits remains pending.

The lease fixture and variant-authentication setup fixes were pushed in separate
commits through `04c95acf`. [CI run 41606357013](https://github.com/tjakobsson/uatu/actions/runs/41606357013)
completed with successful required validation, but four browser cases passed only
after retry. It does not contain the later diagnostic commits and is not evidence
of retry-free suite stability.

- Original permission case and fractional-mtime regression passed on retry 0
  (4,041 ms and 3,763 ms): their second first-attempt CI pass.
- Original variant boundary case and delayed-promotion regression passed on retry 0
  (1,426 ms and 1,680 ms): their first first-attempt CI pass.
- Unit tests passed 8,330/8,330 with 16 skipped. The unsafe-lease fixture passed;
  the original UI wrapper passed in 59,392.88 ms, close to its unchanged 60-second
  budget. That pass does not attribute or fix its previous timeouts.
- The same WebKit Pending-scroller case again moved the timeline by 125 px.
  Newly encountered retry-assisted failures were the WebKit docked/fullscreen iPad
  viewport case (chat above the visible work area), the WebKit long-caption
  wide-threshold case (work width 1,230 instead of at most 642), and the two-queued
  `/reload` case (prompt-response timeout). Their focused investigations remain
  pending; none is claimed fixed.

The committed diagnostic candidate `7d75eb95`, with only pending documentation,
then passed its single full local unit check: **8,348 passed, 16 skipped, 0 failed**
across 322 files, 84,718 assertions, 194.02 seconds. Candidate source and manifest
were unchanged during execution. Both diagnostic test files were collected;
owned processes exited naturally with no observed survivors or cleanup signals.
This local result does not replace the final candidate's GitHub CI verification.
