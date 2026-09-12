## MODIFIED Requirements

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

### Requirement: Background tasks are surfaced, stoppable, and wake the model
When a Claude Code session starts a task in the background — a backgrounded
shell command, a backgrounded subagent, or a monitor — the conversation
SHALL show that background work exists while it runs, naming each task
and its progress where reported, and SHALL let the user stop a task. A
task's completion, failure, or stop SHALL appear in the timeline with its
summary, live and when the conversation is reopened from storage alike:
the notification Claude Code stored for the model SHALL replay as the
settled task row, linked to the step that launched it, never as its
markup. While the session holds live background work the composer SHALL
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
