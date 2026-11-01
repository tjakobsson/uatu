## Why

Three chat-surface presentation defects make the agent conversation hard to read at a glance: billion-token usage counts print as thousands of millions (`1023.7M`), a skill load whose legacy key is gone renders as a bare "Skill" row with no name, and multi-select questions truncate their prompt and leave selected/unselected options visually indistinguishable (GitHub #464, #524, #520).

## What Changes

- Token-scale formatting in the shared `formatTokens` helper gains a billion branch: values at or above 1e9 render with a `B` suffix and one decimal (`1023.7M` → `1.0B`), with thousand/million behavior unchanged. Exact totals remain one hover or expansion away, as they already are via titles and breakdowns (#464).
- Skill-loading rows parse the current Claude Code Skill tool payload, which names the skill by `id` alone (tool schema: "the skill ID must match an available skill"); the collapsed row then carries the skill name in its subject, naming it once, with fork transcript navigation and expanded details untouched (#524).
- Multi-select question rows wrap their full prompt and present clearly distinct selected/unselected states: **reproduced on this base** from a live OpenCode multi-question form (the long question text rides in the structured question's header, questions are optional, so every tab showed a single-line ellipsised question under an unearned ✓ tick). Fix: the active panel states its question in a visible, wrapped legend instead of a screen-reader-only one, and a step's tick states a real choice rather than an optional question left empty (#520; evidence captured under `screenshots/` and covered by e2e).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `claude-code-chat`: usage readout token totals gain readable billion-scale display; skill-loading activity is named by the skill it loads in the collapsed timeline row; multi-select question rows (if the reproduction keeps the item in this batch) wrap the full question and distinguish selection states.

## Impact

- `src/chat/usage.ts` (`formatTokens`), `src/chat/tool-detail.ts` (skill case), `src/chat/timeline-renderer.ts` (question panel legend), `src/chat/question-form.ts` (step tick semantics).
- New colocated tests: `src/chat/usage.test.ts`; additions to `src/chat/tool-detail.test.ts`, `src/chat/timeline-renderer.test.ts`, `src/chat/question-form.test.ts`; new e2e `tests/e2e/chat-question-readability.e2e.ts`.
- Reproduction evidence for #520 travels under this change's `screenshots/` folder at PR time (`UATU_E2E_SCREENSHOTS_DIR`), per the evidence discipline.
- No API, wire-format, or dependency changes.
