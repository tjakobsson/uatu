# claude-code-chat Specification (delta)

## MODIFIED Requirements

### Requirement: A Claude Code conversation runs as its own agent session
Each Claude Code conversation with an active turn or live background work
SHALL be served by its own agent session scoped to the workspace directory;
a conversation that has neither SHALL NOT hold a running session. Prompting
an idle conversation SHALL start or resume its session transparently. The
turn SHALL be considered over when the session reports itself idle, not
when the first turn result arrives, so work the agent left running is not
cut off. The user SHALL be able to interrupt the active turn, and workspace
shutdown SHALL terminate every live Claude Code session it owns before
shutdown completes, leaving completed history in Claude Code's native
session storage.

#### Scenario: Prompting an idle conversation resumes it
- **WHEN** a user prompts a Claude Code conversation that has no running session
- **THEN** the conversation's native session is resumed and the prompt runs in it
- **AND** earlier context from that conversation remains in effect

#### Scenario: Interrupt ends the active turn
- **WHEN** a user cancels a running Claude Code turn
- **THEN** the turn stops and the conversation reports an interrupted status
- **AND** the conversation accepts a new prompt afterward

#### Scenario: Background work keeps the session alive
- **WHEN** a turn's result arrives while the session reports live background tasks
- **THEN** the session is not retired
- **AND** it is retired once the session reports no live background tasks and no pending turn

#### Scenario: Workspace shutdown owns the sessions
- **WHEN** the workspace server shuts down while Claude Code sessions are live
- **THEN** those sessions and their active turns are terminated before shutdown completes
- **AND** their history remains available from native session storage on a later workspace start

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
SHALL be counted by type without recording payloads.

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

### Requirement: Tool permissions are brokered interactively
When a Claude Code session asks for permission to use a tool, the request
SHALL surface as a pending permission in the owning conversation,
identifying the action and affected resources, and the user's approval or
rejection SHALL be returned to the session. An approval scoped to the
session SHALL suppress repeat prompts for equivalent actions within that
conversation where Claude Code supports it, and the card SHALL state that
reach in Claude Code's own terms — never another agent's. A permission
left pending when its session ends SHALL be resolved to a visible failed
or interrupted outcome rather than remaining pending forever.

#### Scenario: A tool request waits for the user
- **WHEN** a Claude Code turn requests permission for a file edit
- **THEN** the conversation shows a pending permission naming the action and file
- **AND** the turn proceeds only after the user approves
- **AND** rejection is reported back and the turn continues without the tool result

#### Scenario: The persistent-approval scope names Claude Code's reach
- **WHEN** a Claude Code permission card offers a persistent approval
- **THEN** its scope line describes what that approval covers under Claude Code
- **AND** it does not name another agent

#### Scenario: A dead session's permission does not hang
- **WHEN** a Claude Code session ends while a permission is pending
- **THEN** the pending card resolves to a non-pending outcome the user can see

### Requirement: Models and effort levels follow Claude Code's catalog
The Claude Code agent SHALL list the models Claude Code offers and SHALL
offer each model's supported effort levels as that model's reasoning
variants. Claude Code's own recommended default SHALL be offered as a
first-class entry presented as the active choice while no model has been
chosen — in place of a generic delegation row — and choosing it SHALL
leave the model resolution to Claude Code. Every surface that names a
model SHALL name it with its version (for example "Opus 5 (1M context)",
"Fable 5.1"), derived from the catalog when the catalog's display name
lacks one. In addition to the catalog, the agent SHALL offer the models
the Claude apps offer under "More models" that the catalog omits, and
SHALL accept a user-typed model id, each presented as distinct from the
catalog's own entries; a rejected id SHALL fail the turn with the CLI's
error, not silently fall back. A model or variant selection SHALL apply to
the conversation's subsequent prompts, an effort level not supported by
the selected model MUST NOT be selectable with it, and the model's
context-window size SHALL be reported when known so context usage can be
presented. The catalog SHALL be read from Claude Code itself before the
first conversation runs when the install permits it, with a static
fallback only for an install that cannot answer, and model ids reported by
a running session SHALL be attributed to catalog entries so context usage
joins the window actually in effect.

#### Scenario: The recommended default is the active choice and names its resolution
- **WHEN** a Claude Code conversation has not chosen a model
- **THEN** the catalog's recommended default is presented as the active choice
- **AND** surfaces that state the choice name the model it currently resolves to, with its version

#### Scenario: A catalog entry without a version in its name is still named with one
- **WHEN** the catalog names a model "Fable" and describes it as "Fable 5.1 · …"
- **THEN** the picker, composer, and conversation surfaces name it "Fable 5.1"

#### Scenario: An app-only model is offered and runs
- **WHEN** a user selects a "More models" entry such as Opus 4.6
- **THEN** subsequent prompts run under that model id
- **AND** the context window presented is the one that model actually has

#### Scenario: A typed model id runs or fails visibly
- **WHEN** a user enters a model id the picker does not list
- **THEN** the next prompt runs under that id
- **AND** an id Claude Code rejects fails that turn with the reported error

#### Scenario: An effort chosen while the default is active travels with the prompt
- **WHEN** a user selects an effort level without first choosing a model
- **THEN** the prompt runs under that effort against the default entry's model
- **AND** the presented effort is the effort actually sent

#### Scenario: The catalog is live before any turn
- **WHEN** the model picker is first read on a workspace whose Claude Code install is healthy
- **THEN** it lists Claude Code's own catalog with its recommended default
- **AND** an install that cannot answer yields the static fallback instead of an error

