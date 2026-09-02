# opencode-chat Specification (delta)

## MODIFIED Requirements

### Requirement: Chat presents turns as readable conversation with inspectable activity
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. Every activity row SHALL name what it acted on where the agent reported it — a shell command's command line, a file operation's path, a search's pattern — so a row and any group summary it joins are legible without being opened. While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, and its elapsed time SHALL be shown where the agent reports progress without output, so long-running activity shows progress. A finished tool or command's output SHALL be bounded - presented as a summary and a bounded preview with a way to see the rest - rather than shown whole or hidden whole. A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

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

### Requirement: Chat reports context usage and subagent cost
Where the agent declares the context capability, Chat SHALL report how full the conversation's context window is, against the selected model's limit, and SHALL attribute each subagent with the model it ran and the tokens it consumed. Each SHALL be gated on that declared capability: undeclared, the readout or figure is absent rather than empty, and its absence SHALL NOT degrade the rest.

The context report SHALL be legible without the user opening anything, and MAY expand to the breakdown the agent reports — input, cache, and output, or the agent's own categories when it reports them. It reports the live window fill after the latest model call, not lifetime spend and not a sum over a turn, and SHALL be populated when an existing conversation is opened, not only after a new turn is taken. When the agent reports that it compacted the conversation, the fill SHALL follow the post-compaction figure. Where the agent reports plan utilization, the readout MAY present it alongside the fill, distinct from it.

A subagent's attribution SHALL reflect the subagent's own session — a subagent may run a different model from its parent — and SHALL state the tokens that subagent consumed, aggregated from its child session onto the launching conversation. The model MAY be shown before any usage is known. When the agent has not reported usage for a subagent, the row SHALL stay readable and SHALL NOT assert a figure it does not have.

#### Scenario: The context indicator reads without being opened
- **WHEN** a conversation has exchanged turns and the agent declares context reporting
- **THEN** the surface shows how full the context window is against the model's limit
- **AND** the fill is legible without expanding anything

#### Scenario: The fill never exceeds the window from a long turn
- **WHEN** a turn made many model calls against a partly full window
- **THEN** the presented fill is that of the latest call
- **AND** it is not the calls summed

#### Scenario: The indicator is populated on opening an existing conversation
- **WHEN** the user opens a conversation that already has assistant turns
- **THEN** the context fill is shown from that history, before any new turn

#### Scenario: The context breakdown expands
- **WHEN** the user opens the context indicator
- **THEN** it shows the input, cache, and output the agent reported, or the agent's own categories when reported

#### Scenario: A subagent row names its model and tokens
- **WHEN** a subagent has run and the agent reports its model and token counts
- **THEN** its row states which model it ran and how many tokens it consumed

#### Scenario: A subagent without reported usage stays readable
- **WHEN** a subagent has not yet reported usage, or the agent does not report it
- **THEN** the row still names the subagent and its status
- **AND** no token figure is asserted for it

#### Scenario: An undeclared context capability leaves nothing behind
- **WHEN** the agent does not declare the context capability
- **THEN** the context indicator and the subagent token figure are absent
- **AND** the capabilities the agent does declare are unaffected

## ADDED Requirements

### Requirement: Background work is a distinct conversation state
Where an agent declares that it can run work in the background, Chat SHALL present live background tasks as a state of the conversation distinct from working and idle: the composer status SHALL name how many tasks run, a list SHALL name each task with its description and progress where reported, each SHALL offer a stop action, and a settled task SHALL appear in the timeline as a row with its outcome and summary. The state SHALL be populated when an existing conversation with live background work is opened, and SHALL clear when the agent reports no live tasks. An agent that does not declare the capability SHALL show none of it.

#### Scenario: Background tasks are listed while they run
- **WHEN** a conversation's agent reports one or more live background tasks
- **THEN** the composer status names the count
- **AND** each task is listed with a stop action

#### Scenario: A settled task lands in the timeline
- **WHEN** a background task completes, fails, or is stopped
- **THEN** a timeline row records the outcome and the agent's summary
- **AND** the task leaves the live list

#### Scenario: A reopened conversation shows its live work
- **WHEN** the user opens a conversation whose agent still reports live background tasks
- **THEN** the background-work state is shown from that report

### Requirement: Persistent-approval scope copy is the owning agent's
When a permission card offers an approval that outlives the request, the sentence stating what that approval covers SHALL describe the owning agent's actual persistence semantics and SHALL name only that agent. Two agents with different semantics SHALL have different sentences.

#### Scenario: Each agent's card states its own reach
- **WHEN** a permission card is shown for a conversation owned by a given agent
- **THEN** its scope sentence describes that agent's persistent-approval lifetime
- **AND** no other agent is named on the card

### Requirement: Timeline marks conversation compaction
Where an agent reports that it compacted the conversation's context, Chat SHALL place a marker in the timeline at that point stating that compaction happened and, where reported, the before and after token figures. Content before the marker SHALL remain readable.

#### Scenario: A compaction marker appears in place
- **WHEN** the agent reports a compaction between two turns of activity
- **THEN** the timeline shows a compaction marker between them with the figures reported
- **AND** the earlier content remains in the timeline
