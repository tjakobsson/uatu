# claude-code-chat Specification

## Purpose

Define the Claude Code chat agent: how a workspace discovers and reports
the user's Claude Code installation, runs one agent session per live
conversation, normalizes Claude Code activity into the shared conversation
timeline, and brokers permissions, questions, modes, models, and resume
against Claude Code's native session storage.

## Requirements

### Requirement: Chat uses the workspace's Claude Code installation and identity

Claude Code SHALL use the workspace's existing configuration and authentication. Chat MUST NOT request Anthropic or provider API keys or other credentials. Logins SHALL start only in the Hub's Agent accounts area through Claude Code's own login interface. UatuCode MUST NOT copy, persist, log, or return resulting credentials or authorization codes. Availability SHALL be checked without a long-lived idle service, with failures isolated to Claude Code.

#### Scenario: Discover the workspace executable on first need
- **WHEN** a Claude Code conversation is first needed
- **THEN** UatuCode discovers the `claude` executable available to the workspace process and uses the existing configuration and authentication
- **AND** availability checking leaves no long-lived idle service

#### Scenario: A failed installation is actionable and isolated
- **WHEN** the Claude Code installation is missing or fails
- **THEN** an actionable unavailable state identifies Claude Code as the affected agent
- **AND** the workspace, non-chat capabilities, and other agents remain usable

#### Scenario: Existing Claude Code authentication is reused
- **WHEN** the workspace user has already authenticated Claude Code and starts a Claude Code conversation
- **THEN** the conversation runs under that existing identity without asking for an API key

#### Scenario: A login made in Agent accounts is used
- **WHEN** a user logs in to Claude Code from Agent accounts and then prompts a Claude Code conversation in a running workspace
- **THEN** the conversation runs under the new login without restarting the workspace

#### Scenario: Claude Code is not installed
- **WHEN** the workspace cannot resolve a `claude` executable
- **THEN** the Claude Code agent reports that Claude Code must be installed and authenticated
- **AND** OpenCode conversations, preview, search, and terminal continue working

### Requirement: A Claude Code conversation runs as its own agent session

Each Claude Code conversation SHALL have its own workspace-directory-scoped session while it has an active turn, live background work, or an uncancelled pending wakeup, and SHALL NOT hold a running session otherwise. Idle prompting SHALL start or resume transparently. Users SHALL be able to interrupt active turns. Shutdown SHALL terminate every owned live session before completing, retaining completed history in native storage.

#### Scenario: The first result does not end a still-active turn
- **WHEN** a turn result arrives before the session reports itself idle
- **THEN** the turn is not considered over and work the agent left running is not cut off

#### Scenario: Native idle ends a turn without requiring a preceding result
- **WHEN** the session reports itself idle
- **THEN** the turn is considered over, even if no turn result preceded the idle report

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

The workspace SHALL enumerate resumable Claude Code conversations from native storage for its canonical directory and present history without a turn or live session. Other-directory conversations MUST NOT be listed or accepted. Unparseable sessions SHALL be skipped without failing enumeration. Stored authorship SHALL decide attribution: Claude-authored user records MUST NOT become user messages, first prompts, or titles; person-authored records SHALL remain their messages regardless of text.

#### Scenario: Harness-authored records cannot supply a first prompt or title
- **WHEN** a stored user record is authored by Claude Code on the person's behalf
- **THEN** it is not shown as the person's message and is not used as the session's first prompt or title
- **AND** this includes a skill's preamble, a local-command caveat, an image caption, and a background task's notification

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

The server SHALL normalize Claude Code activity into ordered shared conversation events, delivering assistant text as it streams and attributing per-message token usage to the reporting model. Unrecognized or unparseable events SHALL be skipped and counted by type without recording payloads or ending the stream; unknown content blocks within recognized messages SHALL likewise be skipped and counted by block type without recording payloads.

#### Scenario: Every supported activity family reaches the shared event stream
- **WHEN** Claude Code reports user or assistant content, reasoning, tool lifecycle or progress, background task lifecycle, permissions or structured questions and their resolutions, tool-driven dialogs, context compaction, turn status, cancellation, completion, warnings, errors, or per-message token usage
- **THEN** the server emits the corresponding shared conversation events in order
- **AND** usage retains the reporting model's attribution

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

Tool permission requests SHALL appear pending in the owning conversation, name the action and resources, and return approval or rejection to the session. Any permission pending at session end SHALL resolve visibly as failed or interrupted, regardless of approval scope. Session-scoped approval SHALL require exact native-rule confirmation before sending. Updates persisting beyond the live session MUST NOT be forwarded or listed.

#### Scenario: Session approval suppresses equivalent prompts only within its supported reach
- **WHEN** the user confirms session-scoped approval
- **THEN** repeat prompts for equivalent actions in that conversation are suppressed where Claude Code supports it
- **AND** the card states that reach in Claude Code's own terms, never another agent's

