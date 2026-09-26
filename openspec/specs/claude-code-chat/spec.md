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
Each Claude Code conversation with an active turn, live background work, or
a pending scheduled wakeup the user has not cancelled SHALL be served by its
own agent session scoped to the workspace directory; a conversation that has
none of these SHALL NOT hold a running session. Prompting an idle conversation SHALL start or
resume its session transparently. The turn SHALL be considered over when
the session reports itself idle, not when the first turn result arrives, so
work the agent left running is not cut off. The user SHALL be able to
interrupt the active turn, and workspace shutdown SHALL terminate every
live Claude Code session it owns before shutdown completes, leaving
completed history in Claude Code's native session storage.

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

#### Scenario: A pending wakeup keeps the session alive
- **WHEN** a turn's result arrives while the session reports one or more scheduled wakeups
- **THEN** the session is not retired
- **AND** it is retired once the session reports no wakeups, no live background tasks, and no pending turn

#### Scenario: A cancelled wakeup holds nothing
- **WHEN** a turn's result arrives while the only wakeups the session reports are ones the user cancelled
- **THEN** the session is retired as if it reported none

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
parse SHALL be skipped without failing enumeration. A stored user record
Claude Code authored on the person's behalf — a skill's preamble, a
local-command caveat, an image caption, a background task's notification —
MUST NOT be presented as the user's message, and MUST NOT serve as a
session's first prompt or title. Where the store states who authored a
record, that statement SHALL decide; a record the store attributes to the
person SHALL be presented as their message whatever its text looks like.

#### Scenario: Prior sessions appear after a workspace restart
- **WHEN** a workspace starts and the user opens Chat
- **THEN** Claude Code conversations previously held in native session storage for that directory are listed
- **AND** opening one renders its history without starting a turn

#### Scenario: A foreign directory's session is not offered
- **WHEN** Claude Code's storage holds sessions for a different directory
- **THEN** those sessions do not appear in the workspace's conversation inventory

#### Scenario: Harness-authored records are not the user's bubbles
- **WHEN** a reopened conversation's transcript holds a user record Claude Code injected (a skill preamble, a task notification)
- **THEN** no user message is shown for it
- **AND** a prompt in which the person merely quotes such markup is still shown as their message

#### Scenario: A record older than the store's authorship field reads the same everywhere
- **WHEN** a transcript written before authorship was recorded opens with a task-notification envelope
- **THEN** it is not offered as the session's first prompt or title
- **AND** the replayed timeline and the session's title agree on what that record is

#### Scenario: A person's own words are never reissued as agent activity
- **WHEN** the store attributes a record to the person and its text is nothing but a task-notification envelope
- **THEN** it is shown as their message
- **AND** no background task row is produced for it

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

The session-scoped approval SHALL NOT be sent on the first click: its
confirmation step SHALL list, in Claude Code's own permission-rule syntax,
exactly the session-scoped permission updates the reply will forward,
listed separately from the request's own resources. Every update the
reply forwards SHALL be listed, and nothing that is not forwarded SHALL be
listed. Updates that would persist beyond the live session MUST NOT be
forwarded and MUST NOT be listed. When Claude Code supplied no
session-scoped update for the request, the confirmation SHALL state that
confirming covers only this request. A request recovered after its live
announcement was missed SHALL confirm with the same listed updates the
live announcement would have shown.

#### Scenario: A tool request waits for the user
- **WHEN** a Claude Code turn requests permission for a file edit
- **THEN** the conversation shows a pending permission naming the action and file
- **AND** the turn proceeds only after the user approves
- **AND** rejection is reported back and the turn continues without the tool result

#### Scenario: The persistent-approval scope names Claude Code's reach
- **WHEN** a Claude Code permission card offers a persistent approval
- **THEN** its scope line describes what that approval covers under Claude Code
- **AND** it does not name another agent

