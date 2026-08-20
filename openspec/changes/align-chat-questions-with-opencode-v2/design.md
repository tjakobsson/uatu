## Context

See `proposal.md` for motivation and `specs/opencode-chat/spec.md` for behavior. Both live SDK v2 question events and pending-question recovery pass through `normalizeQuestion`. It currently sets `allowFreeForm` only for `custom === true`, although OpenCode treats the optional field as enabled unless explicitly false.

Question forms are rendered as persistent keyed timeline nodes, which already protects typed state from unrelated streaming updates. Current custom input is always visible and shares the provider-option name. FormData collection happens generically, and a change handler auto-submits a lone non-custom radio question. The adapter validates answer count and option membership but permits an empty per-question array and whitespace-only custom strings.

## Goals / Non-Goals

**Goals:**
- Preserve OpenCode's optional-field semantics through live and recovered paths.
- Model custom answers as an explicit choice while keeping the entered value as an ordinary answer string.
- Preserve in-progress custom drafts and existing stepped forms under streaming.
- Require deliberate confirmation for every one-question single-select flow.
- Reject malformed answers before provider reply without changing request ownership or idempotency.

**Non-Goals:**
- Changing OpenCode's `string[][]` reply shape or adding a custom-answer transport type.
- Replacing the existing tabbed multi-question presentation.
- Making structured questions optional or allowing unanswered steps.
- Changing rejection, subagent mirroring, active-request ordering, or response receipts.
- Persisting unfinished question drafts across page reloads.

## Decisions

### D1: Normalize omission as enabled at the provider boundary

Set normalized `allowFreeForm` from `question.custom !== false`. Keep `multiple` opt-in with `question.multiple === true`. Since live announcements and pending-list recovery already share `normalizeQuestion`, one rule covers both paths and avoids introducing compatibility state elsewhere.

Defaulting later in the renderer was rejected because snapshots, adapter validation, and alternate clients also consume the normalized flag. The normalized domain should carry the resolved semantic value rather than the SDK's optional representation.

### D2: Keep the custom choice out of provider options

Render the synthetic choice after provider options, but do not add it to `StructuredQuestion.options`. Use a radio for single-select and a checkbox for multi-select, marked with UI-only data attributes. Give the text input its own non-answer field name so neither FormData nor adapter validation can mistake the synthetic marker for a provider answer.

Selecting the custom control reveals and focuses its input. Selecting a provider radio hides the single-select custom input through native radio exclusivity; unchecking a multi-select custom checkbox does the same. Hiding never clears the input value. This preserves a draft if the user changes their mind and returns, while answer collection ignores the value whenever the custom control is not selected.

An always-visible text field was rejected because it does not present custom text as a peer choice and makes single-choice mutual exclusion implicit. Clearing text on deselection was rejected because a harmless exploratory click destroys user input.

### D3: Derive completeness and answers from explicit controls

Replace the broad "any checked input or any text" completeness rule with question-aware collection. A panel is answered when at least one provider option is selected, or when its selected custom control has non-empty trimmed text. For single-select, native radios enforce one chosen path. For multi-select, provider labels and one custom value can coexist.

On final submission, walk questions in order and collect only checked provider-option values plus the selected custom input's trimmed value. Do not rely on generic `FormData.getAll`, which would make synthetic marker leakage easy. Keep the existing missing-step navigation and announcement if a programmatic or Enter submission bypasses the disabled primary action.

### D4: Remove radio-change submission and retain standard form submission

Delete the change-handler branch that calls the question mutation for a lone radio. Every selection change only updates DOM state, tabs, and primary-action availability. The existing Answer button remains the visible confirmation. Standard explicit form submission, including Enter from the revealed text input, follows the same final validation and submission path.

Changing the button copy to Submit was rejected because Answer is already specific to the interaction and multi-question flows use Next followed by Answer. The behavior change is explicit confirmation, not new vocabulary.

### D5: Validate semantic completeness at the adapter boundary

Retain route-level size and type bounds, then strengthen pending-question validation before provider reply. Require the top-level answer count to equal the question count, every answer array to contain at least one string with non-whitespace content, and single-select arrays to contain exactly one string. Offered labels remain valid exact values; unknown strings require `allowFreeForm`.

The browser trims custom text before sending. The adapter rejects whitespace-only values from alternate clients but does not rewrite provider labels or custom strings, avoiding an unexpected server-side mutation contract. Update normalized API documentation so each per-question answer array has `minItems: 1` and explains ordering and custom strings.

Validation remains inside the existing pending-request and receipt flow. A rejected semantic response does not resolve the projection or call the provider, while duplicate valid requests still use the existing at-most-once receipt behavior.

## Risks / Trade-offs

- [Synthetic controls leak into submitted answers] -> Use separate UI-only names and explicit answer collection rather than raw FormData aggregation.
- [A stream update resets the selected custom state] -> Keep the existing question patch-in-place identity rule and test selected, revealed, focused, and typed state during deltas.
- [Hidden custom input remains focusable] -> Pair control state with the `hidden` attribute and move focus only when revealing it.
- [Single-select native radio grouping crosses question panels] -> Keep names scoped by question index and render one custom radio in the same group.
- [Adapter validation rejects a provider label containing surrounding spaces] -> Match exact offered labels before applying non-whitespace custom validation.
- [Enter in a custom field surprises users] -> Route it through the same explicit form submit path and retain missing-step checks for multi-question forms.

## Migration Plan

No persisted data migration is required. Ship normalization, renderer markup, interaction handling, answer collection, and adapter validation together so the new default cannot expose a custom choice that an older collector mishandles. Existing resolved outcomes remain valid `string[][]` records. Rollback restores the old UI and defaulting without transforming stored conversations.
