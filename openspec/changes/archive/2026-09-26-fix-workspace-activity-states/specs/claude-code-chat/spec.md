## MODIFIED Requirements

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