#### Scenario: The confirmation lists the rules the reply will forward
- **WHEN** a Claude Code permission request carries session-scoped rule suggestions and the user chooses the persistent approval
- **THEN** the confirmation lists each suggested rule as a Claude Code permission rule, apart from the request's resources
- **AND** confirming forwards exactly those rules with the approval

#### Scenario: A persisting suggestion is neither forwarded nor listed
- **WHEN** a Claude Code permission request suggests a rule destined for a settings file
- **THEN** the confirmation does not list it
- **AND** confirming does not forward it

#### Scenario: No session-scoped suggestion means only this request
- **WHEN** a Claude Code permission request carries no session-scoped suggestion and the user chooses the persistent approval
- **THEN** the confirmation states that confirming covers only this request
- **AND** confirming approves the request without forwarding any rule

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
the run's own activity — while the run is still in progress as well as
after it ends. An open transcript of a running subagent SHALL update as
the subagent works, including its text and tool activity, and the
subagents track SHALL name a running subagent's latest progress where
Claude Code reports it. Subagent runs MUST NOT appear in the
conversation inventory. The launching row SHALL be attributable with the
subagent's model and consumed tokens as Claude Code reports them, and a
run without reported usage SHALL stay readable without asserting
figures. The same SHALL hold for every other agent run Claude Code
forks from the conversation, however it was started: a skill the agent
runs as a fork of itself, and the run a typed command launches — such
as a review command — which has no launching step in the timeline at
all. Each such run SHALL be named as work in progress alongside the
conversation's subagent runs from the moment Claude Code names it,
carrying what it is running and, where reported, its latest activity,
and SHALL be openable as a child transcript from then on. Where Claude
Code streams the run's activity the open transcript SHALL update as it
arrives; where it does not, the open transcript SHALL still follow the
run from Claude Code's own record of it, refreshed while the run lasts,
so no run is opaque while it works. A fork Claude Code names only when
it ends SHALL still open with its complete transcript then, including
the work it streamed before it was named. The output a typed command
returns SHALL be shown in the timeline, live and when the conversation
is reopened alike.

#### Scenario: A subagent transcript is reachable from its row
- **WHEN** a Claude Code turn runs a subagent and the user opens its row
- **THEN** the subagent's own transcript is presented as a child of the parent conversation
- **AND** the conversation picker still lists only the parent

#### Scenario: A running subagent is opened and followed
- **WHEN** the user opens a subagent that is still running, from its row or the subagents track
- **THEN** its transcript shows the activity so far and continues to update until the run ends
- **AND** the run's completion is reflected in the open transcript and on the launching row

#### Scenario: A forked skill is followed while it runs
- **WHEN** the agent runs a skill as a fork of itself and Claude Code names the run as it starts
- **THEN** the run is listed as work in progress, named by the skill it runs, and opens as a child transcript that updates as it works
- **AND** the conversation picker still lists only the parent

#### Scenario: A run started by a typed command is followed while it runs
- **WHEN** the user types a command that launches a forked run, such as a review command
- **THEN** the run is listed as work in progress while it lasts, named by the command
- **AND** opening it shows the run's transcript, which keeps filling in while the run works even though Claude Code streams none of it
- **AND** the command's output appears in the timeline when it ends, and is still there when the conversation is reopened

#### Scenario: A fork named only at its end is complete when it opens
- **WHEN** Claude Code names a forked run only when it ends
- **THEN** the run's whole transcript is presented when it is opened, including the work it streamed before it was named

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
permissions, questions, context usage, attachments, subagents, reversible
history, background tasks, and scheduled wakeups — and MUST NOT declare a
capability it does not support. Slash commands available to the session
SHALL be discoverable under the declared commands capability.

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
fill. The window the fill is measured against SHALL be the one the session
itself reports for the model once it has reported one; the catalog's figure
for the model is the measure only before that. A catalog figure that the
observed occupancy exceeds SHALL NOT be presented as a full window: the
readout SHALL state the occupancy without a fill until the session reports
its window.

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

