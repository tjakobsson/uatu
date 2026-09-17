## 1. Provider: what a message answers and who produced it

- [x] 1.1 Carry the answered prompt id on `storedMessageUsage` / `StoredMessageAccounting`: named by the classic record (`parentID`), and for the v2 record — which names none — the newest user message before it in the provider's ordered transcript; verify with normalization unit tests covering both shapes and a message lacking the field, and a provider test pairing across a page boundary
- [x] 1.2 Carry the answered prompt id on the live `assistantUsage` / `assistantModel` reports from `message.updated`, falling back to the newest prompt the session was seen to receive; verify with a normalization test that a restated message keeps it
- [x] 1.3 Put `agent` on the `usage:<id>` carrier (live and stored paths) and accept it in `validation.ts`; verify with carrier tests and a validation test for the new field

## 2. Adapter: attribute per task, list descendants

- [x] 2.1 Fold child usage per launcher row: group a child's messages by answered prompt and pair groups with that child's `task` rows in order, unmatched groups to the preceding row; verify with an adapter test where one child has two rows and the rows' usage sums to the child's total with no repetition, live and after reopen
- [x] 2.2 Replace `decorateLauncherRow`'s first-match lookup and `attributeLaunchers`' per-session stamping with the per-row fold; verify the released-token regression with a test that a second task's row states only its own tokens and leaves the first row unchanged
- [x] 2.3 Remove `propagateInclusive` and the `agent:<id>` roll-up; build `descendants` on the top-level launcher row from the recursive reconstruction and from live events at any depth; verify with the existing nested adapter tests rewritten to expect own-spend rows plus a three-deep `descendants` list
- [x] 2.4 Keep removal, revert invalidation, eviction epochs and the completeness mark correct under the new fold; verify the existing attribution race tests pass and add one for a revert inside a reused child
- [x] 2.5 Add `descendants` to the tool item type, merge/replace path (`projection.ts`, the adapter's tool merge) and `validation.ts`; verify with validation and projection tests including a shrinking descendants list

## 3. Receipt model

- [x] 3.1 Rewrite `conversationTotals` to return receipt lines (main-agent lines grouped by carrier agent name, task lines, descendant lines with parent links) and the total; verify with unit tests built from the real-case figures in `screenshots/` that the lines sum to the total
- [x] 3.2 Add the by-type fold (distinct subagents per kind by conversation id, task count where larger) and the by-model fold (tokens, cost, contributing agents); verify all three folds return the same total in the unit tests
- [x] 3.3 Derive the "same agent as" relation from equal conversation ids among lines; verify with a unit test for a reused agent and for two distinct agents sharing a description

## 4. Readout UI

- [x] 4.1 Replace the two tables in `index.html` with one receipt table, the Agents/Types/Models radiogroup and a total row; style nesting indentation, the same-agent note and the total line in `styles.css`; verify in the dev hub against the agreed mock (`screenshots/mock-proposed-vs-before.png`) in light and dark, saved as `screenshots/after-real-3-receipt-by-*.png`
- [x] 4.2 Paint the three itemizations in `ui.ts` from the receipt model, persist the choice on the device, and keep Claude Code's per-model block with no control; verify with ui tests for each view, persistence across conversation switches, and an unchanged Claude readout
- [x] 4.3 State own-task cost on the timeline subagent row and the composer list row, and the agent's own spend across its tasks in the drill-down header; verify with timeline-renderer and ui tests for a reused agent and a nested launcher
- [x] 4.4 Make the composer list summary count distinct subagents and state tasks where they differ; verify with a ui test for "4 subagents finished" and "3 subagents · 4 tasks finished", including the working-state wording

## 5. Contract

- [x] 5.1 Bump `WORKSPACE_API_REVISION` to 20 and update `api/contract.json`, `api/openapi.yaml` (version, `x-uatu-revisions`, tool item and usage schemas) and `api/CHANGELOG.md` with a Migration section; verify `api/contract.test.ts` and the compatibility check pass
- [x] 5.2 Update the fixture agent and e2e server data to produce a reused subagent and a nested subagent; verify the existing chat cost e2e specs pass against them

## 6. End to end

- [x] 6.1 Add an e2e spec in `tests/e2e/` for the receipt: a reused subagent billed once, nested lines beneath their launcher, named main agents, the three itemizations summing to the same total, and the remembered choice; verify it passes and records evidence through `tests/e2e/evidence.ts`
