# chat-agents Specification (delta)

## MODIFIED Requirements

### Requirement: One chat surface serves every agent
Agents SHALL share the timeline, composer, queue, configuration picker, interaction cards, and announcements. Differences SHALL arise only from declared capabilities and agent-specific timeline content; unsupported controls SHALL be normally absent, not errors.

#### Scenario: Capability declarations gate agent-specific controls and timeline presentation
- **WHEN** a conversation's agent-specific controls or timeline presentation are rendered
- **THEN** they SHALL appear only if its owning agent declares the underlying capability, with absence normal rather than erroneous for another agent
- **AND** queue steer delivery and pending Steer entries SHALL require `steering`, composer steer delivery SHALL require `steering` or `immediate-steering`, and Send now SHALL require `send-now`

#### Scenario: Capability differences change controls, not the surface
- **WHEN** a user switches between a conversation whose agent declares reversible history and one whose agent does not
- **THEN** the same chat surface presents both
- **AND** the undo controls appear only in the conversation whose agent declares them

#### Scenario: Steering appears only for an agent that declares it
- **WHEN** a user switches between a running OpenCode 2.x conversation and a running Claude Code conversation
- **THEN** the same composer and dock present both
- **AND** the steer delivery choice and Steer entries appear only in the OpenCode 2.x conversation
- **AND** busy submissions in the Claude Code conversation are queued as before

#### Scenario: Immediate steering changes delivery, not the surface
- **WHEN** a user switches between a running OpenCode 2.x conversation and a running Antigravity conversation
- **THEN** the same composer and dock present both, and both composers steer busy ordinary text
- **AND** pending Steer entries and their withdrawal actions appear only in the OpenCode 2.x conversation

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

#### Scenario: The offered agents and their order
- **WHEN** a client asks a workspace for its chat status
- **THEN** the agents are OpenCode, Claude Code, and Antigravity, in that order
- **AND** the agent picker lists them in that order
- **AND** OpenCode is the server's default agent

### Requirement: An agent without a usable login says so
A running agent SHALL report usable-login availability independently of startup readiness. Missing login SHALL preserve selectable conversations, readable where the agent's own records allow it without the login (for Antigravity, only while `agy`'s transcript is available), and produce agent-specific login guidance and failure explanations, clearing after login without restart.

#### Scenario: Ready agents report login availability without startup failure
- **WHEN** a running agent reports availability
- **THEN** Claude Code SHALL report whether any login/key is effective; OpenCode SHALL report whether a provider is logged in or a no-login model is offered; Antigravity SHALL report whether `agy` accepts its cached login
- **AND** a ready agent lacking usable login SHALL remain ready with selectable conversations, readable as the requirement above allows, and SHALL NOT report startup failure
- **AND** new-conversation entry and that agent's composers SHALL name the agent and how to log in while login is missing

#### Scenario: Login failures and account changes update actionable feedback
- **WHEN** a turn fails due to missing, expired, or rejected login
- **THEN** it SHALL appear as login failure with the agent's own message as detail, not unexplained error
- **WHEN** Agent accounts reports change
- **THEN** login state SHALL be reread and missing-login state SHALL clear without restart once login is effective

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

#### Scenario: New Antigravity conversation without a login
- **WHEN** `agy` is installed but has no usable login and the user starts an Antigravity conversation, whether or not the page is Hub-served
- **THEN** the chat states that Antigravity is not logged in and says to run `agy` where UatuCode runs and sign in
- **AND** the guidance contains no link to the Hub's Agent accounts

#### Scenario: A login made outside UatuCode is picked up
- **WHEN** a user signs in through `agy` while an Antigravity login notice is shown
- **THEN** the next conversation listing, retry, or prompt for Antigravity rereads its login state
- **AND** the notice clears without restarting the workspace or reloading the page

#### Scenario: Login clears the notice
- **WHEN** a user logs in to the agent while its conversation is open
- **THEN** the notice disappears and the composer can send without reloading the page

## ADDED Requirements

