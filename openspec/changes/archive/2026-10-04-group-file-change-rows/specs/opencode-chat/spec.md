## MODIFIED Requirements

### Requirement: Chat presents turns as readable conversation with inspectable activity
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. Every activity row SHALL name what it acted on where the agent reported it, including a shell command's command line, a file operation's path, and a search's pattern, so a row and any group summary it joins are legible without being opened. While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, and its elapsed time SHALL be shown where the agent reports progress without output, so long-running activity shows progress. A finished non-shell tool's output SHALL retain its summary and bounded preview with a way to see the rest. Shell tools and normalized command items SHALL instead present a summary and one bounded-height scrollback viewport containing all available provider-supplied output, while running and after completion. Earlier shell output SHALL be reachable by scrolling rather than a separate preview or "Show more lines" disclosure. A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

While a turn is running, the trailing run of activity SHALL be collapsed behind a single working line rather than rendered as flat rows. Activity, for the working line and for finished groups, SHALL include file-change rows: a file change reported between two steps SHALL join the run around it rather than end it, and a file-change row SHALL count as a finished, clean member, never as the step in flight and never as a failed step. A group summary SHALL name a file-change row by its operation and path, after the steps the summary names, and the row itself SHALL state its operation in that same word — Created, Updated, Deleted — wherever it is shown. The line SHALL carry a live indicator, the elapsed time of the turn, and the step currently in flight, and SHALL be present from the moment the prompt is accepted, before any step has arrived, so the same line carries the turn from waiting to done. Opening the working line SHALL reveal its member rows with their live state, and a running member with output SHALL still open itself so its output viewport is visible. Shell output SHALL initially follow the bottom and respect subsequent reader scrolling. A working line the reader opened SHALL remain open when the turn finishes and the line settles into the finished group summary. Popping out or resizing shell output SHALL count as the reader opening both the output and its containing activity group. That output and group SHALL remain open on completion or failure. A group line SHALL carry a status indicator, live while its turn runs, neutral when every member finished cleanly, and failed when any member failed. A failed outcome MUST NOT rely on colour alone. The line SHALL also state in words that a step failed, in text that is visible and part of the line's accessible name, without the group being opened. The live indicator's motion SHALL honour the reader's reduced-motion preference.

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
- **THEN** the command entry makes that output available without waiting for completion
- **AND** later output updates the same scrollback viewport, following the latest output only while its independent follow state is active

#### Scenario: A fast command retains its completed output
- **WHEN** a shell command completes before the client observes a running update
- **THEN** its completed output remains inspectable from the command entry
- **AND** the entry reports the provider's completed or failed outcome

#### Scenario: A finished tool's output is bounded with a way to see the rest
- **WHEN** a completed non-shell tool produced more output than the bounded preview shows
- **THEN** the entry shows a summary and a bounded preview
- **AND** offers a way to see the full output
- **AND** does not render the whole output by default

#### Scenario: A finished command's output is bounded with a way to see the rest
- **WHEN** a completed shell command produced more output than fits in its bounded-height viewport
- **THEN** the command entry retains one scrollback viewport
- **AND** all available provider-supplied output is reachable by scrolling without a separate preview or "Show more lines" disclosure

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

#### Scenario: Reader-sized output stays open when work finishes
- **WHEN** the reader resizes or pops out shell output and the command or containing turn then completes or fails
- **THEN** the output and its containing activity group remain reader-opened
- **AND** popped-out output remains open on the same item until the reader returns it inline, opens another item, switches conversations, closes its owning child transcript, or the item is removed or its view is disposed
- **AND** the provider-reported outcome remains visible without resetting the reading state


#### Scenario: A file-change row joins the run around it
- **WHEN** a finished turn reports a tool step, a file change for the path that step wrote, and two more tool steps, with no assistant text between them
- **THEN** those rows collapse behind one group line
- **AND** the line counts the file-change row among its steps

#### Scenario: A file-change row stays inside the working line
- **WHEN** a turn is running and the agent has reported a step, a file change, and a further running step
- **THEN** none of the three renders as a flat row
- **AND** the working line names the running step, not the file change

#### Scenario: A group summary names a file change by operation and path
- **WHEN** a finished group contains a file-change row for `src/foo.ts` reported as an update
- **THEN** the group line's summary names it as an update of `src/foo.ts`
- **AND** it does not take a place before the tool steps the summary names

#### Scenario: A file-change row says the same word as its summary
- **WHEN** a file-change row reported as an update is shown, inside a group or flat
- **THEN** the row reads "Updated" followed by the path
- **AND** the word is the one its group summary would count it under

#### Scenario: A file-change row alone does not make a group
- **WHEN** a finished turn reports a single file change between two assistant messages
- **THEN** the file-change row renders flat, as it did before
