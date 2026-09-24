## ADDED Requirements

### Requirement: Chat serves whichever OpenCode generation the workspace has installed
UatuCode SHALL converse through an OpenCode 1.x server and through an OpenCode 2.x server with the same Chat surface, the same agent identity, and the same conversation operations. The generation is a property of the spawned server, decided by its readiness answer, and SHALL be fixed for that server's lifetime; a later start — a retry, a restart after an unexpected exit — SHALL decide again, so a binary replaced on disk is served by the matching generation without a workspace restart. Conversation identifiers, capability declarations, and the chat routes SHALL NOT change form between generations; a capability the running generation cannot back SHALL be left undeclared rather than declared and broken.

Normalization SHALL recognize each generation's event vocabulary — 1.x's cumulative and incremental announcements and 2.x's typed session events — and produce the same ordered conversation events for the same activity: text and reasoning, tool lifecycle, shell commands, permission requests and replies, structured questions and their answers, compaction, staged and committed reverts, usage, turn status, cancellation, completion, and errors. A 2.x structured form SHALL be presented as a structured question: each field becomes one question, a field with options offers those options, a field allowing custom input offers a free-form answer, and answering or rejecting it sends exactly one reply to the form OpenCode is waiting on. Loading a conversation SHALL reconcile pending requests against the running generation's own pending sets — permission requests and forms on 2.x — so a request announced while the stream was interrupted is still answerable.

Every call to a 2.x server SHALL be scoped to the workspace directory, and events for another directory served by the same server MUST NOT reach the workspace's conversations.

#### Scenario: A 2.x workspace holds a conversation
- **WHEN** the workspace's `opencode` is a 2.x binary and the user creates a conversation, sends a prompt, and the agent runs a tool and answers
- **THEN** Chat becomes ready, the conversation streams the answer with its tool activity, and history reloads the same timeline

#### Scenario: A 1.x workspace is unchanged
- **WHEN** the workspace's `opencode` is a 1.x binary
- **THEN** Chat behaves as before this change, with the same declared capabilities

#### Scenario: A replaced binary is served by its own generation
- **WHEN** a 1.x server was running, exits, and the next start finds a 2.x binary on the search path
- **THEN** the restarted service is served as 2.x without restarting the workspace
- **AND** the reported version is the 2.x version

#### Scenario: A 2.x form is answered as a structured question
- **WHEN** a 2.x agent raises a form with a single-choice field, a multiple-choice field, and a free-text field
- **THEN** the conversation shows one structured question per field with the choices OpenCode supplied
- **AND** submitting the answers replies to the form once, and the agent continues

#### Scenario: A 2.x form is rejected
- **WHEN** the user rejects a structured question raised as a 2.x form
- **THEN** OpenCode's form is cancelled once and the request records its outcome

#### Scenario: A 2.x permission is approved persistently
- **WHEN** a 2.x agent asks permission with saved patterns and the user chooses persistent approval
- **THEN** the confirmation lists the patterns OpenCode supplied for that request
- **AND** confirming sends OpenCode's persistent reply once

#### Scenario: A 2.x request missed by the stream is recovered on load
- **WHEN** a 2.x server raised a permission request or a form while the event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered

#### Scenario: Another directory's activity on a 2.x server stays out
- **WHEN** a 2.x server announces events for a session in a directory other than the workspace's
- **THEN** no conversation in the workspace changes

#### Scenario: A 2.x event the server does not handle is counted, not fatal
- **WHEN** a 2.x server emits an event type normalization does not handle
- **THEN** the event is skipped and counted by type, and later events are delivered

## MODIFIED Requirements

### Requirement: Chat uses the workspace's OpenCode installation and identity
When an OpenCode conversation is first needed in a running workspace, UatuCode SHALL discover the `opencode` executable available to that workspace process and start a loopback-only OpenCode service whose lifetime is owned by the workspace server. Opening Chat, or conversing with another agent, MUST NOT by itself start the OpenCode service. The service SHALL use OpenCode's existing user configuration and authentication; UatuCode MUST NOT request, copy, persist, or transmit provider API keys. If OpenCode is unavailable, cannot start, or is not authenticated, the workspace, all non-chat capabilities, and conversations with other agents SHALL remain usable and the Chat surface SHALL report an actionable unavailable state attributed to OpenCode.

