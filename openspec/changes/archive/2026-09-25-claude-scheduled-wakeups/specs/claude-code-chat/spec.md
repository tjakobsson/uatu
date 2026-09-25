## MODIFIED Requirements

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

## ADDED Requirements

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
