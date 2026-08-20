## Context

See `proposal.md` for motivation and `specs/opencode-chat/spec.md` for behavior. Desktop Chat currently flattens context status, three native selects, and Send/Cancel into one wrapping flex context through `.chat-composer-controls { display: contents; }`. The status string changes during a turn, context usage can appear later, and each select has a content-sized minimum, so ordinary flex line breaking moves controls at different panel widths.

The client already loads the complete model inventory during Chat bootstrap and holds staged model, mode, and variant overrides per conversation. Search needs no server endpoint. Touch Chat already tracks the visual viewport for keyboard geometry, and the project uses modal/sheet patterns that constrain focus and restore the covered surface.

Assistant messages currently replace their whole item `innerHTML` during streaming. Any action inserted into that subtree would be removed by the next delta. Preview has clipboard behavior, but its DOM decoration and line-number presentation are Preview-specific.

## Goals / Non-Goals

**Goals:**
- Make composer control placement deterministic from the minimum desktop Chat width through wide layouts.
- Give model-heavy installations a fast picker without changing configuration transport or staging.
- Use one configuration interaction that adapts its geometry across desktop and touch.
- Keep routine state and copy feedback accessible without introducing layout changes.
- Preserve streaming identity, find behavior, and normalized source fidelity for copied content.

**Non-Goals:**
- Recreating Paseo profiles, provider settings, attachments, microphone input, or auto-accept.
- Adding server-side model search, favorites, recents, or new model metadata.
- Changing OpenCode configuration defaults, prompt payloads, or persistence.
- Reworking the already-corrected touch safe-area ownership.
- Adding copy actions to user prompts, tools, reasoning, diffs, or whole conversations.

## Decisions

### D1: Use one non-wrapping grid rail with one flexible control

Replace the flattened wrapping context with an action rail whose columns are `auto minmax(0, 1fr) fixed fixed`: optional context usage, configuration trigger, routine status, and Send/Cancel. The trigger owns all flexible width, uses a one-line ellipsized visible label, and carries the full configuration in its accessible name. Status and Send/Cancel retain explicit square dimensions.

Removing mode, model, and reasoning selects from the rail is what makes this stable at the 340px desktop minimum. Letting them wrap as a group would still change composer height at several content-dependent thresholds. An always-two-row layout was rejected because it spends vertical space even when a compact rail fits and still leaves three controls competing within the second row.

Context appearance can shorten the trigger label but cannot change the status or trailing action coordinates. Visible failure text gets a separate full-width block between the textarea and rail. Textarea autosizing and that failure block can change composer height; neither participates in the rail grid.

### D2: Use one modal dialog with adaptive desktop and touch geometry

Create one configuration dialog and one state/controller path. In desktop mode, measure the Chat panel and trigger when opening and expose their bounds as CSS custom properties so the dialog appears above the trigger without escaping the panel. In touch mode, style the same dialog as a bottom sheet and size it from the current visual viewport above the tab bar or software keyboard.

Use a modal dialog rather than hand-building inertness and a focus trap. On open, desktop focuses search; touch focuses the sheet's first non-editing control so opening does not summon the software keyboard. On close, clear the query and restore focus to the trigger. Escape, backdrop dismissal, and the visible Done action share one close path. A mode change while open updates presentation without replacing the dialog or stacking another layer.

A nested settings sheet followed by a model sheet was rejected. Uatu has only three configuration dimensions, so nesting adds navigation and focus state without clarifying the task. A non-modal desktop popover was rejected because it would need separate focus containment and dismissal behavior from touch while the content and actions are otherwise identical.

### D3: Render searchable model rows from the existing inventory

Keep the fetched `ChatModel[]` as the source of truth. Build a normalized lower-case search string from model name, provider name, provider id, and model id. Filtering is synchronous and local; the expected inventory is tens or hundreds of small records, so an index or server request adds no useful behavior.

Render provider sections in the server's existing provider/name order. Remove empty sections after filtering and announce the visible result count through a polite result-status element. Each model is a button-like selectable row with primary model name, secondary provider plus `providerId/modelId`, and a non-colour-only current marker. Arrow keys move a roving active result, Enter selects it, and typing remains owned by the search field.

Selection calls the same staged-configuration helpers used by the current native selects. Choosing the effective conversation model clears a redundant staged override. A staged selection updates the trigger, context-window calculation, and reasoning inventory immediately. An unavailable effective model is rendered as current but disabled. Where no model is known, use agent-controlled wording such as `Let OpenCode choose` rather than inventing a default.

Mode and reasoning remain native selects inside a fixed picker footer. Native selection behavior is useful there and no longer affects composer geometry. Reasoning is rebuilt from the displayed model and omitted when unsupported or empty. Capability gating constructs only the sections the reported agent supports; if models are absent but another configuration dimension exists, the composer trigger uses a generic Chat-settings label.

### D4: Split routine status, announcements, and errors

Keep one always-present fixed-size visual status element with `data-state`, a state-specific non-colour-only glyph, `aria-label`, and title. Sending, working, and cancelling can animate subtly; reduced motion freezes the glyph. Elapsed time remains in the title and existing timeline waiting copy, not in the visible rail.

Use a separate visually hidden polite live region for significant transitions and do not announce one-second ticks. Provider and transport failures continue through the visible error path and draft restoration. An error glyph can accompany the message but never replaces it.

### D5: Preserve assistant shells and copy source data

Give each assistant item a stable shell with a dedicated Markdown-content child. Streaming patches replace only that child, preserving shell actions. Add the whole-answer action only when item or enclosing-turn completion proves the message is complete. Event delegation resolves the item against the active parent or drill-down projection and copies normalized `item.markdown`, never serialized rendered DOM.

Decorate each completed fenced `pre > code` idempotently. Code copy reads `code.textContent`, preserving source line breaks while excluding fences, highlighting wrappers, and controls. Copy actions remain fixed-size overlays. Fine pointers can recede them until hover or focus-within; coarse pointers keep them visible.

Factor clipboard writing and fallback behavior into a shared helper used by Preview and Chat. Chat owns its glyph and announcement feedback. Success or failure updates button state inside the fixed box and resets after a bounded delay.

## Risks / Trade-offs

- [Modal dialog positioning differs across browsers] -> Measure only on open and viewport/panel resize, clamp to Chat bounds, and cover Chromium plus touch WebKit geometry.
- [Touch search opens the keyboard and shrinks the sheet] -> Do not autofocus search in touch mode; recompute from the visual viewport when the user focuses it.
- [A large inventory makes repeated filtering noisy] -> Keep filtering linear and DOM updates grouped by provider; test with an inventory larger than the normal fixture.
- [Remote configuration updates race a staged local choice] -> Continue using displayed staged configuration as the visual source and effective configuration as the reset target.
- [Capability removal leaves a dead trigger] -> Derive trigger presence from the union of declared model, mode, and variant capabilities.
- [Streaming removes or duplicates copy controls] -> Patch only the content child and make completed decoration idempotent.
- [Clipboard fallback reports imprecise success] -> Return an explicit shared result and contain all failure paths without mutating conversation content.

## Migration Plan

No data or API migration is required. Ship the rail markup, picker controller, adaptive styles, status split, stable assistant shell, and copy decoration together so no intermediate state leaves duplicate configuration controls or streaming-sensitive actions. Existing staged configuration maps remain unchanged. Rollback restores native selects and prior rendering without changing conversation state.
