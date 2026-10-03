# chat-agents Specification

## Purpose

Define the multi-agent chat model: which coding agents a workspace offers,
how each agent's availability is reported and retried, how every
conversation is bound to the agent that owns it, and how one chat surface
presents conversations from different agents without privileging either.

## Requirements

### Requirement: A workspace offers a fixed set of chat agents
The workspace SHALL offer a server-determined set of chat agents and SHALL
identify each by a stable id and a human-readable name. Each agent SHALL
declare its own capabilities, and consumers SHALL take an agent's name and
controls from its declaration rather than from fixed copy. Agents' runtimes
SHALL be independent: one agent being unavailable, failing to start, or
crashing MUST NOT prevent conversations with another agent, and MUST NOT
affect non-chat capabilities of the workspace.

#### Scenario: Agents are listed with identity and capabilities
- **WHEN** a client asks a workspace for its chat status
- **THEN** the response identifies every offered agent by id and name
- **AND** states each agent's declared capabilities and availability independently

#### Scenario: One agent's outage does not block another
- **WHEN** one agent is not installed or fails to start
- **THEN** conversations with every other offered agent remain fully usable
- **AND** the unavailable agent reports an actionable unavailable state

### Requirement: Every conversation belongs to exactly one agent
Every conversation SHALL be owned by exactly one agent, fixed at creation
for the conversation's lifetime. Conversation summaries, snapshots, and
lifecycle announcements SHALL carry the owning agent's id, and every
conversation mutation SHALL be routed to the owning agent. Conversation
identifiers from different agents MUST NOT collide, and a request that
addresses a conversation through the wrong agent SHALL be rejected rather
than served by another agent.

#### Scenario: A conversation keeps its agent for life
- **WHEN** a conversation created with one agent is later opened, prompted, or renamed
- **THEN** every operation reaches the agent that owns it
- **AND** the conversation's reported agent identity never changes

#### Scenario: Summaries identify their agent
- **WHEN** a client lists conversations or receives a conversation lifecycle announcement
- **THEN** each entry identifies its owning agent
- **AND** a client can present the agent without loading the conversation

