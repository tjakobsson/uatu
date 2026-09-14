## ADDED Requirements

### Requirement: Chat reports what an OpenCode conversation has cost
Where OpenCode reports a cost for an assistant message, Chat SHALL present the conversation's accumulated cost in the same place and form a Claude Code conversation's session totals appear: the composer's usage chip reads the conversation's cost when the agent reports no plan windows, and the usage readout's conversation block states the total and a per-model breakdown of tokens and cost. The figure SHALL be the sum of the cost OpenCode reported per assistant message, in the currency OpenCode reports it, counted once per message however many times the message was restated while it streamed.

The cost SHALL be populated when an existing conversation is opened, from its stored history, not only after a new turn is taken; it SHALL NOT be qualified as "since" a later time, because the stored history carries every message's cost. When every message in the conversation reports a cost of zero — a model OpenCode has no price for — Chat SHALL show no cost rather than a zero figure. A message for which OpenCode reports no cost contributes nothing and SHALL NOT be presented as zero.

A subagent's attribution row SHALL state the subagent's cost beside its tokens when the child session reported one, under the same rule: absent, not zero, when unreported.

#### Scenario: The chip reads the conversation's cost
- **WHEN** an OpenCode conversation has exchanged turns and OpenCode reported a cost for its assistant messages
- **THEN** the composer's usage chip reads the accumulated cost as "this conversation"
- **AND** opening the readout shows the total and one row per model with that model's tokens and cost

#### Scenario: A restated message is counted once
- **WHEN** OpenCode restates one assistant message's cumulative cost several times while it streams
- **THEN** the conversation total counts that message's latest figure once

#### Scenario: Cost is restored from history
- **WHEN** the user opens an OpenCode conversation whose assistant messages carry costs
- **THEN** the chip and readout show the cost from that history before any new turn
- **AND** the readout block is titled for the whole conversation, not "since" a time

#### Scenario: A free model shows no cost
- **WHEN** every assistant message in the conversation reports a cost of zero
- **THEN** no cost figure is shown on the chip or in the readout

#### Scenario: A subagent row states its cost
- **WHEN** a subagent's child session reported cost with its tokens
- **THEN** the subagent's row states that cost beside its token figure

#### Scenario: Cost rides the usage wire
- **WHEN** a client validates a conversation snapshot or update carrying a usage record with a cost
- **THEN** the record is accepted under the workspace API revision that introduced it
