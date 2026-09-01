# opencode-chat Specification (delta)

## MODIFIED Requirements

### Requirement: Chat uses the workspace's OpenCode installation and identity
When an OpenCode conversation is first needed in a running workspace, UatuCode SHALL discover the `opencode` executable available to that workspace process and start a loopback-only OpenCode service whose lifetime is owned by the workspace server. Opening Chat, or conversing with another agent, MUST NOT by itself start the OpenCode service. The service SHALL use OpenCode's existing user configuration and authentication; UatuCode MUST NOT request, copy, persist, or transmit provider API keys. If OpenCode is unavailable, cannot start, or is not authenticated, the workspace, all non-chat capabilities, and conversations with other agents SHALL remain usable and the Chat surface SHALL report an actionable unavailable state attributed to OpenCode.

Startup SHALL be observed as two separately bounded phases, distinguished by whether OpenCode has answered at the protocol level rather than by any text it emits. Until a probe receives an HTTP response, the generous bind budget applies; from the first HTTP response onward, a shorter health budget applies. A startup that fails SHALL be attributed to the phase that failed: if no probe ever received an HTTP response, the failure SHALL report that OpenCode never accepted a health request at the probed endpoint; if any probe did, the failure SHALL report that OpenCode answered but never became healthy, naming the endpoint and the last status observed. A health probe SHALL be individually bounded so that a connection which is accepted but never answered does not consume the whole budget.

UatuCode MUST NOT depend on the format of any text OpenCode writes to its standard output or standard error in order to determine readiness. Such output MAY be captured as diagnostic evidence, but a change to its format MUST NOT affect whether Chat becomes ready.

#### Scenario: Existing OpenCode authentication is reused
- **WHEN** the workspace user has already authenticated OpenCode and starts an OpenCode conversation
- **THEN** UatuCode connects using that existing OpenCode identity without asking for a provider API key

#### Scenario: OpenCode is not installed
- **WHEN** the workspace cannot resolve an OpenCode executable
- **THEN** the OpenCode agent explains that OpenCode must be installed and authenticated
- **AND** document preview, search, terminal, and other agents' conversations continue working

#### Scenario: Another agent's conversation does not start OpenCode
- **WHEN** a user opens Chat and converses only with a different agent
- **THEN** the OpenCode service is not started for that activity

#### Scenario: Workspace shutdown owns the agent service
- **WHEN** the workspace server shuts down while its OpenCode service is running
- **THEN** the OpenCode service and any active turn it owns are terminated before workspace shutdown completes
- **AND** persisted OpenCode conversation history remains available for a later workspace start

#### Scenario: OpenCode never accepts a health request
- **WHEN** OpenCode is spawned and stays alive but every probe is refused before the bind budget elapses
- **THEN** Chat reports an unavailable state attributed to the bind phase
- **AND** the reported message distinguishes this from a health-check failure

#### Scenario: OpenCode answers but never becomes healthy
- **WHEN** a probe receives an HTTP response and no subsequent probe reports a healthy body before the health budget elapses
- **THEN** Chat reports an unavailable state attributed to the health phase
- **AND** the reported message identifies the probed endpoint and the last status observed

#### Scenario: An answering-but-unhealthy server fails on the short budget
- **WHEN** OpenCode answers the first probe immediately and then answers every probe with a non-healthy response
- **THEN** Chat reports unavailable after the health budget rather than after the full startup budget

#### Scenario: Readiness does not depend on emitted text
- **WHEN** OpenCode becomes healthy at the probed endpoint but writes nothing recognizable to its standard output
- **THEN** Chat becomes ready

#### Scenario: A single unanswered probe does not exhaust the budget
- **WHEN** a probe connects to the endpoint and the connection is accepted but never answered
- **THEN** that probe is abandoned before the budget elapses
- **AND** further probes are attempted while the budget remains

### Requirement: The workspace API exposes normalized chat operations
The workspace API SHALL provide authenticated operations to list, create, and read conversations; start a prompt turn; remove a queued message; cancel the active turn; answer a pending permission; and answer or reject a structured question. Mutation requests SHALL be origin-protected under cookie authentication, SHALL validate conversation ownership against the workspace directory, and SHALL use client-generated request identifiers to make network retries idempotent. Provider-specific payloads and credentials MUST NOT be exposed as the public contract when a normalized UatuCode representation exists.

A prompt accepted while the conversation is running SHALL be reported as queued, identifying the held message so a client can later remove it. Conversation reads SHALL include the currently held messages in submission order, so a client joining or reloading mid-run presents the same queue as one that watched it build.

The API SHALL report every agent a workspace's Chat offers, and which capabilities each agent declares. A capability is declared only when the agent actually supports it; the absence of a declaration SHALL be a normal, expected state rather than an error or an empty result. Consumers SHALL be able to decide what to present from an agent's declaration alone, without probing an operation to discover whether it works. Agent-scoped catalog reads — models, modes, commands — SHALL identify which agent they describe.

The API SHALL name a way of working a **mode**, and SHALL name the program Chat talks to an **agent**. These two SHALL NOT share a name in the route table, because they are not the same thing and a reader cannot tell them apart from the route alone.

#### Scenario: Retried prompt does not run twice
- **WHEN** a client retries a prompt mutation with the same request identifier after losing the response
- **THEN** the server returns the original accepted result or current outcome
- **AND** the owning agent receives the prompt at most once

#### Scenario: Retried removal is applied once
- **WHEN** a client retries a queued-message removal with the same request identifier after losing the response
- **THEN** the server reports the original outcome
- **AND** at most one held message is removed

#### Scenario: A reload shows the queue as it stands
- **WHEN** a client loads a conversation snapshot while messages are held
- **THEN** the response identifies the held messages in submission order
- **AND** the client can present and remove them without having observed their submission

#### Scenario: Cross-origin mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to prompt, remove a queued message, cancel, or answer an agent request
- **THEN** the workspace rejects it without changing the conversation

#### Scenario: Base-path deployment uses relocated chat routes
- **WHEN** Chat is served under a workspace base path such as `/s/project-a/`
- **THEN** every chat request and stream URL resolves through that base path
- **AND** the hub proxies it without exposing any loopback agent service

#### Scenario: The API reports its agent and that agent's capabilities
- **WHEN** a client asks a workspace for its chat status
- **THEN** the response identifies every agent Chat offers
- **AND** states which capabilities each agent declares

#### Scenario: An undeclared capability is not an error
- **WHEN** an agent does not declare a capability
- **THEN** the status response omits it rather than reporting a failure
- **AND** the client can tell the difference between "not supported" and "supported but empty"

#### Scenario: Modes are listed under a route named for modes
- **WHEN** a client lists the ways of working a prompt can run under
- **THEN** the route names them modes
- **AND** no route names them agents

### Requirement: Chat separates identity from conversation controls
The Chat header SHALL place workspace and agent identity on its own row above the conversation selector and actions in desktop and touch layouts, and the agent identity shown SHALL be the selected conversation's owning agent. Conversation controls SHALL remain usable without competing with identity text at the minimum supported panel width.

#### Scenario: Desktop Chat uses an uncrowded two-row header
- **WHEN** Chat is open in the desktop side panel
- **THEN** workspace and agent identity occupy a row above the conversation controls
- **AND** the conversation selector and actions remain within the header width

#### Scenario: The identity row follows the conversation
- **WHEN** a user switches from a conversation owned by one agent to a conversation owned by another
- **THEN** the identity row names the newly selected conversation's agent
