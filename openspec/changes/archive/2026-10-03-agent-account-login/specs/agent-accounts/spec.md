## Purpose

Let a Hub user see and change the agent logins on the Hub machine (OpenCode
provider credentials and the Claude Code account) from the browser. Chat
agents then work without anyone opening the agents' own TUIs.

## ADDED Requirements

### Requirement: Agent accounts are machine-scoped and say so
The Hub SHALL manage agent logins only through each agent's own login
interface. A login SHALL be written where that agent keeps it on the Hub
machine, and the Hub MUST NOT store, cache, or log any agent secret in its own
state. A login or logout SHALL apply to every workspace on the Hub, every Hub
user, and the agent's own command-line tools on that machine. The Agent
accounts area SHALL state this scope where logins are changed.

#### Scenario: A login made in the Hub is the agent's login
- **WHEN** a user logs in to an OpenCode provider from Agent accounts
- **THEN** OpenCode started outside UatuCode on the same machine sees the provider as logged in
- **AND** no file in the Hub's state directory contains the key or token

#### Scenario: Scope is disclosed
- **WHEN** a user opens Agent accounts
- **THEN** the area states that logins apply to every workspace and every user of this Hub and to the agents' own tools on this machine

### Requirement: Agent accounts lists login state per agent and provider
The Agent accounts area SHALL list every chat agent the Hub offers. For
Claude Code it SHALL show whether a usable login exists. When the agent
reports them, it SHALL also show the account email, organization, plan, and
whether the login is a subscription, an API key, an environment-provided key
or token, or a third-party cloud provider. For OpenCode it SHALL list the
logged-in providers first, each with its credential kind and, on OpenCode 2.x,
its credential label. The providers that can be logged in to SHALL be listed
after them, findable by name. A login method that Agent accounts cannot run
itself, such as one that reads an environment variable or runs a local
helper command, SHALL be listed with what the user does instead: the
variable to set in the Hub's environment, or the agent's own login command.
An agent that is not installed or cannot be reached SHALL be reported with
its diagnostic, without hiding the other agents. Status reads SHALL NOT start a login, change a credential, or spend
model tokens.

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

### Requirement: Users log in with an API key
For every provider or agent login method that accepts a key, Agent accounts
SHALL offer a masked key field together with the method's own extra fields,
honoring each field's type, options, placeholder, and the condition under
which it appears. Submitting SHALL hand the key and answers to the agent, then
clear the key field. Saved keys SHALL NOT be redisplayed or returned by any
response. A rejected key or missing required field SHALL be reported next to
that method's controls.

#### Scenario: Key with an extra field
- **WHEN** a user logs in to a provider whose key method also asks for an account id
- **THEN** the form shows the key field and the account id field
- **AND** after a successful submit the provider is listed as logged in and the key field is empty

#### Scenario: Conditional field appears on demand
- **WHEN** a method's field is shown only for one answer to an earlier select field
- **THEN** the field appears only while that answer is selected and is not submitted otherwise

### Requirement: Users complete browser and device-code logins from any device
Starting a browser login SHALL show the URL to open and the agent's
instructions, including any code the user must enter. The Hub SHALL then
follow the attempt until it completes, fails, expires, or is cancelled, and
show which. When the agent's flow ends with a code to paste back, Agent
accounts SHALL take the code and submit it. When the flow redirects to a
`localhost` address on the Hub machine, Agent accounts SHALL tell the user
that the browser will fail to load that address unless it runs on the Hub
machine, take the full address the browser landed on, and have the Hub
deliver it to the agent's waiting listener on the Hub machine. A user SHALL
be able to cancel an attempt in progress. Starting a login for an agent or
provider SHALL replace that agent's or provider's earlier unfinished attempt.

#### Scenario: Device-code login from a phone
- **WHEN** a user starts a device-code login on a phone
- **THEN** Agent accounts shows the verification URL and the code to enter
- **AND** marks the login complete once the user approves it on the provider's site, with no further input

#### Scenario: Paste-code login
- **WHEN** a user starts a Claude Code login, choosing a Claude subscription or an Anthropic Console account
- **THEN** Agent accounts shows a link to the provider's sign-in page and a field for the code that page shows
- **AND** submitting the code completes the login and the row shows the signed-in account

