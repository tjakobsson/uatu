## MODIFIED Requirements

### Requirement: Chat uses the workspace's Claude Code installation and identity
When a Claude Code conversation is first needed, UatuCode SHALL discover
the `claude` executable available to the workspace process and use the
user's existing Claude Code configuration and authentication. A
workspace's chat MUST NOT request Anthropic or provider API keys or other
credentials. Claude Code logins SHALL be started only from the Hub's Agent
accounts area, through Claude Code's own login interface, and UatuCode MUST
NOT copy, persist, log, or return the resulting credentials or the
authorization codes that produce them. Claude Code availability SHALL be determined without keeping a
long-lived idle service, and a failed or missing installation SHALL be
reported as an actionable unavailable state attributed to Claude Code
while the workspace, non-chat capabilities, and other agents remain
usable.

#### Scenario: Existing Claude Code authentication is reused
- **WHEN** the workspace user has already authenticated Claude Code and starts a Claude Code conversation
- **THEN** the conversation runs under that existing identity without asking for an API key

#### Scenario: A login made in Agent accounts is used
- **WHEN** a user logs in to Claude Code from Agent accounts and then prompts a Claude Code conversation in a running workspace
- **THEN** the conversation runs under the new login without restarting the workspace

#### Scenario: Claude Code is not installed
- **WHEN** the workspace cannot resolve a `claude` executable
- **THEN** the Claude Code agent reports that Claude Code must be installed and authenticated
- **AND** OpenCode conversations, preview, search, and terminal continue working
