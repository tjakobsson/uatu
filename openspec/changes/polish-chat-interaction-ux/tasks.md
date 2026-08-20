## 1. Stable Composer Rail And Status

- [x] 1.1 Replace the flattened wrapping composer controls with context, one flexible configuration trigger, fixed routine status, and fixed Send/Cancel grid columns.
- [x] 1.2 Move actionable composer failures into a separate visible full-width region while preserving draft restoration and existing error announcements.
- [x] 1.3 Replace routine status strings with named fixed-size glyph states and a separate polite live region that excludes elapsed-time ticks.
- [x] 1.4 Add reduced-motion status styling and keep elapsed working time in non-reflowing title or timeline copy.
- [x] 1.5 Add shell and browser geometry tests for minimum, threshold, and wide desktop panel widths; context hidden/visible; and ready, sending, working, cancelling, and failure transitions.

## 2. Unified Searchable Configuration Picker

- [x] 2.1 Replace composer model, mode, and reasoning selects with one trigger that shows an ellipsized model summary and a complete accessible configuration name.
- [x] 2.2 Build one modal configuration dialog with shared open, close, dismissal, query reset, capability gating, and focus-restoration behavior.
- [x] 2.3 Implement desktop trigger-relative positioning clamped to the Chat panel and touch bottom-sheet sizing from the visual viewport without changing safe-area ownership.
- [x] 2.4 Render provider-grouped model rows with primary and secondary identity text, selected and unavailable states, agent-controlled fallback wording, and an accessible result count.
- [x] 2.5 Add case-insensitive local filtering across model name, provider name, provider id, and model id, including empty-result and empty-group handling.
- [x] 2.6 Add search and result keyboard behavior, desktop search autofocus, touch non-editing initial focus, modal focus containment, and Escape/Done/backdrop dismissal.
- [x] 2.7 Move mode and reasoning controls into the picker footer, rebuild reasoning from the displayed model, and omit undeclared or unavailable configuration dimensions.
- [x] 2.8 Route picker selections through existing staged-configuration state, including effective-value reset, remote-update preservation, context-window recalculation, and next-prompt transport.
- [x] 2.9 Replace native-select configuration tests with picker tests for staged/effective values, unknown and unavailable models, capability subsets, large inventories, search fields, and second-client updates.
- [x] 2.10 Add desktop and touch browser coverage for one-layer presentation, panel/viewport bounds, software-keyboard resizing, no touch autofocus, keyboard navigation, and focus restoration.

## 3. Shared Clipboard And Assistant Copy Actions

- [x] 3.1 Extract a shared clipboard-write helper with explicit success/failure results and migrate Preview without changing its presentation.
- [x] 3.2 Refactor assistant rendering to keep a stable item shell and patch only its Markdown-content child during cumulative and incremental streaming.
- [x] 3.3 Add an idempotent whole-answer copy action only for completed assistant items, resolving normalized Markdown from parent and drill-down projections.
- [x] 3.4 Add idempotent fixed-size copy actions to completed assistant fenced code blocks, copying only code text with source line breaks.
- [x] 3.5 Implement fixed-geometry copied/failed glyph feedback, polite announcements, fine-pointer hover/focus presentation, and always-reachable coarse-pointer controls.
- [x] 3.6 Add unit coverage for modern clipboard success, missing clipboard, synchronous failure, rejected promises, fallback behavior, and bounded feedback reset.
- [x] 3.7 Add renderer and browser coverage for streaming completion, rerender idempotence, multiple code blocks, parent/drill-down actions, exact copy scope, touch reachability, and geometry preservation.

## 4. Verification

- [x] 4.1 Run TypeScript checks and focused Chat shell, configuration, timeline, clipboard, viewport, and Preview tests.
- [x] 4.2 Run the full `bun test` suite and relevant serial desktop and mobile WebKit Playwright tests.
- [x] 4.3 Run `openspec validate polish-chat-interaction-ux --strict` and resolve every planning or scenario validation error.