#### Scenario: Confirmation is an exact inventory of forwarded session updates
- **WHEN** the user first clicks session-scoped approval
- **THEN** no approval is sent yet; a confirmation lists every session-scoped update the reply will forward in Claude Code's own permission-rule syntax, separately from the request's resources
- **AND** nothing not forwarded is listed, including updates persisting beyond the live session
- **AND** absent session-scoped updates, the confirmation states that it covers only this request

#### Scenario: Recovered permissions retain the live confirmation rules
- **WHEN** a permission request is recovered after its live announcement was missed
- **THEN** its confirmation lists the same updates that the live announcement would have shown

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

The agent SHALL offer Claude Code's catalog, supported effort variants, its recommended default, distinct app-only models, and typed ids. Selections SHALL govern subsequent prompts; unsupported effort MUST NOT be selectable and rejected ids SHALL fail with the CLI error, never silently fall back. Every model-naming surface SHALL include its version. Known windows SHALL be reported using applicable native evidence, with estimates and cached values identified.

#### Scenario: Default and additional choices retain their distinct meanings
- **WHEN** the agent presents model choices
- **THEN** Claude Code's recommended default is a first-class active entry until a model is chosen, not a generic delegation row; choosing it leaves resolution to Claude Code
- **AND** models the Claude apps offer under "More models" but the catalog omits and user-typed ids are presented distinctly from catalog entries

#### Scenario: Every model-naming surface derives missing versions from the catalog
- **WHEN** any surface names a model whose catalog display name lacks its version
- **THEN** the version is derived from the catalog, for example "Opus 5 (1M context)" or "Fable 5.1"

#### Scenario: Initial catalog and windows are read without model work
- **WHEN** the catalog is first read
- **THEN** the agent reads Claude Code's own catalog when the install permits, using a static fallback only if it cannot answer, and requests windows for every offered model including catalog rows, "More models", and the default

#### Scenario: Native catalog discovery precedes the first conversation
- **WHEN** the workspace is about to run its first Claude Code conversation, whether or not the model picker has been opened
- **THEN** the catalog SHALL already have been read from Claude Code itself when the install permits, with a static fallback only if the install cannot answer

#### Scenario: Every window read preserves catalog responsiveness and conversation configuration
- **WHEN** any model-window read is performed or any offered model's window is presented
- **THEN** reads MUST NOT delay the catalog or change any conversation's model, and SHALL NOT spend tokens or make a model call
- **AND** every offered model's window, including catalog, "More models", and default rows, uses what Claude Code states for that model on this install and login

#### Scenario: Accepted window discoveries propagate to all applicable readers
- **WHEN** a window discovery is accepted
- **THEN** subsequent catalog reads include it and connected clients refresh the affected catalog and context readout without user action or waiting for a turn to finish

#### Scenario: Running-session model ids join the catalog's effective windows
- **WHEN** a running session reports a model id
- **THEN** the id is attributed to catalog entries so context usage joins the window actually in effect

#### Scenario: Window evidence retains its strength and freshness
- **WHEN** the agent resolves a model's context window
- **THEN** a static or known-id estimate is labelled estimated and used only without an applicable Claude-reported window; an unrecognized model without a defensible estimate remains unknown, not assumed 200k
- **AND** reused reported values awaiting execution-context revalidation are labelled cached
- **AND** estimates and catalog refreshes MUST NOT replace applicable confirmed windows, but fresh session reports can replace older windows upward or downward

#### Scenario: Every new session queries its configured effective window
- **WHEN** a conversation starts or resumes its own Claude session, including with a typed model id
- **THEN** after applying the selected configuration and before delivering that session's first prompt, it requests its effective window
- **AND** the wait is bounded; failed or slow reads MUST NOT block prompt delivery, cancellation, or normal stream processing, and valid late answers update the running conversation
- **AND** answers from superseded sessions, selections, or logins MUST NOT override newer contexts; window variants remain distinct even with the same bare model id

#### Scenario: Discovery retries are bounded and share work
- **WHEN** window discovery is attempted, retried, requested concurrently, or its owning provider is disposed
- **THEN** transient failures remain eligible for bounded retries with backoff, and an attempted read MUST NOT count as success
- **AND** concurrent requests share discovery work, unsupported controls do not cause endless retries, and discovery stops when its provider is disposed

#### Scenario: The effective workspace default governs all default metadata
- **WHEN** the recommended default is presented or its resolution is refreshed
- **THEN** the model it actually runs after user, project, environment, and managed settings determines the default entry's resolution, name on every surface, description, effort levels, and context window
- **AND** that resolution is learned before any turn when Claude Code can answer
- **AND** an unrepresented model is named by id; ordinary catalog refreshes retain the resolution, applicable newer observations update it, and the account-level catalog resolution is used only when Claude Code cannot report the effective default

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
- **AND** the context window presented is the one that model actually has when Claude has stated it
- **AND** any fallback figure is explicitly identified as an estimate

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
- **AND** the presented effort is the effort actually sent
- **AND** an effort level the model does not support is not offered alongside it

