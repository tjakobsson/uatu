# claude-code-chat Specification

## Purpose

Define the Claude Code chat agent: how a workspace discovers and reports
the user's Claude Code installation, runs one agent session per live
conversation, normalizes Claude Code activity into the shared conversation
timeline, and brokers permissions, questions, modes, models, and resume
against Claude Code's native session storage.

## Requirements

### Requirement: Chat uses the workspace's Claude Code installation and identity
When a Claude Code conversation is first needed, UatuCode SHALL discover
the `claude` executable available to the workspace process and use the
user's existing Claude Code configuration and authentication. UatuCode
MUST NOT request, copy, persist, or transmit Anthropic or provider API
keys. Claude Code availability SHALL be determined without keeping a
long-lived idle service, and a failed or missing installation SHALL be
reported as an actionable unavailable state attributed to Claude Code
while the workspace, non-chat capabilities, and other agents remain
usable.

#### Scenario: Existing Claude Code authentication is reused
- **WHEN** the workspace user has already authenticated Claude Code and starts a Claude Code conversation
- **THEN** the conversation runs under that existing identity without asking for an API key

#### Scenario: Claude Code is not installed
- **WHEN** the workspace cannot resolve a `claude` executable
- **THEN** the Claude Code agent reports that Claude Code must be installed and authenticated
- **AND** OpenCode conversations, preview, search, and terminal continue working

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

### Requirement: Conversations are discovered from Claude Code's native session storage
The workspace SHALL enumerate resumable Claude Code conversations for the
canonical workspace directory from Claude Code's own session storage, and
SHALL present a conversation's history without starting a turn or
requiring a live session. Conversations belonging to another directory
MUST NOT be listed or accepted. A stored session the workspace cannot
parse SHALL be skipped without failing enumeration.

#### Scenario: Prior sessions appear after a workspace restart
- **WHEN** a workspace starts and the user opens Chat
- **THEN** Claude Code conversations previously held in native session storage for that directory are listed
- **AND** opening one renders its history without starting a turn

#### Scenario: A foreign directory's session is not offered
- **WHEN** Claude Code's storage holds sessions for a different directory
- **THEN** those sessions do not appear in the workspace's conversation inventory

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

### Requirement: Structured questions surface with Claude Code semantics
A question the agent asks through its structured question tool SHALL
surface as a structured question in the owning conversation, preserving
the question set's prompts, headers, options with descriptions, and
multi-select flags. Answers SHALL be returned in the form Claude Code
expects, free-form answers SHALL be supported where the tool accepts
them, and rejecting the question SHALL be possible without ending the
turn.

#### Scenario: A multi-question form is answered
- **WHEN** a Claude Code turn asks two structured questions in one request
- **THEN** the conversation presents both with their options and descriptions
- **AND** the user's selections are returned so the turn continues with those answers

### Requirement: Permission modes are offered as chat modes
The Claude Code agent SHALL offer its permission modes as the
conversation's ways of working, and a mode selected for a conversation
SHALL govern its subsequent prompts. The agent SHALL declare its
recommended mode as the default, a fresh conversation SHALL start in it,
and it SHALL be presented as the active choice rather than a generic
delegation entry. Modes that bypass permission prompting entirely MUST
NOT be offered unless the workspace operator explicitly enabled them for
the workspace.

#### Scenario: Plan mode governs the next prompt
- **WHEN** a user selects the planning mode and sends a prompt
- **THEN** the turn runs under that mode
- **AND** the selection persists for the conversation until changed

#### Scenario: Bypass is absent without operator opt-in
- **WHEN** a workspace without the operator opt-in lists the Claude Code agent's modes
- **THEN** no offered mode disables permission prompting

#### Scenario: A fresh conversation runs the recommended mode
- **WHEN** a Claude Code conversation is created without choosing a mode
- **THEN** it runs in the agent's own recommended mode
- **AND** that mode is presented as the conversation's active choice

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