Startup SHALL be observed as two separately bounded phases, distinguished by whether OpenCode has answered at the protocol level rather than by any text it emits. Until a probe receives an HTTP response, the generous bind budget applies; from the first HTTP response onward, a shorter health budget applies. A startup that fails SHALL be attributed to the phase that failed: if no probe ever received an HTTP response, the failure SHALL report that OpenCode never accepted a health request at the probed endpoint; if any probe did, the failure SHALL report that OpenCode answered but never became healthy, naming the endpoint and the last status observed. A health probe SHALL be individually bounded so that a connection which is accepted but never answered does not consume the whole budget.

Readiness SHALL be decided by either OpenCode generation's contract: a 1.x server is ready when its health resource answers with a well-formed health body that says it is healthy; a 2.x server is ready when its server-information resource answers with a well-formed body carrying its version. Each probe cycle SHALL ask both, and the first well-formed answer decides the generation for that server's lifetime. An answer that is not a well-formed body of either contract — in particular the page a 2.x server returns for any unknown path — MUST NOT be accepted as ready, whatever its status. The version reported for a ready server SHALL be the server's version alone, in the same form for both generations, so the generation is legible from it.

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

### Requirement: A failed Chat startup reports actionable diagnostics
When Chat becomes unavailable because OpenCode could not be started or could not become healthy, the reported unavailable state SHALL carry the evidence needed to diagnose the failure from the report alone, without asking the user to reproduce it. That evidence SHALL include the resolved `opencode` executable path, any other executables of that name that were passed over on the search path, the OpenCode version when it could be determined, the endpoint that was probed, the elapsed time and number of probes attempted, the concrete outcome of the last probe on each generation's readiness resource, and bounded captures of OpenCode's standard output and standard error. When the failure is that OpenCode answered but never became ready, the report SHALL name both readiness resources and what each last answered, so a server of one generation behind a probe that only understood the other is diagnosable from the report.

The diagnostics MUST NOT contain the ephemeral OpenCode server password, in any field or capture, in any encoding. Captures SHALL be bounded so a verbose or looping OpenCode cannot grow the workspace process's memory without limit.

#### Scenario: A timed-out startup names its own evidence
- **WHEN** OpenCode fails to become ready and Chat reports unavailable
- **THEN** the reported state includes the resolved executable path, the probed endpoint, the elapsed time, and the last probe's concrete outcome
- **AND** a user can attach that report to a bug report without running any further commands

#### Scenario: The last probe outcome distinguishes failure kinds
- **WHEN** the last health probe failed
- **THEN** the reported outcome distinguishes a refused connection from an abandoned unanswered connection from an HTTP status response from a malformed or unhealthy body
- **AND** an HTTP status response reports the status code

#### Scenario: Both readiness resources are accounted for
- **WHEN** OpenCode answered but never became ready
- **THEN** the report states the last outcome of the 1.x health probe and the last outcome of the 2.x server-information probe separately

#### Scenario: An unrecognized probe failure is not misattributed
- **WHEN** a probe fails in a way that matches none of the known outcome kinds
- **THEN** the outcome is recorded as unknown along with the underlying error
- **AND** it is not counted as a refused connection

#### Scenario: Shadowed executables on the search path are reported
- **WHEN** more than one `opencode` executable is present on the workspace process's search path
- **THEN** the diagnostics report the one that was chosen and the ones that were passed over

#### Scenario: The server password never appears in diagnostics
- **WHEN** any unavailable state carrying diagnostics is produced
- **THEN** no field or capture contains the ephemeral OpenCode server password

#### Scenario: Captured output is bounded
- **WHEN** OpenCode writes more output than the capture limit before failing
- **THEN** the diagnostics retain a bounded portion of that output rather than all of it
