## MODIFIED Requirements

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