#### Scenario: Localhost redirect completed from another device
- **WHEN** a user on a laptop that is not the Hub machine completes a provider sign-in whose redirect points at `localhost` and pastes the address the browser failed to load
- **THEN** the Hub delivers it to the agent's listener and the login completes

#### Scenario: Attempt expires
- **WHEN** a started login is not completed before the agent's deadline
- **THEN** Agent accounts reports it expired and offers to start again

### Requirement: Pasted redirect addresses are confined to the attempt
The Hub SHALL deliver a pasted redirect address only when its scheme, host,
port, and path match the local callback address of the attempt in progress
for that agent or provider, with its host a loopback address. The Hub MUST
reject any other address without requesting it and MUST NOT follow redirects
from the listener. The response SHALL report only whether the login completed
or failed, not the listener's response body.

#### Scenario: Address for another host is refused
- **WHEN** a user pastes an address whose host is not loopback or whose port differs from the attempt's callback
- **THEN** the Hub rejects it without making any request and the attempt stays in progress

#### Scenario: No attempt in progress
- **WHEN** a redirect address is submitted for a provider with no login in progress
- **THEN** the Hub rejects it without making any request

### Requirement: Users log out and switch credentials where the agent allows
Agent accounts SHALL offer log out for each OpenCode provider credential the
installed OpenCode can remove, and for a Claude Code login that UatuCode or the Claude Code CLI created. Where the
installed OpenCode supports it, Agent accounts SHALL offer to make a different
saved credential the active one when an integration has more than one. Logging out SHALL ask for
confirmation, stating that every workspace and the agent's own tools lose
that login. Agent accounts SHALL NOT offer log out for a login it cannot
remove, such as a key from the Hub's environment or a third-party cloud
provider. For those it SHALL say where the login is configured.

#### Scenario: OpenCode provider logout
- **WHEN** a user confirms log out for a logged-in OpenCode provider
- **THEN** the provider is listed as not logged in
- **AND** its models leave the chat model picker in open workspaces

#### Scenario: Claude Code logout
- **WHEN** a user confirms log out for a Claude Code subscription login
- **THEN** the Claude Code row reads "Not logged in"
- **AND** a new Claude conversation reports that no login is available

#### Scenario: Environment key cannot be logged out
- **WHEN** Claude Code's login comes from `ANTHROPIC_API_KEY` in the Hub's environment
- **THEN** no log out action is offered and the row says the key is set in the Hub's environment

#### Scenario: Switching the active credential
- **WHEN** an OpenCode 2.x integration has two saved credentials and the user activates the inactive one
- **THEN** that credential is marked active and later turns use it

### Requirement: Login changes reach open workspaces without a restart
After a login, logout, or credential switch completes, every running
workspace SHALL refresh the affected agent's availability and model catalog.
A newly logged-in provider's models SHALL become selectable without
restarting the workspace, and a running turn SHALL NOT be interrupted.

#### Scenario: Provider appears in the picker
- **WHEN** a user logs in to an OpenCode provider while a workspace's chat is open
- **THEN** that provider's models appear in the workspace's model picker without a reload or restart

#### Scenario: Running turn is not disturbed
- **WHEN** a login completes while a conversation in a running workspace has a turn in progress
- **THEN** the turn continues to completion

### Requirement: Agent account mutations are protected
Every Agent accounts operation that starts, completes, cancels, or changes a
login SHALL be a POST request protected by the Hub's same-origin policy and
authentication. Reads and mutations SHALL require an authenticated Hub
session. Responses, logs, and diagnostics SHALL NOT contain keys, tokens,
authorization codes, or pasted redirect addresses.

#### Scenario: Cross-origin login start is refused
- **WHEN** a cookie-authenticated cross-origin request tries to start a login or submit a key
- **THEN** the Hub rejects it and the agent's credentials are unchanged

#### Scenario: Codes do not reach logs
- **WHEN** a user submits a paste-back code or redirect address
- **THEN** neither the Hub log nor any response contains it