#### Scenario: A model's window is the one Claude Code states, before any turn
- **WHEN** the model picker is read on a healthy install whose catalog offers Sonnet 5.5 under an id with no window marker, after Claude Code has stated a 1M window for it
- **THEN** Sonnet 5.5 is offered with a 1M context window, though no conversation has run
- **AND** no tokens are spent and no model call is made to learn it

#### Scenario: Reading windows does not delay the catalog
- **WHEN** the model picker is first read and Claude Code takes seconds to state every model's window
- **THEN** the catalog is presented without waiting for all windows
- **AND** a model whose window has not been stated yet is presented with a labelled estimate or an unknown window
- **AND** a discovered window reaches the open picker and applicable readout without reopening the picker

#### Scenario: Settings that override the account default are what the default names
- **WHEN** the catalog's default row resolves to Sonnet 5.5 and the workspace's Claude Code settings set the model to `fable[1m]`
- **THEN** before any turn on a healthy install the default is presented as "Default · Fable 5.1", resolving to the Fable 5.1 entry
- **AND** its description and effort levels are Fable 5.1's
- **AND** a first prompt under the default runs on Fable 5.1, matching what was presented

#### Scenario: The default's window is the window of what it runs
- **WHEN** the recommended default runs a model whose stated window differs from the window of the model the catalog names for it
- **THEN** the default entry's context window is the stated window of the model the default actually runs

#### Scenario: A default running an unlisted model is named by its id
- **WHEN** the workspace's settings make the default run a model id that no offered entry represents
- **THEN** the default is presented naming that id
- **AND** not as the catalog's account-level resolution, nor as an unnamed "Default (recommended)"

#### Scenario: The default's resolution outlives a catalog refresh
- **WHEN** the default's actual model has been learned and a conversation then starts and refreshes the catalog without reporting a different resolution
- **THEN** the default is still presented as the model it actually runs

#### Scenario: Without a report the catalog's resolution stands
- **WHEN** Claude Code cannot report what the default runs
- **THEN** the default is presented by the catalog's own resolution, as before

#### Scenario: Reading windows leaves running conversations alone
- **WHEN** the catalog and its windows are read while a Claude Code conversation is running under a chosen model
- **THEN** that conversation's model is unchanged and its next prompt runs under the model it had

#### Scenario: A stated window outlives a catalog refresh
- **WHEN** a model's window has been stated and a conversation then starts and refreshes the catalog
- **THEN** the model is still offered with its applicable stated window, not an id-derived figure

#### Scenario: A model with no stated window falls back to the derived figure
- **WHEN** Claude Code cannot state a window for a model with a known static or id-derived figure
- **THEN** the model is offered with that figure explicitly labelled as estimated
- **AND** the catalog itself is still offered

#### Scenario: An unrecognized model has no invented window
- **WHEN** a typed or newly listed model has no known estimate and Claude cannot state its window
- **THEN** the window is unavailable rather than assigned 200k
- **AND** the user can still send a prompt under that model id

#### Scenario: The conversation states its window before its first prompt
- **WHEN** the user selects Opus 5.5 and its own Claude session reports 1M within the bounded startup read
- **THEN** 1M is available to the conversation before its first prompt is delivered
- **AND** a smaller catalog estimate does not replace that answer

#### Scenario: A stalled startup read does not hold the prompt
- **WHEN** the conversation's initial window read exceeds its startup wait budget
- **THEN** prompt delivery proceeds with a labelled fallback or unknown limit
- **AND** cancellation and stream processing remain available
- **AND** a valid late answer updates the conversation while it is running

#### Scenario: A failed discovery can recover
- **WHEN** a window read fails transiently and a bounded retry succeeds
- **THEN** connected clients receive the recovered value without another model selection or a completed turn
- **AND** concurrent requests do not multiply the retry work

#### Scenario: Unsupported discovery does not loop
- **WHEN** the CLI does not support window reads
- **THEN** the catalog and prompting remain available with labelled estimates or unknown windows
- **AND** discovery does not continuously restart a process or issue reads

#### Scenario: A superseded answer cannot change the current window
- **WHEN** a read started under one session, model selection, or login finishes after that context has been superseded
- **THEN** it does not replace the current context's window
- **AND** a newer answer can increase or decrease the current window

#### Scenario: Window variants remain distinct
- **WHEN** two selections resolve to the same bare model id but Claude reports different windows for them
- **THEN** each conversation uses the window of the variant it actually runs
- **AND** the first catalog alias does not determine both conversations' limits

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

Each subagent SHALL have a launching row in the parent timeline and a child transcript of its own activity openable through shared drill-down, during and after execution. Subagents and all other agent forks MUST NOT appear in conversation inventory. Every other Claude Code agent fork SHALL receive the same inspection and attribution, however started, including forked skills and typed commands without launching rows. Live transcripts SHALL follow streamed activity or refreshed native records.

