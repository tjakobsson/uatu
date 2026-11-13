# Tasks

## 1. Recover aliases with interleaved native execution clocks

- [x] 1.1 Add permanent provider tests for source-plausible input/execution order differences; verify they fail before the correction and retain the original parent tool order.
- [x] 1.2 Correct interval comparison without merging tied, missing, or boundary-separated starts; verify the new regressions and stale-result controls pass.
- [x] 1.3 Update the historical-recovery architecture note and verify it describes order-independent interval comparison, not global transcript sorting.

## 2. Recover after a partially failed initial inventory

- [x] 2.1 Add permanent first-failure/healthy-retry tests for shell ownership, agent active state, and child execution history; verify the expected-working assertions fail before the correction.
- [x] 2.2 Correct completion accounting while retaining healthy sibling admission; verify repeated and queued fresh retries restore only positively verified unchanged occurrences.
- [x] 2.3 Verify observation gaps, revoked/unavailable records, changed ownership, and capacity guards still refuse unproved controls; document partial-inventory behavior beside the existing recovery architecture.

## 3. Verify and deliver the expanded follow-up

- [x] 3.1 Run the provider/control regression suites, sanitized reproductions, typecheck, build/smoke, strict OpenSpec checks, and diff checks; record pass/fail results and distinguish unchanged baseline failures.
  - RED before each correction: two provider interleaved-clock cases failed after preserving tool order; seven first-inventory/queued-retry cases failed their expected-working assertions.
  - GREEN: `bun test src/chat/opencode/v2/provider.test.ts src/chat/opencode/v2/background.test.ts src/chat/opencode/v2/normalization.test.ts` — 1,624 passed, zero failed. Includes 32 new positive and conservative-boundary cases.
  - Unedited synthetic reproductions: 30 live/recovery cases passed (one diagnostic that asserts the old bug remains was excluded); all three source-valid history cases passed. Notification-first multi-alias cases remain outside this correction.
  - `bun run typecheck`, `bun run build`, `bun run smoke`, and `git diff --check` passed. Build emitted unsupported CSS `highlight` selector warnings. `openspec validate --all --strict` passed all 61 items.
  - The full unit suite completed with 7,207 passed, 16 skipped, and the same two unchanged baseline failures: the 150 ms backend startup-progress window and the unsafe-mode fixture affected by inherited umask `077`. No new full-suite failures appeared. Dedicated functional browser suites and the unrelated CI UI-wrapper timeout were not rerun; no unrelated runtime/configuration tests were changed.
- [x] 3.2 Obtain fresh independent review focused on recovery completion and Stop admission, resolve affected findings, and verify no private capture data or credentials enter the patch.
  - Fresh independent Sol/high control-safety review and Luna/high standards/spec review found no issues. Independent execution passed 50 focused repository cases and three additional guard/accounting/concurrency probes. The lead reran both original minimal reproductions and observed GREEN results.
- [x] 3.3 Prepare the updated #559 content and verification limitations, and obtain approval before publishing the update.
  - The user approved publishing both verified corrections, updating the PR title/scope/evidence, and retaining ready-for-review status.
