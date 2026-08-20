## 1. OpenCode Semantics And Validation

- [x] 1.1 Change question normalization so omitted `custom` enables free-form answers and only explicit false disables them for live and recovered requests.
- [x] 1.2 Add normalization and SDK provider tests for omitted, true, and false `custom` values across event and pending-list paths.
- [x] 1.3 Strengthen adapter validation to require one non-empty answer array per question, exactly one string for single-select, valid option labels, and custom support for unknown strings.
- [x] 1.4 Add adapter and route tests proving empty arrays, whitespace-only values, extra single-select values, and custom-disabled unknown values never reach the provider or resolve the request.
- [x] 1.5 Document ordered answer arrays, ordinary custom strings, and per-question `minItems: 1` in the normalized OpenAPI schema and keep generated API checks current.

## 2. Question Choice Rendering And Interaction

- [x] 2.1 Render a UI-only "Type your own answer" radio or checkbox after provider options when `allowFreeForm` is true, with an initially hidden separately named input.
- [x] 2.2 Style the custom choice as a peer option and implement accessible reveal, focus, hide, selected, and disabled states for single-select and multi-select forms.
- [x] 2.3 Preserve custom input text on deselection while excluding hidden or deselected custom values from form completeness and submission.
- [x] 2.4 Replace generic FormData aggregation with ordered question-aware answer collection that trims selected custom text and never emits the synthetic label.
- [x] 2.5 Remove single-radio auto-submission so option changes only update selection, tabs, missing state, and Answer-button availability.
- [x] 2.6 Preserve existing Next/final Answer stepping, revisiting earlier questions, explicit multi-select confirmation, Enter submission validation, rejection, and card disabling.

## 3. Regression Coverage And Verification

- [x] 3.1 Extend timeline renderer tests for omitted/false custom behavior, hidden and revealed input markup, single and multi synthetic controls, and resolved-card receding.
- [x] 3.2 Add interaction tests for reveal/focus, non-empty completeness, no click auto-submit, custom draft preservation, provider-option exclusivity, mixed multi answers, trimming, and synthetic-label exclusion.
- [x] 3.3 Add streaming and drill-down tests proving selected custom state, input visibility, typed text, stepping, ownership, and at-most-once replies survive updates.
- [x] 3.4 Add desktop and touch Playwright coverage for explicit Answer confirmation, live and recovered omitted-custom questions, explicit false, and multi-select option-plus-custom payloads.
- [x] 3.5 Run TypeScript checks and focused normalization, provider, adapter, route, renderer, client, and Chat browser tests.
- [x] 3.6 Run the full `bun test` suite and relevant serial Playwright tests.
- [x] 3.7 Run `openspec validate align-chat-questions-with-opencode-v2 --strict` and resolve every planning or scenario validation error.