#### Scenario: Effort qualifies the selected model
- **WHEN** a user selects a model and one of its effort levels
- **THEN** subsequent prompts run with that model and effort
- **AND** an effort level the model does not support is not offered alongside it

## ADDED Requirements

### Requirement: Context usage measures the window, not the turn's spend
Context usage for a Claude Code conversation SHALL be the occupancy of the
context window after the most recent model call — the tokens that call
sent as input, read from cache, and wrote to cache — and MUST NOT be a
figure summed across the calls of a turn. When Claude Code compacts the
conversation, the reported occupancy SHALL drop to the post-compaction
figure and the timeline SHALL mark where compaction happened. Where the
session can report its own context breakdown, that breakdown SHALL be
offered as the expanded view and its total SHALL agree with the presented
fill.

#### Scenario: A long turn does not exceed its window
- **WHEN** a turn makes many model calls, each against a window that is 30% full
- **THEN** the presented fill after the turn is about 30%, not the sum of the calls

#### Scenario: Compaction is visible and resets the fill
- **WHEN** Claude Code compacts the conversation mid-turn
- **THEN** the timeline shows a compaction marker with the before and after figures
- **AND** the presented fill reflects the post-compaction figure

#### Scenario: The expanded breakdown is the session's own
- **WHEN** the user opens the context readout on a session that reports a breakdown
- **THEN** it shows the session's categories (system prompt, tools, messages, memory, and so on)
- **AND** their total matches the presented fill

### Requirement: Background tasks are surfaced, stoppable, and wake the model
When a Claude Code session starts a task in the background — a backgrounded
shell command, a backgrounded subagent, or a monitor — the conversation
SHALL show that background work exists while it runs, naming each task
and its progress where reported, and SHALL let the user stop a task. A
task's completion, failure, or stop SHALL appear in the timeline with its
summary. While the session holds live background work the composer SHALL
present a background-work state distinct from both working and idle, and
prompting SHALL remain possible. When a background task settles and the
model is not mid-turn, the workspace SHALL wake the session so the agent
can act on the notification, as Claude Code's own terminal client does.
Housekeeping tasks the CLI marks as ambient MUST NOT count as background
work.

#### Scenario: Backgrounded work is visible after the turn ends
- **WHEN** a turn ends while a backgrounded command is still running
- **THEN** the composer shows a background-work state naming one running task
- **AND** the conversation still accepts a new prompt

#### Scenario: A finished background task reaches the reader and the model
- **WHEN** a backgrounded command completes
- **THEN** the timeline gains a row with the task's summary
- **AND** the agent produces a follow-up turn acting on it without a user prompt

#### Scenario: The user stops a background task
- **WHEN** the user stops a listed background task
- **THEN** the task is stopped in the session
- **AND** the timeline records it as stopped

#### Scenario: Ambient tasks stay out of the indicator
- **WHEN** the session runs a housekeeping task marked ambient
- **THEN** no background-work state is shown for it

### Requirement: Tool-driven dialogs and elicitations are brokered
When a Claude Code session asks the host to render a tool-driven dialog or
an MCP elicitation, the request SHALL surface as a pending interaction in
the owning conversation with the prompt and the offered choices or fields,
and the user's answer or dismissal SHALL be returned to the session. A
dialog left pending when its session ends SHALL resolve to a visible
outcome rather than remaining pending.

#### Scenario: A dialog waits for the user
- **WHEN** a tool requests a blocking dialog with choices
- **THEN** the conversation shows a pending card with those choices
- **AND** the chosen option is returned and the turn continues

#### Scenario: An elicitation collects input
- **WHEN** an MCP server requests user input through elicitation
- **THEN** the conversation shows a pending card with the requested fields
- **AND** the submitted values, or the decline, are returned to the session

### Requirement: Session signals surface as status, not silence
The conversation SHALL surface Claude Code's routine session signals where
they affect what the user is waiting on: an API retry SHALL show as a
retrying state with the reason where reported; a claude.ai plan
rate-limit warning or rejection SHALL be shown with its reset time; a
compaction in progress SHALL show as compacting; a refusal that moved the
turn to a fallback model SHALL be attributed to the fallback model in the
timeline; and memories the session recalled SHALL be shown inline as
recalled context. Where the login reports plan utilization, the
conversation SHALL be able to present it beside context usage.

#### Scenario: A retry is not a silent stall
- **WHEN** Claude Code retries a failed API request
- **THEN** the composer status shows a retrying state
- **AND** it returns to working when the request succeeds

#### Scenario: A rate limit names its reset
- **WHEN** Claude Code reports a plan rate limit warning or rejection
- **THEN** the conversation shows the limit's kind and when it resets

#### Scenario: A refusal fallback is attributed truthfully
- **WHEN** a turn is retried on a fallback model after a refusal
- **THEN** the assistant content from the retry is attributed to the fallback model

### Requirement: Conversation titles follow Claude Code's own
A Claude Code conversation's title SHALL follow the title Claude Code
itself assigns to the session, when one exists, in the conversation
chooser and inventory. A conversation without a Claude Code title SHALL
keep the prompt-derived title. A title the user sets in UatuCode SHALL
take precedence over both.

#### Scenario: A generated title replaces the prompt excerpt
- **WHEN** Claude Code assigns a title to a session after its first turn
- **THEN** the conversation chooser shows that title instead of the truncated prompt

#### Scenario: A user rename wins
- **WHEN** the user has renamed the conversation in UatuCode
- **THEN** a later Claude Code title does not replace the user's name