### Requirement: Users choose an agent when starting a conversation
When more than one agent is offered, starting a conversation SHALL let the
user choose among the offered agents before the conversation exists, and
the choice SHALL be presented with each agent's availability so an
unavailable agent is explained rather than hidden. The workspace SHALL
apply a stable default (the user's most recently used agent, then the
server's default) so a user who never chooses gets a working conversation.
Opening an existing conversation SHALL NOT require or offer an agent
choice.

#### Scenario: Creation offers the available agents
- **WHEN** a user starts a new conversation in a workspace offering two agents
- **THEN** the user can choose which agent the conversation belongs to
- **AND** the conversation is created under the chosen agent

#### Scenario: A returning user keeps their preference
- **WHEN** a user who last conversed with a given agent starts another conversation without making a choice
- **THEN** the new conversation belongs to that same agent

#### Scenario: An unavailable agent is explained at creation
- **WHEN** a user starts a conversation while one offered agent is unavailable
- **THEN** the unavailable agent is shown with its unavailable state rather than omitted
- **AND** choosing it does not create a conversation

### Requirement: Per-agent availability is independently reported and retryable
Chat availability SHALL be reported per agent, with each agent's state,
version, and failure diagnostics attributed to that agent alone. A failed
agent startup SHALL be retryable without restarting the workspace and
without disturbing another agent's running conversations.

#### Scenario: Retry touches only the failed agent
- **WHEN** a user retries an agent whose startup failed while another agent has an active turn
- **THEN** the failed agent's runtime is restarted
- **AND** the other agent's active turn continues uninterrupted

### Requirement: Conversation inventory spans all offered agents
The workspace's conversation inventory SHALL include every agent's
top-level conversations for the workspace directory, merged into one list
in which each entry carries its owning agent. An agent whose runtime is
unavailable SHALL contribute the conversations it can enumerate or none,
and its outage MUST NOT hide or delay another agent's entries.

#### Scenario: The chooser presents both agents' conversations
- **WHEN** a workspace holds conversations owned by two different agents
- **THEN** the conversation chooser lists both agents' conversations
- **AND** each entry is attributable to its agent without opening it

#### Scenario: A failing agent does not empty the chooser
- **WHEN** one agent cannot enumerate its conversations
- **THEN** the other agent's conversations remain listed

### Requirement: One chat surface serves every agent
The chat surface — timeline, composer, queue, configuration picker,
interaction cards, and announcements — SHALL be shared across agents, with
per-agent differences expressed only through declared capabilities and
agent-specific timeline content. An agent-specific control or timeline
presentation SHALL appear only for conversations whose owning agent
declares the capability behind it, and its absence for another agent
SHALL be a normal state rather than an error.

#### Scenario: Capability differences change controls, not the surface
- **WHEN** a user switches between a conversation whose agent declares reversible history and one whose agent does not
- **THEN** the same chat surface presents both
- **AND** the undo controls appear only in the conversation whose agent declares them

### Requirement: Inventory changes ride the brokered stream
When a session is served through the hub, the merged conversation inventory's invalidation signal SHALL be delivered as the `inventory` topic of the hub's brokered live stream, and the chat surface MUST NOT open a separate connection for it. The signal SHALL keep its meaning — the client re-reads the authoritative inventory — and one agent's outage MUST NOT withhold the signal for another agent's changes.

#### Scenario: A new conversation appears without a dedicated connection
- **WHEN** a conversation is created in the workspace from another device
- **THEN** the chooser on a hub-served page updates from an `inventory` topic event
- **AND** the page holds no connection dedicated to inventory

### Requirement: Chat navigation remains responsive across agents

Claude Code and OpenCode conversations SHALL use the same responsiveness and loading-feedback behavior. Returning to an already loaded Chat surface SHALL display retained content without waiting for a conversation-list refresh, optional catalogs, or a new transcript request. A required resynchronization SHALL preserve that content with an updating indication until current content is available. Hidden Chat activity MUST NOT prevent interaction with Files, Preview, or Terminal. Returning to Chat SHALL preserve drafts, pending attachments, expanded activity, and the prior reading anchor, or follow the latest output if previously pinned.

#### Scenario: Return while the network is slow
- **WHEN** an already loaded conversation is hidden behind another touch tab and the user returns while inventory reconciliation is delayed
- **THEN** the retained conversation is displayed without waiting for that request
- **AND** the user can interact with it or navigate away

#### Scenario: Output arrives while Chat is hidden
- **WHEN** a selected conversation produces output or requests input while another surface is visible
- **THEN** the visible surface remains interactive and chat attention indicators remain current
- **AND** returning to Chat presents the accumulated state without losing the draft or reading position

#### Scenario: Agent catalogs are delayed
- **WHEN** the user opens a conversation whose optional model, mode, or command catalog is delayed or unavailable
- **THEN** transcript loading and navigation proceed independently
- **AND** dependent controls communicate their own availability without applying another agent's catalog

### Requirement: Slow Chat reads expose their progress and recovery

Opening a conversation, loading older history, and retrying a failed read SHALL acknowledge the action immediately. An operation still pending after 200 milliseconds SHALL expose an accessible loading indication naming the operation. Once shown, a progress indication SHALL remain visible for at least 300 milliseconds unless its surface is dismissed. Feedback MUST NOT shift the reading position, erase retained content during refresh, or clear unrelated agent or connection errors. Reduced-motion users SHALL receive the same state information without continuous animation. Completion SHALL mean that the requested content is available for interaction, not merely that bytes arrived.

Obsolete reads SHALL stop controlling feedback when the user navigates elsewhere. Reads SHALL have finite documented deadlines, with actionable timeout or failure feedback and a read retry. Retrying a read MUST NOT create a conversation, resend a prompt, or repeat another mutation.

#### Scenario: Fast read avoids a progress flash
- **WHEN** a read completes before 200 milliseconds
- **THEN** the action is acknowledged without flashing a progress bar

#### Scenario: Slow read identifies the wait
- **WHEN** a read remains pending past 200 milliseconds
- **THEN** the surface identifies the pending operation and remains navigable

#### Scenario: Older history loads slowly
- **WHEN** an older-history request is delayed
- **THEN** the current timeline remains visible, its position stays stable, and the older-history control communicates loading

#### Scenario: Superseded request completes
- **WHEN** conversation A is loading, the user selects B, and A later completes or fails
- **THEN** A cannot replace B's content or settle B's loading indication

#### Scenario: Read times out
- **WHEN** a selected conversation read exceeds its deadline
- **THEN** loading ends with a timeout explanation and a retry action
- **AND** the draft and retained content are preserved

### Requirement: Long-chat improvements are verified without losing interaction behavior

Responsiveness SHALL be validated with equivalent short and long workloads for both agents, measuring warm surface switching, cold conversation opening, older-history loading, streaming, and resume separately. Validation SHALL distinguish server/read duration from browser presentation duration and record the browser, hardware, workload, and throttling settings. Under the documented controlled profile, warm touch-tab return to retained content SHALL meet a p95 target of 200 milliseconds. Delayed data requests MUST NOT determine that warm-return duration.

Optimized presentation SHALL preserve find over loaded history, copy actions, file links, accessible reading order, answerable requests, and stable scrolling. Completed content MUST NOT be silently dropped to meet the responsiveness target.

#### Scenario: Compare both agents under controlled load
- **WHEN** the same recorded workload and device profile are run against Claude Code and OpenCode
- **THEN** the validation report includes separate before/after timings and the warm-return result for each agent
- **AND** an improvement in one agent does not substitute for validating the other

#### Scenario: Find reaches older loaded content
- **WHEN** the user searches for text in an older loaded message whose presentation was deferred
- **THEN** find can locate and reveal that result in the correct conversation order
- **AND** the result's copy actions and file links remain usable

### Requirement: The conversation chooser groups conversations by the day of their last activity
The conversation chooser SHALL file every agent's conversations alike
under a heading for the reader's local calendar day of each conversation's
last activity, as the agent reports it. Headings SHALL appear newest day
first, with conversations newest first within a day. A heading SHALL read
"Today" or "Yesterday" for those days, and otherwise the short weekday and
the ISO date (`YYYY-MM-DD`), such as "Sun 2026-09-20", matching the
timeline's day separators. Days and times SHALL be those of the reader's
time zone; weekday names MAY follow the reader's locale, but dates and times
SHALL NOT. Each entry SHALL show the 24-hour clock time (`HH:MM`,
zero-padded, never AM/PM) of its last activity after its title and, where the workspace offers several agents,
its agent. A last-activity time later than the reader's clock SHALL be read
as now. A conversation whose agent reports no usable time (none, or a
placeholder before the year 2001) SHALL show no time and SHALL be listed
after the dated days, under an "Undated" heading when any other
conversation is dated and without a heading otherwise. When the reader's
local day changes while the chooser is shown, its headings SHALL be
relabelled without waiting for the inventory to change. Grouping SHALL NOT
change which conversation is selected.

#### Scenario: Conversations from different days are grouped
- **WHEN** a workspace holds conversations last active today, yesterday, and three days ago
- **THEN** the chooser shows the headings "Today", "Yesterday", and the short weekday and ISO date of three days ago, such as "Tue 2026-09-22", in that order
- **AND** each conversation is listed under the heading for the day of its last activity

#### Scenario: Both agents' conversations share the days
- **WHEN** an OpenCode conversation and a Claude Code conversation were both last active yesterday
- **THEN** both are listed under the one "Yesterday" heading, newest first
- **AND** each entry still names its agent

#### Scenario: Each entry shows its last-activity time
- **WHEN** a conversation was last active at 09:30 yesterday
- **THEN** its entry shows its title followed by 09:30, such as "Tick · OpenCode · 09:30"

#### Scenario: Entry times are 24-hour in every locale
- **WHEN** the reader's browser locale uses a 12-hour clock and a conversation was last active at 7:43 in the evening
- **THEN** its entry shows 19:43, never "7:43 PM"

#### Scenario: Activity moves a conversation to today
- **WHEN** a conversation listed under "Yesterday" gains new activity
- **THEN** once the inventory reflects it, the conversation is listed first under "Today"
- **AND** a day heading left with no conversations is removed

#### Scenario: A conversation with no usable time is undated
- **WHEN** an agent reports no last-activity time for a conversation while other conversations are dated
- **THEN** that conversation is listed after the dated days under "Undated" with no time shown

#### Scenario: Headings roll over at midnight
- **WHEN** the reader's local day changes while the chooser is shown
- **THEN** the heading that read "Today" reads "Yesterday" without any conversation changing

#### Scenario: The touch layout groups alike
- **WHEN** the chooser is opened in the touch layout
- **THEN** it shows the same day headings and entries as on desktop

### Requirement: Chat times are 24-hour and chat dates are ISO in every locale
Every time the chat surface shows, for every agent — including the usage
readout's "as of" time, the conversation cost's "since" time, a scheduled
wakeup's fire time in the composer, its list and the timeline, the hover
time of a timeline item, and a shell output window's completion time —
SHALL be a 24-hour clock time (`HH:MM`, zero-padded, never AM/PM) in the
reader's time zone, whatever the reader's locale. Where a date is shown
with it, the date SHALL be the ISO date (`YYYY-MM-DD`) after the short
weekday, such as "Sun 2026-09-20 19:43"; only weekday names MAY follow the
reader's locale.

#### Scenario: The usage readout's time is 24-hour
- **WHEN** the reader's browser locale uses a 12-hour clock and the plan usage was read at 7:43 in the evening
- **THEN** the readout states "as of 19:43", never "7:43 PM"

#### Scenario: A scheduled wakeup's fire time is 24-hour
- **WHEN** a wakeup is scheduled to fire at 20:03 today, and another eight days from now at 09:00
- **THEN** the first is stated as "about 20:03" and the second with its weekday and ISO date, such as "about Mon 2026-10-05 09:00"

#### Scenario: A hover time states the date and 24-hour time
- **WHEN** the reader hovers a timeline item created at 19:43 on 20 September 2026
- **THEN** its hover text reads the short weekday, "2026-09-20", and "19:43", such as "Sun 2026-09-20 19:43"

### Requirement: An agent without a usable login says so
A running agent SHALL report, as part of its availability, whether it has a
usable login: for Claude Code, whether any login or key is in effect; for
OpenCode, whether at least one model provider is logged in or a model that
needs no login is offered. A ready agent
with no usable login SHALL remain ready: its conversations SHALL stay
readable and selectable, and the missing login SHALL NOT be reported as a
startup failure. While no usable login is in effect, the chat SHALL say so
where a new conversation with that agent is started and in the composer of
that agent's conversations, naming the agent and how to log in. A turn that
fails because the agent's login is missing, expired, or rejected SHALL be
presented as a login failure with the agent's own message kept as detail,
not as an unexplained error. The login state SHALL be re-read when Agent
accounts reports a change, and SHALL clear without a restart once a login is
in effect.

#### Scenario: New Claude conversation without a login
- **WHEN** Claude Code is installed and ready but has no usable login and the user starts a Claude conversation
- **THEN** the chat states that Claude Code is not logged in and how to log in
- **AND** existing Claude conversations remain readable

#### Scenario: Expired login fails a turn
- **WHEN** a Claude turn fails with the agent's authentication error
- **THEN** the turn is presented as "Claude Code login failed" with the agent's message as detail and a way to log in

#### Scenario: OpenCode with no providers
- **WHEN** OpenCode is ready, no model provider is logged in, and no model that needs no login is offered
- **THEN** the model picker states that no provider is logged in and how to log in, instead of an empty list

#### Scenario: Login clears the notice
- **WHEN** a user logs in to the agent while its conversation is open
- **THEN** the notice disappears and the composer can send without reloading the page