#### Scenario: Reported progress and usage accompany each run without invented figures
- **WHEN** a subagent or other forked agent run is presented
- **THEN** its launching row, where present, is attributable with the model and consumed tokens Claude Code reports, and missing usage does not prevent reading or assert figures
- **AND** while running, the subagents track names its latest progress where reported and its open transcript updates with its own text and tool activity

#### Scenario: A newly named fork is immediately inspectable
- **WHEN** Claude Code names a forked agent run, however it was started
- **THEN** it appears alongside subagents as work in progress, carrying what it runs and any reported latest activity, and is openable from that moment
- **AND** streamed activity updates the open transcript as it arrives; without streaming, the run's native record is refreshed throughout execution

#### Scenario: Late-named forks and typed-command results remain complete
- **WHEN** Claude Code names a fork only at completion or a typed command returns output
- **THEN** a fork named only at completion opens with its complete transcript, including activity streamed before naming
- **AND** whenever typed-command output returns, it is shown in the timeline both live and after reopening the conversation

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

Completed plans presented for approval in planning mode SHALL surface with their content in the owning conversation. Approval SHALL offer implementation, leaving planning mode, and, where Claude Code supports it, proceeding in the previously selected mode. The chosen intent SHALL govern subsequent mode without a separate user mode change. Rejection SHALL retain planning mode and allow the turn to continue planning.

#### Scenario: Returning to the previous mode is a distinct supported intent
- **WHEN** Claude Code supports proceeding with a plan while returning to the previously selected mode
- **THEN** plan approval offers that intent separately from leaving planning mode for implementation
- **AND** choosing it makes the previous mode govern subsequent work without a separate user mode change

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

Context usage SHALL be the latest model call's window occupancy: input, cache-read, and cache-write tokens, never summed across a turn's calls. Occupancy and window knowledge SHALL update independently within their execution context. Readouts SHALL expose evidence and uncertainty and refresh on limit or provenance changes without new usage. Reconnecting clients SHALL recover latest window knowledge with conversation state without another completed turn.

#### Scenario: Compaction and expanded breakdown reflect native occupancy
- **WHEN** Claude Code compacts a conversation or reports its own context breakdown
- **THEN** if compaction occurs, occupancy drops to the post-compaction figure and its location is marked in the timeline
- **AND** an available native breakdown is offered in the expanded view with a total agreeing with the presented fill

#### Scenario: Window evidence cannot replace occupancy or stronger window knowledge
- **WHEN** context evidence is reconciled within its applicable execution context
- **THEN** a window-only discovery MUST NOT replace the latest occupancy with a promptless estimate, zero, or another session's count
- **AND** session-reported windows take precedence over catalog-reported windows, then known static estimates; retained observations awaiting revalidation are labelled cached
- **AND** estimates MUST NOT overwrite applicable reported windows, while the newest valid session observation replaces an older session window even if smaller
- **AND** a model or window-variant change does not measure old-model occupancy against the newly selected window

#### Scenario: Limit and provenance changes repaint every context presentation
- **WHEN** the applicable limit or its provenance changes without another usage message
- **THEN** the percentage, fill, warning state, tooltip, and expanded breakdown update to match
- **AND** connected clients receive the update during running turns, and reconnecting clients recover the latest window knowledge with conversation state without another completed turn

#### Scenario: Unknown limits and compaction boundaries are not hard-capacity alerts
- **WHEN** the readout resolves its applicable limit and provenance
- **THEN** an estimate visibly labels both percentage and limit as estimated
- **AND** absent a known limit, or when occupancy disproves an estimate, it states tokens used and explains limit unavailability without a percentage, bare question mark, or full-window alert
- **AND** an explicitly reported compaction-policy boundary is not discarded merely because occupancy exceeds it; where Claude distinguishes it from model capacity, both values are distinguished and the boundary is not labelled hard capacity

#### Scenario: A long turn does not exceed its window
- **WHEN** a turn makes many model calls, each against a window that is 30% full
- **THEN** the presented fill after the turn is about 30%, not the sum of the calls

#### Scenario: Compaction is visible and resets the fill
- **WHEN** Claude Code compacts the conversation mid-turn
- **THEN** the timeline shows a compaction marker with the before and after figures
- **AND** the presented fill reflects the post-compaction figure

#### Scenario: The expanded breakdown is the session's own
- **WHEN** the user opens the context readout on a session that reports a breakdown
- **THEN** it shows the session's categories, such as system prompt, tools, messages, and memory
- **AND** their total matches the presented fill

#### Scenario: The session's window beats the catalog's figure
- **WHEN** the catalog lists a model with a 200k estimate and the session reports a 1M window for it
- **THEN** a later call that occupies 212k tokens presents a fill of about 21%
- **AND** the readout is not in its alert state

#### Scenario: A first turn is measured against the stated window
- **WHEN** Claude Code stated a 1M window for Sonnet 5.5 when the catalog was read, and a new conversation's first turn on Sonnet 5.5 occupies 50k tokens before any session report
- **THEN** the presented fill is about 5% of 1M, not 25% of 200k

