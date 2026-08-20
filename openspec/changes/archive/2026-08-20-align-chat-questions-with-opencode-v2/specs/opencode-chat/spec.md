## ADDED Requirements

### Requirement: Structured questions follow OpenCode custom-answer semantics
For every structured question, Chat SHALL support a custom answer unless OpenCode explicitly reports `custom === false`. An omitted `custom` value MUST enable custom answers for both live question announcements and pending questions recovered from OpenCode. An explicit false value MUST suppress the custom-answer choice.

Where custom answers are supported, Chat SHALL append a UI-only choice labelled "Type your own answer" to the provider's options. Selecting that choice SHALL reveal and focus a text input. The synthetic label MUST NOT be submitted to OpenCode. Chat SHALL trim the entered text and submit the non-empty result as an ordinary string in that question's answer array.

For a single-select question, the custom choice SHALL be mutually exclusive with provider options. For a multi-select question, it SHALL be selectable alongside provider options and its entered text SHALL be appended as one additional answer string. Deselecting the custom choice SHALL hide its input and exclude its text from submission, but MUST preserve the text while the pending question remains mounted so selecting it again restores the draft.

#### Scenario: Omitted custom flag enables a custom choice
- **WHEN** OpenCode asks a question without a `custom` field
- **THEN** Chat shows a "Type your own answer" choice
- **AND** this behavior is the same for a live announcement and a recovered pending question

#### Scenario: Explicit false suppresses custom answers
- **WHEN** OpenCode asks a question with `custom === false`
- **THEN** Chat does not show a custom-answer choice or input
- **AND** only provider options can satisfy that question

#### Scenario: Selecting custom reveals its input
- **WHEN** the user selects "Type your own answer"
- **THEN** its text input becomes visible and receives focus
- **AND** the question remains unanswered until that input contains non-whitespace text

#### Scenario: Single-select custom answer is submitted as text
- **WHEN** the user selects the custom choice, enters text, and confirms a single-select question
- **THEN** OpenCode receives the trimmed entered text as the question's one answer string
- **AND** it does not receive the synthetic choice label

#### Scenario: Multi-select combines options and custom text
- **WHEN** the user selects provider options and the custom choice in a multi-select question, enters text, and confirms
- **THEN** the answer array contains the selected provider labels and the trimmed custom text
- **AND** the synthetic choice label is absent

#### Scenario: Custom draft survives temporary deselection
- **WHEN** the user types a custom answer, deselects the custom choice, and selects it again while the request remains pending
- **THEN** the typed draft is restored
- **AND** the draft is omitted from any answer submitted while the custom choice is deselected

#### Scenario: Streaming preserves an unfinished custom answer
- **WHEN** conversation updates arrive while the user is typing a custom answer in a pending question
- **THEN** the selected custom choice, input visibility, focusable control, and typed draft remain intact

### Requirement: Single-question choices require explicit confirmation
A question form containing one single-select question SHALL retain the selected option without submitting it when the option is clicked. Chat SHALL expose an explicit Answer action and SHALL submit only when the user activates that action or performs the form's equivalent explicit submission. This rule SHALL apply whether custom answers are enabled or disabled.

Existing multi-question stepping SHALL remain unchanged: intermediate confirmation advances to the next question, the final action submits all ordered answers, and earlier answers remain revisitable. Existing multi-select questions SHALL continue to require explicit confirmation and SHALL allow more than one selected answer.

#### Scenario: Single provider option does not auto-submit
- **WHEN** the user selects a provider option in a one-question single-select form
- **THEN** the option remains selected and the Answer action becomes available
- **AND** no response is sent until explicit confirmation

#### Scenario: Single custom choice does not auto-submit
- **WHEN** the user selects the custom choice and enters a valid answer in a one-question single-select form
- **THEN** the custom answer remains staged and the Answer action becomes available
- **AND** no response is sent until explicit confirmation

#### Scenario: Multi-question stepping is preserved
- **WHEN** a structured request contains more than one question
- **THEN** confirming an answered intermediate question advances to the next question
- **AND** the final confirmation submits one ordered answer array per question

#### Scenario: Multi-select confirmation is preserved
- **WHEN** a question allows multiple answers
- **THEN** the user can select more than one provider option and an applicable custom answer
- **AND** Chat waits for explicit confirmation before submitting them

### Requirement: Question answers are semantically valid before provider reply
Every answered question request SHALL contain exactly one answer array for each question in request order, and every such array MUST contain at least one non-empty string. A single-select answer array MUST contain exactly one string. A provider-option string MUST match an offered label, while any other string MUST be accepted only when that question supports custom answers. Chat MUST reject an invalid response without forwarding it to OpenCode or resolving the pending request.

#### Scenario: Missing per-question answer is rejected
- **WHEN** a response omits an answer array or provides an empty answer array for any question
- **THEN** Chat rejects the response
- **AND** OpenCode receives no reply

#### Scenario: Empty custom text is rejected
- **WHEN** a custom answer is empty after trimming
- **THEN** Chat keeps the question pending and requires a non-empty answer
- **AND** OpenCode receives no reply

#### Scenario: Unknown answer is rejected when custom is disabled
- **WHEN** a response contains a string that is not an offered option and the question explicitly disables custom answers
- **THEN** Chat rejects the response
- **AND** OpenCode receives no reply

#### Scenario: Valid ordered answers reach OpenCode once
- **WHEN** every question has a semantically valid answer and the user confirms the form
- **THEN** OpenCode receives the ordered string arrays once
- **AND** the request resolves everywhere it is shown under the existing ownership rules