### Requirement: Attached images reach Claude Code with their prompt
Images staged on a prompt to a Claude Code conversation SHALL be
delivered to the session as model-visible image content with that
prompt, within the workspace's shared attachment bounds. Whether the
selected model accepts images SHALL be reported per model so the attach
control can be gated. A replayed message whose attachment reference
cannot be recovered from native session storage SHALL render as a
labeled placeholder rather than failing the history.

#### Scenario: A staged image reaches the turn
- **WHEN** a user attaches an image and sends a prompt in a Claude Code conversation
- **THEN** the turn's model receives the image with the prompt text
- **AND** the conversation renders the attachment with the user message

#### Scenario: Unrecoverable replayed attachments degrade to placeholders
- **WHEN** history replays a message whose image reference cannot be recovered
- **THEN** the message renders with a labeled attachment placeholder
- **AND** the rest of the history renders normally

### Requirement: Subagent runs open as child transcripts
Each subagent run in a Claude Code conversation SHALL be represented by
its launching row in the parent timeline and SHALL be openable as a
child transcript through the shared drill-down behavior, rendered from
the run's own activity. Subagent runs MUST NOT appear in the
conversation inventory. The launching row SHALL be attributable with the
subagent's model and consumed tokens as Claude Code reports them, and a
run without reported usage SHALL stay readable without asserting
figures.

#### Scenario: A subagent transcript is reachable from its row
- **WHEN** a Claude Code turn runs a subagent and the user opens its row
- **THEN** the subagent's own transcript is presented as a child of the parent conversation
- **AND** the conversation picker still lists only the parent

#### Scenario: A replayed conversation retains its subagent transcripts
- **WHEN** a conversation with completed subagent runs is opened from native session storage
- **THEN** each run's row is present and its child transcript is still openable

### Requirement: Conversation history is reversible through native rewind
The Claude Code agent SHALL declare reversible-history support and
implement the shared undo, redo, revert, and restore operations through
Claude Code's native rewind, restoring both visible conversation history
and affected workspace files. The boundary turn's prompt text SHALL be
returned for composer restoration. If a rewind operation fails or is
unsupported for the conversation's state, the failure SHALL be reported
and the operation MUST NOT claim that history or files changed.

#### Scenario: Undo rewinds conversation and files
- **WHEN** a user invokes Undo in a Claude Code conversation
- **THEN** the latest visible user turn and later work leave the transcript
- **AND** affected workspace files return to their prior state
- **AND** the turn's prompt text is offered back as an editable draft

#### Scenario: A failed rewind claims nothing
- **WHEN** the native rewind operation fails
- **THEN** the user is told the revert did not happen
- **AND** the transcript and files are reported unchanged

### Requirement: Plan approvals offer implementation intents
When a Claude Code session in a planning mode presents a completed plan
for approval, the request SHALL surface as a plan approval in the owning
conversation, presenting the plan's content. Approval SHALL offer
distinct intents: proceed with implementation (leaving the planning
mode), and where Claude Code supports it, proceed while returning to the
previously selected mode. Rejecting SHALL keep the conversation in its
planning mode with the turn able to continue planning. The chosen intent
SHALL govern the conversation's subsequent mode without a separate mode
change by the user.

#### Scenario: Approving a plan starts implementation
- **WHEN** a plan approval is presented and the user approves with the implement intent
- **THEN** the conversation leaves the planning mode
- **AND** implementation proceeds without a separate user mode change

#### Scenario: Rejecting a plan keeps planning
- **WHEN** the user rejects a presented plan
- **THEN** the conversation remains in its planning mode
- **AND** the agent can continue refining the plan

### Requirement: Task progress surfaces live in the timeline
When a Claude Code session maintains a task list for its work, the
conversation SHALL present that list as a live task-progress surface in
the timeline: one presentation updated in place as items are added,
started, and completed — not a new timeline entry per update. The
surface SHALL be present when a stored conversation is reopened, showing
the list's final state. Agents that report no task list SHALL simply
have no task-progress surface.

#### Scenario: The task list updates in place
- **WHEN** a Claude Code turn creates a task list and completes items over time
- **THEN** the timeline shows one task-progress presentation reflecting current states
- **AND** the transcript is not flooded with an entry per update

