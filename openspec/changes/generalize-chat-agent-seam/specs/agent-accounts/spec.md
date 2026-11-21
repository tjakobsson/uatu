# agent-accounts Specification (delta)

## MODIFIED Requirements

### Requirement: Agent accounts lists login state per agent and provider
The Agent accounts area SHALL list every chat agent whose login the Hub manages, its login state and available methods, with independent diagnostics and bounded requests. Status reads SHALL NOT start a login, change a credential, or spend model tokens.

#### Scenario: Account status describes Claude Code and OpenCode logins
- **WHEN** Agent accounts reads agent status
- **THEN** Claude Code SHALL show whether a usable login exists and, when reported by the agent, the account email, organization, plan, and whether the login is a subscription, an API key, an environment-provided key or token, or a third-party cloud provider
- **AND** OpenCode SHALL list logged-in providers first, each with its credential kind and, on OpenCode 2.x, its credential label
- **AND** providers that can be logged in to SHALL follow them, findable by name

#### Scenario: A login method needs configuration outside Agent accounts
- **WHEN** a method cannot be run by Agent accounts, such as one reading an environment variable or running a local helper command
- **THEN** it SHALL be listed with the variable to set in the Hub's environment or the agent's own login command

#### Scenario: Missing and unresponsive agents do not block account management
- **WHEN** an agent is not installed, cannot be reached, or does not answer a status read or any login, logout, or switch step within a bounded time
- **THEN** missing or unreachable agents SHALL be reported with their diagnostic without hiding other agents
- **AND** an unresponsive agent SHALL be reported as not answering and SHALL NOT hold up later requests
- **AND** its in-progress login SHALL be reported as failed and the next request SHALL start it again

#### Scenario: Claude Code is not logged in
- **WHEN** Claude Code is installed but has no usable login
- **THEN** its row reads "Not logged in" and offers to log in

#### Scenario: Claude Code uses a key from the environment
- **WHEN** the Hub's environment provides `ANTHROPIC_API_KEY`
- **THEN** the row reports the login as an environment-provided API key
- **AND** states that a browser login does not take effect while that key is set

#### Scenario: OpenCode provider list is searchable
- **WHEN** OpenCode offers more providers than fit on the page and the user types part of a provider's name
- **THEN** the list narrows to matching providers, with logged-in providers still listed first

#### Scenario: Environment-variable method
- **WHEN** an OpenCode provider offers a method that reads `GROQ_API_KEY`
- **THEN** Agent accounts lists it as "set `GROQ_API_KEY` in the Hub's environment" with no submit control

#### Scenario: One agent is missing
- **WHEN** OpenCode is not installed and Claude Code is
- **THEN** the OpenCode row reports it is not installed with the diagnostic
- **AND** the Claude Code row is fully usable

#### Scenario: An agent stops answering
- **WHEN** Claude Code starts but never answers the request for its login
- **THEN** its row reports that it did not answer instead of staying "Checking"
- **AND** the next visit starts Claude Code again

#### Scenario: An agent the Hub does not manage has no entry
- **WHEN** a chat agent declares that the Hub does not manage its login
- **THEN** Agent accounts shows no entry for that agent
- **AND** that agent's login guidance in chat names its own login command instead
