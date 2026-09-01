# claude-code-chat Specification (delta)

## Purpose

Define the Claude Code chat agent: how a workspace discovers and reports
the user's Claude Code installation, runs one agent session per live
conversation, normalizes Claude Code activity into the shared conversation
timeline, and brokers permissions, questions, modes, models, and resume
against Claude Code's native session storage.

## ADDED Requirements

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
Each Claude Code conversation with an active turn SHALL be served by its
own agent session scoped to the workspace directory; an idle conversation
SHALL NOT hold a running session. Prompting an idle conversation SHALL
start or resume its session transparently. The user SHALL be able to
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
reasoning, tool lifecycle, permission requests and resolutions,
structured questions and resolutions, turn status, cancellation,
completion, warnings, errors, and per-message token usage attributed to
the reporting model. An event the server does not recognize, or whose
payload it cannot parse, SHALL be skipped without ending the stream and
SHALL be counted by type without recording payloads.

#### Scenario: A streamed turn renders as shared timeline items
- **WHEN** a Claude Code turn streams assistant text, reasoning, and tool activity
- **THEN** connected clients render them with the same timeline presentation used for other agents
- **AND** token usage for the turn is attributed to the model that reported it

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
conversation where Claude Code supports it. A permission left pending when
its session ends SHALL be resolved to a visible failed or interrupted
outcome rather than remaining pending forever.

#### Scenario: A tool request waits for the user
- **WHEN** a Claude Code turn requests permission for a file edit
- **THEN** the conversation shows a pending permission naming the action and file
- **AND** the turn proceeds only after the user approves
- **AND** rejection is reported back and the turn continues without the tool result

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
SHALL govern its subsequent prompts. Modes that bypass permission
prompting entirely MUST NOT be offered unless the workspace operator
explicitly enabled them for the workspace.

#### Scenario: Plan mode governs the next prompt
- **WHEN** a user selects the planning mode and sends a prompt
- **THEN** the turn runs under that mode
- **AND** the selection persists for the conversation until changed

#### Scenario: Bypass is absent without operator opt-in
- **WHEN** a workspace without the operator opt-in lists the Claude Code agent's modes
- **THEN** no offered mode disables permission prompting

### Requirement: Models and effort levels follow Claude Code's catalog
The Claude Code agent SHALL list the models Claude Code offers and SHALL
offer each model's supported effort levels as that model's reasoning
variants. A model or variant selection SHALL apply to the conversation's
subsequent prompts, an effort level not supported by the selected model
MUST NOT be selectable with it, and the model's context-window size SHALL
be reported when known so context usage can be presented.

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
