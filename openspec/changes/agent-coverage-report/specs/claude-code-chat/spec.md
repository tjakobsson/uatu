## MODIFIED Requirements

### Requirement: Claude Code activity is normalized into the shared timeline
The server SHALL normalize Claude Code session activity into the shared
ordered conversation events covering user and assistant content,
reasoning, tool lifecycle, tool progress, background task lifecycle,
permission requests and resolutions, structured questions and resolutions,
tool-driven dialogs, context compaction, turn status, cancellation,
completion, warnings, errors, and per-message token usage attributed to
the reporting model. Assistant text SHALL be delivered as it streams, not
only per completed block. An event the server does not recognize, or whose
payload it cannot parse, SHALL be skipped without ending the stream and
SHALL be counted by type without recording payloads. A content block of a
type the server does not recognize inside a recognized message SHALL
likewise be skipped and counted by block type without recording its
payload, so an unknown block is measured the same way an unknown message
is.

#### Scenario: A streamed turn renders as shared timeline items
- **WHEN** a Claude Code turn streams assistant text, reasoning, and tool activity
- **THEN** connected clients render them with the same timeline presentation used for other agents
- **AND** token usage for the turn is attributed to the model that reported it

#### Scenario: Assistant text arrives as it streams
- **WHEN** Claude Code is producing a text block
- **THEN** the assistant message grows in place as text arrives
- **AND** the completed block matches the streamed text

#### Scenario: A running tool reports elapsed time
- **WHEN** Claude Code reports progress for a tool that is still running
- **THEN** that tool's row states how long it has been running
- **AND** the row is the same entry that later carries the result

#### Scenario: An unrecognized event does not end the stream
- **WHEN** a Claude Code session emits an event shape the workspace does not recognize
- **THEN** the event is skipped and counted by type
- **AND** the conversation stream continues

#### Scenario: An unrecognized content block is counted
- **WHEN** an assistant or user message carries a content block of a type the workspace does not recognize
- **THEN** the recognized blocks of that message are rendered as usual
- **AND** the unknown block is skipped and counted by its block type without recording its payload

#### Scenario: An unrecognized system subtype is counted by subtype
- **WHEN** a Claude Code session emits a `system` message whose subtype the workspace neither handles nor deliberately ignores
- **THEN** the message is skipped and counted as unrecognized under its subtype, not as a deliberately ignored message
- **AND** the conversation stream continues

#### Scenario: A recognized event with an unusable payload does not end the stream
- **WHEN** a Claude Code session emits a recognized event type whose payload lacks what its handling requires
- **THEN** the event is skipped and counted as unparseable
- **AND** the conversation stream continues
