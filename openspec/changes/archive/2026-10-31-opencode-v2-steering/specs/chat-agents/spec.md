## MODIFIED Requirements

### Requirement: One chat surface serves every agent
The chat surface — timeline, composer, queue, configuration picker,
interaction cards, and announcements — SHALL be shared across agents, with
per-agent differences expressed only through declared capabilities and
agent-specific timeline content. An agent-specific control or timeline
presentation SHALL appear only for conversations whose owning agent
declares the capability behind it, and its absence for another agent
SHALL be a normal state rather than an error. The queue's steer delivery
and its Send now action are such controls: they SHALL appear only for
conversations whose agent declares `steering` or `send-now` respectively.

#### Scenario: Capability differences change controls, not the surface
- **WHEN** a user switches between a conversation whose agent declares reversible history and one whose agent does not
- **THEN** the same chat surface presents both
- **AND** the undo controls appear only in the conversation whose agent declares them

#### Scenario: Steering appears only for an agent that declares it
- **WHEN** a user switches between a running OpenCode 2.x conversation and a running Claude Code conversation
- **THEN** the same composer and dock present both
- **AND** the steer delivery choice and Steer entries appear only in the OpenCode 2.x conversation
- **AND** busy submissions in the Claude Code conversation are queued as before