#### Scenario: The session's window beats the catalog's figure
- **WHEN** the catalog lists a model with a 200k window and the session reports a 1M window for it
- **THEN** a later call that occupies 212k tokens presents a fill of about 21%
- **AND** the readout is not in its alert state

#### Scenario: An occupancy beyond the catalog's figure is not a full window
- **WHEN** no window has been reported for the model and a call occupies more tokens than the catalog's figure
- **THEN** the readout states the occupancy without a percentage
- **AND** it is not in its alert state

### Requirement: Background tasks are surfaced, stoppable, and wake the model
When a Claude Code session starts a task in the background — a backgrounded
shell command, a backgrounded subagent, or a monitor — the conversation
SHALL show that background work exists while it runs, naming each task
and its progress where reported, and SHALL let the user stop a task.
Each running task SHALL carry what it is doing (the agent's latest
progress note, for an agent task the model-written progress summary
Claude Code produces when asked), how long it has run, and the tokens
and tool uses it has consumed as Claude Code reports them. A running task
SHALL be selectable and open an inspection view: an agent task opens the
subagent's own transcript (see "Subagent runs open as child transcripts"),
a shell task opens a task view with its command, elapsed time, latest
progress, and — from the moment Claude Code makes the task's output
location known — the output produced so far, refreshed while the task
runs. Stop SHALL remain available from the inspection view. Tasks that
start while a turn is still running SHALL be listed at once, not only
after the turn ends. The lists of running background tasks and running
subagents SHALL be shown expanded when running work first appears in
them, so a task can be inspected or stopped without first disclosing the
list; a list the user collapses SHALL stay collapsed until the work it
holds is over, so the surface never reopens against the user's choice. A task's completion, failure, or stop SHALL appear
in the timeline with its summary, live and when the conversation is
reopened from storage alike: the notification Claude Code stored for the
model SHALL replay as the settled task row, linked to the step that
launched it, never as its markup. While the session holds live
background work the composer SHALL present a background-work state
distinct from both working and idle, and prompting SHALL remain possible;
to the hub's workspace activity summary, however, live background work
SHALL count as the workspace working, so the switcher does not show the
workspace idle while a task runs. When a background task settles and the
model is not mid-turn, the workspace SHALL wake the session so the agent
can act on the notification, as Claude Code's own terminal client does.
Housekeeping tasks the CLI marks as ambient MUST NOT count as background
work. An agent run the CLI marks ambient — a forked skill, or the run a
typed command such as a review command launches — is not housekeeping:
it SHALL be treated as a run (listed and openable, see "Subagent runs
open as child transcripts"), and the ambient mark SHALL only keep it out
of the background-work state.

#### Scenario: Backgrounded work is visible after the turn ends
- **WHEN** a turn ends while a backgrounded command is still running
- **THEN** the composer shows a background-work state naming one running task
- **AND** the conversation still accepts a new prompt
- **AND** the workspace's activity summary reports it working

#### Scenario: Work that starts mid-turn is listed while the turn runs
- **WHEN** a running turn launches a backgrounded task and a subagent
- **THEN** the task is listed as running background work and the subagent appears in the subagents track before the turn ends

#### Scenario: Running work is reachable without disclosing the list
- **WHEN** a backgrounded task or a subagent starts in a conversation whose lists held no running work
- **THEN** its list is shown expanded, with the entry's inspect and Stop controls reachable directly

#### Scenario: A list the user collapsed stays collapsed
- **WHEN** the user collapses a list while it holds running work, and further work starts in it
- **THEN** the list stays collapsed
- **AND** it expands again for work that starts after everything it held is over

#### Scenario: A running agent task is inspected
- **WHEN** the user selects a running background agent task
- **THEN** the subagent's transcript opens as a child of the conversation, updating as the agent works
- **AND** the view names the task, its latest progress note, elapsed time, and consumed tokens and tool uses
- **AND** the user can stop the task from the view

#### Scenario: A running shell task is inspected
- **WHEN** the user selects a running backgrounded shell command whose output location Claude Code has made known
- **THEN** a task view shows the command, elapsed time, latest progress, and the output produced so far
- **AND** the output refreshes while the task runs
- **AND** the user can stop the task from the view

#### Scenario: A finished background task reaches the reader and the model
- **WHEN** a backgrounded command completes
- **THEN** the timeline gains a row with the task's summary
- **AND** the agent produces a follow-up turn acting on it without a user prompt

#### Scenario: A reopened conversation replays the settled task
- **WHEN** a stored conversation whose transcript holds a background task's notification is reopened
- **THEN** the timeline shows the task's settled row with its status and summary, named by the step that launched it
- **AND** the notification's markup is not shown as a user message

#### Scenario: The user stops a background task
- **WHEN** the user stops a listed background task
- **THEN** the task is stopped in the session
- **AND** the timeline records it as stopped

#### Scenario: Ambient tasks stay out of the indicator
- **WHEN** the session runs a housekeeping task marked ambient
- **THEN** no background-work state is shown for it
- **AND** the workspace's activity summary does not report it working on their account

### Requirement: Scheduled wakeups are held, shown, fired, and releasable
When a Claude Code session schedules a future turn for itself — a
self-paced wakeup, a cron, or a loop — the conversation SHALL enter a
scheduled state distinct from working, background, and idle for as long as
at least one wakeup the user has not cancelled is pending and nothing else
is running. The composer SHALL name the state and list each pending wakeup
with its prompt, whether it recurs, and when it next fires. Each wakeup
SHALL appear in the timeline as a row that follows its life: pending, then
fired, cancelled, paused, or lost. When a wakeup fires, the turn it starts
SHALL be presented as a wakeup turn, attributed to the wakeup that started
it, and MUST NOT be presented as a message the user typed.

The user SHALL be able to cancel any single wakeup and to release a
scheduled session. A cancelled wakeup MUST NOT start a turn again, even
when the agent's session is later resumed and the agent's tooling rebuilds
it; enforcing this MUST NOT spend a model turn. Releasing cancels every
wakeup of the session and ends the session.

When the session ends for any other reason while wakeups are pending, a
wakeup the agent's tooling cannot rebuild SHALL be marked lost with a
notice saying the agent's schedule did not survive its session. A wakeup
the agent's tooling rebuilds when the conversation runs again SHALL be
marked paused with a notice saying it fires again once the conversation
runs. A conversation opened without a live session SHALL list its paused
wakeups, each with a cancel action. The workspace MUST NOT start a session
on its own to keep a paused wakeup running. Prompting SHALL remain possible
in the scheduled state. Agents that do not declare the capability SHALL
show none of this.

#### Scenario: A scheduled wakeup fires
- **WHEN** a turn ends after the agent scheduled a wakeup in one minute
- **THEN** the composer shows the scheduled state naming one pending wakeup and its fire time
- **AND** about a minute later a wakeup turn begins without a user prompt, attributed to that wakeup
- **AND** the wakeup's row reads as fired and links to that turn

#### Scenario: The agent cancels its own wakeup
- **WHEN** the agent ends its loop so that the session reports no pending wakeups
- **THEN** the pending row reads as cancelled
- **AND** the conversation returns to idle and its session is retired

#### Scenario: The user cancels one wakeup
- **WHEN** the user cancels one of two pending wakeups in a scheduled conversation
- **THEN** that wakeup's row reads as cancelled and it is no longer listed
- **AND** the session stays in the scheduled state for the other wakeup

#### Scenario: The user releases a scheduled session
- **WHEN** the user releases a conversation in the scheduled state
- **THEN** the session ends, each pending wakeup's row reads as cancelled
- **AND** the conversation is idle and accepts a new prompt

#### Scenario: A cancelled cron stays cancelled when the conversation runs again
- **WHEN** the user prompts a conversation whose recurring cron they released, and the agent's tooling rebuilds that cron in the resumed session
- **THEN** each time the cron would fire, no turn starts, no model call is made, and no notification is sent
- **AND** the conversation's state is not affected by the blocked fire

#### Scenario: A recurring cron is visible and releasable
- **WHEN** the agent creates a recurring cron
- **THEN** the wakeup list marks it as recurring with its next fire time
- **AND** the state persists across fired turns until the agent removes the cron or the user cancels it or releases the session

#### Scenario: The session dies with a self-paced wakeup pending
- **WHEN** the workspace stops, or the session process exits, while a self-paced wakeup is pending
- **THEN** its row reads as lost with a notice that the schedule did not survive the session
- **AND** the conversation is idle afterward

#### Scenario: The session dies with a cron pending
- **WHEN** the workspace stops, or the session process exits, while a cron the agent created is pending
- **THEN** its row reads as paused with a notice that it fires again once the conversation runs
- **AND** the conversation is idle afterward

#### Scenario: A reopened conversation lists its paused crons
- **WHEN** a conversation with no live session is opened whose agent created a cron that was not removed, not cancelled, and not expired
- **THEN** the cron is listed as paused with its prompt and a cancel action
- **AND** the conversation is idle, and no session is started for the cron

#### Scenario: A prompt during the scheduled state
- **WHEN** the user prompts a conversation in the scheduled state
- **THEN** the prompt runs in the same session
- **AND** the pending wakeups remain listed after that turn ends

#### Scenario: A reopened conversation replays fired wakeups truthfully
- **WHEN** a stored conversation whose transcript holds fired wakeup turns is reopened
- **THEN** those turns are presented as wakeup turns where the transcript records their origin
- **AND** no wakeup is shown as pending, because an idle conversation holds no session

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
rate-limit warning or rejection SHALL be shown as the current standing in
the composer's plan summary and the readout it opens, with its reset
time, and MUST NOT be presented as timeline content; a compaction in
progress SHALL show as compacting; a refusal that moved the turn to a
fallback model SHALL be attributed to the fallback model in the
timeline; and memories the session recalled SHALL be shown inline as
recalled context.

A rate-limit standing is a standing, not an event log: however many times
the login reports the same standing, the conversation SHALL present it
once and update it in place, and SHALL retire it when the login reports
that requests are allowed again. A change of standing SHALL be announced
to assistive technology.

Where the login reports plan utilization, the conversation SHALL present
it beside context usage as a compact summary naming each window in plain
words — the 5-hour window as the session and the 7-day window as the
week — with its percentage used, and SHALL mark the summary as a warning
when any window is at or past 80% or when a rate-limit warning stands.
While a rejection stands the summary SHALL instead state that requests
are rate limited, name when the limit resets, and be marked as a
rejection. Activating the summary SHALL open a
readout that states, for every window the login reports: its name, its
percentage used, and when it resets, both as a clock time and relative to
now. The readout SHALL name the plan, SHALL list per-model weekly windows
and model-scoped buckets under the label the login reports for them, SHALL
show extra-usage credits where the login has them enabled — as amounts in
the login's currency, whatever unit the wire counts them in, with the
percentage used derived from the amounts where the login states none — and SHALL show
this conversation's accumulated cost and per-model token totals where the
agent reports them. A login that reports only the two base windows SHALL
render the summary and readout with just those. For a login without plan
limits no plan summary SHALL be shown unless a rate-limit standing exists,
in which case the summary SHALL appear carrying that standing; where the
agent still reports this conversation's accumulated cost, the summary SHALL
state that cost instead,
and activating it SHALL show only this conversation's cost and per-model
totals, with no plan name, windows, or sidebar control.

Plan utilization belongs to the login, not to a conversation, and it
SHALL be remembered and readable on demand rather than only after a
turn. The workspace SHALL keep the newest plan report read through any
of its Claude Code conversations — the windows and the time they were
read — across conversation reopening, client reloads, and workspace
restarts. A conversation that has no plan report of its own SHALL present
the workspace's last-known report in its summary and readout, stating
when it was read and how long ago; a report older than ten minutes SHALL
be marked stale while remaining readable. A rate-limit standing MUST NOT
displace the last-known windows: the readout SHALL show the standing
beside them.

The readout SHALL offer a control that reads plan usage now. A read
SHALL go through a Claude Code session that is already live where one
exists — a turn in flight or background tasks running — without
interrupting it; otherwise it SHALL start a session for the conversation
and let it retire after the read, adding no message to the conversation;
and a workspace with no Claude Code conversation SHALL still answer,
without a conversation appearing in the inventory. Every read SHALL
refresh the conversation it went through with a fresh context report and
this conversation's totals, exactly as a turn-end read does. While a read
is in flight the control SHALL say so and further requests SHALL join it
rather than start another; a read that fails SHALL keep the last-known
figures and state why it failed. Opening the readout when the last-known
report is stale and a Claude Code session is already live SHALL refresh
through that session unasked; a session MUST NOT be started for a read
the user did not ask for.

#### Scenario: A retry is not a silent stall
- **WHEN** Claude Code retries a failed API request
- **THEN** the composer status shows a retrying state
- **AND** it returns to working when the request succeeds

#### Scenario: A rate limit names its reset
- **WHEN** Claude Code reports a plan rate limit warning or rejection
- **THEN** the composer's plan summary is marked at that level
- **AND** the readout it opens names the limit's window and when it resets

#### Scenario: A rate limit is not timeline content
- **WHEN** Claude Code reports a plan rate limit warning or rejection
- **THEN** the timeline gains no row for it
- **AND** the conversation's messages, tool activity, and task rows are unchanged

#### Scenario: A standing is stated once, not once per report
- **WHEN** the login reports the same rate-limit standing across many turns
- **THEN** the conversation presents one standing, updated in place
- **AND** it is retired once the login reports that requests are allowed again

#### Scenario: A rejection says requests are blocked
- **WHEN** the login rejects a request for having reached a window's limit, resetting at 06:00
- **THEN** the composer summary states that requests are rate limited and that the limit resets at 06:00
- **AND** the summary is marked as a rejection

#### Scenario: A rate limit without a plan still has somewhere to go
- **WHEN** the login reports no plan utilization but a rate-limit standing exists
- **THEN** the composer summary is shown carrying that standing

#### Scenario: A changed standing is announced
- **WHEN** a rate-limit standing begins, changes level, or is retired
- **THEN** the change is announced to assistive technology

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

#### Scenario: A warned window keeps its figures
- **WHEN** a rate-limit warning stands for a window the base summary does not name
- **THEN** the composer summary still reads its windows' percentages
- **AND** it is marked as a warning

#### Scenario: The readout names every window and its reset
- **WHEN** the reader activates the plan summary
- **THEN** each reported window shows its name, percentage, and reset as a clock time and a relative time
- **AND** the plan name is shown

#### Scenario: Extra-usage credits read as money
- **WHEN** a Pro login has 85 € of extra usage enabled, none of it spent, and states no percentage
- **THEN** the readout's extra-usage row reads 0,00 € of 85,00 € (in the reader's locale)
- **AND** its percentage reads 0%

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
- **WHEN** the login has no plan limits (an API-key session), the agent reports no conversation cost, and no rate-limit standing exists
- **THEN** no summary is shown beside the composer

