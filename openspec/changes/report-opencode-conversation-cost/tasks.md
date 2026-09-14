## 1. Wire and types

- [x] 1.1 Add `costUsd?: number` to `TokenUsage` in `src/chat/types.ts`; keep it out of `TOKEN_USAGE_COMPONENTS` in `src/chat/usage.ts` and make `sameUsage` compare it; verify `bun test src/chat/usage.test.ts` passes with a new case for cost equality
- [x] 1.2 Accept `costUsd` (finite, ≥ 0) in `expectTokenUsage` in `src/chat/validation.ts`; verify a validation test accepts a usage record with cost and rejects a negative one
- [x] 1.3 Bump the workspace API revision 17 → 18: `TokenUsage.costUsd` in `api/openapi.yaml` (+ `info.version`, `info.summary`, `x-uatu-revisions`), `api/contract.json`, `src/shared/version.ts`, and a `## Hub 5 / Workspace 18 - Unreleased` section in `api/CHANGELOG.md` with `Compatibility: breaking (workspace)` and a Migration paragraph; verify `bun test src/shared/api-revisions.test.ts` passes and the CI "Enforce compatibility" step run locally against `origin/main` classifies it as an announced break

## 2. OpenCode adapter

- [x] 2.1 Read `cost` in `tokensToUsage` (`src/chat/opencode/normalization.ts`) with the same finite/≥0 guard as the token fields; verify `normalization.test.ts` covers a live `message.updated` carrying cost, a stored-history message carrying cost (via `storedMessageUsage`), and a message with `cost: 0` producing `costUsd: 0`
- [x] 2.2 Confirm the subagent usage mirror carries `costUsd` unchanged onto the launching tool row; verify with a test on the mirror path

## 3. Client fold and readout

- [x] 3.1 Add `conversationTotals(items)` (new `src/chat/conversation-totals.ts`) that sums carrier costs into a `SessionTotals` with per-model rows, returns `undefined` when no carrier has a cost or the sum is zero, and omits `since`; verify unit tests for: restated carrier counted once, absent cost contributes nothing, all-zero → undefined, two models → two rows
- [x] 3.2 Add a `resolveSessionTotals(items)` that prefers the newest `context_report.session` and falls back to the carrier fold; route `paintPlanSession` and `planSummaryLabel` through it in `src/chat/ui.ts` / `src/chat/composer-status.ts`; verify the Claude Code path is unchanged by the existing `composer-status.test.ts` and `ui` tests, and a new test shows the chip reading "$x.xx this conversation" from carriers alone
- [x] 3.3 Show the subagent's cost beside its tokens on the subagent row (painted in `src/chat/ui.ts`, not the timeline renderer) when `usage.costUsd > 0`; verify a renderer test for present and absent cost

## 4. Verification

- [ ] 4.1 Run a real OpenCode conversation on the dev hub with a priced model and capture `screenshots/after-chip-desktop.png`, `screenshots/after-readout-desktop.png` (readout open, model rows visible), and `screenshots/after-chip-phone.png`; verify the cost matches OpenCode's own session cost for the same session — *blocked: the only priced provider (`opencode-go`) has no balance, and the OAuth OpenAI login is priced at 0 by OpenCode. The real run did prove the path: a live `opencode-go/gpt-5.6-luna` turn reached the workspace API as a carrier with `costUsd: 0`, and the chip stayed hidden as specified. The positive figure is verified by the fixture-driven `tests/e2e/chat-shell-output.e2e.ts` (chip, readout rows, subagent row) against the real client and wire validation; its shots are the `after-*` files. Rerun `.local/opencode-cost-walkthrough.ts <session-url>` once the provider has balance.*
- [ ] 4.2 Reopen the same conversation after a workspace restart and capture `screenshots/after-reopen-desktop.png`; verify the chip shows the same cost with the block titled "This conversation" (no "since") — *the fixture e2e covers reopen after a page reload (`after-reopen-desktop.png`); the restart case waits on 4.1's provider.*