#### Scenario: A reopened conversation is measured against the stated window
- **WHEN** a Claude Code conversation on Sonnet 5.5 is reopened, its last call occupied 250k tokens, and Claude Code stated a 1M window for Sonnet 5.5 when the catalog was read
- **THEN** the readout presents a fill of about 25% against 1M
- **AND** it does not drop the fill for exceeding a 200k guess

#### Scenario: An occupancy beyond the catalog's figure is not a full window
- **WHEN** no applicable window has been reported and a call occupies more tokens than a static estimate
- **THEN** the readout states the occupancy and explains that the limit is unavailable
- **AND** it shows neither a percentage nor a full-window alert
- **AND** a later confirmed limit restores the percentage without waiting for the turn to finish

#### Scenario: A corrected limit repaints an unchanged usage message
- **WHEN** the latest usage message remains at 150k tokens and the applicable limit changes from an estimated 200k to a reported 1M
- **THEN** the percentage changes from an estimated 75% to 15%
- **AND** the fill, warning state, tooltip, breakdown, and source label agree with 1M
- **AND** no new message, model selection, or picker interaction is required

#### Scenario: A source-only change is visible
- **WHEN** a 1M estimate is confirmed as 1M with no new usage message
- **THEN** the percentage stays the same and its estimated label is removed

#### Scenario: Window discovery preserves occupancy
- **WHEN** an early window query reports a local occupancy estimate and a 1M window while the conversation already has a newer usage count
- **THEN** the readout keeps that usage count and uses the discovered window
- **AND** discovery creates no synthetic conversation message or reset to zero

#### Scenario: A fresh session answer can reduce the window
- **WHEN** the session reports a current 200k window after an earlier 1M observation and the applicable usage is 50k
- **THEN** the readout shows 25% against the newer 200k window
- **AND** an older delayed 1M answer does not reverse it

#### Scenario: A staged model change does not relabel old occupancy
- **WHEN** the last usage belongs to one model and the user selects a different model or window variant for the next prompt
- **THEN** the last usage remains measured against its own applicable window
- **AND** new usage uses the window of the execution that produced it

#### Scenario: Reconnect recovers window knowledge
- **WHEN** the browser disconnects before a corrected window arrives and reconnects while the turn is still running
- **THEN** its recovered conversation state includes the latest applicable window and source
- **AND** its readout agrees with a browser that remained connected

#### Scenario: A reported compaction boundary is not an invalid estimate
- **WHEN** Claude explicitly distinguishes a 200k compaction boundary from a 1M model capacity and reports usage above the compaction boundary
- **THEN** the readout labels the compaction boundary separately from model capacity
- **AND** it does not discard that reported boundary using the rule for disproven estimates

### Requirement: Background tasks are surfaced, stoppable, and wake the model

Background shell commands, subagents, and monitors SHALL be named, visible, stoppable, and inspectable while running, with reported progress. Live background work SHALL give the composer a state distinct from working and idle, keep prompting available, and count as working in Hub activity. Settled tasks SHALL show summary rows live and on replay. Ambient housekeeping MUST NOT count as background work; ambient agent runs SHALL stay listed and openable, excluded only from background-work state.

#### Scenario: Running tasks expose native progress and inspection before turn end
- **WHEN** Claude Code starts or reports on a background task, including during a running turn
- **THEN** it is listed at once with what it is doing, elapsed time, and tokens and tool uses as Claude Code reports them
- **AND** progress uses the latest agent note, including for agent tasks the model-written progress summary Claude Code produces when asked
- **AND** selecting an agent task opens its own transcript; selecting a shell task opens its command, elapsed time, and latest progress, plus output refreshed from the moment its location is known
- **AND** Stop remains available inside the inspection view

#### Scenario: Running-work lists respect discovery and manual collapse
- **WHEN** background-task or subagent lists gain running work, update, or are manually collapsed
- **THEN** when running work first appears, its list is expanded so inspection and Stop need no prior disclosure
- **AND** a list manually collapsed stays collapsed until all work it holds is over, even if further work starts

#### Scenario: Every settled task has a durable row and a conditional model wakeup
- **WHEN** a background task completes, fails, or is stopped
- **THEN** its summary appears live and on reopening as a settled task row linked to its launching step, never as stored notification markup
- **AND** if the model is not mid-turn, the workspace wakes the session to act on the notification as Claude Code's terminal client does

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

With uncancelled pending wakeups and nothing else running, the conversation SHALL be scheduled, distinct from working, background, and idle. Users SHALL be able to prompt, cancel any wakeup, or release the session. Cancelled wakeups MUST NOT start another turn even after rebuild or resume; enforcement MUST NOT spend a model turn. The workspace MUST NOT start sessions to keep paused wakeups running. Agents without this capability SHALL show none of this.

#### Scenario: Pending and fired schedules retain their origin and details
- **WHEN** a session schedules a future turn, whether a self-paced wakeup, cron, or loop
- **THEN** the composer names the scheduled state when applicable and lists each pending wakeup's prompt, recurrence, and next fire time
- **AND** each timeline row follows pending, fired, cancelled, paused, or lost state
- **AND** fired turns name their originating wakeup and MUST NOT be presented as user-typed messages

