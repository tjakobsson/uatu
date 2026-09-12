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