#### Scenario: No plan, the cost is still reachable
- **WHEN** the login has no plan limits and the agent reports this conversation's accumulated cost
- **THEN** the composer summary states the cost, as "$1.23 this conversation"
- **AND** activating it shows only this conversation's cost and per-model usage, with no plan name or windows

#### Scenario: A reopened conversation shows the last-known plan
- **WHEN** a Claude Code conversation is opened after a reload, a workspace switch, or a workspace restart, and no turn has ended since
- **THEN** the composer summary reads the workspace's last-known windows
- **AND** the readout states when they were read and how long ago

#### Scenario: A stale report says so
- **WHEN** the last-known report was read more than ten minutes ago
- **THEN** the summary and readout still show its figures
- **AND** they are marked stale

#### Scenario: A standing does not empty the readout
- **WHEN** a rate-limit warning stands for a conversation that has no plan report of its own and the workspace holds a last-known report
- **THEN** the readout shows the standing and the last-known windows together

#### Scenario: A busy session answers without interruption
- **WHEN** the reader asks for a read while the conversation runs a long background task
- **THEN** the windows are refreshed from that session
- **AND** the task continues, with no message or turn added to the conversation

#### Scenario: An idle conversation is started for the read
- **WHEN** the reader asks for a read and the conversation's session is retired
- **THEN** a session is started, the windows are read, and the session retires again
- **AND** the conversation gains a fresh context report and no message

