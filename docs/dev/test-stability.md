# Test-stability investigation

## Objective and current status

Make test results trustworthy by establishing failure mechanisms and fixing their
causes, including product defects when implicated. This draft starts with planning
only: no failures have been reproduced and no fixes or passing test runs are
claimed by this change.

The initial source baseline is `ffd92c36203dc47d1a6254e5aef319d0d8cc1453`.
The nine initial issues below remain investigation targets, not promises of nine
fixes. Newly discovered test-stability defects are also in scope, under the same
reproduction, review and GitHub CI acceptance criteria.

## Scope and sequence

| Order | Issue | Investigation | Status |
| --- | --- | --- | --- |
| 1 | [#563](https://github.com/tjakobsson/uatu/issues/563) | Reproduce credential-test contamination from inherited Git/SSH projection; preserve the credential behavior under test. | pending |
| 2 | [#560](https://github.com/tjakobsson/uatu/issues/560) | Attribute the isolated chat UI wrapper timeout to child execution, output handling or shutdown. | pending |
| 3 | [#536](https://github.com/tjakobsson/uatu/issues/536) | Investigate the remaining clipboard rejection and native-watcher final-write timeout separately; account for the polling failures already addressed by #511. | pending |
| 4 | [#233](https://github.com/tjakobsson/uatu/issues/233) | Investigate the remaining macOS find-next shortcut failure; distinguish it from the document-tree case addressed by #462. | pending |
| 4 | [#253](https://github.com/tjakobsson/uatu/issues/253) | Map reported load-sensitive failures, including comments, against #462 before investigating the remaining mechanisms. | pending |
| 4 | [#438](https://github.com/tjakobsson/uatu/issues/438) | Distinguish the lost-click and WebKit connection failures from the personal-state race addressed by #462. | pending |
| 5 | [#538](https://github.com/tjakobsson/uatu/issues/538) | Separate expensive execution, contention and the workdock timeout; account for partition and trace-policy improvements in #519. | pending |
| 6 | [#579](https://github.com/tjakobsson/uatu/issues/579) | Attribute the intermittent pre-bootstrap syntax error using sanitized script and exception diagnostics. | pending |
| 6 | [#580](https://github.com/tjakobsson/uatu/issues/580) | Attribute the WebKit login mismatch without recording credentials or weakening authentication. | pending |

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
