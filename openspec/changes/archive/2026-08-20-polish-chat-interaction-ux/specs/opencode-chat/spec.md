## ADDED Requirements

### Requirement: Chat composer actions keep a stable one-line layout
The Chat composer SHALL place context usage, one configuration trigger, routine status, and the Send/Cancel action in a deliberate non-wrapping action rail. The configuration trigger SHALL take the flexible space and truncate its visible label when necessary. Routine status and the trailing action SHALL keep fixed footprints, and routine lifecycle changes MUST NOT move either control or reorder the rail. Deliberate panel resizing can change the flexible label width but MUST NOT make individual controls jump between rows.

Actionable failures SHALL remain visible as explanatory text outside the routine status footprint. Displaying or dismissing that text can change composer height but MUST NOT horizontally reorder the action rail. Textarea autosizing remains independent of action-rail stability.

#### Scenario: Routine lifecycle keeps trailing controls stationary
- **WHEN** a prompt moves through ready, sending, working, cancelling, and ready states at an unchanged Chat-panel width
- **THEN** the routine status and Send/Cancel controls retain their dimensions and positions
- **AND** the configuration trigger remains on the same row

#### Scenario: Narrow desktop panel truncates configuration
- **WHEN** the desktop Chat panel narrows while remaining open
- **THEN** the configuration trigger label truncates to the available width
- **AND** context, status, and Send/Cancel remain on one action row

#### Scenario: Context usage does not displace the trailing action
- **WHEN** context usage becomes available or its displayed value changes
- **THEN** it does not move the routine status or Send/Cancel action
- **AND** it does not create another action row

#### Scenario: Failure remains explanatory
- **WHEN** sending, cancellation, or the active turn fails
- **THEN** Chat displays explanatory failure text
- **AND** the action rail keeps its horizontal ordering

### Requirement: Chat configuration uses one adaptive searchable picker
Chat SHALL expose model, mode, and reasoning configuration through one configuration trigger rather than separate composer controls. The trigger SHALL summarize the displayed model when model selection is supported and SHALL have an accessible name that identifies every displayed configuration value. A capability the active agent does not declare MUST be absent from both the trigger summary and picker.

The picker SHALL use one interaction layer. On desktop it SHALL remain constrained to the Chat panel and appear in relation to the trigger. In touch mode it SHALL appear as a bottom sheet sized to the current visual viewport above global Chat navigation. It MUST NOT open a second nested sheet for model selection.

Model search SHALL operate on the already available model inventory and match case-insensitively across model name, provider name, provider identifier, and model identifier. Results SHALL identify the human-readable model first, show provider and provider/model identifiers as secondary information, group available models by provider, expose a result count, and distinguish the displayed selection without relying on colour alone. Empty groups SHALL disappear when filtering, and an empty result SHALL be stated explicitly.

Choosing model, mode, or reasoning SHALL update the displayed staged configuration immediately and SHALL preserve the existing rule that staged values travel with the next prompt. An unavailable effective value SHALL remain identifiable but MUST NOT be offered as a newly selectable value. Where no explicit model override exists, the picker SHALL describe the agent-controlled choice without claiming a model Uatu does not know.

#### Scenario: Desktop opens one anchored configuration panel
- **WHEN** a desktop user activates the configuration trigger
- **THEN** one configuration panel opens within the Chat panel's usable bounds
- **AND** model search, mode, and applicable reasoning controls are available in that panel

#### Scenario: Touch opens one viewport-aware bottom sheet
- **WHEN** a touch user activates the configuration trigger
- **THEN** one bottom sheet opens above Chat navigation within the current visual viewport
- **AND** focusing model search keeps the sheet operable above the software keyboard

#### Scenario: Search matches model identity fields
- **WHEN** the user enters text matching a model name, provider name, provider id, or model id with different letter casing
- **THEN** the corresponding model remains in the filtered result list
- **AND** the result count reflects the filtered inventory

