# agent-accounts Specification

## Purpose
Let a Hub user see and change the agent logins on the Hub machine (OpenCode
provider credentials and the Claude Code account) from the browser. Chat
agents then work without anyone opening the agents' own TUIs.

## Requirements

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
The Agent accounts area SHALL list every chat agent the Hub offers, its login state and available methods, with independent diagnostics and bounded requests. Status reads SHALL NOT start a login, change a credential, or spend model tokens.

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

### Requirement: Users log in with an API key
For every provider or agent login method that accepts a key, Agent accounts
SHALL offer a masked key field together with the method's own extra fields,
honoring each field's type, options, placeholder, and the condition under
which it appears.

#### Scenario: Key submission clears secrets and reports errors locally
- **WHEN** a user fills and submits a key method
- **THEN** a field the agent marks as sensitive SHALL be masked like the key
- **AND** submitting SHALL hand the key and answers to the agent, then clear the key field and any sensitive field
- **AND** saved keys SHALL NOT be redisplayed or returned by any response, and an agent's error message SHALL NOT repeat the key or an answer
- **AND** a rejected key or missing required field SHALL be reported next to that method's controls

#### Scenario: Key with an extra field
- **WHEN** a user logs in to a provider whose key method also asks for an account id
- **THEN** the form shows the key field and the account id field
- **AND** after a successful submit the provider is listed as logged in and the key field is empty

#### Scenario: Sensitive field is masked
- **WHEN** a provider's login method asks for a value the agent marks as a password
- **THEN** the field is masked and is empty again once the login has started

#### Scenario: Conditional field appears on demand
- **WHEN** a method's field is shown only for one answer to an earlier select field
- **THEN** the field appears only while that answer is selected and is not submitted otherwise

### Requirement: Users complete browser and device-code logins from any device
Starting a browser login SHALL show the URL to open and the agent's instructions, including any code the user must enter. The Hub SHALL follow and report the attempt through completion, failure, expiry, or cancellation, supporting paste-back codes and remote completion of Hub-machine localhost redirects.

#### Scenario: A browser flow needs a code or localhost callback
- **WHEN** the agent's flow ends with a code to paste back or redirects to a `localhost` address on the Hub machine
- **THEN** Agent accounts SHALL take and submit a paste-back code
- **AND** for a localhost redirect it SHALL explain that the browser will fail to load the address unless running on the Hub machine, take the full address the browser landed on, and have the Hub deliver it to the agent's waiting listener on the Hub machine

#### Scenario: Login attempts can be cancelled, replaced, and retried safely
- **WHEN** a login is in progress or the user starts another attempt
- **THEN** the user SHALL be able to cancel an in-progress attempt
- **AND** a start SHALL replace that agent's or provider's earlier unfinished attempt, with simultaneous starts leaving at most one unfinished
- **AND** a restart after failure or expiry SHALL reuse answers except sensitive fields, which SHALL be asked for again rather than kept by the page

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

#### Scenario: Starting again asks for a sensitive field
- **WHEN** an attempt whose method asked for a sensitive field expires and the user starts again
- **THEN** the method's form shows the earlier answers, asks for the sensitive field again, and starts nothing until it is entered

#### Scenario: Two starts at once
- **WHEN** a user starts two logins for the same provider at the same moment
- **THEN** one attempt is in progress and the other is cancelled

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
Agent accounts SHALL offer log out for each OpenCode provider credential the installed OpenCode can remove, and for a Claude Code login that UatuCode or the Claude Code CLI created. Credential switching SHALL be offered where supported, and logout SHALL disclose its scope and require confirmation.

#### Scenario: An integration has multiple saved credentials
- **WHEN** the installed OpenCode supports switching and an integration has more than one saved credential
- **THEN** Agent accounts SHALL offer to make a different saved credential active

#### Scenario: Logout distinguishes removable and externally configured logins
- **WHEN** a user manages a login
- **THEN** logging out SHALL ask for confirmation stating that every workspace and the agent's own tools lose that login
- **AND** Agent accounts SHALL NOT offer log out for a login it cannot remove, such as a Hub-environment key or a third-party cloud provider
- **AND** for those logins it SHALL say where the login is configured

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
