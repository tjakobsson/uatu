# Tasks

## 1. Diagnose and lock down the occurrence boundary

- [x] 1.1 Reproduce six unknown launcher rows despite five explicit results, and minimize the failure to two same-child launches with a later idle boundary; verify the original history fold fails the expected-completion assertion.
- [x] 1.2 Add provider-history regressions for the six-launcher sequence, ambiguous clocks, delayed old results, duplicate notifications, and unresolved-work Stop refusal; verify the regression fails before the correction and all eight cases pass afterward.

## 2. Correct the transient history fold

- [x] 2.1 Group aliases using complete verified execution intervals, then apply uncertainty to unresolved work; verify explicit results settle the correct occurrences without reordering parent tools.
- [x] 2.2 Document historical grouping, conservative recovery, and unchanged control boundaries in `ARCHITECTURE.md`; verify the documentation matches the implementation and existing `opencode-chat` requirements.

## 3. Integrate and review the follow-up

- [x] 3.1 Verify the sanitized native-record replay and full unit suite on top of merged `main`, recording actual results without issuing model turns or mutating live sessions.
- [x] 3.2 Run typecheck, binary build/smoke, strict OpenSpec validation, and `git diff --check`; verify each completes successfully.
- [x] 3.3 Obtain fresh independent review of the integrated code and tracking artifacts; resolve affected findings and verify publication contains no credentials, private conversation content, or native identifiers from the captured records.

## Verification results

- Eight historical-provider tests and the sanitized actual-provider replay passed. The replay resolves six launcher references to five completed occurrences.
- Typecheck, build, binary/browser smoke checks, strict OpenSpec validation, and diff checks passed. Fresh independent review found no issues.
- The full local suite completed with 7,175 passed, 16 skipped, and two failures outside this change. Both failures reproduce on baseline `512290b`: the unsafe-mode fixture inherits an `077` umask, and the startup-progress test exceeds its 150 ms inactivity budget.
- A command-scoped `umask 022` removes the fixture failure on both baseline and follow-up; the startup test still fails on both. Its underlying process-delay cause is unproven. These unrelated tests and production service settings were not changed.
- Dedicated functional browser suites were not rerun for this follow-up; coverage includes provider-level regression tests, captured-record replay, and the existing binary/browser smoke suite.
- This change passes strict validation and its archived tasks are complete. The optional repository-wide archived-task check also reports six pre-existing incomplete archives; this follow-up does not modify those records.
