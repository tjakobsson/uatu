## MODIFIED Requirements

### Requirement: Chat presents turns as readable conversation with inspectable activity
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. Every activity row SHALL name what it acted on where the agent reported it — a shell command's command line, a file operation's path, a search's pattern — so a row and any group summary it joins are legible without being opened. While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, and its elapsed time SHALL be shown where the agent reports progress without output, so long-running activity shows progress. A finished tool or command's output SHALL be bounded - presented as a summary and a bounded preview with a way to see the rest - rather than shown whole or hidden whole. A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

While a turn is running, the trailing run of activity SHALL be collapsed behind a single working line rather than rendered as flat rows: the line SHALL carry a live indicator, the elapsed time of the turn, and the step currently in flight, and SHALL be present from the moment the prompt is accepted — before any step has arrived — so the same line carries the turn from waiting to done. Opening the working line SHALL reveal its member rows with their live state, and a running member with output SHALL still open itself so its streaming tail is visible. A working line the reader opened SHALL remain open when the turn finishes and the line settles into the finished group summary. A group line SHALL carry a status indicator: live while its turn runs, neutral when every member finished cleanly, and failed when any member failed. A failed outcome MUST NOT rely on colour alone: the line SHALL also state in words that a step failed, in text that is visible and part of the line's accessible name, without the group being opened. The live indicator's motion SHALL honour the reader's reduced-motion preference.

#### Scenario: Assistant answer remains visually primary
- **WHEN** a turn contains assistant text interleaved with multiple tool calls
- **THEN** the answer reads as a coherent conversation
- **AND** tool activity can be expanded for detail without being mistaken for assistant prose

#### Scenario: A shell tool row names its command
- **WHEN** an agent runs a shell command through a tool that carries the command in its input
- **THEN** the row's subject is the command line
- **AND** a group that collapses several such rows still names the commands it contains

#### Scenario: Streaming tool lifecycle updates in place
- **WHEN** a tool moves from running to completed or failed
- **THEN** its existing activity entry updates state instead of adding a duplicate entry

#### Scenario: A running tool shows its output as it streams
- **WHEN** a tool is running and the agent streams its output
- **THEN** the surface shows that output as it arrives
- **AND** it updates the tool's existing entry in place

#### Scenario: A running tool without output shows elapsed time
- **WHEN** a tool has run for several seconds and the agent reports progress but no output
- **THEN** the row states the elapsed time
- **AND** the time updates in place

#### Scenario: A running shell command shows its output as it streams
- **WHEN** the agent reports rolling output for a running shell command
- **THEN** the command entry shows the latest output without waiting for completion
- **AND** later output updates the same command entry

#### Scenario: A fast command retains its completed output
- **WHEN** a shell command completes before the client observes a running update
- **THEN** its completed output remains inspectable from the command entry
- **AND** the entry reports the provider's completed or failed outcome

#### Scenario: A finished tool's output is bounded with a way to see the rest
- **WHEN** a completed tool produced more output than the bounded preview shows
- **THEN** the entry shows a summary and a bounded preview
- **AND** offers a way to see the full output
- **AND** does not render the whole output by default

#### Scenario: A finished command's output is bounded with a way to see the rest
- **WHEN** a completed shell command produced more output than the bounded preview shows
- **THEN** the command entry shows a bounded preview
- **AND** offers a way to see the full output

#### Scenario: Hostile content remains inert
- **WHEN** assistant Markdown or tool output contains script-capable markup or a JavaScript URL
- **THEN** the rendered conversation does not execute it or expose an active unsafe link

#### Scenario: The live tail collapses behind a working line
- **WHEN** a turn is running and the agent has produced several activity steps with no assistant text after them
- **THEN** those steps are not shown as flat rows
- **AND** one working line shows a live indicator, the turn's elapsed time, and the step in flight

#### Scenario: The working line stands in for the waiting state
- **WHEN** a prompt has been accepted and nothing has come back yet
- **THEN** the working line is already present with its live indicator and elapsed time
- **AND** the first step to arrive joins it rather than replacing it with a different element

#### Scenario: Opening the working line reveals live steps
- **WHEN** the reader opens the working line while the turn runs
- **THEN** the member rows are shown with their running, completed, or failed state
- **AND** a running member with streamed output is open so its output is visible

#### Scenario: An opened working line stays open when the turn finishes
- **WHEN** the reader opened the working line and the turn then completes
- **THEN** the line becomes the finished group summary naming its steps
- **AND** it remains open

#### Scenario: A finished group signals a failed step
- **WHEN** a finished group contains a step that failed
- **THEN** the group line's status indicator reads as failed without the group being opened
- **AND** the line states in words that a step failed, so the outcome is carried by something other than colour alone

#### Scenario: Reduced motion stills the live indicator
- **WHEN** the reader's system prefers reduced motion
- **THEN** the working line's live indicator does not animate