#### Scenario: Release and session loss have different schedule outcomes
- **WHEN** a scheduled session is released or otherwise ends with pending wakeups
- **THEN** release cancels every wakeup and ends the session
- **AND** on other endings, unrebuildable wakeups are lost with a notice that the schedule did not survive, while rebuildable wakeups are paused with a notice that they fire again when the conversation runs

#### Scenario: Paused wakeups remain cancellable without a live session
- **WHEN** a conversation is opened without a live session
- **THEN** it lists each paused wakeup with a cancel action

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

Routine Claude Code signals SHALL surface where they affect waiting: retry and compaction status, fallback attribution, recalled context, and plan standing. Rate-limit warnings and rejections SHALL appear once with reset time in the composer summary and readout, MUST NOT become timeline content, and SHALL update in place, retire when requests are allowed, and announce changes to assistive technology. Login-level plan usage SHALL remain readable on demand, not only after turns.

#### Scenario: Waiting signals name their native cause
- **WHEN** Claude Code retries an API request, compacts, switches to a fallback model after refusal, or recalls memories
- **THEN** retries show a retrying state with the reason where reported, and active compaction shows compacting
- **AND** fallback work is attributed to its fallback model in the timeline, and recalled memories appear inline as recalled context

#### Scenario: Plan summary and expanded readout expose only reported utilization
- **WHEN** the login reports plan utilization or its reported utilization is presented in the summary or readout
- **THEN** plan utilization appears beside context usage as a compact summary naming each window and percentage in plain words, calling the 5-hour window session and the 7-day window week; it warns at or past 80% in any window or while a rate-limit warning stands
- **AND** a standing rejection instead says requests are rate limited, names the reset, and is marked rejection
- **AND** activating the summary opens a readout naming the plan and every reported window, percentage, and reset as both clock time and relative time, using reported labels for per-model weekly windows and model-scoped buckets
- **AND** enabled extra-usage credits use amounts in the login's currency regardless of wire unit, deriving percentage from amounts only when none is stated; reported conversation cost and per-model token totals are shown
- **AND** a login reporting only the two base windows shows only those

#### Scenario: A login without plan limits has no invented plan display
- **WHEN** the login has no plan limits
- **THEN** no plan summary is shown unless a rate-limit standing exists, which the summary carries
- **AND** where conversation cost is still reported, the summary states that cost instead and opens only conversation cost and per-model totals, without plan name, windows, or sidebar control

#### Scenario: Login reports survive conversation and workspace lifecycles
- **WHEN** the workspace retains, reads, or presents plan usage, including conversation reopening, client reloads, workspace restarts, or rate-limit standing changes
- **THEN** the newest report from any of its Claude Code conversations remains retained with its windows and read time across those lifecycles
- **AND** conversations without their own report show that last-known report in summary and readout with when it was read and how long ago, marked stale after ten minutes but still readable
- **AND** a rate-limit standing MUST NOT displace the windows; the readout shows both

#### Scenario: On-demand usage reads use live sessions before temporary sessions
- **WHEN** the readout is presented or any plan-usage read is requested, starts, or settles, including an automatic read
- **THEN** the readout offers a read-plan-usage-now control, and reads use an already-live Claude Code session, including an in-flight turn or background work, without interruption
- **AND** without a live session, a user-requested read starts a conversation session and lets it retire after the read without adding a message
- **AND** a workspace without a Claude Code conversation still answers without adding one to inventory
- **AND** every read refreshes the conversation it used with a fresh context report and that conversation's totals, as a turn-end read does
- **AND** while reading the control says so and additional requests join the read; failure keeps the last-known figures and states why it failed

#### Scenario: Only an already-live session refreshes stale usage unasked
- **WHEN** a readout opens with a stale last-known report
- **THEN** an already-live Claude Code session refreshes it without a click

#### Scenario: Unrequested plan reads cannot start a session
- **WHEN** a plan-usage read was not requested by the user
- **THEN** it MUST NOT start a session

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

Verified unchanged native Claude history SHALL reuse processing within documented limits, bounded in memory and isolated by workspace and native transcript identity, including children and forks. Reuse MUST preserve order, parent/child separation, token accounting, model attribution, reversible-history boundaries, and cursor correctness. Reading history SHALL NOT start a turn; optional catalog readiness MUST NOT block available content.

#### Scenario: Repeated reads reuse processing only within verified limits
- **WHEN** a native transcript is paged repeatedly, reopened, or unavailable for reuse
- **THEN** a verified unchanged transcript within documented reuse limits avoids rereading, reparsing, and renormalizing the entire transcript each time
- **AND** eviction or a transcript exceeding the limits falls back to authoritative reads without content loss

