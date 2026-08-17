## MODIFIED Requirements

### Requirement: Chat uses the workspace's OpenCode installation and identity
When chat is first needed in a running workspace, UatuCode SHALL discover the `opencode` executable available to that workspace process and start a loopback-only OpenCode service whose lifetime is owned by the workspace server. The service SHALL use OpenCode's existing user configuration and authentication; UatuCode MUST NOT request, copy, persist, or transmit provider API keys. If OpenCode is unavailable, cannot start, or is not authenticated, the workspace and all non-chat capabilities SHALL remain usable and the Chat surface SHALL report an actionable unavailable state.

Startup SHALL be observed as two separately bounded phases, distinguished by whether OpenCode has answered at the protocol level rather than by any text it emits. Until a probe receives an HTTP response, the generous bind budget applies; from the first HTTP response onward, a shorter health budget applies. A startup that fails SHALL be attributed to the phase that failed: if no probe ever received an HTTP response, the failure SHALL report that OpenCode never accepted a health request at the probed endpoint; if any probe did, the failure SHALL report that OpenCode answered but never became healthy, naming the endpoint and the last status observed. A health probe SHALL be individually bounded so that a connection which is accepted but never answered does not consume the whole budget.

UatuCode MUST NOT depend on the format of any text OpenCode writes to its standard output or standard error in order to determine readiness. Such output MAY be captured as diagnostic evidence, but a change to its format MUST NOT affect whether Chat becomes ready.

#### Scenario: Existing OpenCode authentication is reused
- **WHEN** the workspace user has already authenticated OpenCode and opens Chat
- **THEN** UatuCode connects using that existing OpenCode identity without asking for a provider API key

#### Scenario: OpenCode is not installed
- **WHEN** the workspace cannot resolve an OpenCode executable
- **THEN** Chat explains that OpenCode must be installed and authenticated
- **AND** document preview, search, and terminal capabilities continue working

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

## ADDED Requirements

### Requirement: A failed Chat startup reports actionable diagnostics
When Chat becomes unavailable because OpenCode could not be started or could not become healthy, the reported unavailable state SHALL carry the evidence needed to diagnose the failure from the report alone, without asking the user to reproduce it. That evidence SHALL include the resolved `opencode` executable path, any other executables of that name that were passed over on the search path, the OpenCode version when it could be determined, the endpoint that was probed, the elapsed time and number of probes attempted, the concrete outcome of the last probe, and bounded captures of OpenCode's standard output and standard error.

The diagnostics MUST NOT contain the ephemeral OpenCode server password, in any field or capture, in any encoding. Captures SHALL be bounded so a verbose or looping OpenCode cannot grow the workspace process's memory without limit.

#### Scenario: A timed-out startup names its own evidence
- **WHEN** OpenCode fails to become ready and Chat reports unavailable
- **THEN** the reported state includes the resolved executable path, the probed endpoint, the elapsed time, and the last probe's concrete outcome
- **AND** a user can attach that report to a bug report without running any further commands

#### Scenario: The last probe outcome distinguishes failure kinds
- **WHEN** the last health probe failed
- **THEN** the reported outcome distinguishes a refused connection from an abandoned unanswered connection from an HTTP status response from a malformed or unhealthy body
- **AND** an HTTP status response reports the status code

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

### Requirement: The Chat startup budget is operator-overridable
The workspace SHALL accept an environment variable `UATU_OPENCODE_STARTUP_TIMEOUT_MS` that overrides the default Chat startup budget for that workspace process. An absent, empty, non-numeric, or non-positive value SHALL leave the default in effect rather than failing workspace startup, because Chat is not required for the workspace to be usable. The default budget SHALL be generous enough to tolerate a cold OpenCode start on a slow filesystem.

#### Scenario: An operator widens the budget without a new build
- **WHEN** a workspace process runs with `UATU_OPENCODE_STARTUP_TIMEOUT_MS` set to a larger value than the default
- **THEN** Chat startup waits up to that value before reporting unavailable

#### Scenario: The override reaches a hub-hosted workspace
- **WHEN** the hub runs with `UATU_OPENCODE_STARTUP_TIMEOUT_MS` set and starts a session for a workspace
- **THEN** that session's Chat startup uses the overridden budget

#### Scenario: An invalid override is ignored
- **WHEN** a workspace process runs with `UATU_OPENCODE_STARTUP_TIMEOUT_MS` set to an empty, non-numeric, or non-positive value
- **THEN** the default budget is used
- **AND** the workspace starts normally

### Requirement: A failed Chat startup can be retried without restarting the workspace
A Chat startup failure SHALL NOT be permanent for the life of the workspace process. The Chat surface SHALL offer a user-initiated retry whenever it is unavailable for a startup reason, and that retry SHALL discard the cached failure and attempt startup again. Retry SHALL be user-initiated rather than automatic, so that a slow start is not multiplied by unattended attempts. A retry already in flight SHALL NOT start a second concurrent OpenCode process.

#### Scenario: A user recovers after fixing their environment
- **WHEN** Chat is unavailable because OpenCode failed to start, the user corrects the cause, and the user triggers retry
- **THEN** Chat attempts startup again and becomes ready without the workspace being restarted

#### Scenario: A retry that fails reports fresh diagnostics
- **WHEN** a user triggers retry and startup fails again
- **THEN** Chat reports the unavailable state with diagnostics from the new attempt, not the previous one

#### Scenario: Retry is not offered when OpenCode is absent
- **WHEN** Chat is unavailable because no `opencode` executable could be resolved
- **THEN** the surface explains that OpenCode must be installed rather than presenting retry as the remedy

#### Scenario: Concurrent retries are joined
- **WHEN** a retry is in flight and another retry is triggered
- **THEN** the second retry joins the in-flight attempt
- **AND** only one OpenCode process is started