#### Scenario: A reopened conversation shows the final list
- **WHEN** a conversation whose turn maintained a task list is reopened later
- **THEN** the task-progress surface shows the list as it last stood

### Requirement: Claude Code capabilities are declared truthfully
The Claude Code agent SHALL declare exactly the capabilities this
capability specifies — including models, modes, variants, commands,
permissions, questions, context usage, attachments, subagents, and
reversible history — and MUST NOT declare a capability it does not
support. Slash commands available to the session SHALL be discoverable
under the declared commands capability.

#### Scenario: Undeclared abilities are absent, not broken
- **WHEN** a client reads the Claude Code agent's declaration
- **THEN** unsupported abilities are absent from it
- **AND** the client presents no control for them

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
recalled context.

Where the login reports plan utilization, the conversation SHALL present
it beside context usage as a compact summary naming each window in plain
words — the 5-hour window as the session and the 7-day window as the
week — with its percentage used, and SHALL mark the summary as a warning
when any window is at or past 80%. Activating the summary SHALL open a
readout that states, for every window the login reports: its name, its
percentage used, and when it resets, both as a clock time and relative to
now. The readout SHALL name the plan, SHALL list per-model weekly windows
and model-scoped buckets under the label the login reports for them, SHALL
show extra-usage credits where the login has them enabled, and SHALL show
this conversation's accumulated cost and per-model token totals where the
agent reports them. A login that reports only the two base windows SHALL
render the summary and readout with just those. For a login without plan
limits no plan summary SHALL be shown; where the agent still reports this
conversation's accumulated cost, the summary SHALL state that cost instead,
and activating it SHALL show only this conversation's cost and per-model
totals, with no plan name, windows, or sidebar control.

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

#### Scenario: Plan usage reads in plain words
- **WHEN** the login reports 9% of the 5-hour window and 25% of the 7-day window used
- **THEN** the composer summary reads "Session 9% · Week 25%"
- **AND** it is not marked as a warning

#### Scenario: A nearly spent window warns
- **WHEN** any reported window is at or past 80%
- **THEN** the composer summary is marked as a warning

#### Scenario: The readout names every window and its reset
- **WHEN** the reader activates the plan summary
- **THEN** each reported window shows its name, percentage, and reset as a clock time and a relative time
- **AND** the plan name is shown

#### Scenario: Per-model windows appear under their own labels
- **WHEN** the login reports a weekly Opus window and a model-scoped bucket labelled "Fable"
- **THEN** the readout lists "Week · Opus" and "Week · Fable" with their own percentages and resets

#### Scenario: Conversation cost is stated
- **WHEN** the agent reports this conversation's cost and per-model usage
- **THEN** the readout shows the total cost and, per model, input and output tokens with that model's cost
- **AND** the figures are accumulated across the conversation's turns, including turns that ran as separate resumed agent queries, with per-model rows merged by model

#### Scenario: A tally that began mid-conversation says so
- **WHEN** the workspace process first saw the conversation after its first user message (it was restarted mid-conversation)
- **THEN** the readout's block is titled "This conversation · since HH:MM" rather than "This conversation"

#### Scenario: A minimal report degrades cleanly
- **WHEN** the login reports only the 5-hour and 7-day windows
- **THEN** the summary and readout show those two and nothing else

#### Scenario: Windows without a base percentage are still a plan
- **WHEN** the login reports only a model-scoped bucket, or base windows with a reset and no percentage
- **THEN** the composer summary names the first window that has a percentage, else reads "Plan usage"
- **AND** activating it shows those windows as rows, and is not the cost-only readout

#### Scenario: No plan, no summary
- **WHEN** the login has no plan limits (an API-key session) and the agent reports no conversation cost
- **THEN** no summary is shown beside the composer

#### Scenario: No plan, the cost is still reachable
- **WHEN** the login has no plan limits and the agent reports this conversation's accumulated cost
- **THEN** the composer summary states the cost, as "$1.23 this conversation"
- **AND** activating it shows only this conversation's cost and per-model usage, with no plan name or windows

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