#### Scenario: Mutations and uncertain freshness require authoritative reconciliation
- **WHEN** a transcript is appended, rewritten, replaced, truncated, deleted, otherwise history-mutated, or of uncertain freshness
- **THEN** mutation invalidates or reconciles affected state before it is returned as current
- **AND** uncertain freshness causes an authoritative read

#### Scenario: Catalog-dependent history values remain explicitly unknown
- **WHEN** history is available but reliable catalog metadata has not arrived
- **THEN** available content is displayed and catalog-dependent readouts remain explicitly unknown until reliable metadata arrives

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

### Requirement: A rate-limit reset names its day when it is not today

Standing resets in the composer summary, readout, and accessibility announcement SHALL use zero-padded 24-hour `HH:MM` in the reader's time zone, never AM/PM in any locale. They SHALL name the weekday when not on the current local day, however far out, and otherwise use clock time alone; plan windows SHALL follow the same day rule. The readout's standing line and announcement SHALL also state remaining time, phrased like plan windows.

#### Scenario: Retained notices use stable reset times
- **WHEN** a reset is stated in a notice kept in the conversation timeline
- **THEN** it names the weekday and 24-hour clock time regardless of the day it is read or replayed
- **AND** it SHALL NOT state time remaining

#### Scenario: A reset later today is a bare time
- **WHEN** a rate-limit warning stands whose reset falls later on the reader's current local day at 23:00
- **THEN** the readout's standing line states that it resets at 23:00 without naming a day, such as "Resets 23:00 · in 3h 00m"
- **AND** it states the time remaining until the reset

#### Scenario: A reset on another day names the weekday
- **WHEN** it is Monday and a 7-day rate-limit warning stands whose reset falls on Thursday at 23:00
- **THEN** the readout's standing line states that it resets on Thursday at 23:00, such as "Resets Thu 23:00 · in 3d 4h"
- **AND** it states the time remaining until the reset in days and hours
- **AND** the composer's plan summary names Thursday with the reset time, such as "resets Thu 23:00"

#### Scenario: A reset early tomorrow is not read as today
- **WHEN** it is 23:30 and a rate-limit warning stands whose reset falls at 06:00 the next local day
- **THEN** every statement of that reset names the next day's weekday rather than stating 06:00 alone

#### Scenario: A reset a week or more out names only its weekday
- **WHEN** a rate-limit standing's reset falls seven or more local days after the reader's current day
- **THEN** the reset is stated with its weekday and 24-hour time and no date, such as "Resets Mon 23:00 · in 10d 4h"

#### Scenario: Reset times are 24-hour in every locale
- **WHEN** the reader's browser locale uses a 12-hour clock and a reset falls at 7:43 in the evening
- **THEN** every statement of that reset states 19:43, never "7:43 PM"

#### Scenario: Plan windows follow the same day rule
- **WHEN** the readout lists a plan window whose reset falls on the next local day, less than 24 hours away
- **THEN** that window's reset names the day rather than stating the clock time alone

#### Scenario: The announcement carries the day
- **WHEN** a rate-limit standing whose reset falls on a later local day begins or changes level
- **THEN** the announcement made to assistive technology names the reset's day, clock time, and the time remaining

#### Scenario: A timeline notice's reset stays true later
- **WHEN** the timeline shows a notice whose reset was stated earlier, and the reader reads or replays it after that reset has passed
- **THEN** the notice states the reset's weekday and clock time, such as "Resets Mon 23:00"
- **AND** it does not state a time remaining, such as "now" or "in 2h 05m"

### Requirement: Usage figures read at their count's scale
A conversation's token usage figures, wherever the chat surface shortens
them for at-a-glance reading, SHALL render with the scale suffix that
matches the count's magnitude — thousands, millions, then billions with a
`B` suffix — so a billion-scale total never reads as thousands of
millions. The exact figure SHALL remain reachable through the breakdown,
title, or expansion that already carries it.

#### Scenario: A billion-scale input total reads in billions
- **WHEN** the usage readout shows a model whose input token total has reached 1,023,700,000
- **THEN** the compact figure reads `1.0B`, not `1023.7M`
- **AND** the exact total remains available through the readout's breakdown or title

#### Scenario: Counts below a billion keep their compact form
- **WHEN** the usage readout shows figures below one billion tokens
- **THEN** they render as before — bare counts, `k` below a million, `M` below a billion

### Requirement: A loaded skill is named where it loads
A tool row for a skill-loading event SHALL name the skill it loads in the
collapsed row, whichever input key the agent's CLI generation names the
skill by — a `skill` key, a `name` key, or an `id` alone. The name SHALL
be stated once in the row, as its subject, and the row's expanded details
and forked-transcript navigation SHALL behave as for any skill row.

#### Scenario: The current Skill tool names the skill by id alone
- **WHEN** a skill-loading event's input carries only an `id` naming the skill
- **THEN** the collapsed row states that skill's name as its subject, not a bare generic label
- **AND** the name appears exactly once in the row, with no duplication through the expanded body

#### Scenario: Older payloads keep their behavior
- **WHEN** the input names the skill by a `skill` or `name` key
- **THEN** the row reads exactly as it did before this change
- **AND** a forked skill still offers its transcript from its row

