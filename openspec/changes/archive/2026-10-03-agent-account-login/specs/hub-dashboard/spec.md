## ADDED Requirements

### Requirement: Settings manages agent accounts
The authenticated `/settings` page SHALL provide an Agent accounts area,
separate from Credentials, that presents the behavior defined by the
`agent-accounts` capability. One card per agent SHALL be collapsed by default
and summarize the agent's name, installation state, and login state in plain
words: "Logged in as <account> · <plan>", "Not logged in", or the number of
logged-in OpenCode providers. Expanded cards SHALL keep their state across
refreshes. Each login form, login attempt, and card action SHALL report its
own failures next to its controls, and the page-level alert SHALL remain
reserved for load failures. Actions that wait on an agent SHALL disable their
control and show an in-progress label until they settle. The area SHALL work
at phone width: a login started on a phone SHALL show its URL as a link that
opens in a new tab, any code as large selectable text with a copy control,
and paste fields that accept the whole pasted value.

#### Scenario: Collapsed summary states the login
- **WHEN** Claude Code is logged in with a subscription and OpenCode has three providers logged in
- **THEN** the collapsed Claude Code card reads "Logged in as <email> · <plan>"
- **AND** the collapsed OpenCode card reads "3 providers logged in"

#### Scenario: Login attempt errors stay local
- **WHEN** a pasted code is rejected
- **THEN** the error appears next to that login attempt's code field
- **AND** the page-level alert is not used

#### Scenario: Device code on a phone
- **WHEN** a user starts a device-code login on a phone-width screen
- **THEN** the code is shown large enough to read and has a copy control, and the verification URL opens in a new tab

### Requirement: Chat links a missing login to Agent accounts
When a session is served by the Hub and the chat reports that an agent has
no usable login, the chat SHALL offer a link that opens the Hub's Settings at
the Agent accounts area with that agent's card expanded. Outside a Hub there
is no Settings page, so the chat SHALL name the agent's own login command
instead.

#### Scenario: Link from a failed Claude turn
- **WHEN** a Claude turn in a Hub-served workspace fails because there is no usable login
- **THEN** the failure offers "Log in to Claude Code", which opens Settings with the Claude Code card expanded
