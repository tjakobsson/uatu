## ADDED Requirements

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