### Requirement: A multi-select question reads whole and states its selection
A multi-select question the agent asks SHALL be readable whole — its full
prompt visible at narrow and wide viewports, wrapped rather than
truncated — and every option's selected or unselected state SHALL read
distinctly from more than colour alone, at narrow and wide viewports
alike.

#### Scenario: A long multi-select prompt is fully readable
- **WHEN** a multi-select question carries a prompt long enough to reach its container's edge at a narrow viewport
- **THEN** the full prompt remains readable, wrapped rather than cut off

#### Scenario: Selected and unselected options are told apart
- **WHEN** a multi-select question is presented with some options chosen
- **THEN** each chosen option reads as chosen and each unchosen option reads as unchosen, from the row's own presentation, at narrow and wide viewports

### Requirement: The owed-answer line follows the form's outstanding required steps
A multi-question form whose required validation spoke the owed-answer line
onto a surface's status region SHALL keep that line accurate as the form
stands — wherever the reader navigates or submits — and SHALL speak it only
while it is the region's current news. The line SHALL name every outstanding
required step of the form, including when raised or refreshed from the Next
advance gate, never the step last left alone.

#### Scenario: An optional empty step does not retire or rewrite a required step's line
- **WHEN** a required step's Next has raised the owed-answer line, and the reader then presses Next past an optional empty step (or tabs across one)
- **THEN** the line survives into the next step, still naming the required steps that remain outstanding
- **AND** once no required step is outstanding, the line retires

#### Scenario: The advance gate names the whole outstanding set
- **WHEN** the reader presses Next on an empty required step while other required steps — earlier or later — are also unanswered, whether on the form's first gate or after the final validation already listed the full set
- **THEN** the owed-answer line names every outstanding required step of the form, not only the step the advance stopped on
- **AND** repeated presses keep naming that whole set instead of shrinking it to the step just left

#### Scenario: An in-flight answer retires nothing until it succeeds
- **WHEN** an answer has gone out but its api call has not yet come back — or has come back failed, its failure reported on the surface the answer ran from
- **THEN** the raised owed lines stay standing on every surface, still reporting the question's unanswered step
- **AND** only the successful resolution retires them — including a line the same pending request raises while its answer hangs, with the reader free to navigate away and back in between

#### Scenario: A successful rejection retires the line it left behind
- **WHEN** a question is rejected after a required validation error raised the owed-answer line
- **THEN** the successful resolution retires that line along with the form
- **AND** a failed rejection leaves the failure's own status standing, with no owed-line cleanup behind it

#### Scenario: A landing resolution retires only the line its own question raised
- **WHEN** a question's reject or answer is still in flight, and meanwhile another conversation's validation — or a newer question of the same conversation — raises the owed-answer line, and the in-flight resolution then succeeds
- **THEN** the line the newer validation raised stays standing
- **AND** the resolution retires only the lines raised by the exact question request it resolved, with the parent's and the drill-down's timelines sharing the one ownership record, so a reject pressed in a drill-down that has since closed still retires the mirrored line on the surface the retirement's routing ends on

#### Scenario: A resolution retires its raised line on every surface while it is open
- **WHEN** a mirrored question's line was raised on the parent surface, and the answer or reject goes out from the drill-down whose surface stays open (or the reverse), and the resolution succeeds — with no stream event to clear the status itself
- **THEN** the raised line retires on every surface whose record matches — the parent's included, the drill-down's included — whether the drill-down is open or has closed, so closing it never exposes a stale status
- **AND** a line a newer unrelated status has displaced stays standing

#### Scenario: Settling one surface's form leaves the other surface's line standing
- **WHEN** both surfaces carry the mirrored card and the child surface's line stands for the child form's still-empty required step
- **THEN** answering the parent form's controls and navigating within it retires only the parent's own line — the child's valid owed error stays standing

#### Scenario: Navigation on one active form never steals another's line
- **WHEN** two active question forms of two owners share the surface's one status line, one form's validation has raised the line, and the reader tabs across — or presses Next past the optional empty step of — the other form, whose own required step is still empty
- **THEN** the line the first form's validation raised stays standing, unrewritten and unowned by the second form
- **AND** the second form's own failed validation (the Next gate or the final check) may take the line over, after which its own settlements keep refreshing it

#### Scenario: The owed line names steps by the labels the tabs render
- **WHEN** a provider mapping puts the long question text in the header and the short label in the prompt, so each tab renders a distinct short label
- **THEN** the owed-answer line names those same labels through the renderer's shared step-label selection, never a divergent algorithm repeating one long header per step
- **AND** equal-length prompt and header pick the header, a missing header picks the prompt, and a step carrying neither reads "the current question"

#### Scenario: An unrelated status is never spoken over
- **WHEN** the status region holds a newer message an outside owner spoke — an outage, a refusal, a turn failure
- **THEN** the owed-answer settlement leaves it standing, whether the form was advanced, rejected, or answered
