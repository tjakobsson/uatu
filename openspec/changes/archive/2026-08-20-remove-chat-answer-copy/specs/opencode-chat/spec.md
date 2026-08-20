## MODIFIED Requirements

### Requirement: Completed assistant content has scoped copy actions
Each fenced code block inside completed assistant content SHALL offer an accessible copy action that writes only the code content with its source line breaks, excluding syntax markup, fence delimiters, and controls. Completed assistant messages MUST NOT present a whole-answer copy action.

Code-block copy controls SHALL be keyboard operable and directly reachable on coarse-pointer devices. Success and failure feedback SHALL be perceivable without resizing the message, code block, or composer. Clipboard failure MUST leave conversation content unchanged and MUST NOT produce an uncaught error.

#### Scenario: Copy a completed assistant answer
- **WHEN** the user views a completed assistant message containing prose or fenced code
- **THEN** the message does not present an action to copy the whole answer
- **AND** each completed fenced code block retains its own scoped copy action

#### Scenario: Copy one fenced code block
- **WHEN** the user activates copy for a fenced code block in completed assistant content
- **THEN** the clipboard receives only that block's code with its source line breaks
- **AND** syntax markup, fences, and control labels are excluded

#### Scenario: Streaming answer is not presented as complete
- **WHEN** an assistant message is still streaming
- **THEN** it does not present a whole-message copy action
- **AND** completing the message does not add a whole-message copy action

#### Scenario: Touch copy does not depend on hover
- **WHEN** a coarse-pointer user views a fenced code block in completed assistant content
- **THEN** its code-copy action is reachable by tap
- **AND** no hover state is required to reveal it

#### Scenario: Copy feedback preserves geometry
- **WHEN** a code-block copy succeeds or fails
- **THEN** Chat reports the outcome accessibly
- **AND** the message, code block, composer, and surrounding timeline retain their dimensions

#### Scenario: Clipboard failure is contained
- **WHEN** clipboard access is unavailable or rejects the write
- **THEN** conversation content remains unchanged
- **AND** Chat reports failure without an uncaught error
