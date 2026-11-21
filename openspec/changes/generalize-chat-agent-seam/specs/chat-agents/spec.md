# chat-agents Specification (delta)

## ADDED Requirements

### Requirement: Login guidance follows the agent's declared login
Each agent SHALL declare its own login command and whether the Hub manages its login. Login guidance SHALL link to that agent's entry in the Hub's Agent accounts only on a Hub-served page and only for an agent whose login the Hub manages. Otherwise the guidance SHALL name the agent's declared login command. Guidance MUST NOT link to Agent accounts for an agent that the Hub does not manage.

#### Scenario: A Hub-managed agent links to Agent accounts
- **WHEN** a Hub-served page shows login guidance for an agent whose login the Hub manages
- **THEN** the guidance links to that agent's entry in the Hub's Agent accounts

#### Scenario: An agent the Hub does not manage names its own command
- **WHEN** a Hub-served page shows login guidance for an agent whose login the Hub does not manage
- **THEN** the guidance names the agent's declared login command to run where UatuCode runs
- **AND** it contains no link to Agent accounts

#### Scenario: Outside a Hub every agent names its own command
- **WHEN** a workspace served outside a Hub shows login guidance for any agent
- **THEN** the guidance names that agent's declared login command

#### Scenario: The declaration is known before the agent starts
- **WHEN** a client reads chat status while an agent is idle, starting, ready, or unavailable
- **THEN** the agent's login command and whether the Hub manages its login are part of that agent's identity in the status

### Requirement: Startup and availability messages name their agent
A message that reports an agent's startup failure, restart, or incompatible version SHALL name the agent it belongs to. One agent's failure MUST NOT be reported under another agent's name. Copy that describes one agent's state or choices SHALL use that agent's declared name.

#### Scenario: A failed Claude Code start is not reported as OpenCode
- **WHEN** a Claude Code conversation cannot be served because its provider failed to start
- **THEN** the unavailable message names Claude Code
- **AND** it does not name OpenCode

#### Scenario: OpenCode's messages are unchanged
- **WHEN** OpenCode is restarting or its installed version is not compatible with chat
- **THEN** the messages read "OpenCode is restarting; chat will retry." and "The installed OpenCode version is not compatible with chat." as before

#### Scenario: The default-model label names the conversation's agent
- **WHEN** a conversation's agent declares models and no model is chosen or declared as default
- **THEN** the configuration summary reads "Let" followed by that agent's name and "choose"