### Requirement: An agent can declare immediate steering
An agent that takes a message into its running turn as soon as it is sent, but cannot withdraw or switch that message afterwards, SHALL declare `immediate-steering` and SHALL NOT declare `steering`. Its composer SHALL offer the same fixed steer and queue deliveries as a steering conversation, but a steer SHALL be handed to the agent at once and SHALL NOT wait in a pending state.

#### Scenario: Agents declare the steering capability that matches their delivery
- **WHEN** a client reads the agents' declarations
- **THEN** Antigravity declares `immediate-steering` and not `steering`
- **AND** OpenCode 2.x declares `steering` and not `immediate-steering`
- **AND** OpenCode 1.x and Claude Code declare neither

#### Scenario: Busy ordinary text steers at once
- **WHEN** a user taps Send, presses desktop Enter, or presses touch Ctrl/Command+Enter with ordinary text while an immediate-steering conversation is running
- **THEN** the message is handed to the agent at once as a steer
- **AND** the composer's busy guidance and Send's accessible name describe the action as steering, as in a steering conversation
- **AND** no pending or paused Steer entry appears in the dock

#### Scenario: Queuing still uses the workspace's held queue
- **WHEN** a user presses Alt/Option+Enter or completes the two-second Send hold while an immediate-steering conversation is running
- **THEN** the message is held in the workspace's queue and delivered when the turn ends
- **AND** the dock lists it as a queued entry with the usual edit and remove actions
- **AND** busy slash commands and drafts with attachments are queued, as in a steering conversation

#### Scenario: A delivered steer cannot be withdrawn
- **WHEN** an immediate steer has been handed to the agent
- **THEN** no switch to queue, edit, remove, or withdrawal retry is offered for it
- **AND** no paused-steers send action is offered after a cancellation, because nothing is left pending

#### Scenario: Send now keeps its rule for agents without steering
- **WHEN** an immediate-steering conversation that declares `send-now` has held messages
- **THEN** Send now is offered only while the held queue is dormant or the conversation is idle, as for any agent that declares `send-now` without `steering`
- **AND** a held message is not switched to a steer while the turn runs

### Requirement: An immediate steer appears once in the timeline
An immediate steer that the agent accepts SHALL appear in the timeline exactly once, as an ordinary user message at the point where the agent took it, both live and after the conversation is reopened. A steer the agent refuses SHALL NOT appear in the timeline. Its text and attachments SHALL return to the composer with the agent's reason. A steer whose admission is unknown SHALL be kept as an unconfirmed entry under the existing rules and SHALL NOT be resent automatically.

#### Scenario: An accepted steer is shown once
- **WHEN** the agent accepts an immediate steer during a running turn
- **THEN** the timeline shows it as one user message after the turn's content so far
- **AND** reopening the conversation shows that message once, at the same position

#### Scenario: A refused steer returns to the composer
- **WHEN** the agent refuses an immediate steer
- **THEN** no user message is added to the timeline
- **AND** the composer holds the steer's text and attachments again, with the agent's reason

#### Scenario: An unknown admission is kept, not resent
- **WHEN** the workspace cannot tell whether the agent accepted an immediate steer, for example because the agent's process ended while it was being sent
- **THEN** the steer is kept as an unconfirmed entry with its text and attachments
- **AND** it is not resent automatically

### Requirement: An immediate steer keeps the turn running
After an immediate steer is accepted, the conversation SHALL stay running until the turn that carries the steer ends. An end the agent reports for the part of the turn before the steer SHALL NOT count as a turn end. It SHALL NOT notify completion, start delivery of held messages, or mark workspace activity finished. Cancelling SHALL end the whole turn, including the steered part.

#### Scenario: The earlier part's end is not a turn end
- **WHEN** an agent reports that the part of the turn before an accepted immediate steer has ended, and then continues with the steer
- **THEN** the conversation stays running without a completion notification
- **AND** held messages stay held until the carried turn ends

#### Scenario: Cancel ends the steered turn
- **WHEN** a user cancels a running turn that carries an immediate steer
- **THEN** the whole turn ends as interrupted and the conversation accepts a new prompt