#### Scenario: Search has no matches
- **WHEN** no model matches the search text
- **THEN** the picker states that no models match
- **AND** it does not show empty provider groups

#### Scenario: Selection remains staged until the next prompt
- **WHEN** the user changes the model, mode, or reasoning and closes the picker
- **THEN** the composer trigger reflects the staged configuration
- **AND** the next prompt carries that configuration under the existing conversation configuration rules

#### Scenario: Current unavailable model remains honest
- **WHEN** a conversation reports a current model that is absent from the available inventory
- **THEN** the picker identifies that current model as unavailable
- **AND** it does not allow the unavailable value to be selected as a new override

#### Scenario: Undeclared configuration capability is absent
- **WHEN** the active agent does not declare model, mode, or reasoning support
- **THEN** the corresponding value and control are absent from the picker
- **AND** other declared configuration capabilities remain usable

#### Scenario: Picker focus is contained and restored
- **WHEN** the user opens the picker, navigates results with the keyboard, and dismisses it
- **THEN** focus remains within the open picker
- **AND** dismissal returns focus to the configuration trigger

### Requirement: Routine Chat status is compact and accessible
Chat SHALL represent routine composer states in an always-present fixed-size status region. Each state SHALL have a programmatic name and a non-colour-only visual distinction. Active-state motion MUST stop when the user prefers reduced motion. Significant transitions SHALL be announced without announcing elapsed-time ticks, and elapsed working time SHALL remain available outside the fixed visible footprint.

#### Scenario: Assistive technology receives the current state
- **WHEN** the routine status changes without variable-width visible text
- **THEN** the current state has an accessible name
- **AND** significant transitions are announced without repeating every streaming update

#### Scenario: Reduced motion removes continuous animation
- **WHEN** the user prefers reduced motion and Chat is working
- **THEN** the state remains visually distinguishable
- **AND** no continuous status animation runs

### Requirement: Completed assistant content has scoped copy actions
Each completed assistant message SHALL offer an accessible copy action that writes that message's normalized Markdown source to the clipboard, excluding timestamps, status labels, activity rows, copy-control labels, and other Chat chrome. Each fenced code block inside completed assistant content SHALL offer an accessible copy action that writes only the code content with its source line breaks, excluding syntax markup, fence delimiters, and controls.

Copy controls SHALL be keyboard operable and directly reachable on coarse-pointer devices. Success and failure feedback SHALL be perceivable without resizing the message, code block, or composer. Clipboard failure MUST leave conversation content unchanged and MUST NOT produce an uncaught error. A message still streaming MUST NOT present its whole-message action as copying a completed answer.

#### Scenario: Copy a completed assistant answer
- **WHEN** the user activates copy on a completed assistant message containing prose and fenced code
- **THEN** the clipboard receives that message's normalized Markdown
- **AND** no surrounding Chat chrome or activity output is included

#### Scenario: Copy one fenced code block
- **WHEN** the user activates copy for a fenced code block in completed assistant content
- **THEN** the clipboard receives only that block's code with its source line breaks
- **AND** syntax markup, fences, and control labels are excluded

#### Scenario: Streaming answer is not presented as complete
- **WHEN** an assistant message is still streaming
- **THEN** its whole-message completed-answer copy action is unavailable
- **AND** the action becomes available when completion is known

#### Scenario: Touch copy does not depend on hover
- **WHEN** a coarse-pointer user views a completed answer or fenced code block
- **THEN** each applicable copy action is reachable by tap
- **AND** no hover state is required to reveal it

#### Scenario: Copy feedback preserves geometry
- **WHEN** a copy succeeds or fails
- **THEN** Chat reports the outcome accessibly
- **AND** the message, code block, composer, and surrounding timeline retain their dimensions

#### Scenario: Clipboard failure is contained
- **WHEN** clipboard access is unavailable or rejects the write
- **THEN** conversation content remains unchanged
- **AND** Chat reports failure without an uncaught error
