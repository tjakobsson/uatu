## MODIFIED Requirements

### Requirement: Chat uses the workspace's OpenCode installation and identity
When an OpenCode conversation is first needed in a running workspace, UatuCode SHALL discover the `opencode` executable available to that workspace process and start a loopback-only OpenCode service whose lifetime is owned by the workspace server. Opening Chat, or conversing with another agent, MUST NOT by itself start the OpenCode service. The service SHALL use OpenCode's existing user configuration and authentication. A workspace's chat MUST NOT request provider API keys or other provider credentials. UatuCode SHALL accept a provider credential only through the Hub's Agent accounts area, which hands it to OpenCode's own login interface; UatuCode MUST NOT copy, persist, log, or return it. If OpenCode is unavailable, cannot start, or is not authenticated, the workspace, all non-chat capabilities, and conversations with other agents SHALL remain usable and the Chat surface SHALL report an actionable unavailable state attributed to OpenCode.

Startup SHALL be observed as two separately bounded phases, distinguished by whether OpenCode has answered at the protocol level rather than by any text it emits. Until a probe receives an HTTP response, the generous bind budget applies; from the first HTTP response onward, a shorter health budget applies. A startup that fails SHALL be attributed to the phase that failed: if no probe ever received an HTTP response, the failure SHALL report that OpenCode never accepted a health request at the probed endpoint; if any probe did, the failure SHALL report that OpenCode answered but never became healthy, naming the endpoint and the last status observed. A health probe SHALL be individually bounded so that a connection which is accepted but never answered does not consume the whole budget.

Readiness SHALL be decided by either OpenCode generation's contract: a 1.x server is ready when its health resource answers with a well-formed health body that says it is healthy; a 2.x server is ready when its server-information resource answers with a well-formed body carrying its version. Each probe cycle SHALL ask both, and the first well-formed answer decides the generation for that server's lifetime. An answer that is not a well-formed body of either contract — in particular the page a 2.x server returns for any unknown path — MUST NOT be accepted as ready, whatever its status. The version reported for a ready server SHALL be the server's version alone, in the same form for both generations, so the generation is legible from it.

UatuCode MUST NOT depend on the format of any text OpenCode writes to its standard output or standard error in order to determine readiness. Such output MAY be captured as diagnostic evidence, but a change to its format MUST NOT affect whether Chat becomes ready.

#### Scenario: Existing OpenCode authentication is reused
- **WHEN** the workspace user has already authenticated OpenCode and starts an OpenCode conversation
- **THEN** UatuCode connects using that existing OpenCode identity without asking for a provider API key

#### Scenario: Chat never asks for a key
- **WHEN** an OpenCode conversation runs in a workspace with no provider logged in
- **THEN** the chat directs the user to Agent accounts and offers no field for a provider key

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
- **WHEN** a probe receives an HTTP response and no subsequent probe reports a well-formed ready body of either generation before the health budget elapses
- **THEN** Chat reports an unavailable state attributed to the health phase
- **AND** the reported message identifies the probed endpoint and the last status observed

#### Scenario: An answering-but-unhealthy server fails on the short budget
- **WHEN** OpenCode answers the first probe immediately and then answers every probe with a non-ready response
- **THEN** Chat reports unavailable after the health budget rather than after the full startup budget

#### Scenario: A 1.x server is recognized
- **WHEN** the spawned server answers the health resource with a healthy body carrying its version
- **THEN** Chat becomes ready as a 1.x server and reports that version

#### Scenario: A 2.x server is recognized
- **WHEN** the spawned server answers the server-information resource with a body carrying its version
- **THEN** Chat becomes ready as a 2.x server and reports that version in the same form a 1.x version takes

#### Scenario: A 2.x server's page on the 1.x path is not health
- **WHEN** the spawned server answers the 1.x health resource with a successful status and a body that is not a health body
- **THEN** that answer counts as answering but not as ready
- **AND** the same cycle's server-information probe can still make Chat ready

#### Scenario: Readiness does not depend on emitted text
- **WHEN** OpenCode becomes ready at the probed endpoint but writes nothing recognizable to its standard output
- **THEN** Chat becomes ready

#### Scenario: A single unanswered probe does not exhaust the budget
- **WHEN** a probe connects to the endpoint and the connection is accepted but never answered
- **THEN** that probe is abandoned before the budget elapses
- **AND** further probes are attempted while the budget remains