#### Scenario: A workspace without a conversation still answers
- **WHEN** the reader asks for a read and the workspace has no Claude Code conversation
- **THEN** the windows are read
- **AND** the conversation inventory is unchanged

#### Scenario: One read at a time
- **WHEN** the reader activates the read control while a read is in flight
- **THEN** the control shows the read in progress
- **AND** no second read is started

#### Scenario: A failed read keeps the figures
- **WHEN** a read times out or the login refuses it
- **THEN** the last-known windows remain shown
- **AND** the readout states that the read failed and why

#### Scenario: A live session refreshes a stale report unasked
- **WHEN** the reader opens the readout while the last-known report is stale and a Claude Code session in this workspace is live
- **THEN** the windows are refreshed through that session without a click

#### Scenario: No session is started unasked
- **WHEN** the reader opens the readout while the last-known report is stale and no Claude Code session is live
- **THEN** the stale figures are shown with their age
- **AND** no session is started until the reader activates the read control

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

### Requirement: Claude transcript paging reuses unchanged native history

Repeated paging or reopening of a verified unchanged native Claude Code transcript within the documented reuse limits SHALL avoid rereading, reparsing, and renormalizing the entire transcript for every request. Reusable history SHALL be bounded in memory and isolated by workspace and native transcript identity, including child transcripts and forked histories. Eviction or a transcript larger than those limits SHALL fall back to authoritative reads without losing content. A transcript append, rewrite, replacement, truncation, deletion, or history mutation SHALL invalidate or reconcile affected state before it is returned as current. Uncertain freshness SHALL cause an authoritative read.

The optimization MUST preserve transcript order, parent/child separation, token accounting, model attribution, reversible-history boundaries, and cursor correctness. Reading history SHALL NOT start a turn. Optional catalog readiness MUST NOT prevent displaying available transcript content; catalog-dependent readouts SHALL remain explicitly unknown until reliable metadata arrives.

#### Scenario: Adjacent pages share unchanged transcript work
- **WHEN** a user requests several pages from a retained transcript within the reuse limits verified unchanged since the first read
- **THEN** later pages reuse the verified result without repeating full transcript processing
- **AND** messages and usage remain correctly ordered and attributed

#### Scenario: Transcript changes outside the current browser
- **WHEN** a transcript is appended, rewritten, replaced, truncated, or deleted by the provider or another client
- **THEN** subsequent history reads reconcile the changed source
- **AND** no stale completed history is returned as authoritative

#### Scenario: Native history is available before the model catalog
- **WHEN** a stored conversation can be read but its optional model catalog is still loading
- **THEN** its transcript becomes readable without starting a turn or waiting for that catalog
- **AND** unresolved model-dependent values are presented as unknown until resolved
