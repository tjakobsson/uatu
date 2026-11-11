# opencode-chat Specification

## Purpose
Define workspace-scoped OpenCode conversations and the responsive web chat surface through which authenticated users can inspect, direct, interrupt, and resume coding-agent work.

## Requirements

### Requirement: Chat uses the workspace's OpenCode installation and identity

UatuCode SHALL start a workspace-owned loopback OpenCode service only for an OpenCode conversation, reusing workspace installation/configuration/authentication. Chat MUST NOT request provider credentials; UatuCode SHALL accept them only through Hub Agent accounts to OpenCode login and MUST NOT copy, persist, log or return them. Readiness SHALL use bounded protocol probes, not emitted text. OpenCode failure MUST NOT disable the workspace or other agents and SHALL yield actionable guidance.

#### Scenario: The workspace first needs an OpenCode conversation, or OpenCode is unavailable or unauthenticated
- **WHEN** the workspace first needs an OpenCode conversation, or OpenCode is unavailable or unauthenticated
- **THEN** When an OpenCode conversation is first needed in a running workspace, UatuCode SHALL discover the `opencode` executable available to that workspace process and start a loopback-only OpenCode service whose lifetime is owned by the workspace server.
- **AND** Opening Chat, or conversing with another agent, MUST NOT by itself start the OpenCode service.
- **AND** The service SHALL use OpenCode's existing user configuration and authentication.
- **AND** A workspace's chat MUST NOT request provider API keys or other provider credentials.
- **AND** UatuCode SHALL accept a provider credential only through the Hub's Agent accounts area, which hands it to OpenCode's own login interface; UatuCode MUST NOT copy, persist, log, or return it.
- **AND** If OpenCode is unavailable, cannot start, or is not authenticated, the workspace, all non-chat capabilities, and conversations with other agents SHALL remain usable and the Chat surface SHALL report an actionable unavailable state attributed to OpenCode.

#### Scenario: The spawned OpenCode service is being probed before and after its first HTTP response
- **WHEN** the spawned OpenCode service is being probed before and after its first HTTP response
- **THEN** Startup SHALL be observed as two separately bounded phases, distinguished by whether OpenCode has answered at the protocol level rather than by any text it emits.
- **AND** Until a probe receives an HTTP response, the generous bind budget applies; from the first HTTP response onward, a shorter health budget applies.
- **AND** A startup that fails SHALL be attributed to the phase that failed: if no probe ever received an HTTP response, the failure SHALL report that OpenCode never accepted a health request at the probed endpoint; if any probe did, the failure SHALL report that OpenCode answered but never became healthy, naming the endpoint and the last status observed.
- **AND** A health probe SHALL be individually bounded so that a connection which is accepted but never answered does not consume the whole budget.

#### Scenario: A probe cycle receives a readiness response from an OpenCode 1.x or 2.x server
- **WHEN** a probe cycle receives a readiness response from an OpenCode 1.x or 2.x server
- **THEN** Readiness SHALL be decided by either OpenCode generation's contract: a 1.x server is ready when its health resource answers with a well-formed health body that says it is healthy; a 2.x server is ready when its server-information resource answers with a well-formed body carrying its version.
- **AND** Each probe cycle SHALL ask both, and the first well-formed answer decides the generation for that server's lifetime.
- **AND** An answer that is not a well-formed body of either contract — in particular the page a 2.x server returns for any unknown path — MUST NOT be accepted as ready, whatever its status.
- **AND** The version reported for a ready server SHALL be the server's version alone, in the same form for both generations, so the generation is legible from it.

#### Scenario: OpenCode writes diagnostic output during startup
- **WHEN** OpenCode writes diagnostic output during startup
- **THEN** UatuCode MUST NOT depend on the format of any text OpenCode writes to its standard output or standard error in order to determine readiness.
- **AND** Such output MAY be captured as diagnostic evidence, but a change to its format MUST NOT affect whether Chat becomes ready.

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

### Requirement: A failed Chat startup reports actionable diagnostics

A failed OpenCode startup SHALL report actionable, bounded diagnostics sufficient to diagnose it without reproduction. Diagnostics MUST NOT disclose the ephemeral server password in any encoding.

#### Scenario: OpenCode cannot start or cannot become healthy and Chat reports unavailable
- **WHEN** OpenCode cannot start or cannot become healthy and Chat reports unavailable
- **THEN** When Chat becomes unavailable because OpenCode could not be started or could not become healthy, the reported unavailable state SHALL carry the evidence needed to diagnose the failure from the report alone, without asking the user to reproduce it.
- **AND** That evidence SHALL include the resolved `opencode` executable path, any other executables of that name that were passed over on the search path, the OpenCode version when it could be determined, the endpoint that was probed, the elapsed time and number of probes attempted, the concrete outcome of the last probe on each generation's readiness resource, and bounded captures of OpenCode's standard output and standard error.
- **AND** When the failure is that OpenCode answered but never became ready, the report SHALL name both readiness resources and what each last answered, so a server of one generation behind a probe that only understood the other is diagnosable from the report.

#### Scenario: Startup diagnostics capture fields and service output
- **WHEN** startup diagnostics capture fields and service output
- **THEN** The diagnostics MUST NOT contain the ephemeral OpenCode server password, in any field or capture, in any encoding.
- **AND** Captures SHALL be bounded so a verbose or looping OpenCode cannot grow the workspace process's memory without limit.

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

#### Scenario: Installation guidance leads when OpenCode is absent
- **WHEN** Chat is unavailable because no `opencode` executable could be resolved
- **THEN** the surface leads with the instruction to install OpenCode rather than presenting retry as the remedy
- **AND** retry remains available as a secondary action, because the workspace caches the unavailable state and a completed installation must be discoverable without restarting the workspace

#### Scenario: Concurrent retries are joined
- **WHEN** a retry is in flight and another retry is triggered
- **THEN** the second retry joins the in-flight attempt
- **AND** only one OpenCode process is started

### Requirement: Every conversation is confined to the server-selected workspace directory

The chat backend SHALL select the workspace's canonical first watch root for OpenCode discovery, creation, history, prompts and tools. Browser requests MUST NOT provide or override a filesystem working directory. Before exposing or resuming a session, UatuCode SHALL verify its canonical directory matches; foreign-directory sessions MUST NOT be exposed, resumed or mutated through that workspace.

#### Scenario: A browser requests conversation discovery, creation, history, prompts, tools, or resumption
- **WHEN** a browser requests conversation discovery, creation, history, prompts, tools, or resumption
- **THEN** The chat backend SHALL select the workspace's canonical first watch root as the OpenCode working directory and SHALL use that directory for conversation discovery, creation, history, prompts, and tools.
- **AND** Browser requests MUST NOT provide or override a filesystem working directory.
- **AND** Before exposing or resuming an OpenCode session, UatuCode SHALL verify that the session's canonical directory matches the selected workspace directory; a session belonging to another directory MUST NOT be exposed, resumed, or mutated through that workspace.

#### Scenario: Hub workspace fixes the working directory
- **WHEN** a user opens Chat under `/s/project-a/`
- **THEN** every newly created OpenCode conversation runs in the canonical registered path for `project-a`
- **AND** no request field can redirect it to another folder

#### Scenario: Multi-root direct serve has a deterministic chat root
- **WHEN** a direct UatuCode workspace watches more than one root
- **THEN** Chat uses the canonical first watch root, matching the embedded terminal's working-directory rule

#### Scenario: Foreign session identifier is rejected
- **WHEN** a client supplies an OpenCode session identifier whose canonical directory belongs to another workspace
- **THEN** the server rejects the operation without revealing that conversation's content or metadata

### Requirement: Users can discover, create, resume, and inspect workspace conversations

The authenticated workspace API SHALL discover, create, and paginate resumable workspace conversations while preserving OpenCode ownership of identity and durable history across restarts.

#### Scenario: An authenticated client discovers, creates, or reads workspace conversations, including after a restart
- **WHEN** an authenticated client discovers, creates, or reads workspace conversations, including after a restart
- **THEN** The authenticated workspace API SHALL list resumable OpenCode conversations associated with the selected workspace directory, create a new conversation, and return paginated normalized history for a selected conversation.
- **AND** Conversation identity and durable provider history SHALL remain owned by OpenCode; UatuCode SHALL retain only the provider identifiers and presentation state needed to reconnect and render them.
- **AND** Restarting UatuCode or its workspace-scoped OpenCode service MUST NOT by itself erase completed conversation history.

#### Scenario: Existing workspace conversation appears after restart
- **WHEN** an OpenCode conversation has completed turns in a workspace and the UatuCode workspace restarts
- **THEN** the conversation appears in the Chat inventory and can be resumed with its prior history

#### Scenario: New conversation starts empty
- **WHEN** the user creates a conversation from Chat
- **THEN** OpenCode creates it in the selected workspace directory
- **AND** the client receives its server-issued identity and an empty initial timeline

#### Scenario: Older history is paginated
- **WHEN** a conversation has more history than the initial page limit
- **THEN** the client can request older items with an opaque server-issued cursor
- **AND** items are not duplicated or reordered across adjacent pages

### Requirement: Conversation configuration follows the conversation

The Chat API SHALL expose effective model, mode and reasoning variant when determinable by the agent. Known configuration SHALL follow the conversation across clients/restarts without browser-storage authority. Absent fields mean unknown/not explicitly selected; the surface MUST NOT invent first-option/default selections. Unstaged prompts SHALL preserve effective configuration. Clients MAY stage offered choices locally; acceptance SHALL publish shared effective state and update unstaged clients.

#### Scenario: Known configuration is exposed on any conversation read
- **WHEN** an authenticated client reads a conversation, including after a workspace restart or on another client
- **THEN** The normalized Chat API SHALL expose the effective model, mode, and reasoning variant of a conversation when the agent can determine them.
- **AND** This configuration SHALL be conversation state rather than physical client presentation state: opening the conversation from another authenticated client or after a workspace restart SHALL restore the same known configuration without relying on that client's browser storage.

#### Scenario: Absent configuration is displayed without inventing a selection
- **WHEN** the agent cannot report a conversation's effective model, mode or reasoning variant
- **THEN** that absent field is displayed as unknown or not explicitly selected, not replaced with the first option or a claimed default
- **WHEN** the user sends a prompt without staging that field
- **THEN** the prompt preserves the agent's effective configuration rather than switching it

#### Scenario: A client stages an offered configuration and the agent accepts its next prompt
- **WHEN** a client stages an offered configuration, submits it or receives agent acceptance
- **THEN** A client MAY stage a different offered model, mode, or variant for its next prompt without changing another client.
- **AND** Once the agent accepts that prompt, the accepted configuration SHALL become the conversation's shared effective state and SHALL be published to subscribed clients.
- **AND** A client with no unsubmitted local selection SHALL update its controls from that publication; an explicitly staged selection remains local until submitted or discarded.

#### Scenario: Another device restores an existing conversation
- **WHEN** a user opens on a second device a conversation that previously accepted a prompt with a known model, mode, and reasoning variant
- **THEN** Chat displays that known configuration on the second device
- **AND** the second device does not derive the conversation's configuration from its own browser defaults

#### Scenario: Restart recovers provider-owned configuration
- **WHEN** the workspace restarts and a persisted conversation is opened again
- **THEN** Chat recovers every configuration field the agent persisted with that conversation
- **AND** a missing field is presented as unknown or agent-controlled rather than as a selected option

#### Scenario: Unknown configuration does not switch the conversation
- **WHEN** an existing conversation has no recoverable model or mode and the user sends a prompt without choosing one
- **THEN** the request omits that selection
- **AND** Chat does not switch the conversation to the first option listed by the current device

#### Scenario: Accepted configuration reaches another open client
- **WHEN** one client submits and the agent accepts a prompt with a different model, mode, or reasoning variant
- **THEN** that configuration becomes the conversation's effective configuration
- **AND** another subscribed client with no staged selection updates its controls without reopening the conversation

#### Scenario: An unsubmitted choice remains local
- **WHEN** one client selects a different offered model, mode, or variant but has not submitted a prompt
- **THEN** the conversation's shared effective configuration is unchanged
- **AND** another client neither displays nor applies the unsubmitted choice

#### Scenario: Stale browser configuration is not authoritative
- **WHEN** browser storage contains a per-conversation selection that disagrees with the configuration recovered from the agent
- **THEN** the recovered conversation configuration wins
- **AND** the stale browser value is not sent implicitly with the next prompt

### Requirement: Users can rename resumable conversations

Where supported, users SHALL be able to rename a workspace conversation without changing its identity, history, active turn, or configuration. Renames SHALL be protected and idempotent, propagate to clients, and survive automatic title generation.

#### Scenario: An authenticated client renames the selected conversation on an agent that declares renaming
- **WHEN** an authenticated client renames the selected conversation on an agent that declares renaming
- **THEN** Where the agent declares conversation renaming, the authenticated workspace API SHALL let a user replace a workspace conversation's title with a non-empty bounded title, and the Chat surface SHALL provide a rename affordance for the selected conversation.
- **AND** Renaming SHALL preserve the conversation identity, history, active turn, and effective configuration.
- **AND** The mutation SHALL be origin-protected under cookie authentication, workspace-confined, and idempotent under a client-generated request identifier.

#### Scenario: A rename succeeds, renaming is unsupported, or automatic first-prompt naming runs
- **WHEN** a rename succeeds, renaming is unsupported, or automatic first-prompt naming runs
- **THEN** A successful rename SHALL update the conversation inventory and every subscribed client that displays that conversation.
- **AND** Where the agent does not declare renaming, the affordance SHALL be absent rather than inert.
- **AND** Automatic first-prompt title generation MAY still name a conversation that the user has not manually renamed, but SHALL NOT overwrite a user-supplied title.

#### Scenario: Rename persists across clients and restart
- **WHEN** a user renames a conversation and later opens it from another client or after a workspace restart
- **THEN** the new title is displayed for the same conversation
- **AND** its prior history and effective configuration remain intact

#### Scenario: Rename updates another open client
- **WHEN** one client successfully renames a conversation while another client is subscribed to it
- **THEN** the subscribed client updates the displayed title without reopening the conversation

#### Scenario: Invalid rename changes nothing
- **WHEN** a rename supplies an empty, oversized, foreign-workspace, cross-origin, or otherwise invalid request
- **THEN** the workspace rejects it without changing the persisted title

#### Scenario: Retried rename is applied once
- **WHEN** a client retries a rename with the same request identifier after losing the response
- **THEN** the workspace returns the original result or current outcome
- **AND** the agent receives the rename at most once

#### Scenario: Unsupported rename has no control
- **WHEN** the current agent does not declare conversation renaming
- **THEN** Chat shows no rename affordance
- **AND** conversation discovery and prompting remain available

### Requirement: Conversation creation is named unambiguously
The Chat action that creates another conversation with the current workspace agent SHALL be labelled `New conversation`. It MUST NOT be labelled `New agent`, because changing or adding the program Chat talks to is a separate operation.

#### Scenario: Creation control names what it creates
- **WHEN** Chat presents the action for creating an empty resumable conversation
- **THEN** the action is labelled `New conversation`
- **AND** activating it does not change the workspace agent

### Requirement: The workspace API exposes normalized chat operations

The workspace API SHALL expose normalized, authenticated, workspace-confined chat operations with idempotent mutations, explicit agent capabilities, and pending-message state. It SHALL distinguish agents from modes and preserve the API31 unconfirmed-admission discard contract.

#### Scenario: A client reads conversations or mutates prompts, pending messages, turns, permissions, or questions
- **WHEN** a client reads conversations or mutates prompts, pending messages, turns, permissions, or questions
- **THEN** The workspace API SHALL provide authenticated operations to list, create, and read conversations; start a prompt turn; remove a queued message; change a pending message's delivery; send a pending message now; cancel the active turn; answer a pending permission; and answer or reject a structured question.
- **AND** Mutation requests SHALL be origin-protected under cookie authentication, SHALL validate conversation ownership against the workspace directory, and SHALL use client-generated request identifiers to make network retries idempotent.
- **AND** Provider-specific payloads and credentials MUST NOT be exposed as the public contract when a normalized UatuCode representation exists.

#### Scenario: A prompt specifies steer, queue, or no delivery, or a client reads a running conversation
- **WHEN** a prompt specifies steer, queue, or no delivery, or a client reads a running conversation
- **THEN** A prompt MAY name its delivery, steer or queue.
- **AND** A prompt that names steer SHALL be accepted as a steer only when the owning agent declares the `steering` capability, the conversation is running, and the text is not a command.
- **AND** Otherwise it SHALL be handled as a queued prompt.
- **AND** A prompt that names no delivery SHALL be handled as a queued prompt.
- **AND** A prompt accepted while the conversation is running SHALL be reported as pending, identifying the message and its delivery so that a client can later remove it or change its delivery.
- **AND** Conversation reads SHALL include the currently pending messages in delivery order, each with its delivery and whether it is paused.
- **AND** A client that joins or reloads mid-run therefore presents the same dock as a client that watched it build.

#### Scenario: A client requests workspace agents, capabilities, or agent-scoped catalogs
- **WHEN** a client requests workspace agents, capabilities, or agent-scoped catalogs
- **THEN** The API SHALL report every agent a workspace's Chat offers, and which capabilities each agent declares.
- **AND** A capability is declared only when the agent actually supports it; the absence of a declaration SHALL be a normal, expected state rather than an error or an empty result.
- **AND** Consumers SHALL be able to decide what to present from an agent's declaration alone, without probing an operation to discover whether it works.
- **AND** Agent-scoped catalog reads — models, modes, commands — SHALL identify which agent they describe.

#### Scenario: A client identifies programs and ways of working through the route table
- **WHEN** a client identifies programs and ways of working through the route table
- **THEN** The API SHALL name a way of working a **mode**, and SHALL name the program Chat talks to an **agent**.
- **AND** These two SHALL NOT share a name in the route table, because they are not the same thing and a reader cannot tell them apart from the route alone.

#### Scenario: An API31 client reads admission uncertainty or requests discard-unconfirmed
- **WHEN** an API31 client reads admission uncertainty or requests discard-unconfirmed
- **THEN** Workspace API31 SHALL expose the optional server-owned `QueuedMessage.admissionUncertaintyId` and the strict `POST /api/chat/conversations/:conversationId/queue/:messageId/discard-unconfirmed` body `{requestId, uncertaintyId}`.
- **AND** The acknowledgement SHALL be `{discarded: true, outcomeUnconfirmed: true}`.
- **AND** The route SHALL retain existing authentication, workspace/conversation ownership, cookie-origin and caller-scoped request-identity protections.
- **AND** Local discard SHALL reuse queue change `removed` only to describe local-record removal, never native cancellation.
- **AND** Hub API11 and bundled web revision3 SHALL remain unchanged by this contract revision.

#### Scenario: Retried prompt does not run twice
- **WHEN** a client retries a prompt mutation with the same request identifier after losing the response
- **THEN** the server returns the original accepted result or current outcome
- **AND** the owning agent receives the prompt at most once

#### Scenario: Retried removal is applied once
- **WHEN** a client retries a queued-message removal with the same request identifier after losing the response
- **THEN** the server reports the original outcome
- **AND** at most one held message is removed

#### Scenario: A reload shows the queue as it stands
- **WHEN** a client loads a conversation snapshot while messages are pending
- **THEN** the response identifies the pending messages in delivery order, each with its delivery and paused state
- **AND** the client can present, remove, and switch them without having observed their submission

#### Scenario: Retried delivery change is applied once
- **WHEN** a client retries a change of a pending message's delivery, or a send-now, with the same request identifier after losing the response
- **THEN** the server reports the original outcome
- **AND** the message is delivered to the agent at most once

#### Scenario: A steer request to an agent without steering is queued
- **WHEN** a client submits a prompt naming steer delivery to a conversation whose agent does not declare `steering`
- **THEN** the prompt is handled as a queued prompt
- **AND** nothing is delivered to the agent mid-turn

#### Scenario: Cross-origin mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to prompt, remove a queued message, change a pending message's delivery, send a pending message now, cancel, or answer an agent request
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

### Requirement: Conversation updates are structured and reconnectable

Conversation activity and pending-message changes SHALL produce ordered normalized events with replayable snapshot cursors. Duplicate announcements MUST NOT duplicate timeline entries, and unknown or malformed events SHALL be skipped and counted without disrupting the stream.

#### Scenario: OpenCode announces conversation activity under either event-naming generation
- **WHEN** OpenCode announces conversation activity under either event-naming generation
- **THEN** The server SHALL normalize OpenCode activity into ordered conversation events covering user and assistant content, reasoning, tool lifecycle, permission requests and resolutions, structured questions and resolutions, context compaction, reverted work, turn status, cancellation, completion, warnings, and errors.
- **AND** Normalization SHALL recognize each of these regardless of which of OpenCode's event-naming generations announced it, and when one logical occurrence is announced more than once the timeline SHALL contain a single entry for it.

#### Scenario: A pending message is held, steered, removed, switched, paused, resumed, or delivered
- **WHEN** a pending message is held, steered, removed, switched, paused, resumed, or delivered
- **THEN** Changes to a conversation's pending messages SHALL be announced on the same ordered event stream, so every connected client presents the same dock at the same point in the conversation.
- **AND** Those changes are: a message held, a message accepted as a steer, a message removed, a message's delivery changed, a message paused or resumed, and a message delivered to the agent.

#### Scenario: The server receives an unknown event or an unparseable payload
- **WHEN** the server receives an unknown event or an unparseable payload
- **THEN** An event the server does not recognize, or whose payload it cannot parse, SHALL be skipped without ending or restarting the event stream, and SHALL be counted by type so an operator can discover what a running workspace is discarding.
- **AND** Counting MUST NOT record event payloads.

#### Scenario: A client applies a history snapshot and reconnects from its stream cursor
- **WHEN** a client applies a history snapshot and reconnects from its stream cursor
- **THEN** A history snapshot SHALL identify a stream cursor; reconnecting from a retained cursor SHALL replay every later event in order before delivering live events.
- **AND** If the cursor is no longer replayable or belongs to an earlier server generation, the server SHALL explicitly require a fresh snapshot.
- **AND** Applying a snapshot followed by its event stream MUST NOT duplicate message content or tool entries.

#### Scenario: Stream reconnect replays missed output
- **WHEN** the event connection drops during an assistant response and reconnects with a retained cursor
- **THEN** every event after that cursor is replayed once in order before live output continues

#### Scenario: Queue changes reach every connected client
- **WHEN** a message is held, steered, removed, switched, paused, or delivered while more than one client watches the conversation
- **THEN** each client receives the change on the ordered event stream
- **AND** all clients present the same pending messages, deliveries, and paused states in the same order

#### Scenario: Stale cursor requests resynchronization
- **WHEN** a client reconnects with a cursor outside retained history or from an earlier workspace-server generation
- **THEN** the stream reports that a new snapshot is required rather than silently omitting events

#### Scenario: Cumulative and incremental provider updates do not duplicate text
- **WHEN** OpenCode reports overlapping cumulative part state and text deltas for one assistant part
- **THEN** the normalized timeline contains each text segment exactly once

#### Scenario: An interaction announced under either naming generation is recognized
- **WHEN** OpenCode announces a permission request or a structured question using either its current or its legacy event name
- **THEN** the request appears in the conversation that raised it and can be answered

#### Scenario: One occurrence announced twice yields one entry
- **WHEN** a single permission request or question reaches the server under both naming generations
- **THEN** the conversation shows one entry for it
- **AND** answering it sends exactly one response to OpenCode

#### Scenario: An unrecognized event does not end the stream
- **WHEN** OpenCode emits an event type the server does not handle
- **THEN** the event is skipped, the stream continues delivering later events, and the occurrence is counted by type

#### Scenario: An unparseable event costs one event, not the stream
- **WHEN** an event of a recognized type carries a payload the server cannot parse
- **THEN** only that event is dropped and counted
- **AND** subsequent events for that conversation are still delivered

#### Scenario: Discarded-event counts are observable
- **WHEN** an operator inspects the workspace's diagnostic counters after events were discarded
- **THEN** the counts are reported per event type
- **AND** no event payload is included

#### Scenario: A compacted conversation says so
- **WHEN** OpenCode compacts a conversation's context
- **THEN** the timeline records that compaction occurred rather than appearing to lose content without explanation

#### Scenario: Reverted work stops being presented as current
- **WHEN** OpenCode reports that work in a conversation was reverted
- **THEN** the timeline reflects the revert rather than continuing to present the reverted work as though it still applies

### Requirement: Chat presents turns as readable conversation with inspectable activity

Chat SHALL keep safe user and assistant content primary and tool activity inspectable. Running activity SHALL group behind a stable working line, retain streamed shell output and reader-opened state, and communicate progress and failures accessibly.

#### Scenario: A turn produces assistant content, tools, commands, searches, or file changes during execution or completion
- **WHEN** a turn produces assistant content, tools, commands, searches, or file changes during execution or completion
- **THEN** The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture.
- **AND** Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose.
- **AND** Every activity row SHALL name what it acted on where the agent reported it, including a shell command's command line, a file operation's path, and a search's pattern, so a row and any group summary it joins are legible without being opened.
- **AND** While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, and its elapsed time SHALL be shown where the agent reports progress without output, so long-running activity shows progress.
- **AND** A finished non-shell tool's output SHALL retain its summary and bounded preview with a way to see the rest.
- **AND** Shell tools and normalized command items SHALL instead present a summary and one bounded-height scrollback viewport containing all available provider-supplied output, while running and after completion.
- **AND** Earlier shell output SHALL be reachable by scrolling rather than a separate preview or "Show more lines" disclosure.
- **AND** A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state.
- **AND** Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

#### Scenario: A running turn accumulates activity, the reader opens its working line or output, and the turn settles
- **WHEN** a running turn awaits its first step or accumulates activity, the reader opens its working line or output, or the turn settles
- **THEN** While a turn is running, the trailing run of activity SHALL be collapsed behind a single working line rather than rendered as flat rows.
- **AND** Activity, for the working line and for finished groups, SHALL include file-change rows: a file change reported between two steps SHALL join the run around it rather than end it, and a file-change row SHALL count as a finished, clean member, never as the step in flight and never as a failed step.
- **AND** A group summary SHALL name a file-change row by its operation and path, after the steps the summary names, and the row itself SHALL state its operation in that same word — Created, Updated, Deleted — wherever it is shown.
- **AND** The line SHALL carry a live indicator, the elapsed time of the turn, and the step currently in flight, and SHALL be present from the moment the prompt is accepted, before any step has arrived, so the same line carries the turn from waiting to done.
- **AND** Opening the working line SHALL reveal its member rows with their live state, and a running member with output SHALL still open itself so its output viewport is visible.
- **AND** Shell output SHALL initially follow the bottom and respect subsequent reader scrolling.
- **AND** A working line the reader opened SHALL remain open when the turn finishes and the line settles into the finished group summary.
- **AND** Popping out or resizing shell output SHALL count as the reader opening both the output and its containing activity group.
- **AND** That output and group SHALL remain open on completion or failure.
- **AND** A group line SHALL carry a status indicator, live while its turn runs, neutral when every member finished cleanly, and failed when any member failed.
- **AND** A failed outcome MUST NOT rely on colour alone.
- **AND** The line SHALL also state in words that a step failed, in text that is visible and part of the line's accessible name, without the group being opened.
- **AND** The live indicator's motion SHALL honour the reader's reduced-motion preference.

#### Scenario: Assistant answer remains visually primary
- **WHEN** a turn contains assistant text interleaved with multiple tool calls
- **THEN** the answer reads as a coherent conversation
- **AND** tool activity can be expanded for detail without being mistaken for assistant prose

#### Scenario: A shell tool row names its command
- **WHEN** an agent runs a shell command through a tool that carries the command in its input
- **THEN** the row's subject is the command line
- **AND** a group that collapses several such rows still names the commands it contains

#### Scenario: Streaming tool lifecycle updates in place
- **WHEN** a tool moves from running to completed or failed
- **THEN** its existing activity entry updates state instead of adding a duplicate entry

#### Scenario: A running tool shows its output as it streams
- **WHEN** a tool is running and the agent streams its output
- **THEN** the surface shows that output as it arrives
- **AND** it updates the tool's existing entry in place

#### Scenario: A running tool without output shows elapsed time
- **WHEN** a tool has run for several seconds and the agent reports progress but no output
- **THEN** the row states the elapsed time
- **AND** the time updates in place

#### Scenario: A running shell command shows its output as it streams
- **WHEN** the agent reports rolling output for a running shell command
- **THEN** the command entry makes that output available without waiting for completion
- **AND** later output updates the same scrollback viewport, following the latest output only while its independent follow state is active

#### Scenario: A fast command retains its completed output
- **WHEN** a shell command completes before the client observes a running update
- **THEN** its completed output remains inspectable from the command entry
- **AND** the entry reports the provider's completed or failed outcome

#### Scenario: A finished tool's output is bounded with a way to see the rest
- **WHEN** a completed non-shell tool produced more output than the bounded preview shows
- **THEN** the entry shows a summary and a bounded preview
- **AND** offers a way to see the full output
- **AND** does not render the whole output by default

#### Scenario: A finished command's output is bounded with a way to see the rest
- **WHEN** a completed shell command produced more output than fits in its bounded-height viewport
- **THEN** the command entry retains one scrollback viewport
- **AND** all available provider-supplied output is reachable by scrolling without a separate preview or "Show more lines" disclosure

#### Scenario: Hostile content remains inert
- **WHEN** assistant Markdown or tool output contains script-capable markup or a JavaScript URL
- **THEN** the rendered conversation does not execute it or expose an active unsafe link

#### Scenario: The live tail collapses behind a working line
- **WHEN** a turn is running and the agent has produced several activity steps with no assistant text after them
- **THEN** those steps are not shown as flat rows
- **AND** one working line shows a live indicator, the turn's elapsed time, and the step in flight

#### Scenario: The working line stands in for the waiting state
- **WHEN** a prompt has been accepted and nothing has come back yet
- **THEN** the working line is already present with its live indicator and elapsed time
- **AND** the first step to arrive joins it rather than replacing it with a different element

#### Scenario: Opening the working line reveals live steps
- **WHEN** the reader opens the working line while the turn runs
- **THEN** the member rows are shown with their running, completed, or failed state
- **AND** a running member with streamed output is open so its output is visible

#### Scenario: An opened working line stays open when the turn finishes
- **WHEN** the reader opened the working line and the turn then completes
- **THEN** the line becomes the finished group summary naming its steps
- **AND** it remains open

#### Scenario: A finished group signals a failed step
- **WHEN** a finished group contains a step that failed
- **THEN** the group line's status indicator reads as failed without the group being opened
- **AND** the line states in words that a step failed, so the outcome is carried by something other than colour alone

#### Scenario: Reduced motion stills the live indicator
- **WHEN** the reader's system prefers reduced motion
- **THEN** the working line's live indicator does not animate

#### Scenario: Reader-sized output stays open when work finishes
- **WHEN** the reader resizes or pops out shell output and the command or containing turn then completes or fails
- **THEN** the output and its containing activity group remain reader-opened
- **AND** popped-out output remains open on the same item until the reader returns it inline, opens another item, switches conversations, closes its owning child transcript, or the item is removed or its view is disposed
- **AND** the provider-reported outcome remains visible without resetting the reading state


#### Scenario: A file-change row joins the run around it
- **WHEN** a finished turn reports a tool step, a file change for the path that step wrote, and two more tool steps, with no assistant text between them
- **THEN** those rows collapse behind one group line
- **AND** the line counts the file-change row among its steps

#### Scenario: A file-change row stays inside the working line
- **WHEN** a turn is running and the agent has reported a step, a file change, and a further running step
- **THEN** none of the three renders as a flat row
- **AND** the working line names the running step, not the file change

#### Scenario: A group summary names a file change by operation and path
- **WHEN** a finished group contains a file-change row for `src/foo.ts` reported as an update
- **THEN** the group line's summary names it as an update of `src/foo.ts`
- **AND** it does not take a place before the tool steps the summary names

#### Scenario: A file-change row says the same word as its summary
- **WHEN** a file-change row reported as an update is shown, inside a group or flat
- **THEN** the row reads "Updated" followed by the path
- **AND** the word is the one its group summary would count it under

#### Scenario: A file-change row alone does not make a group
- **WHEN** a finished turn reports a single file change between two assistant messages
- **THEN** the file-change row renders flat, as it did before
### Requirement: Shell output reads as the terminal would render it

Chat SHALL render terminal escapes safely using the embedded terminal palette and font. Shell tools and command items SHALL retain all available provider output as rendered scrollback, without wrapping tokens or discarding earlier output through a client preview limit.

Recovery of output truncated upstream by the provider is not required. Non-shell output SHALL retain its existing preview behavior.

#### Scenario: Tool output contains terminal styling, carriage-return overwrites, erase-line sequences, or other controls
- **WHEN** tool output contains terminal styling, carriage-return overwrites, erase-line sequences, or other controls
- **THEN** Where a tool's output carries terminal escape sequences, Chat SHALL interpret them rather than show them.
- **AND** Select-graphic-rendition styling, including the 16 standard colours, 256-colour and truecolour foreground and background, bold, dim, italic, underline, inverse, and strikethrough, SHALL be rendered as styling.
- **AND** Carriage-return overwrites and erase-line sequences SHALL be applied so a line that was rewritten in place shows only its final content, and any other control sequence SHALL be removed from the shown text.
- **AND** Interpreting escapes MUST NOT create active markup or script execution, whatever the sequences or the text around them contain.

#### Scenario: A shell output block displays styled text and lines wider than its viewport
- **WHEN** a shell output block is displayed, with or without styling or lines wider than its viewport
- **THEN** A shell command's output block SHALL be presented with the embedded terminal's background, foreground, 16-colour palette, and font, so the same bytes read the same in Chat and in the terminal pane.
- **AND** The palette SHALL be the one central set of terminal colour variables, not a second copy.
- **AND** Lines in a shell output block SHALL NOT be broken mid-token.
- **AND** A line longer than the block SHALL scroll horizontally, as it would in the terminal.

#### Scenario: Parent and child shell output remains inspectable during and after execution
- **WHEN** a shell tool or normalized command item in a parent or subagent conversation supplies output during its retained view lifetime, while running or after completion or failure
- **THEN** all available provider-supplied output remains reachable in its viewport without a client-side preview or tail limit discarding earlier output
- **AND** repeated progress-bar overwrites of one line count as one rendered scrollback line, not one line per overwrite

#### Scenario: Provider truncation does not discard the shell output that arrived
- **GIVEN** the provider truncated earlier output before supplying the remaining output to UatuCode
- **WHEN** that parent or subagent shell tool or normalized command item is inspected while running or after completion or failure within its retained view lifetime
- **THEN** all available provider-supplied output remains reachable by scrolling, without a further client preview or tail limit discarding it

#### Scenario: Non-shell output keeps its existing preview
- **WHEN** a non-shell tool supplies output, whether it fits or exceeds its existing preview
- **THEN** its existing preview behavior remains in use rather than being replaced by the shell scrollback presentation

#### Scenario: Coloured test output renders in colour
- **WHEN** a shell command's output contains `\x1b[32mpass\x1b[0m` and `\x1b[31mfail\x1b[0m`
- **THEN** the block shows "pass" in the terminal's green and "fail" in the terminal's red
- **AND** no bracket-code fragments appear in the text

#### Scenario: A progress bar collapses to its final state
- **WHEN** a running command rewrites one line repeatedly with carriage returns and erase-line sequences
- **THEN** the block shows that line once, with its latest content
- **AND** the scrollback's line count treats it as one line

#### Scenario: Unknown control sequences are dropped
- **WHEN** a command's output contains cursor-movement or operating-system-command sequences the renderer does not interpret
- **THEN** those sequences do not appear in the shown text
- **AND** the surrounding text is shown intact

#### Scenario: Escapes cannot smuggle markup
- **WHEN** a command's output interleaves escape sequences with `<script>` text or a JavaScript URL
- **THEN** the rendered block contains no active markup and executes nothing

#### Scenario: Shell output uses the terminal's palette and font
- **WHEN** the same coloured output is shown in Chat and typed into the embedded terminal
- **THEN** both use the same background, foreground, colour values and font family
- **AND** changing a terminal colour variable changes both

#### Scenario: Long lines scroll instead of wrapping
- **WHEN** a command prints a table wider than the output block
- **THEN** the columns stay aligned and the block scrolls horizontally
- **AND** no line is broken mid-token

#### Scenario: Earlier output remains available throughout the command lifecycle
- **WHEN** a shell tool or normalized command item in a parent or subagent conversation emits more rendered lines than fit in the viewport
- **THEN** the reader can scroll to the earliest available provider-supplied lines while it runs and after it completes or fails
- **AND** later output does not discard earlier available lines to maintain a preview or tail limit

#### Scenario: Provider truncation does not imply recoverable output
- **WHEN** the provider supplies only a truncated portion of a command's output
- **THEN** scrollback makes that available portion inspectable
- **AND** Chat does not claim that omitted upstream output can be recovered by its scrollback controls

### Requirement: Shell scrollback has accessible inline sizing and a floating output window

Shell output SHALL offer bounded, accessible inline sizing and one in-app popped-out view per Chat surface. Desktop floating and maximized views and touch full-area views SHALL retain reading state, keep return controls reachable, and restore focus without closing the owning child transcript.

#### Scenario: A reader sizes inline shell output or returns it from a popped-out view
- **WHEN** a reader sizes inline shell output or returns it from a popped-out view
- **THEN** Each shell tool and normalized command item's output in a parent or subagent conversation SHALL offer inline height adjustment through both pointer and keyboard controls.
- **AND** The resize control SHALL be focusable, have an accessible name, expose its current size and bounds, and show visible keyboard focus.
- **AND** Applied inline height SHALL be finite and clamped between a usable minimum and the available layout height.
- **AND** A layout smaller than the preferred minimum SHALL take precedence so output cannot force controls outside the available area.
- **AND** The reader's chosen inline height SHALL be retained while output is popped out and restored on return inline, subject to those bounds.

#### Scenario: A desktop reader pops out shell output and moves or resizes its window
- **WHEN** a desktop reader pops out shell output, moves it or resizes it
- **THEN** On desktop, an accessible Pop out control SHALL move the same output into one nonmodal in-app floating window.
- **AND** The reader SHALL be able to drag the window and resize its width and height, with keyboard equivalents for movement and both resize dimensions.
- **AND** Its bounds SHALL be the UatuCode work area, not the Chat column, panel, or transcript area.
- **AND** The window SHALL be able to exceed the Chat width while keeping its controls reachable within the work area.
- **AND** Uncovered parts of the app SHALL remain usable without dismissing the window.
- **AND** Pop out MUST NOT open a separate browser window or use browser fullscreen.

#### Scenario: A reader maximizes or restores floating output, or pops it out in touch mode
- **WHEN** a reader maximizes or restores floating output, or pops it out in touch mode
- **THEN** Maximize SHALL fill the UatuCode work area.
- **AND** Restore size SHALL return a maximized window to its previous floating position and dimensions, clamped only as needed to fit the current work area.
- **AND** In touch mode, Pop out SHALL present a full-area output view within the UatuCode work area instead of floating drag and resize interactions.
- **AND** Maximized and touch full-area output MAY cover Preview, the composer, and request controls, but controls to return to chat SHALL remain reachable.
- **AND** Covered app controls MUST NOT receive keyboard focus while covered.

#### Scenario: A reader opens another output item, returns to chat, or presses Escape in popped-out output
- **WHEN** a reader opens another output item, returns to chat, or presses Escape in popped-out output
- **THEN** Each Chat surface SHALL have at most one popped-out shell output across its parent and child transcripts.
- **AND** Popping out another item SHALL return the previous item inline with its reading state retained before opening the selected item.
- **AND** Return to chat and Escape from the output SHALL return it directly inline, including from maximized or touch full-area presentation.
- **AND** They SHALL restore focus to the invoking control when available or a logical control for the same item without stealing the current outer reading anchor.
- **AND** Escape handled by output MUST NOT also close the subagent transcript.
- **AND** Pop out SHALL place keyboard focus within the output controls.
- **AND** All controls SHALL have accessible names and visible focus, and keyboard movement and resize controls SHALL expose their current values and bounds.

#### Scenario: Inline output can be resized with a pointer or keyboard
- **WHEN** the reader adjusts a shell viewport using its pointer resize control or focuses the resize control and uses the keyboard
- **THEN** its inline height changes within the available bounds
- **AND** the control exposes the resulting size and bounds accessibly
- **AND** the reader retains the output's reading position and follow state

#### Scenario: Output height remains bounded in a smaller layout
- **WHEN** the reader requests an inline height beyond the available layout or the layout shrinks below the chosen inline height
- **THEN** the applied height remains finite and clamped to the available layout
- **AND** output controls, the composer, and request controls remain reachable
- **AND** the chosen height remains available when space permits it again

#### Scenario: Pop out opens beyond the chat column
- **WHEN** the reader pops out shell output from a parent or subagent transcript on desktop
- **THEN** the same output appears in a nonmodal in-app floating window whose width can exceed the Chat column or panel within the UatuCode work area
- **AND** keyboard focus moves into the output controls and Return to chat is available
- **AND** uncovered app content and controls remain usable
- **AND** no separate browser window or browser fullscreen opens

#### Scenario: Floating output can be moved and resized with a pointer or keyboard
- **WHEN** the reader drags or uses keyboard movement controls, or resizes either dimension with pointer or keyboard controls
- **THEN** the floating window changes position, width, or height within the UatuCode work area
- **AND** its controls remain reachable and keyboard controls expose current values and bounds
- **AND** the output retains its reading anchor, horizontal offset, and follow state within available bounds

#### Scenario: Maximize and Restore size preserve floating bounds
- **WHEN** the reader maximizes floating output and then activates Restore size
- **THEN** Maximize fills the UatuCode work area and may cover Preview and the composer while keeping Return to chat reachable
- **AND** Restore size returns to the previous floating position, width, and height, clamped only to fit the current work area
- **AND** neither action overwrites the chosen inline height or follow state

#### Scenario: Touch output uses a full-area view
- **WHEN** the reader pops out shell output in touch mode
- **THEN** the same output fills the UatuCode work area without floating drag or resize interactions
- **AND** Return to chat remains reachable even when Preview, the composer, or request controls are covered
- **AND** keyboard focus cannot move to covered app controls

#### Scenario: Only one shell view is popped out per Chat surface
- **WHEN** one shell view is popped out and the reader pops out a different item in the parent or a child transcript
- **THEN** the previous item returns inline with its reading state retained
- **AND** only the newly selected item owns the popped-out view

#### Scenario: Return to chat returns to the inline reading context
- **WHEN** the reader activates Return to chat or presses Escape from floating, maximized, or touch full-area shell output
- **THEN** the output returns inline at its retained height subject to available bounds
- **AND** focus returns to the invoking control or a logical control for that item if the invoking control is unavailable
- **AND** the outer timeline anchor and shell reading state are restored
- **AND** maximized output returns directly inline without an intermediate floating view

#### Scenario: Escape returns child output without closing the child
- **WHEN** shell output is popped out from a subagent transcript, including maximized or touch full-area output, and the reader presses Escape from that output
- **THEN** the shell output returns inline within that transcript
- **AND** the subagent transcript remains open

#### Scenario: Return respects reading elsewhere in the transcript
- **WHEN** the reader scrolls the uncovered outer transcript while a floating output window is open and then returns that output inline
- **THEN** the current outer reading position remains anchored rather than reverting to the position saved at Pop out
- **AND** focus restoration does not scroll the transcript back to an offscreen invoking control

### Requirement: Popped-out output identifies and retains its owning command

Popped-out output SHALL stay bound to its immutable conversation and command item, expose truthful provider status and completion metadata, and remain open through lifecycle and regrouping changes without switching to later commands.

#### Scenario: A popped-out command receives output, status updates, disconnection, or later conversation activity
- **WHEN** a popped-out command receives output, status updates, disconnection, or later conversation activity
- **THEN** Popped-out output SHALL remain bound to the specific immutable conversation and item identity selected by the reader.
- **AND** It SHALL show the command, conversation label, and provider-reported running, completed, failed, or cancelled status.
- **AND** It SHALL show the provider's completion time when known and MUST NOT fabricate a completion time when unknown.
- **AND** Disconnection MUST NOT be presented as completion.
- **AND** Completion, failure, cancellation, activity regrouping, and later commands SHALL NOT dismiss the output or automatically switch it to another item.
- **AND** Output and status updates SHALL continue to apply only to its owning item.

#### Scenario: The window identifies the selected command
- **WHEN** the reader pops out a shell item from a parent or child conversation
- **THEN** the output shows that item's command, conversation label, and provider-reported status
- **AND** updates to other items do not change its conversation or item identity

#### Scenario: Completed output stays open as later commands run
- **WHEN** the selected command completes, fails, or is cancelled and later commands start or activity is regrouped
- **THEN** its output remains open with its own provider-reported outcome
- **AND** the window does not switch automatically to a later command
- **AND** its reading state is retained

#### Scenario: Completion metadata is not invented
- **WHEN** a provider reports command completion with a known completion time
- **THEN** the output shows that provider-reported time
- **AND** when the provider supplies no completion time, the output does not invent one

#### Scenario: Disconnection is not completion
- **WHEN** the provider disconnects without reporting a terminal outcome for the selected running command
- **THEN** the output does not label that command completed or fabricate a completion time

### Requirement: Shell reading state is local to its conversation and item

Shell reading state SHALL remain client-local and scoped to its immutable conversation and item during the retained view lifetime. Presentation changes SHALL preserve it within bounds; navigation or disposal SHALL release output interactions, and hidden Chat SHALL hide and defer its output window.

Persistence across reloads is not required.

#### Scenario: An output item updates or changes presentation while its local view is retained
- **WHEN** an output item updates or changes presentation while its local view is retained
- **THEN** Shell reading state SHALL belong to the local client's immutable conversation and item identity during the retained view lifetime.
- **AND** It SHALL include the output's horizontal position, vertical reading anchor and offset, chosen inline height, follow state, reader-opened status, and floating position and dimensions.
- **AND** These values SHALL survive output updates, moves between inline and popped-out views, Maximize, Restore size, desktop/touch presentation changes, and command lifecycle changes, subject to available content and layout bounds.
- **AND** Temporary maximized or touch full-area geometry MUST NOT overwrite the retained floating bounds.
- **AND** Updates to other items or conversations MUST NOT overwrite this state.

#### Scenario: The reader switches conversations, leaves a child transcript, removes an item, or disposes and recreates a view
- **WHEN** the reader switches conversations, leaves a child transcript, removes an item, or disposes and recreates a view
- **THEN** Explicitly switching the selected conversation SHALL close any popped-out shell output and release its old focus, movement, resize, and keyboard ownership so it cannot act on the new conversation.
- **AND** Leaving or closing a child transcript SHALL likewise release output owned by that child.
- **AND** Removing the owning item or disposing its view SHALL close its output and release those interactions.
- **AND** Popped-out output SHALL NOT remain pinned across conversations.
- **AND** Retained per-item reading state SHALL remain scoped to its owning conversation if it survives navigation, and returning SHALL NOT automatically reopen the prior popped-out view.
- **AND** A newly created view without retained state SHALL start with the default bounded inline height and bottom following.

#### Scenario: The reader hides Chat without changing its selected conversation and later returns
- **WHEN** the reader hides Chat without changing its selected conversation and later returns
- **THEN** Hiding Chat without changing the selected conversation SHALL hide its output window and defer output painting under the existing hidden-Chat behavior.
- **AND** Returning to the same retained Chat view SHALL restore the window's presentation and reconcile its owning item's latest output and status.
- **AND** It SHALL NOT display an independent output inspector over another active app tab.

#### Scenario: Switching conversations releases popped-out ownership
- **WHEN** the reader explicitly switches conversations while a parent or child shell output is popped out
- **THEN** the popped-out view closes and its old focus, movement, resize, and keyboard ownership is released
- **AND** subsequent input affects only the current conversation
- **AND** no old shell reading state is applied to an item in the new conversation

#### Scenario: Leaving a child transcript releases its popped-out view
- **WHEN** the reader navigates out of or closes a child transcript that owns popped-out shell output
- **THEN** that popped-out view closes and releases its interaction ownership
- **AND** the parent transcript remains usable with its own reading state

#### Scenario: Retained reading state survives a return without reopening output
- **WHEN** the reader returns to a conversation whose shell item view state was retained
- **THEN** the item uses its retained position, inline height, follow state, and reader-opened status within current bounds
- **AND** its previous popped-out view does not reopen automatically
- **AND** a later explicit Pop out uses its retained floating bounds within the current work area

#### Scenario: Presentation changes preserve per-item geometry and reading state
- **WHEN** the reader moves an item between inline, floating, maximized, and touch full-area output and then returns to floating or inline output
- **THEN** floating output uses its retained floating position and dimensions and inline output uses its chosen inline height, subject to current layout bounds
- **AND** the output retains its horizontal offset, vertical reading anchor, and follow state wherever the content and layout permit
- **AND** maximized or touch full-area dimensions do not replace its retained floating geometry

#### Scenario: Item removal or view disposal releases output interactions
- **WHEN** the owning item is removed or its view is disposed while output is popped out
- **THEN** the popped-out view closes and releases its focus, movement, resize, and keyboard ownership
- **AND** subsequent pointer or keyboard input cannot manipulate the removed output or an unrelated item

#### Scenario: A fresh view does not require persisted reading state
- **WHEN** a shell item is opened after reload or after its retained view state has been released
- **THEN** it can start at the default bounded inline height with bottom following
- **AND** restoring prior local shell reading state from persistent storage is not required

#### Scenario: Hiding Chat hides its output window
- **WHEN** the reader hides Chat or selects another app tab without changing the selected conversation
- **THEN** its output window is hidden and output painting is deferred
- **AND** returning to the same retained Chat view restores the output window with its owning item's latest output and status

### Requirement: Activity chrome is legible and distinct from prose

Activity chrome SHALL remain legible but quieter than assistant prose in light and dark themes, using stronger colour than secondary labels while preserving status colours.

#### Scenario: Chat renders a working line, finished group, member labels and subjects, or connecting rules and dots in either theme
- **WHEN** Chat renders a working line, finished group, member labels and subjects, or connecting rules and dots in either theme
- **THEN** The activity chrome — the working line while a turn runs, a finished group's summary line, each member row's label and subject, and the rule and neutral dot that tie a group's members together — SHALL use a colour that is visibly stronger than the surface's secondary-label colour and visibly quieter than assistant prose, in both the light and the dark theme, so steps are readable and told apart from each other and from the answer without being the answer's equal.
- **AND** Status words and outcome indicators (running, failed) keep their own colours.

#### Scenario: Steps are readable in light and dark
- **WHEN** a turn has produced a working line with several member rows, in either theme
- **THEN** the line and its rows meet at least the contrast the surface's body text meets against the same background
- **AND** they remain distinguishable from the assistant prose around them

#### Scenario: Chrome stays quieter than the answer
- **WHEN** a finished group sits between two assistant messages
- **THEN** the group's summary and rows read as secondary to the messages
- **AND** a failed step's status is still shown in the failure colour

### Requirement: Users can resolve agent interaction requests in context

Agent requests SHALL be answerable/recoverable with truthful provenance, per-owner permission FIFO, single replies and reachable controls. Every MCP permission SHALL identify the registered server/tool, distinct from built-ins, or show the sent action if unresolved; persistent confirmation SHALL name that action. Wildcard-only permissions SHALL show unchanged call arguments, or unchanged provider input if the call is missing. Persistent authority SHALL disclose scope and require confirmation.

#### Scenario: OpenCode raises or resolves a permission or structured question
- **WHEN** OpenCode raises or resolves a permission or structured question
- **THEN** An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting.
- **AND** Where a permission would change a file, the request SHALL show what it would change — the pending diff — where the choice is made, so the user sees the change before allowing it.
- **AND** A permission with nothing to show a diff for is unaffected.
- **AND** A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported.
- **AND** A resolved request SHALL become non-interactive and record its outcome.
- **AND** A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form.
- **AND** Submitting a response more than once MUST NOT produce multiple provider replies.

#### Scenario: A live or recovered permission names only a wildcard resource for a tool call, including an MCP tool
- **WHEN** a live or recovered permission names only a wildcard resource for a tool call, including an MCP tool
- **THEN** A permission that names no specific resource, whose request carries only a wildcard as OpenCode's request to call an MCP tool does, SHALL show the arguments of the tool call it would allow, where the choice is made, so the user sees what the call does before allowing it.
- **AND** The arguments SHALL be those of the tool call the permission belongs to, as the conversation already shows them; the surface MUST NOT invent, summarize, or reorder them.
- **AND** When that call cannot be found in the conversation, the request SHALL show what OpenCode sent, unchanged.
- **AND** A permission naming a specific resource, carrying a diff, or carrying a plan is unaffected.
- **AND** Like the diff, the arguments are shown while the request is open; the resolved request recedes to its outcome and the resources OpenCode named, as any other permission does.
- **AND** The arguments SHALL be shown for a request recovered from OpenCode's pending set as for one announced live.

#### Scenario: MCP identity is shown regardless of resource specificity
- **WHEN** a live or recovered MCP permission names a wildcard, a specific resource, a diff or a plan
- **THEN** if the server can be identified among those OpenCode reports, the permission names the MCP server and tool as registered and distinguishes them from built-in tools
- **AND** its persistent-approval confirmation names the action OpenCode sent, not the display identity
- **WHEN** its server cannot be identified among the servers OpenCode reports
- **THEN** the permission shows the action as sent

#### Scenario: A subagent request is mirrored to its launching conversation
- **WHEN** a subagent raises a request
- **THEN** A request raised by a subagent SHALL additionally appear in the conversation that launched that subagent, and SHALL be answerable there.
- **AND** The subagent's own conversation remains the single owner of the request: an answer given from the launching conversation SHALL be directed to the owning conversation, so exactly one response reaches OpenCode however many places the request was shown.
- **AND** Resolving it SHALL resolve it everywhere it appears.

#### Scenario: A subagent-owned request is shown outside its owning transcript before or after resolution
- **WHEN** a subagent-owned request is shown outside its owning transcript before or after resolution
- **THEN** When a subagent-owned request appears outside its owning transcript, the request SHALL identify the specific launching subagent from the best available structured attribution and SHALL offer direct navigation to the owning transcript.
- **AND** If the specific attribution has not arrived or cannot be resolved, the request MUST use a truthful generic subagent label rather than inventing an identity, while retaining transcript navigation whenever the agent supports subagent transcripts.
- **AND** The origin and transcript control SHALL remain available after resolution so the decision can be audited.
- **AND** A conversation's own requests MUST NOT be labeled as coming from a subagent.

#### Scenario: Unresolved requests from one or several owning conversations are presented together
- **WHEN** unresolved requests from one or several owning conversations are presented together
- **THEN** Only the active unresolved request of a given conversation MAY accept a response.
- **AND** Where requests from more than one conversation are shown together, they SHALL each be governed by the conversation that owns them, so a request awaiting a user in one conversation does not block answering a request owned by another.

#### Scenario: Pending permissions retain the owning queue order
- **WHEN** permissions are pending or recovered for a conversation, with or without structured questions
- **THEN** Pending permissions of the same owning conversation SHALL be answered in FIFO order, matching OpenCode's pending queue.
- **AND** A new permission SHALL NOT displace the permission already awaiting an answer.
- **AND** Recovery SHALL preserve OpenCode's pending-list order, including when timestamps are equal or a missed request precedes an already observed one.
- **AND** Request ids and transcript timestamps MUST NOT override this queue order.
- **AND** The surface, request shortcut, and server response validation SHALL agree on the answerable permission.
- **AND** Pending permissions SHALL take precedence over structured questions of the same owner, as in OpenCode; questions retain their existing ordering when no permission is pending.

#### Scenario: Each request exposes its own state
- **WHEN** a conversation displays an active, waiting or resolved request
- **THEN** A request's state SHALL be distinguishable without reading its body — whether it awaits the user now, awaits its turn behind another request of the same conversation, or is resolved.
- **AND** That distinction MUST NOT rely on colour alone.
- **AND** A request awaiting its turn MUST NOT be presented as obsolete, superseded, or otherwise not needing an answer, because it will require one.

#### Scenario: Outstanding request counts do not obscure answer controls
- **WHEN** the surface displays outstanding requests, including with overlays or at the transcript end
- **THEN** The surface SHALL report how many requests are outstanding across everything it is showing, and SHALL offer a way to reach an outstanding request without hunting for it.
- **AND** That report, and any other control the surface floats over the conversation, MUST NOT cover a request's own answer field or its submit and cancel controls; the conversation SHALL reserve room for them so an outstanding request shown at the end of the transcript stays fully operable.
- **AND** The report SHALL NOT be shown while a request it would lead to is already on screen; when it is shown, its count remains that of every outstanding request.

#### Scenario: The reader reveals a request's free-form answer field
- **WHEN** the reader reveals a request's free-form answer field
- **THEN** Revealing a request's free-form answer field SHALL hold the conversation's position on the request being answered, so the request does not scroll out of view as the user starts to answer it.

#### Scenario: A permission offers approval that extends beyond the current request
- **WHEN** a permission offers approval that extends beyond the current request
- **THEN** A choice that grants authority beyond the request being answered SHALL state the scope and lifetime of that authority where the choice is offered, so a user learns what they are granting before granting it rather than afterwards.
- **AND** In particular, OpenCode's persistent approval carries past the answered request into later conversations served by the same OpenCode instance and covers the request's saved pattern rather than only the resource displayed, and it is lost when that instance restarts.
- **AND** It MUST NOT be presented as limited to the current conversation, nor as permanent, nor as outliving the OpenCode instance that granted it.

#### Scenario: The reader chooses persistent approval on a live or recovered request
- **WHEN** the reader chooses persistent approval on a live or recovered request
- **THEN** Choosing the persistent approval SHALL NOT send a reply.
- **AND** It SHALL open a confirmation step on the same request that lists the future-approval patterns OpenCode supplied for that request, the patterns its persistent reply installs, verbatim and apart from the request's own resources, so the user can see where the two differ.
- **AND** The surface MUST NOT derive or shorten a pattern from the displayed command; a request whose patterns are unknown SHALL say so rather than present the command as the scope.
- **AND** The patterns SHALL be carried on the request wherever it is shown, including a request recovered from OpenCode's pending set after its live announcement was missed.

#### Scenario: A conversation loads after a request's live announcement was missed
- **WHEN** a conversation loads after a request's live announcement was missed
- **THEN** A pending request SHALL remain discoverable and answerable even when the server did not observe its live announcement — because the event stream was interrupted, restarted, or the conversation was not being tracked at the time.
- **AND** Loading a conversation SHALL reconcile its unresolved requests against OpenCode's own pending set, so a request that OpenCode is still waiting on is never permanently invisible.

#### Scenario: Permission is approved once
- **WHEN** OpenCode requests permission for a command and the user chooses one-time approval
- **THEN** the response is sent once to the matching pending request
- **AND** the card records that the request was approved for that occurrence

#### Scenario: New permissions wait behind the current permission
- **WHEN** multiple permissions are pending in one owning conversation
- **THEN** the first permission in OpenCode's queue is answerable and later permissions await their turn
- **AND** new arrivals do not displace it
- **AND** answering it makes the next pending permission answerable
- **AND** each reply retains the matching request id and owning conversation

#### Scenario: Permission recovery preserves queue order
- **WHEN** Uatu recovers pending permissions after missing live announcements
- **THEN** their answerable order matches OpenCode's pending list, even with equal timestamps or ids sorting differently
- **AND** a recovered earlier request precedes a later request already observed live
- **AND** the owning transcript, mirrored parent card, request shortcut, and server validation agree on which request can be answered

#### Scenario: An edit permission shows its diff before approval
- **WHEN** a pending permission would change a file
- **THEN** the card shows the change it would apply
- **AND** the diff is shown where the approve and reject choices are

#### Scenario: A non-edit permission shows no diff
- **WHEN** a pending permission has no file change to show
- **THEN** the card presents its choices without a diff

#### Scenario: An MCP tool permission shows the call's arguments
- **WHEN** OpenCode asks permission to call an MCP tool, naming only a wildcard resource, and the conversation holds that call with its arguments
- **THEN** the card shows those arguments where the approve and reject choices are
- **AND** the card names the MCP server and the tool, apart from the built-in tools
- **AND** no bare wildcard stands in for the arguments

#### Scenario: The persistent-approval confirmation keeps OpenCode's own action name
- **WHEN** the user chooses the persistent approval on an MCP tool permission
- **THEN** the confirmation names the action as OpenCode sent it, the rule it will install

#### Scenario: An MCP permission whose server cannot be identified keeps the action as sent
- **WHEN** a pending permission's action matches none of the MCP servers OpenCode reports
- **THEN** the card shows the action as OpenCode sent it

#### Scenario: A wildcard permission whose call is not in the conversation
- **WHEN** a pending permission names only a wildcard resource and the conversation holds no tool call it belongs to
- **THEN** the card shows the request as OpenCode sent it, with its choices

#### Scenario: A permission naming a specific resource adds no arguments
- **WHEN** a pending permission names a command, a file, or another specific resource
- **THEN** the card shows that resource as before
- **AND** it does not add the tool call's arguments beside it

#### Scenario: A resolved MCP permission recedes like any other
- **WHEN** a permission that showed a call's arguments has been answered
- **THEN** its receded form records the outcome and the resources OpenCode named, without the arguments block
- **AND** the arguments remain readable on the tool row the call ran as

#### Scenario: An answered request recedes
- **WHEN** a permission or question has been answered
- **THEN** what was asked and what was decided remain legible
- **AND** the request occupies less of the transcript than it did while it needed an answer
- **AND** the resources it named remain reachable from it

#### Scenario: A subagent's request reaches the conversation that launched it
- **WHEN** a subagent raises a permission request while its parent conversation is open
- **THEN** the request appears in the parent conversation
- **AND** it is answerable there without first opening the subagent's transcript

#### Scenario: A surfaced request identifies its subagent and opens its transcript
- **WHEN** a subagent-owned permission or question appears in its launching conversation and structured attribution is available
- **THEN** the request identifies that subagent
- **AND** offers a direct control that opens the owning transcript without changing the selected parent conversation

#### Scenario: Missing attribution uses a truthful fallback
- **WHEN** a subagent-owned request appears before its specific attribution can be resolved
- **THEN** the request states that it came from a subagent without inventing a name or description
- **AND** still offers transcript navigation when subagent transcripts are supported

#### Scenario: Request provenance remains auditable after resolution
- **WHEN** a surfaced subagent request has been answered
- **THEN** its receded form retains the subagent origin and transcript control

#### Scenario: A conversation's own request has no foreign origin
- **WHEN** a permission or question belongs to the conversation currently being shown
- **THEN** it is not labeled as a subagent request
- **AND** no redundant transcript control is added to it

#### Scenario: Answering a subagent's request from the parent replies once
- **WHEN** the user answers a subagent's request from the parent conversation
- **THEN** OpenCode receives exactly one response, for the subagent's conversation
- **AND** the request shows as resolved in both the parent and the subagent's transcript

#### Scenario: Requests owned by different conversations do not block each other
- **WHEN** a parent conversation has its own pending request and a subagent's pending request is shown alongside it
- **THEN** both are answerable
- **AND** answering one does not change whether the other can be answered

#### Scenario: A request needing an answer is distinguishable at a glance
- **WHEN** a conversation shows requests that need an answer, requests awaiting their turn, and resolved requests
- **THEN** each state is distinguishable without reading the card body
- **AND** the distinction is carried by something other than colour alone

#### Scenario: A queued request is not described as obsolete
- **WHEN** a pending request is not yet answerable because another request of the same conversation is active
- **THEN** it is presented as awaiting its turn
- **AND** it is not presented as superseded, obsolete, or resolved

#### Scenario: Outstanding requests are counted and reachable
- **WHEN** one or more requests are outstanding in what the surface is showing
- **THEN** the surface reports how many are outstanding
- **AND** offers a way to reach an outstanding request directly
- **AND** reports none once every request has been answered

#### Scenario: The outstanding-request report does not cover an answer
- **WHEN** a request at the end of the conversation shows its answer field and submit and cancel controls while the surface reports outstanding requests
- **THEN** the report does not overlap that field or those controls
- **AND** each of them can be activated directly where it appears

#### Scenario: The outstanding-request report yields to a visible request
- **WHEN** the only outstanding request's card is within the visible part of the conversation
- **THEN** the report is not shown
- **AND** it reappears once the card is scrolled out of view while the request is still outstanding

#### Scenario: Revealing a free-form answer holds the request in view
- **WHEN** the user chooses a request's free-form answer and its field is revealed and focused
- **THEN** the request being answered stays in view
- **AND** the conversation does not reposition onto a different entry

#### Scenario: User rejects a structured question
- **WHEN** OpenCode asks a structured question and the user rejects or dismisses it
- **THEN** OpenCode receives one rejection response
- **AND** the resolved card can no longer submit an answer

#### Scenario: Stale request response is refused
- **WHEN** a client attempts to answer a request that is already resolved or no longer active
- **THEN** the server rejects it without forwarding another response to OpenCode

#### Scenario: Persistent approval states the authority it grants
- **WHEN** a permission request offers the persistent approval choice
- **THEN** the surface states that choosing it reaches beyond this conversation and beyond this exact request, and that it lasts until OpenCode restarts
- **AND** it is not described as applying only to this conversation, nor as permanent

#### Scenario: The confirmation shows OpenCode's pattern, not the command
- **WHEN** OpenCode requests permission for `git status --short` and supplies `git status *` as its future-approval pattern, and the user chooses the persistent approval
- **THEN** no reply is sent
- **AND** the confirmation lists `git status *` as what will be allowed
- **AND** the request's own resource `git status --short` remains visible apart from that list

#### Scenario: Persistent approval is still sent as OpenCode's persistent reply
- **WHEN** the user confirms the persistent approval
- **THEN** OpenCode receives its persistent-approval reply once for that request
- **AND** the recorded outcome is unchanged from before this correction

#### Scenario: Patterns are announced under either naming generation
- **WHEN** OpenCode announces a request's future-approval patterns under its current or its legacy event name
- **THEN** the request carries those patterns
- **AND** a request announced under both carries them once

#### Scenario: A request missed by the event stream is recovered on load
- **WHEN** OpenCode raised a permission request while the server's event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered
- **AND** answering it resolves the request OpenCode is waiting on
- **AND** its persistent approval confirms with the future-approval patterns OpenCode reports for it
- **AND** a wildcard-only request shows the arguments of the call it belongs to, as the live announcement would have

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable

### Requirement: Chat supports reversible conversation undo and redo

On agents declaring reversible history, Chat SHALL offer local `/undo`, `/redo`, Revert message and Restore actions, reconciling history/files across clients. Only the invoking client's draft SHALL receive boundary text/attachments or clear on full restoration; other clients' private drafts MUST NOT be overwritten by any boundary change. Revert SHALL preserve pending input, pause delivery safely and admit replacement prompts before older queued work.

#### Scenario: A reversible-history agent receives local Undo, Redo, or direct Revert message
- **WHEN** a reversible-history agent receives local Undo, Redo, or direct Revert message
- **THEN** When the connected agent declares reversible-history support, Chat SHALL offer local `/undo` and `/redo` commands that operate on the selected conversation and MUST NOT send those command strings as ordinary prompts or provider-defined slash commands.
- **AND** Each visible user turn in the main transcript SHALL also offer a direct Revert message action.
- **AND** Undo SHALL stage the previous visible user turn as the conversation's revert boundary; direct Revert SHALL stage the selected visible user turn in one boundary mutation rather than repeated Undo mutations.
- **AND** Both SHALL hide the boundary turn and all later work from the current transcript and restore affected workspace files through the agent's revert operation.
- **AND** The invoking client SHALL receive the boundary turn's non-synthetic prompt text and any still-available attachments as an editable composer draft; other clients' private drafts MUST NOT be overwritten.

#### Scenario: Undo interrupts running work or stages a revert while queued messages and steers are pending
- **WHEN** Undo interrupts running work or stages a revert while queued messages and steers are pending
- **THEN** If work is running, Undo SHALL interrupt it before changing the boundary.
- **AND** Messages queued behind that work MUST NOT be admitted between interruption and the completed revert.
- **AND** Existing pending messages SHALL remain visible and removable but paused while a revert is staged.
- **AND** They SHALL resume only after Redo clears the revert or after the user submits a replacement prompt, with that replacement admitted before the older held queue resumes.
- **AND** When the agent declares `steering`, the replacement SHALL be sent as a steer.
- **AND** Messages held in the workspace's queue SHALL stay pending rather than being discarded.
- **AND** Steers already pending with the agent SHALL be delivered together with the replacement, the oldest first.
- **AND** When Undo succeeds while steers are pending, Chat's undo confirmation SHALL count those steers without repeating their message text and say that they will be delivered together with the replacement.

#### Scenario: The user repeats Undo, advances Redo, restores a hidden turn, or submits a replacement prompt
- **WHEN** the user repeats Undo, advances Redo, restores a hidden turn, or submits a replacement prompt
- **THEN** Repeated Undo SHALL move the boundary backward one visible user turn at a time.
- **AND** While a boundary is staged, Chat SHALL list the hidden user turns from the boundary onward and offer a Restore message action for each.
- **AND** Redo SHALL move forward one hidden user turn at a time.
- **AND** Restoring a selected hidden turn SHALL make history current through that turn in one mutation by staging the following hidden user turn, or SHALL clear the boundary when the selected turn is newest.
- **AND** The invoking client's composer SHALL receive the next boundary turn when one remains and SHALL clear when the original transcript is fully restored.
- **AND** other clients' private drafts remain unchanged during Redo and Restore as during Undo and Revert
- **AND** Submitting a replacement prompt while a revert is staged SHALL commit the reverted history before starting the replacement turn, after which the hidden turns can no longer be restored by Redo or Restore.

#### Scenario: A boundary mutation succeeds, is retried, or fails during interruption or revert
- **WHEN** a boundary mutation succeeds, is retried, or fails during interruption or revert
- **THEN** Every successful boundary change SHALL reconcile the authoritative conversation so all connected clients agree on visible history and workspace state.
- **AND** Mutation retries MUST be idempotent.
- **AND** If interruption or the requested boundary change fails, Chat SHALL report the failure and MUST NOT claim that history or files changed.

#### Scenario: Undo and redo are offered only when supported
- **WHEN** the connected agent declares reversible-history support
- **THEN** Chat offers `/undo` and `/redo` as local commands
- **AND** invoking them does not send their text as an ordinary prompt or provider-defined command

#### Scenario: Unsupported agents do not expose reversible history
- **WHEN** the connected agent does not declare reversible-history support
- **THEN** Chat does not offer Undo or Redo controls
- **AND** a direct request to mutate the revert boundary is refused without changing the conversation

#### Scenario: Undo restores the latest user turn for editing
- **WHEN** the user invokes Undo with no revert currently staged
- **THEN** the latest visible user turn and all later work disappear from the visible transcript
- **AND** affected workspace files return to their state before that turn
- **AND** the invoking client's composer receives the turn's non-synthetic text and available attachments

#### Scenario: A selected visible message becomes the boundary directly
- **WHEN** the user invokes Revert message on an earlier visible user turn
- **THEN** that selected turn and every later turn disappear from the visible transcript
- **AND** the agent receives one revert operation naming the selected turn
- **AND** the invoking client's composer receives the selected turn for editing

#### Scenario: Undo interrupts active work before reverting
- **WHEN** the user invokes Undo while the selected conversation is running
- **THEN** the active turn is interrupted before the revert boundary changes
- **AND** no queued message is admitted during that transition

#### Scenario: Queued messages pause behind a staged revert
- **WHEN** Undo succeeds while messages are pending
- **THEN** the pending messages remain visible and removable, presented as paused
- **AND** none is delivered while the revert remains staged

#### Scenario: Repeated Undo walks backward by user turn
- **WHEN** a revert is staged and the user invokes Undo again
- **THEN** the boundary moves to the preceding visible user turn
- **AND** the invoking client's composer receives that earlier turn for editing

#### Scenario: Redo walks forward through hidden turns
- **WHEN** more than one user turn is hidden behind a staged revert and the user invokes Redo
- **THEN** the boundary advances to the next hidden user turn
- **AND** that turn becomes the invoking client's editable composer draft

#### Scenario: Redo clears the newest boundary
- **WHEN** the boundary is at the newest hidden user turn and the user invokes Redo
- **THEN** the staged revert is cleared
- **AND** the original transcript and workspace state become current again
- **AND** paused queued messages may resume

#### Scenario: Reverted messages remain visible in a restore dock
- **WHEN** a revert boundary is staged
- **THEN** Chat lists every hidden user turn from the boundary onward outside the active transcript
- **AND** each listed turn offers a Restore message action
- **AND** every connected client sees the same list without losing its private composer draft

#### Scenario: Restore advances through the selected hidden message
- **WHEN** the user restores a hidden user turn that has later hidden turns
- **THEN** the boundary advances to the following hidden user turn in one mutation
- **AND** the selected turn and its prior history return to the active transcript
- **AND** the invoking client's composer receives the following boundary turn

#### Scenario: Restoring the newest hidden message clears the boundary
- **WHEN** the user restores the newest hidden user turn
- **THEN** the staged revert is cleared
- **AND** the original transcript and workspace state become current again
- **AND** the invoking client's restored composer draft is cleared

#### Scenario: A replacement prompt commits the reverted branch
- **WHEN** the user edits the restored draft and submits it while a revert is staged
- **THEN** the hidden history is committed as reverted before the replacement turn starts
- **AND** the replacement is admitted before previously held messages resume
- **AND** Redo no longer restores the discarded branch

#### Scenario: A replacement on a steering agent is a steer
- **WHEN** the agent declares `steering` and the user submits a replacement prompt while a revert is staged and messages are pending
- **THEN** the replacement is sent to the agent as a steer
- **AND** the messages held in the workspace's queue remain pending
- **AND** steers already pending with the agent are delivered with the replacement, the oldest first

#### Scenario: The undo confirmation counts pending steers
- **WHEN** the agent declares `steering` and Undo succeeds while steers are pending
- **THEN** Chat's undo confirmation counts pending steers without repeating their message text
- **AND** says they will be delivered together with the replacement prompt

#### Scenario: Other clients reconcile without losing private drafts
- **WHEN** one client successfully changes the revert boundary
- **THEN** every connected client reconciles to the same visible conversation and workspace state
- **AND** only the invoking client's composer draft is replaced

#### Scenario: Retried undo does not move twice
- **WHEN** a client retries the same Undo mutation after losing its response
- **THEN** the conversation boundary changes at most once for that request

#### Scenario: Failed undo preserves current state
- **WHEN** interruption or the agent's revert operation fails
- **THEN** Chat reports the failure
- **AND** does not claim that the transcript, composer, queue, or workspace files were reverted

#### Scenario: Undo at the oldest boundary is harmless
- **WHEN** no earlier visible user turn exists and the user invokes Undo
- **THEN** Chat reports that there is nothing more to undo
- **AND** the current revert boundary and workspace state do not change

#### Scenario: Redo without a staged revert is harmless
- **WHEN** no revert is staged and the user invokes Redo
- **THEN** Chat reports that there is nothing to redo
- **AND** the conversation and workspace state do not change

### Requirement: Chat discovers commands by meaningful name fragments
Slash-command suggestions SHALL match command names case-insensitively by exact name, whole-name prefix, segment prefix, contiguous substring, and ordered subsequence, in that priority order. Matching SHALL affect discovery only; Chat MUST still insert and submit the command's actual complete name. Equal-quality suggestions SHALL have deterministic ordering.

#### Scenario: A command is found by a later name segment
- **WHEN** the user enters `/archive`
- **AND** the agent offers `/openspec-archive-change`
- **THEN** that command appears in the suggestion list
- **AND** choosing it inserts `/openspec-archive-change` rather than the query text

#### Scenario: Stronger command matches rank first
- **WHEN** exact, prefix, segment, substring, and subsequence matches exist for a query
- **THEN** they appear in that order
- **AND** unrelated commands are omitted

### Requirement: Chat separates identity from conversation controls
The Chat header SHALL place workspace and agent identity on its own row above the conversation selector and actions in desktop and touch layouts, and the agent identity shown SHALL be the selected conversation's owning agent. Conversation controls SHALL remain usable without competing with identity text at the minimum supported panel width.

#### Scenario: Desktop Chat uses an uncrowded two-row header
- **WHEN** Chat is open in the desktop side panel
- **THEN** workspace and agent identity occupy a row above the conversation controls
- **AND** the conversation selector and actions remain within the header width

#### Scenario: The identity row follows the conversation
- **WHEN** a user switches from a conversation owned by one agent to a conversation owned by another
- **THEN** the identity row names the newly selected conversation's agent

### Requirement: Structured questions follow OpenCode custom-answer semantics

Structured questions SHALL enable custom answers unless OpenCode explicitly disables them. The UI-only custom choice SHALL submit trimmed user text, combine correctly with selection modes, and retain its draft during temporary deselection.

#### Scenario: A live or recovered structured question reports or omits the custom flag
- **WHEN** a live or recovered structured question reports or omits the custom flag
- **THEN** For every structured question, Chat SHALL support a custom answer unless OpenCode explicitly reports `custom === false`.
- **AND** An omitted `custom` value MUST enable custom answers for both live question announcements and pending questions recovered from OpenCode.
- **AND** An explicit false value MUST suppress the custom-answer choice.

#### Scenario: The user selects Type your own answer and enters a custom response
- **WHEN** the user selects Type your own answer or enters a custom response
- **THEN** Where custom answers are supported, Chat SHALL append a UI-only choice labelled "Type your own answer" to the provider's options.
- **AND** Selecting that choice SHALL reveal and focus a text input.
- **AND** The synthetic label MUST NOT be submitted to OpenCode.
- **AND** Chat SHALL trim the entered text and submit the non-empty result as an ordinary string in that question's answer array.

#### Scenario: The user combines or deselects custom input in single-select or multi-select questions
- **WHEN** the user combines or deselects custom input in single-select or multi-select questions
- **THEN** For a single-select question, the custom choice SHALL be mutually exclusive with provider options.
- **AND** For a multi-select question, it SHALL be selectable alongside provider options and its entered text SHALL be appended as one additional answer string.
- **AND** Deselecting the custom choice SHALL hide its input and exclude its text from submission, but MUST preserve the text while the pending question remains mounted so selecting it again restores the draft.

#### Scenario: Omitted custom flag enables a custom choice
- **WHEN** OpenCode asks a question without a `custom` field
- **THEN** Chat shows a "Type your own answer" choice
- **AND** this behavior is the same for a live announcement and a recovered pending question

#### Scenario: Explicit false suppresses custom answers
- **WHEN** OpenCode asks a question with `custom === false`
- **THEN** Chat does not show a custom-answer choice or input
- **AND** only provider options can satisfy that question

#### Scenario: Selecting custom reveals its input
- **WHEN** the user selects "Type your own answer"
- **THEN** its text input becomes visible and receives focus
- **AND** the question remains unanswered until that input contains non-whitespace text

#### Scenario: Single-select custom answer is submitted as text
- **WHEN** the user selects the custom choice, enters text, and confirms a single-select question
- **THEN** OpenCode receives the trimmed entered text as the question's one answer string
- **AND** it does not receive the synthetic choice label

#### Scenario: Multi-select combines options and custom text
- **WHEN** the user selects provider options and the custom choice in a multi-select question, enters text, and confirms
- **THEN** the answer array contains the selected provider labels and the trimmed custom text
- **AND** the synthetic choice label is absent

#### Scenario: Custom draft survives temporary deselection
- **WHEN** the user types a custom answer, deselects the custom choice, and selects it again while the request remains pending
- **THEN** the typed draft is restored
- **AND** the draft is omitted from any answer submitted while the custom choice is deselected

#### Scenario: Streaming preserves an unfinished custom answer
- **WHEN** conversation updates arrive while the user is typing a custom answer in a pending question
- **THEN** the selected custom choice, input visibility, focusable control, and typed draft remain intact

### Requirement: Single-question choices require explicit confirmation

A form containing one single-select question SHALL stage a clicked choice and expose Answer, submitting only on that action or equivalent explicit submission whether custom answers are enabled or disabled. Existing multi-question stepping and multi-select confirmation SHALL remain unchanged.

#### Scenario: The user clicks a choice or explicitly submits a one-question single-select form
- **WHEN** the user clicks a choice or explicitly submits a one-question single-select form with custom answers enabled or disabled
- **THEN** A question form containing one single-select question SHALL retain the selected option without submitting it when the option is clicked.
- **AND** Chat SHALL expose an explicit Answer action and SHALL submit only when the user activates that action or performs the form's equivalent explicit submission.

#### Scenario: The user confirms intermediate, final, or multi-select answers
- **WHEN** the user confirms intermediate, final, or multi-select answers
- **THEN** Existing multi-question stepping SHALL remain unchanged: intermediate confirmation advances to the next question, the final action submits all ordered answers, and earlier answers remain revisitable.
- **AND** Existing multi-select questions SHALL continue to require explicit confirmation and SHALL allow more than one selected answer.

#### Scenario: Single provider option does not auto-submit
- **WHEN** the user selects a provider option in a one-question single-select form
- **THEN** the option remains selected and the Answer action becomes available
- **AND** no response is sent until explicit confirmation

#### Scenario: Single custom choice does not auto-submit
- **WHEN** the user selects the custom choice and enters a valid answer in a one-question single-select form
- **THEN** the custom answer remains staged and the Answer action becomes available
- **AND** no response is sent until explicit confirmation

#### Scenario: Multi-question stepping is preserved
- **WHEN** a structured request contains more than one question
- **THEN** confirming an answered intermediate question advances to the next question
- **AND** the final confirmation submits one ordered answer array per question

#### Scenario: Multi-select confirmation is preserved
- **WHEN** a question allows multiple answers
- **THEN** the user can select more than one provider option and an applicable custom answer
- **AND** Chat waits for explicit confirmation before submitting them

### Requirement: Question answers are semantically valid before provider reply
Every answered question request SHALL contain exactly one answer array for each question in request order, and every such array MUST contain at least one non-empty string. A single-select answer array MUST contain exactly one string. A provider-option string MUST match an offered label, while any other string MUST be accepted only when that question supports custom answers. Chat MUST reject an invalid response without forwarding it to OpenCode or resolving the pending request.

#### Scenario: Missing per-question answer is rejected
- **WHEN** a response omits an answer array or provides an empty answer array for any question
- **THEN** Chat rejects the response
- **AND** OpenCode receives no reply

#### Scenario: Empty custom text is rejected
- **WHEN** a custom answer is empty after trimming
- **THEN** Chat keeps the question pending and requires a non-empty answer
- **AND** OpenCode receives no reply

#### Scenario: Unknown answer is rejected when custom is disabled
- **WHEN** a response contains a string that is not an offered option and the question explicitly disables custom answers
- **THEN** Chat rejects the response
- **AND** OpenCode receives no reply

#### Scenario: Valid ordered answers reach OpenCode once
- **WHEN** every question has a semantically valid answer and the user confirms the form
- **THEN** OpenCode receives the ordered string arrays once
- **AND** the request resolves everywhere it is shown under the existing ownership rules

### Requirement: Timeline position remains stable under streaming and navigation

Chat timelines and shell viewports SHALL preserve reading anchors and independent follow intent through streaming, navigation, layout, and command lifecycle changes. Latest controls SHALL resume stable following; manual upward scrolling SHALL immediately pause it without moving unrelated views.

#### Scenario: Content streams, older history is prepended, activity expands, or a conversation opens
- **WHEN** content streams, older history is prepended, activity expands, or a conversation opens
- **THEN** The Chat timeline SHALL remain pinned to the latest content only while the user is at or near its end.
- **AND** Once the user scrolls away, streaming, tool updates, image or code layout, and activity expansion MUST NOT steal the reading position; an accessible latest-content affordance SHALL indicate unseen updates and return to the end.
- **AND** Prepending older history SHALL preserve the same visible content and offset.
- **AND** Opening a conversation SHALL restore that client's last reading position when possible, otherwise it SHALL open at the latest turn.

#### Scenario: The reader scrolls a shell viewport upward, returns to its bottom, or activates latest output
- **WHEN** the reader scrolls a shell viewport upward, returns to its bottom, or activates latest output
- **THEN** Each shell viewport SHALL have a follow state independent of the outer timeline and other shell items.
- **AND** It SHALL initially follow the bottom.
- **AND** Any upward reader scroll SHALL stop following, including a movement smaller than a near-bottom threshold.
- **AND** Returning to the bottom or activating the viewport's accessible latest-output control SHALL resume following.
- **AND** Incoming output while following SHALL keep the bottom visible without resetting the horizontal offset.
- **AND** While following is paused, incoming output SHALL preserve the visible rendered content and its vertical offset, and the latest-output control SHALL indicate unseen output.

#### Scenario: Shell output or layout changes, its presentation changes, or its command completes or fails
- **WHEN** shell output or layout changes, its presentation changes, or its command completes or fails
- **THEN** Output updates, layout resize, inline height adjustment, Pop out, Maximize, Restore size, Return to chat, changes between desktop and touch presentation, and completion or failure SHALL preserve the shell item's horizontal position, vertical reading anchor, chosen inline height, and follow state.
- **AND** Position and applied size SHALL be clamped only where the available content or layout cannot accommodate them.
- **AND** A layout change that clamps position to the bottom MUST NOT itself resume paused following.
- **AND** Resizing or popping out shell output SHALL preserve the outer timeline's reading anchor, and returning inline SHALL preserve its current reading anchor, including any deliberate outer scrolling while the nonmodal window was open.
- **AND** Shell scrolling and its latest-output control MUST NOT independently move the outer timeline to its end.
- **AND** Long shell output SHALL preserve long-chat responsiveness, text selection, copying, and find over available rendered output.

#### Scenario: Parent or child timelines or shell viewports follow append-only streaming or latest-control movement
- **WHEN** parent or child timelines or shell viewports follow append-only streaming or latest-control movement
- **THEN** Following SHALL be stable in both parent and child outer timelines and in each shell output viewport, whether inline or popped out.
- **AND** While following during passive append-only updates, automatic movement MUST NOT alternate upward and downward when the scroll extent is not shrinking.
- **AND** Activating the relevant latest-content or latest-output control during streaming SHALL settle at the current bottom and continue following without oscillation between smooth movement and snapping.
- **AND** Any upward manual scroll SHALL interrupt automatic movement immediately and pause following, even during movement initiated by a latest control.
- **AND** Resize effects and programmatic scroll echoes MUST NOT change the reader's follow intent.
- **AND** A shrinking layout or content extent MAY cause a legitimate position clamp without being treated as follow jitter or resuming paused following.

#### Scenario: Active reader follows streaming output
- **WHEN** the user is at the end of the timeline as assistant content streams
- **THEN** new content remains visible without repeated manual scrolling

#### Scenario: Reading older content is not interrupted
- **WHEN** the user scrolls above the end while content continues streaming
- **THEN** their visible content remains anchored
- **AND** an affordance reports and navigates to unseen latest content

#### Scenario: Any upward scroll leaves the end
- **WHEN** the user scrolls upward by less than the near-end distance while content continues streaming
- **THEN** the timeline is no longer pinned and the next update does not return it to the end

#### Scenario: Sending returns the reader to the end
- **WHEN** the user submits a message while scrolled above the end
- **THEN** the timeline moves to the end so the sent message and the reply that follows are in view

#### Scenario: Loading older history preserves the viewport
- **WHEN** the user requests an older history page at the top of the loaded timeline
- **THEN** the previously visible first item remains at the same visual offset after insertion

#### Scenario: Expanding activity does not cause an unrelated jump
- **WHEN** the user expands or collapses a tool entry away from the timeline end
- **THEN** the chosen entry remains anchored in the viewport

#### Scenario: Shell output initially follows independently
- **WHEN** a shell viewport first shows output and further output arrives
- **THEN** it shows the bottom of its scrollback
- **AND** an outer timeline scrolled away from its end retains its reading anchor

#### Scenario: Any upward shell scroll pauses following
- **WHEN** the reader scrolls a shell viewport upward even by less than a near-bottom threshold and more output arrives
- **THEN** the viewport preserves the reader's visible content and vertical offset instead of returning to the bottom
- **AND** its latest-output control indicates unseen output
- **AND** other shell viewports and the outer timeline retain their own follow state

#### Scenario: Returning to latest output resumes following
- **WHEN** the reader scrolls a paused shell viewport back to the bottom or activates its latest-output control
- **THEN** that viewport resumes following incoming output
- **AND** it preserves its horizontal offset and does not jump the outer timeline to its end

#### Scenario: Reading position survives output and layout changes
- **WHEN** the reader has paused shell following and scrolled horizontally, and the output updates, the layout resizes, the inline height changes, the viewport is popped out, maximized, restored to floating size, returned inline, changes between desktop and touch presentation, or the command completes or fails
- **THEN** the same rendered content remains at the same vertical offset and the horizontal offset is preserved wherever the content and layout permit
- **AND** the chosen inline height is retained with its applied size clamped to the available layout
- **AND** following remains paused even if clamping places the viewport at the bottom

#### Scenario: Following survives resize and completion
- **WHEN** a shell viewport is following and is resized, popped out, maximized, restored to floating size, returned inline, changes between desktop and touch presentation, or receives completion or failure
- **THEN** it remains at the bottom with following active
- **AND** its horizontal offset and chosen inline height are retained within available bounds

#### Scenario: Long scrollback remains usable
- **WHEN** a long conversation contains shell output spanning many viewport heights and further output streams
- **THEN** scrolling, resizing, and conversation controls remain responsive
- **AND** available rendered output remains selectable, copyable, and reachable through find in inline, floating, maximized, and touch full-area views
- **AND** streaming does not clear an existing selection in unchanged output or steal the outer reading anchor

#### Scenario: Passive following does not jitter during append
- **WHEN** a parent outer timeline, child outer timeline, or shell output viewport is following during passive append-only streaming and its scroll extent is not shrinking
- **THEN** automatic scrolling keeps the latest content visible without alternating upward and downward movement
- **AND** the same behavior applies to inline, floating, maximized, and touch full-area shell output

#### Scenario: Latest settles at the bottom during streaming
- **WHEN** the reader activates the latest control in a parent outer timeline, child outer timeline, or shell output viewport while content continues appending
- **THEN** the view settles at the current bottom and follows subsequent appends
- **AND** it does not oscillate between smooth movement and snapping

#### Scenario: Manual upward scrolling interrupts automatic movement
- **WHEN** the reader scrolls upward in a parent outer timeline, child outer timeline, or shell output viewport during automatic following or movement initiated by its latest control
- **THEN** automatic movement stops immediately and following pauses, even for movement smaller than the near-bottom threshold
- **AND** subsequent appends preserve the reader's position rather than completing the interrupted movement

#### Scenario: Resize and programmatic echoes preserve follow intent
- **WHEN** resize effects or scroll events caused by automatic movement occur in a parent outer timeline, child outer timeline, or shell output viewport
- **THEN** they do not change whether the reader has chosen to follow
- **AND** a legitimate position clamp after layout or content shrink is allowed
- **AND** clamping a paused view to the bottom does not resume following

### Requirement: Desktop presents Preview and Chat as a persistent split

Desktop SHALL present a persistent Preview/Chat split with a draggable, fractionally persisted divider and a reopen strip for collapsed Chat. Narrow viewports SHALL preserve the open preference; Chat state MUST NOT change terminal docking or sizing.

#### Scenario: Desktop Chat renders and changes state independently of terminal visibility
- **WHEN** the desktop work area is rendered or Chat is resized, collapsed, reopened, or auto-collapsed, regardless of whether the terminal is visible or docked
- **THEN** In desktop mode the work area SHALL present Preview and Chat side by side with a draggable divider between them; Chat SHALL NOT be movable or dockable.
- **AND** The split position SHALL be persisted as a fraction of the work-area width so window resizing preserves the proportion, and it SHALL be restored across reloads.
- **AND** A collapsed Chat SHALL render as a slim strip at the work area's right edge carrying a visible reopen affordance, and expanding SHALL restore the retained fraction.
- **AND** When the viewport is too narrow to present both surfaces at their minimum usable widths, Chat SHALL auto-collapse with its open preference preserved and SHALL be restored when the viewport grows.
- **AND** Chat panel state MUST NOT alter the terminal's dock, sizing, visibility, or persistence behavior: a bottom-docked terminal SHALL span beneath both Preview and Chat, and a right-docked terminal SHALL keep the work area's right edge, with Chat between Preview and the terminal.

#### Scenario: Split proportion survives reload and resize
- **WHEN** a desktop user drags the divider to a new position, resizes the
  window, and reloads the page
- **THEN** Preview and Chat retain their fractional share of the work area
  throughout, subject to each surface's minimum width

#### Scenario: Collapsed panel reopens at its prior share
- **WHEN** the user collapses Chat and later activates the strip's reopen
  affordance
- **THEN** Chat expands to the fraction it had before collapsing

#### Scenario: Narrow viewport yields to Preview
- **WHEN** the viewport shrinks below the width needed for both surfaces and
  later grows past it again
- **THEN** Chat auto-collapses while Preview remains usable
- **AND** Chat reopens automatically because the open preference was preserved

#### Scenario: Right-docked terminal keeps the right edge
- **WHEN** the terminal is docked right and Chat is open
- **THEN** the terminal occupies the work area's right edge exactly as it does
  with Chat collapsed
- **AND** Chat sits between Preview and the terminal

#### Scenario: Revealing chat content expands a collapsed panel
- **WHEN** an action that presents Chat content (such as find-in-chat) targets
  a collapsed panel
- **THEN** the panel expands to its retained fraction rather than acting on an
  invisible surface

### Requirement: Chat adapts to the desktop split, touch, and software-keyboard viewports

Preview and Chat SHALL remain co-visible and stateful on desktop; touch SHALL use a full-screen Chat tab with keyboard-aware geometry. Foreground recovery, caret movement, and request answering SHALL preserve reading position and keep focused controls reachable without page zoom.

#### Scenario: Desktop Chat changes panel state or touch Chat opens, resizes, or dismisses the software keyboard
- **WHEN** desktop Chat changes panel state or touch Chat opens, resizes, or dismisses the software keyboard
- **THEN** In desktop mode Preview and Chat SHALL be co-visible primary surfaces sharing the main work area alongside the existing sidebar and independently dockable terminal; there SHALL NOT be a mode that replaces Preview with Chat.
- **AND** Collapsing, expanding, or resizing the Chat panel MUST NOT remount either surface or lose its state.
- **AND** In touch mode Chat SHALL occupy its own full-screen tab surface.
- **AND** The composer SHALL remain reachable above the visual viewport and safe-area inset while the software keyboard is present, and keyboard opening, resizing, or dismissal MUST NOT hide the input or cause the current reading position to jump.

#### Scenario: Touch Chat returns to the foreground or the keyboard pans rather than shrinks the page
- **WHEN** touch Chat returns to the foreground or the keyboard pans rather than shrinks the page
- **THEN** The touch surface's geometry SHALL follow the viewport that is actually visible.
- **AND** It SHALL be re-derived whenever the page returns to the foreground and not only when the platform announces a viewport change, so a keyboard dismissed while the app was backgrounded leaves no keyboard-sized surface behind and the user does not have to open and dismiss the keyboard to recover the full height.
- **AND** Detection of the software keyboard SHALL hold on platforms that pan the page under the keyboard rather than only shrinking it.

#### Scenario: Pinned tracks expand or a text caret moves while the keyboard is present
- **WHEN** pinned tracks expand or a text caret moves while the keyboard is present
- **THEN** While the keyboard is present the pinned progress tracks SHALL yield so the composer stays inside the visible viewport, and every pinned track that can grow SHALL be bounded, so no combination of populated and expanded tracks can push the composer out of view.
- **AND** Moving the text caret inside a chat text control MUST NOT move the conversation's reading position, even when the platform pans the viewport to follow the caret.
- **AND** A reading-position correction withheld while the page is hidden SHALL be applied once the page is visible again rather than dropped.

#### Scenario: A request text control gains or loses focus on a touch device
- **WHEN** a request text control gains or loses focus on a touch device
- **THEN** While a text control that belongs to a request has focus on a touch device, the surface SHALL give the transcript the visible band: chrome that cannot be used while the keyboard is open SHALL sit beneath the keyboard rather than above it, so the band above the keyboard belongs to the transcript and the request; it SHALL reappear as the keyboard dismisses; the transcript SHALL keep enough scroll room below its last entry that a request at the end of the conversation can still be lifted above the keyboard.
- **AND** The focused control SHALL be kept inside the visible viewport once the keyboard geometry has settled.
- **AND** Focusing that control MUST NOT change the page's scale.
- **AND** When focus leaves the request, the surface SHALL return to its normal arrangement.

#### Scenario: Preview updates while the conversation stays visible
- **WHEN** a desktop user prompts the agent and it modifies the currently
  previewed document
- **THEN** the live preview updates while the conversation, its streaming
  output, and the composer remain visible

#### Scenario: Desktop collapse and reopen preserves both surfaces
- **WHEN** a desktop user collapses the Chat panel and reopens it
- **THEN** the same conversation, draft, loaded history, and reading position
  are retained
- **AND** the Preview document and scroll position are unchanged
- **AND** terminal attachment and visibility are unchanged

#### Scenario: iPhone keyboard keeps composer visible
- **WHEN** a touch user focuses the Chat composer and the software keyboard
  reduces the visual viewport
- **THEN** the composer remains fully visible above the keyboard and bottom
  safe area
- **AND** the timeline resizes without placing the active content behind the
  composer

#### Scenario: Returning from the background restores the surface
- **WHEN** a touch user focuses the composer, backgrounds the app with the
  keyboard open, and returns to it with the keyboard dismissed and no
  viewport-change notification from the platform
- **THEN** the Chat surface again fills the visible viewport with no
  keyboard-sized strip below it
- **AND** the composer is reachable without opening and dismissing the
  keyboard again
- **AND** the conversation shows the reading position it held

#### Scenario: A panned keyboard is still a keyboard
- **WHEN** the software keyboard opens on a device that pans the page upward,
  so the strip occluded below the visible viewport is smaller than the
  keyboard itself
- **THEN** Chat treats the keyboard as present
- **AND** the pinned progress tracks give up their rows as they do when the
  keyboard shrinks the viewport without panning

#### Scenario: Pinch zoom is not a software keyboard
- **WHEN** the browser magnifies the page and reduces the visual viewport at a
  non-default scale
- **THEN** Chat retains its last normal-scale layout and keyboard state without
  treating the zoom as a keyboard or correcting the browser's zoom pan
- **AND** normal viewport measurement resumes when the scale returns to normal

#### Scenario: Expanded progress tracks cannot displace the composer
- **WHEN** the task list, the subagent list, and the background-task list are
  all populated and expanded while the keyboard is open
- **THEN** the composer and its send control remain inside the visible
  viewport
- **AND** the transcript absorbs the reduction instead of the composer

#### Scenario: Moving the caret does not move the conversation
- **WHEN** a touch user moves the text caret inside the composer or a
  request's answer field and the platform pans the visible viewport to follow
  it
- **THEN** the conversation's reading position is unchanged
- **AND** repeated pans during one caret movement do not each reposition the
  transcript

#### Scenario: The transcript holds still while an answer is typed
- **WHEN** a touch user has a request's answer field focused and the platform
  autoscrolls the transcript while the caret is dragged
- **THEN** the transcript returns to the position that keeps the field in view
- **AND** it scrolls freely again once the field loses focus

#### Scenario: Resolving a focused answer removes the answering state
- **WHEN** answering, rejecting, or a remote update removes a focused request
  field, including on a browser that emits no focusout for a removed node
- **THEN** the editing and answering state is cleared and the detached field no
  longer holds the transcript
- **AND** the normal tabs and chrome return and the transcript can scroll freely

#### Scenario: Answering temporarily preserves the reader's follow choice
- **WHEN** a reader following the newest content answers a request and its
  temporary positioning hold ends
- **THEN** following resumes for the agent's next message
- **AND** a reader who was already reading older content is not forced to follow
- **AND** an explicit transcript gesture or Latest action ends the answer hold

#### Scenario: A live refresh preserves an actual answer hold
- **WHEN** an authoritative snapshot refresh cancels pending scroll work while a
  focused request field is held in its parent or drill-down timeline
- **THEN** the retained field is held again after the refresh
- **AND** a hold already ended by explicit reader action is not resurrected

#### Scenario: Dragging a question choice scrolls the conversation
- **WHEN** an upward transcript drag starts on a radio or checkbox choice
- **THEN** following pauses as it does for the same drag starting on its label
- **AND** caret gestures inside text-editing controls do not pause following

#### Scenario: A keyboard resize and pan together keep the answer visible
- **WHEN** a touch user is answering a request and the visual viewport's height
  and offset change together while the chat surface retains its layout height
- **THEN** the focused field and its submit and cancel controls are repositioned
  inside the new visible band without waiting for another viewport notification
- **AND** a subsequent pan with no height change does not reposition the transcript

#### Scenario: A direct focus transfer holds the new answer field
- **WHEN** focus moves directly between two independently answerable request
  fields without leaving the answering state
- **THEN** subsequent platform autoscroll is corrected for the newly focused
  field rather than the previous field
- **AND** the previous field's timeline hold is released

#### Scenario: Returning with retained answer focus restores the hold
- **WHEN** the app returns from the background with a request's answer field
  still focused and without a new focus event
- **THEN** the field's timeline hold is restored in its parent or drill-down
  transcript
- **AND** later caret autoscroll is corrected after foreground recovery settles

#### Scenario: Answering a request on touch puts the chrome under the keyboard
- **WHEN** a touch user focuses a request's free-form answer field and the
  software keyboard opens while the task, subagent and background-task tracks
  are populated and the conversation has a composer
- **THEN** the composer and the pinned tracks lie beneath the keyboard's edge
  rather than above it
- **AND** the chat header remains visible
- **AND** the answer field and the request's submit and cancel controls are
  inside the visible viewport
- **AND** the field and its submit and cancel controls sit directly above the
  keyboard's edge, with the conversation filling the band above them
- **AND** the composer and the pinned tracks are back above the keyboard's
  former edge once it dismisses

#### Scenario: A parent request pill cannot override child answer clearance
- **WHEN** a parent request is outstanding while a child request is answered in
  the pushed drill-down with the keyboard open
- **THEN** the answering keyboard inset takes precedence over the pill's normal
  reservation even if the pill's hidden attribute is unset
- **AND** the child's field and action row remain above the keyboard

#### Scenario: Focusing the answer field does not zoom the page
- **WHEN** a touch user focuses a request's free-form answer field
- **THEN** the page's scale is unchanged
- **AND** the field's text renders at the same size as the composer's

### Requirement: Conversation file references navigate through UatuCode safely

Workspace-relative file references in assistant content or normalized file-change activity SHALL offer Preview navigation for targets within watched roots and reveal supplied lines on activation. Desktop navigation MUST NOT hide, collapse or resize Chat; touch SHALL switch to Preview. Outside-root absolute paths, traversal attempts and unresolved targets MUST NOT become navigable workspace links.

#### Scenario: A user activates a file reference in assistant content or normalized file-change activity
- **WHEN** assistant content or normalized file-change activity displays a file reference, or the user activates it
- **THEN** Workspace-relative file references in assistant content or normalized file-change activity SHALL offer navigation to the corresponding UatuCode document preview when the target is within the watched roots.
- **AND** Activating such a reference SHALL open the document in Preview and reveal the referenced line when supplied; in desktop mode this MUST NOT hide, collapse, or resize the Chat panel, and in touch mode it SHALL switch to the Preview tab.
- **AND** Absolute paths outside the watched roots, traversal attempts, and unresolved targets MUST NOT be exposed as navigable workspace links.

#### Scenario: Assistant references a watched source line
- **WHEN** assistant content references `src/app.ts:42` and that file is in the watched workspace
- **THEN** activating the reference opens that document in Preview at line 42
- **AND** in desktop mode the conversation remains visible beside it

#### Scenario: Outside path is not navigable
- **WHEN** provider output references an absolute path outside every watched root or contains traversal outside the workspace
- **THEN** Chat renders it as inert text rather than a UatuCode navigation action

### Requirement: Chat reads at its own density and tiers its surfaces

Chat SHALL use its own consistent reading density without changing Preview scale. Pinned progress tracks SHALL form a distinct present-state tier in both themes without relying on colour alone.

#### Scenario: A narrow Chat surface renders transcript, Markdown, requests, tracks, and composer beside Preview
- **WHEN** Chat renders its transcript, Markdown, requests, tracks and composer at any panel width or UI mode
- **THEN** The Chat surface SHALL set a reading density of its own rather than inheriting the document preview's prose scale, so that a conversation read in a narrow side panel shows several turns at once.
- **AND** That density MUST apply to the whole surface — transcript, rendered assistant Markdown, requests, pinned tracks, and composer — so that no region is left at a scale that disagrees with the rest.
- **AND** The document preview's own reading scale SHALL be unaffected.

#### Scenario: Pinned progress tracks appear above the composer in either colour scheme
- **WHEN** pinned progress tracks appear above the composer in either colour scheme
- **THEN** Chat SHALL present its pinned progress tracks as a tier distinct from the transcript entries above them, so a reader can tell at a glance which part of the surface reports the present state.
- **AND** That distinction MUST NOT rely on colour alone, and MUST hold under both the light and the dark colour scheme.

#### Scenario: The conversation is denser than the preview
- **WHEN** the same viewport shows the rendered document and the Chat transcript
- **THEN** Chat renders its conversation at a smaller reading scale than the document preview
- **AND** the document preview's own scale is unchanged

#### Scenario: Every chat region shares the scale
- **WHEN** a conversation shows assistant Markdown, an activity row, a request card, a pinned track, and the composer
- **THEN** all of them read at Chat's scale
- **AND** no region reads at the document preview's scale

#### Scenario: Live tracks are distinguishable from the transcript
- **WHEN** a conversation is running with an active task list and running subagents
- **THEN** the pinned tracks are distinguishable from the transcript entries above them
- **AND** the distinction is carried by something other than colour alone

#### Scenario: The tier survives both colour schemes
- **WHEN** the surface is rendered under the light scheme and under the dark scheme
- **THEN** the pinned tracks remain distinguishable from the transcript in both

### Requirement: Chat lets the user choose how hard the model reasons

Where supported, Chat SHALL offer the selected model's advertised reasoning variants as a remembered per-conversation prompt configuration. Models without variants and agents without the capability SHALL expose no control.

#### Scenario: A user selects reasoning for the next prompt on a model with or without advertised variants
- **WHEN** Chat displays reasoning configuration for an agent and a model, with or without advertised variants, or the user selects a variant
- **THEN** Where the agent declares the reasoning-variant capability, Chat SHALL let the user choose how hard the selected model reasons, from the named ways of thinking that model advertises — such as thinking harder or faster.
- **AND** The choice SHALL be scoped to how a prompt runs, sent with the prompt rather than changing the model, and SHALL be remembered per conversation as the model choice is.
- **AND** A model that advertises no such ways offers no choice, and where the capability is undeclared the control is absent rather than shown empty.

#### Scenario: A model's reasoning variants are offered and sent
- **WHEN** the selected model advertises reasoning variants and the user chooses one
- **THEN** the choice is presented as how the prompt runs, not as a different model
- **AND** the next prompt is sent with that variant
- **AND** the choice is remembered for the conversation

#### Scenario: A model without variants offers no reasoning control
- **WHEN** the selected model advertises no reasoning variants
- **THEN** no reasoning control is shown for it

#### Scenario: An unknown variant is refused
- **WHEN** a prompt is sent with a variant the selected model does not advertise
- **THEN** the server refuses it rather than forwarding it

#### Scenario: The control is absent when the capability is undeclared
- **WHEN** the agent does not declare the reasoning-variant capability
- **THEN** no reasoning control appears
- **AND** the capabilities the agent does declare are unaffected

### Requirement: A subagent's transcript opens as a drill-down from its parent

Subagent transcripts SHALL open from their parent as drill-downs, not picker conversations, without changing parent selection. The parent and its requests SHALL remain reachable, and returning SHALL restore the parent through a first-class return path.

#### Scenario: The user discovers or opens a subagent transcript from its parent row
- **WHEN** the user discovers or opens a subagent transcript from its parent row
- **THEN** A subagent's transcript SHALL be reached from its parent conversation — the subagent row that represents it — and SHALL NOT be presented as an entry in the conversation picker, which lists the conversations a user can start and resume.
- **AND** Opening a subagent's transcript SHALL NOT change which conversation the picker shows as selected: the parent remains the selected conversation.

#### Scenario: The user opens a subagent transcript on a phone stack or desktop split
- **WHEN** the user opens a subagent transcript on a phone stack or desktop split
- **THEN** Opening a subagent's transcript SHALL present it as a layer over the parent with a first-class way back to the parent.
- **AND** Where the surface navigates as a stack — a phone — this SHALL be a push with the platform's back gesture returning to the parent.
- **AND** Where the surface shows the parent alongside — the desktop split — the child SHALL open as an inline drill-down that keeps the parent in view, with a return affordance.

#### Scenario: A parent or sibling request needs an answer while a child transcript is open
- **WHEN** a parent or sibling request needs an answer while a child transcript is open
- **THEN** While a subagent's transcript is open, the parent SHALL remain reachable and its pending requests answerable, so a request the parent or another subagent is waiting on is not trapped behind the open child.

#### Scenario: The reader returns from a child transcript to its parent
- **WHEN** the reader returns from a child transcript to its parent
- **THEN** Returning from a subagent's transcript SHALL restore the parent as it was, without the child persisting as a pseudo-conversation and without the return depending on re-selecting the parent from a list.

#### Scenario: A subagent transcript is not a picker entry
- **WHEN** a conversation has run subagents
- **THEN** the conversation picker lists only conversations the user can start and resume
- **AND** no subagent transcript appears in it

#### Scenario: Opening a subagent drills down without changing the selected conversation
- **WHEN** the user opens a subagent's transcript from its row
- **THEN** the transcript opens as a layer over the parent
- **AND** the picker still shows the parent as the selected conversation

#### Scenario: Returning to the parent is first-class
- **WHEN** a subagent's transcript is open
- **THEN** there is a way back to the parent that does not require re-selecting it from a list
- **AND** returning restores the parent as it was

#### Scenario: The parent stays answerable behind an open child
- **WHEN** a subagent's transcript is open and the parent has a pending request
- **THEN** the parent's request remains reachable and answerable

#### Scenario: Touch navigates as a stack
- **WHEN** the surface navigates as a stack and the user opens a subagent's transcript
- **THEN** it is pushed as a screen
- **AND** the platform back gesture returns to the parent

### Requirement: Chat reports context usage and subagent cost

Where the context capability is declared, Chat SHALL show live context fill against the model limit and attribute each subagent's own-task model and tokens. Missing capability or usage SHALL not produce invented values or degrade other functionality.

#### Scenario: An agent declares or omits context reporting and a subagent has model or usage metadata
- **WHEN** an agent declares or omits context reporting, with or without available subagent model or usage metadata
- **THEN** Where the agent declares the context capability, Chat SHALL report how full the conversation's context window is, against the selected model's limit, and SHALL attribute each subagent with the model it ran and the tokens it consumed.
- **AND** Each SHALL be gated on that declared capability: undeclared, the readout or figure is absent rather than empty, and its absence SHALL NOT degrade the rest.

#### Scenario: The reader opens a conversation, inspects context, or receives compaction and utilization reports
- **WHEN** the reader opens a conversation, inspects context, or receives compaction and utilization reports
- **THEN** The context report SHALL be legible without the user opening anything, and MAY expand to the breakdown the agent reports — input, cache, and output, or the agent's own categories when it reports them.
- **AND** It reports the live window fill after the latest model call, not lifetime spend and not a sum over a turn, and SHALL be populated when an existing conversation is opened, not only after a new turn is taken.
- **AND** When the agent reports that it compacted the conversation, the fill SHALL follow the post-compaction figure.
- **AND** Where the agent reports plan utilization, the readout MAY present it alongside the fill, distinct from it.

#### Scenario: A subagent executes one or several tasks, possibly launching descendants
- **WHEN** a subagent executes one or several tasks, possibly launching descendants
- **THEN** A subagent's attribution SHALL reflect the subagent's own session — a subagent may run a different model from its parent — and SHALL state the tokens that subagent consumed for the task the row represents, taken from its child session onto the launching conversation.
- **AND** Where the agent gives one subagent several tasks, each task's row SHALL state that task's tokens alone, and tokens consumed by subagents the subagent launched SHALL NOT be added to its row.
- **AND** The model MAY be shown before any usage is known.
- **AND** When the agent has not reported usage for a subagent, the row SHALL stay readable and SHALL NOT assert a figure it does not have.

#### Scenario: The context indicator reads without being opened
- **WHEN** a conversation has exchanged turns and the agent declares context reporting
- **THEN** the surface shows how full the context window is against the model's limit
- **AND** the fill is legible without expanding anything

#### Scenario: The fill never exceeds the window from a long turn
- **WHEN** a turn made many model calls against a partly full window
- **THEN** the presented fill is that of the latest call
- **AND** it is not the calls summed

#### Scenario: The indicator is populated on opening an existing conversation
- **WHEN** the user opens a conversation that already has assistant turns
- **THEN** the context fill is shown from that history, before any new turn

#### Scenario: The context breakdown expands
- **WHEN** the user opens the context indicator
- **THEN** it shows the input, cache, and output the agent reported, or the agent's own categories when reported

#### Scenario: A subagent row names its model and tokens
- **WHEN** a subagent has run and the agent reports its model and token counts
- **THEN** its row states which model it ran and how many tokens it consumed

#### Scenario: A subagent's second task states its own tokens
- **WHEN** a subagent that finished one task is given a further task
- **THEN** the second task's row states the tokens of the second task alone
- **AND** the first task's row is unchanged by it

#### Scenario: A subagent without reported usage stays readable
- **WHEN** a subagent has not yet reported usage, or the agent does not report it
- **THEN** the row still names the subagent and its status
- **AND** no token figure is asserted for it

#### Scenario: An undeclared context capability leaves nothing behind
- **WHEN** the agent does not declare the context capability
- **THEN** the context indicator and the subagent token figure are absent
- **AND** the capabilities the agent does declare are unaffected

### Requirement: Chat reports what an OpenCode conversation has cost

Chat SHALL report provider-priced conversation cost from history and live updates, counting each assistant message once across all descendant sessions. A consistent receipt SHALL offer remembered agent, type, and model itemizations; own-task attribution and unknown or zero pricing SHALL remain truthful.

#### Scenario: OpenCode reports assistant-message cost while a conversation and its descendant sessions execute
- **WHEN** OpenCode reports assistant-message cost in a conversation or any descendant session
- **THEN** Where OpenCode reports a cost for an assistant message, Chat SHALL present the conversation's accumulated cost in the same place a Claude Code conversation's session totals appear: the composer's usage chip reads the conversation's cost when the agent reports no plan windows, and the usage readout's conversation block states the total.
- **AND** The figure SHALL be the sum of the cost OpenCode reported per assistant message, in the currency OpenCode reports it, across the conversation and every subagent session beneath it at any depth.
- **AND** Each message SHALL be counted once — however many times it was restated while it streamed, and however many tasks the subagent that produced it was given.

#### Scenario: An existing conversation opens or messages report zero or missing cost
- **WHEN** an existing conversation opens or messages report zero or missing cost
- **THEN** The cost SHALL be populated when an existing conversation is opened, from its stored history, not only after a new turn is taken; it SHALL NOT be qualified as "since" a later time, because the stored history carries every message's cost.
- **AND** When every message in the conversation reports a cost of zero — a model OpenCode has no price for — Chat SHALL show no cost rather than a zero figure.
- **AND** A message for which OpenCode reports no cost contributes nothing and SHALL NOT be presented as zero.

#### Scenario: The reader views or switches the conversation receipt itemization
- **WHEN** the reader views or switches the conversation receipt itemization
- **THEN** The conversation block SHALL read as a receipt: line items, each with its tokens and cost, closed by a total line, where the line items' costs sum to the stated total.
- **AND** It SHALL offer three itemizations of that same total — by agent, by agent type, and by model — through one control that shows one itemization at a time.
- **AND** Switching itemization SHALL NOT change the total, and the chosen itemization SHALL be remembered on the device across conversations and reloads.

#### Scenario: The receipt is itemized by agent across main-agent names, reused tasks, and nested subagents
- **WHEN** the receipt is itemized by agent across main-agent names, reused tasks, and nested subagents
- **THEN** Itemized by agent, the block SHALL list:
  - the main agent under the name OpenCode gives it, identified as the main agent, with one line per name the conversation ran under; an agent OpenCode runs on the conversation's behalf to summarise it SHALL have its own line saying so; where OpenCode names no agent the line reads "This agent";
  - one line per task given to a subagent — labelled by the subagent's kind and the task's description, with the model it ran — stating the tokens and cost of that task alone: what the subagent spent answering that task, excluding any other task it was given and excluding any subagent it launched;
  - a task given to a subagent that already has a line as its own line, identifying the earlier line as the same agent;
  - a subagent launched by a subagent as its own line beneath its launcher's line, visibly subordinate to it, at every depth.

#### Scenario: The receipt is itemized by agent type or by model
- **WHEN** the receipt is itemized by agent type or by model
- **THEN** Itemized by agent type, the block SHALL list the main agent lines as above and one line per kind of subagent, stating how many distinct subagents of that kind worked in the conversation at any depth, with their combined tokens and cost, and stating the number of tasks where it exceeds the number of subagents.
- **AND** Itemized by model, the block SHALL list one line per model with the tokens and cost of every agent that ran it, naming which agents those were.

#### Scenario: Subagent task rows and an opened child transcript display their own costs
- **WHEN** subagent task rows and an opened child transcript display their own costs
- **THEN** A subagent's timeline row and its row in the composer's subagent list SHALL state the same own-task cost as its receipt line, in the conversation that launched it and inside an opened subagent transcript alike.
- **AND** The header of an opened subagent transcript SHALL state what that subagent itself spent across every task it was given, excluding subagents it launched.
- **AND** A line whose session reported no cost SHALL be listed without a figure, not with zero.

#### Scenario: The chip reads the conversation's cost
- **WHEN** an OpenCode conversation has exchanged turns and OpenCode reported a cost for its assistant messages
- **THEN** the composer's usage chip reads the accumulated cost as "this conversation"
- **AND** opening the readout shows the total and the line items of the remembered itemization

#### Scenario: A restated message is counted once
- **WHEN** OpenCode restates one assistant message's cumulative cost several times while it streams
- **THEN** the conversation total counts that message's latest figure once

#### Scenario: Cost is restored from history
- **WHEN** the user opens an OpenCode conversation whose assistant messages carry costs
- **THEN** the chip and readout show the cost from that history before any new turn
- **AND** the readout block is titled for the whole conversation, not "since" a time

#### Scenario: A free model shows no cost
- **WHEN** every assistant message in the conversation reports a cost of zero
- **THEN** no cost figure is shown on the chip or in the readout

#### Scenario: The readout attributes cost per agent
- **WHEN** a conversation launched two subagents whose child sessions reported cost, on the same model as the main agent
- **THEN** itemized by agent, the conversation block lists the main agent's own spend and one line per subagent task with its label, model, tokens, and cost
- **AND** the chip's figure and the model line for that model include the subagents' spend

#### Scenario: The receipt adds up
- **WHEN** a priced conversation ran a main agent, several subagents, a subagent given two tasks, and a subagent that launched its own subagent
- **THEN** in each of the three itemizations the line items' costs sum to the total line
- **AND** the total line, the block's stated total, and the chip state the same figure
- **AND** that figure equals the sum of the costs OpenCode reported for every assistant message in the conversation and the subagent sessions beneath it

#### Scenario: A subagent given a second task is billed once
- **WHEN** the main agent gives a subagent a task, and after it finishes gives the same subagent a further task
- **THEN** the receipt lists two lines for that subagent, each stating only the spend of its own task
- **AND** the second line identifies the first as the same agent
- **AND** the two lines together equal what that subagent's session reported, and the total counts it once
- **AND** this holds while the second task streams and after the conversation is reopened

#### Scenario: Work between two tasks belongs to the task before it
- **WHEN** a subagent given two tasks summarised its own conversation partway through the first, so that its session holds prompts that are not tasks
- **THEN** the first task's line includes what the subagent spent summarising and continuing
- **AND** the second task's line states only what the subagent spent answering the second task

#### Scenario: Nested subagents are listed beneath their launcher
- **WHEN** a subagent launched a subagent, which launched a further subagent
- **THEN** each has its own line beneath its launcher's line, visibly subordinate to it
- **AND** the launcher's line states only the launcher's own spend

#### Scenario: Main agents are named
- **WHEN** a conversation ran under one named main agent, was switched to another, and OpenCode summarised it along the way
- **THEN** the receipt lists one line per main agent name, each identified as the main agent
- **AND** the summarising agent has its own line saying what it did
- **AND** no line reads "This agent"

#### Scenario: Types count distinct subagents
- **WHEN** a conversation ran three subagents of one kind, one of them given two tasks, and two nested subagents of another kind
- **THEN** the itemization by type lists the first kind with a count of three and states four tasks
- **AND** lists the second kind with a count of two and no task count

#### Scenario: Models name who ran them
- **WHEN** the user itemizes the receipt by model
- **THEN** each model's line states the tokens and cost of every agent that ran it and names those agents

#### Scenario: The itemization choice is remembered
- **WHEN** the user chooses an itemization, opens another conversation, and reloads the page
- **THEN** the readout opens on the chosen itemization

#### Scenario: A subagent row states its cost in context
- **WHEN** a subagent's child session reported cost with its tokens
- **THEN** the subagent's timeline row and its row in the composer's subagent list state that task's own cost, equal to its receipt line
- **AND** opening the subagent's transcript shows in its header what that subagent itself spent across its tasks

#### Scenario: An unpriced subagent is listed without a figure
- **WHEN** a subagent's child session reported tokens but no cost
- **THEN** its line in the conversation block names it and its tokens and asserts no cost

#### Scenario: Cost rides the usage wire
- **WHEN** a client validates a conversation snapshot or update carrying a usage record with a cost, a subagent row carrying the lines beneath it, or a usage record naming the agent that produced it
- **THEN** the record is accepted under the workspace API revision that introduced it

### Requirement: The composer's subagent list counts subagents and tasks distinctly

Desktop subagent summaries SHALL count distinct subagents separately from tasks. Touch SHALL use one canonical worker projection counting execution occurrences without losing historical launch, task, model, or cost attribution.

#### Scenario: A desktop conversation assigns one or several tasks to each subagent
- **WHEN** a desktop conversation assigns one or several tasks to each subagent
- **THEN** On desktop the composer's subagent list SHALL keep one row per task, and its summary line SHALL NOT count a subagent once per task it was given.
- **AND** Where every task went to its own subagent the summary SHALL count subagents as it does today.
- **AND** Where a subagent was given more than one task, the summary SHALL state the number of distinct subagents and the number of tasks.

#### Scenario: Touch consolidates subagent and background worker lists with launcher aliases
- **WHEN** touch consolidates subagent and background worker lists with launcher aliases
- **THEN** On touch, the compact worker disclosure SHALL replace duplicate pinned subagent/background lists with one canonical row projection and renderer.
- **AND** The summary and rows SHALL count the same worker execution occurrences rather than launcher aliases.
- **AND** Ordinary foreground shell commands SHALL remain in the timeline and SHALL NOT count as workers; actual background shell tasks SHALL count.
- **AND** Historical timeline launch/result records, distinct task references and their model/cost attribution SHALL remain available through inspection and the timeline; consolidation SHALL NOT create a second lifecycle or combine separate worker executions into one.

#### Scenario: One task per subagent reads as before
- **WHEN** a desktop conversation launched four subagents with one task each and all have finished
- **THEN** the summary reads "4 subagents finished"

#### Scenario: A subagent given two tasks is one subagent
- **WHEN** a desktop conversation launched three subagents, gave one of them a second task, and all have finished
- **THEN** the list shows four rows
- **AND** the summary reads "3 subagents · 4 tasks finished"

#### Scenario: Touch worker summary avoids launcher duplicates
- **WHEN** two launching task references refer to the same confirmed live worker occurrence
- **THEN** the touch summary counts one working occurrence
- **AND** expanding it shows one inspection row, with both launch references and their attribution retained in the timeline rather than duplicate worker rows

### Requirement: Chat composer actions keep a stable responsive layout

The composer SHALL keep responsive configuration, status, Send, and separate Stop controls stable and accessible across lifecycle changes. Desktop rails and compact touch keyboard layouts SHALL retain their specified target, spacing, viewport, and safe-area behavior. Later fixed-delivery and fine-pointer desktop-density rules supersede earlier delivery-selector and comfortable desktop target geometry.

#### Scenario: Composer lifecycle or delivery-menu state changes at unchanged panel dimensions and editing state
- **WHEN** composer lifecycle or delivery-menu state changes at unchanged panel dimensions and editing state
- **THEN** The Chat composer SHALL present context usage, one flexible configuration trigger, routine status, a persistent visible Send action, and a separate Stop action, subject to the compact touch layout below.
- **AND** A capability-gated delivery selector SHALL precede Send where supported.
- **AND** Send SHALL NOT become Stop while work runs.
- **AND** Each submission control SHALL have a target at least 44×44 CSS pixels with at least 8px separation from adjacent submission controls and a visible keyboard-focus indicator.
- **AND** Stop SHALL remain in place but disabled when no turn is live.
- **AND** Routine lifecycle changes and opening the delivery menu MUST NOT move or resize these controls at unchanged panel dimensions and keyboard/editing state.

#### Scenario: A desktop panel narrows or widens, configuration truncates, or an actionable failure appears
- **WHEN** a desktop panel narrows or widens, configuration truncates, or an actionable failure appears
- **THEN** Wide desktop panels SHALL use one non-wrapping rail.
- **AND** At narrow desktop widths steering-capable composers SHALL use two deliberate rails: context/configuration/status above delivery/Send/Stop.
- **AND** Desktop composers without a delivery selector SHALL keep one compact rail without reserving an empty delivery row.
- **AND** The configuration label SHALL truncate as needed, without shrinking submission targets or causing horizontal overflow.
- **AND** Resizing MAY switch the entire rail arrangement; individual desktop controls MUST NOT wrap independently.
- **AND** touch primary controls remain reachable at enlarged text sizes in the compact composition layout
- **AND** Actionable failures SHALL remain explanatory text outside the routine status footprint, without horizontally reordering the controls.
- **AND** Textarea autosizing remains independent of rail stability.

#### Scenario: Touch software-keyboard or short landscape geometry activates the compact parent composer
- **WHEN** touch software-keyboard or short landscape geometry activates the compact parent composer
- **THEN** When the touch software-keyboard visual band is at most 450px, or a touch landscape band is at most 390px with width at least 600px, the composer SHALL instead use compact input and submission rows, retaining the current inline picker and primary actions.
- **AND** Short touch headers SHALL omit the identity row.
- **AND** Parent-composer viewport handling SHALL keep the header and submission controls within the available visual band without scrolling the outer surface wherever measured physical minima fit; the physical-minimum exception in Desktop work shares measured panel space SHALL govern impossible enlarged bands.
- **AND** Transcript and dock body scrolling remain separate.
- **AND** Existing interaction-request answering behavior is unchanged.
- **AND** Hardware-keyboard editing SHALL retain the bottom safe-area inset without doubling it under a software keyboard.

#### Scenario: Routine lifecycle keeps trailing controls stationary
- **WHEN** a prompt moves through ready, sending, working, cancelling, and ready states at unchanged Chat-panel dimensions and keyboard/editing state
- **THEN** the status, Send, Stop, and supported delivery selector retain their dimensions and positions
- **AND** Stop is enabled only during live work and unavailable during its cancellation request

#### Scenario: Narrow desktop panel truncates configuration
- **WHEN** a desktop Chat panel is too narrow for one rail
- **THEN** the submission controls occupy one separate non-wrapping row below settings/status
- **AND** their minimum target sizes and separation are preserved without horizontal overflow
- **AND** the configuration label truncates to its available width

#### Scenario: Context usage does not displace the trailing action
- **WHEN** context usage becomes available or its displayed value changes
- **THEN** it does not move the routine status, Send, or Stop
- **AND** it does not change the number of action rows

#### Scenario: Failure remains explanatory
- **WHEN** sending, cancellation, or the active turn fails
- **THEN** Chat displays explanatory failure text
- **AND** the action rails keep their horizontal ordering

#### Scenario: Non-steering narrow composer stays compact
- **WHEN** an agent without steering is shown in a desktop composer at most 30rem wide
- **THEN** settings, status, Send and Stop share one rail with no empty selector row

#### Scenario: Delivery choice explains its shortcuts and restores focus
- **WHEN** the delivery menu opens
- **THEN** its current choice has a visible check and the device-appropriate submit hint (Enter on desktop, Send / Ctrl+Enter on touch), and the other choice has Alt+Enter
- **AND** Escape restores the previously focused control, including the composer on touch
- **AND** the selector title explains Send's delivery and whether Enter submits or adds a newline, or why selection is disabled while idle
- **AND** busy Send's accessible name says Send as steer, Send to queue, or Queue message as appropriate
- **AND** enabled Send text has at least 4.5:1 contrast in light and dark themes

#### Scenario: Gap taps do not activate adjacent actions
- **WHEN** a touch lands in the gap between submission controls
- **THEN** no prompt or cancellation is sent, even if the browser attempts to retarget that tap

#### Scenario: An outside delivery-menu tap consumes activation
- **WHEN** a touch user taps outside the open delivery menu over an underlying Revert or other action
- **THEN** the menu closes without activating that action or altering the draft
- **AND** Escape retains its existing focus-restoration behavior

#### Scenario: Compact parent composer stays in the keyboard band
- **WHEN** loaded work is shown at 390px width with a 380px or 450px visual band, or at 844px landscape width with a 230px band
- **THEN** Send, delivery selection and Stop remain fully inside the band with their target sizes and gaps preserved
- **AND** with both cards collapsed at least 40% of that band remains available to the transcript wherever measured minimum headers, whole actions and composer physically permit it; expanded cards use the measured small-strip policy in Desktop work shares measured panel space, and insufficient short bands retain both headers

#### Scenario: Loaded hardware-keyboard portrait preserves conversation space
- **WHEN** the 390×844 touch parent composer is focused without a software keyboard, with 47px top and 34px bottom safe insets, workers and pending messages
- **THEN** with both cards collapsed the aggregate dock is capped at 24% of visual height and the transcript retains at least 40% of visual height in the standard-size layout; with either expanded, measured small-strip capacity replaces those percentages
- **AND** the composer respects the bottom safe inset and its submission controls remain reachable

### Requirement: Chat configuration uses one adaptive searchable picker

Chat SHALL expose supported configuration through one adaptive searchable picker and summary trigger. Search SHALL use the available model inventory; staged values SHALL travel with the next prompt, and unknown or unavailable effective values MUST NOT become false selections.

#### Scenario: The composer displays the active agent's supported configuration values
- **WHEN** the composer displays the active agent's supported configuration values
- **THEN** Chat SHALL expose model, mode, and reasoning configuration through one configuration trigger rather than separate composer controls.
- **AND** The trigger SHALL summarize the displayed model when model selection is supported and SHALL have an accessible name that identifies every displayed configuration value.
- **AND** A capability the active agent does not declare MUST be absent from both the trigger summary and picker.

#### Scenario: The reader opens the configuration picker on desktop or touch
- **WHEN** the reader opens the configuration picker on desktop or touch
- **THEN** The picker SHALL use one interaction layer.
- **AND** On desktop it SHALL remain constrained to the Chat panel and appear in relation to the trigger.
- **AND** In touch mode it SHALL appear as a bottom sheet sized to the current visual viewport above global Chat navigation.
- **AND** It MUST NOT open a second nested sheet for model selection.

#### Scenario: The reader searches the available model inventory or receives no matching results
- **WHEN** the reader searches the available model inventory or receives no matching results
- **THEN** Model search SHALL operate on the already available model inventory and match case-insensitively across model name, provider name, provider identifier, and model identifier.
- **AND** Results SHALL identify the human-readable model first, show provider and provider/model identifiers as secondary information, group available models by provider, expose a result count, and distinguish the displayed selection without relying on colour alone.
- **AND** Empty groups SHALL disappear when filtering, and an empty result SHALL be stated explicitly.

#### Scenario: The reader changes configuration or the effective model is unknown or unavailable
- **WHEN** the reader changes configuration or the effective model is unknown or unavailable
- **THEN** Choosing model, mode, or reasoning SHALL update the displayed staged configuration immediately and SHALL preserve the existing rule that staged values travel with the next prompt.
- **AND** An unavailable effective value SHALL remain identifiable but MUST NOT be offered as a newly selectable value.
- **AND** Where no explicit model override exists, the picker SHALL describe the agent-controlled choice without claiming a model Uatu does not know.

#### Scenario: Desktop opens one anchored configuration panel
- **WHEN** a desktop user activates the configuration trigger
- **THEN** one configuration panel opens within the Chat panel's usable bounds
- **AND** model search, mode, and applicable reasoning controls are available in that panel

#### Scenario: Touch opens one viewport-aware bottom sheet
- **WHEN** a touch user activates the configuration trigger
- **THEN** one bottom sheet opens above Chat navigation within the current visual viewport
- **AND** focusing model search keeps the sheet operable above the software keyboard

#### Scenario: Search matches model identity fields
- **WHEN** the user enters text matching a model name, provider name, provider id, or model id with different letter casing
- **THEN** the corresponding model remains in the filtered result list
- **AND** the result count reflects the filtered inventory

#### Scenario: Search has no matches
- **WHEN** no model matches the search text
- **THEN** the picker states that no models match
- **AND** it does not show empty provider groups

#### Scenario: Selection remains staged until the next prompt
- **WHEN** the user changes the model, mode, or reasoning and closes the picker
- **THEN** the composer trigger reflects the staged configuration
- **AND** the next prompt carries that configuration under the existing conversation configuration rules

#### Scenario: Current unavailable model remains honest
- **WHEN** a conversation reports a current model that is absent from the available inventory
- **THEN** the picker identifies that current model as unavailable
- **AND** it does not allow the unavailable value to be selected as a new override

#### Scenario: Undeclared configuration capability is absent
- **WHEN** the active agent does not declare model, mode, or reasoning support
- **THEN** the corresponding value and control are absent from the picker
- **AND** other declared configuration capabilities remain usable

#### Scenario: Picker focus is contained and restored
- **WHEN** the user opens the picker, navigates results with the keyboard, and dismisses it
- **THEN** focus remains within the open picker
- **AND** dismissal returns focus to the configuration trigger

### Requirement: Routine Chat status is compact and accessible
Chat SHALL represent routine composer states in an always-present fixed-size status region. Each state SHALL have a programmatic name and a non-colour-only visual distinction. Active-state motion MUST stop when the user prefers reduced motion. Significant transitions SHALL be announced without announcing elapsed-time ticks, and elapsed working time SHALL remain available outside the fixed visible footprint.

#### Scenario: Assistive technology receives the current state
- **WHEN** the routine status changes without variable-width visible text
- **THEN** the current state has an accessible name
- **AND** significant transitions are announced without repeating every streaming update

#### Scenario: Reduced motion removes continuous animation
- **WHEN** the user prefers reduced motion and Chat is working
- **THEN** the state remains visually distinguishable
- **AND** no continuous status animation runs

### Requirement: Completed assistant content has scoped copy actions

Completed assistant code blocks SHALL offer safe, accessible, code-only copying without whole-answer copy actions. Feedback and clipboard failure SHALL preserve geometry and content and MUST NOT produce uncaught errors.

#### Scenario: A completed assistant message contains a fenced code block
- **WHEN** a completed assistant message contains a fenced code block
- **THEN** Each fenced code block inside completed assistant content SHALL offer an accessible copy action that writes only the code content with its source line breaks, excluding syntax markup, fence delimiters, and controls.
- **AND** Completed assistant messages MUST NOT present a whole-answer copy action.

#### Scenario: A keyboard or coarse-pointer reader copies code and clipboard access succeeds or fails
- **WHEN** a keyboard or coarse-pointer reader copies code and clipboard access succeeds or fails
- **THEN** Code-block copy controls SHALL be keyboard operable and directly reachable on coarse-pointer devices.
- **AND** Success and failure feedback SHALL be perceivable without resizing the message, code block, or composer.
- **AND** Clipboard failure MUST leave conversation content unchanged and MUST NOT produce an uncaught error.

#### Scenario: Copy a completed assistant answer
- **WHEN** the user views a completed assistant message containing prose or fenced code
- **THEN** the message does not present an action to copy the whole answer
- **AND** each completed fenced code block retains its own scoped copy action

#### Scenario: Copy one fenced code block
- **WHEN** the user activates copy for a fenced code block in completed assistant content
- **THEN** the clipboard receives only that block's code with its source line breaks
- **AND** syntax markup, fences, and control labels are excluded

#### Scenario: Streaming answer is not presented as complete
- **WHEN** an assistant message is still streaming
- **THEN** it does not present a whole-message copy action
- **AND** completing the message does not add a whole-message copy action

#### Scenario: Touch copy does not depend on hover
- **WHEN** a coarse-pointer user views a fenced code block in completed assistant content
- **THEN** its code-copy action is reachable by tap
- **AND** no hover state is required to reveal it

#### Scenario: Copy feedback preserves geometry
- **WHEN** a code-block copy succeeds or fails
- **THEN** Chat reports the outcome accessibly
- **AND** the message, code block, composer, and surrounding timeline retain their dimensions

#### Scenario: Clipboard failure is contained
- **WHEN** clipboard access is unavailable or rejects the write
- **THEN** conversation content remains unchanged
- **AND** Chat reports failure without an uncaught error

### Requirement: Users can prompt, queue, and cancel the active conversation

Users SHALL be able to submit content, queue follow-ups, edit or remove pending messages, and cancel active work without losing history or drafts. Pending input SHALL remain ordered beside the composer with frozen queued configuration; cancellation SHALL pause it, and fixed Send/Stop semantics SHALL prevent accidental delivery.

#### Scenario: A user submits text or attachments while a conversation is running or its pending bound is reached
- **WHEN** a user submits text or attachments to an idle or running conversation, including at its pending-message bound
- **THEN** The Chat composer SHALL submit a message with content — non-empty text, at least one image attachment, or both — to the selected conversation and clearly distinguish ready, sending, running, interrupted, and failed states.
- **AND** A prompt submitted while the conversation is running SHALL be held in a workspace-owned queue rather than delivered to the agent mid-turn.
- **AND** The exception is a prompt the user explicitly submits as a steer to an agent that declares `steering`, which "OpenCode 2.x conversations can steer the running turn" governs.
- **AND** Pending messages, steers and queued messages alike, SHALL be presented adjacent to the composer as one list in delivery order, with steers listed before queued messages.
- **AND** Each SHALL be visibly labelled with its delivery and SHALL NOT appear as part of the running turn's timeline.
- **AND** While the agent continues to stream output, pending messages SHALL remain adjacent to the composer rather than drifting into the transcript.
- **AND** Pending messages SHALL be bounded per conversation, with steers and queued messages counted together.
- **AND** A submission that would exceed the bound SHALL be refused without altering the pending messages, with the draft preserved.

#### Scenario: A held prompt, skill, slash command, or /reload is delivered, edited, or removed
- **WHEN** a held prompt, skill, slash command, or /reload is delivered, edited, or removed
- **THEN** Every message held in the workspace's queue SHALL stay held until delivery, whatever its kind: prompts, skills, slash commands, and `/reload`.
- **AND** When the running turn ends on its own, the workspace SHALL deliver held messages to the agent one at a time in submission order.
- **AND** Each held message SHALL be delivered under the model, mode, and reasoning variant fixed at its submission.
- **AND** A delivered message SHALL leave the dock and begin its own turn at the end of the timeline.
- **AND** The user SHALL be able to remove any message that is still pending; a removed message is never delivered.
- **AND** Removal of a message that has already been delivered SHALL be refused without altering the conversation.
- **AND** The user SHALL be able to edit a pending message: the message leaves the dock under the same rules as removal, and the invoking client's composer receives its text and attachments.

#### Scenario: The reader cancels work, later resumes a dormant queue, or encounters transport uncertainty
- **WHEN** the reader cancels work, later resumes a dormant queue, or encounters transport uncertainty
- **THEN** The user SHALL be able to cancel an active turn without deleting its completed history.
- **AND** Cancellation SHALL NOT deliver pending messages.
- **AND** They remain pending, removable, and visible, and are presented as paused.
- **AND** The queue stays dormant until the user next submits a prompt, which joins the end of the queue and resumes delivery from its head.
- **AND** The other ways out of the dormant state are switching an entry to steer and Send now.
- **AND** Transport failure SHALL preserve the draft until acceptance is known; uncertain Hub steer actions follow the unconfirmed, no-automatic-replay contract below.

#### Scenario: The reader uses Send, explicit Queue, Stop, or keyboard submission during cancellation
- **WHEN** the reader uses Send, explicit Queue, Stop, or keyboard submission during cancellation
- **THEN** Send SHALL remain visible while work runs and SHALL steer ordinary text on a steering agent, or queue when steering is unsupported.
- **AND** Explicit Queue submission SHALL remain available through the existing hold and Alt/Option+Enter paths; commands and attachments SHALL retain mandatory queue semantics.
- **AND** Send and explicit Queue remain usable without configuring a per-device default or using a delivery selector
- **AND** A separate Stop button SHALL cancel active work without submitting or discarding an unsent draft.
- **AND** Send SHALL be unavailable for an empty draft, during submission, or while a cancellation request is pending.
- **AND** The shared submit path SHALL also refuse keyboard submission during cancellation, preserving the draft and discarding any one-shot delivery override from the refused attempt.

#### Scenario: Visible Send works while busy for every agent
- **WHEN** the user clicks or taps Send with a non-empty draft while work runs
- **THEN** the draft is submitted with the selected delivery, or queued when the agent does not support steering
- **AND** the running turn is not cancelled

#### Scenario: Stop does not send the draft
- **WHEN** the user activates Stop while work runs and an unsent draft exists
- **THEN** only cancellation is requested and the draft remains intact

#### Scenario: Keyboard submission cannot bypass pending cancellation
- **WHEN** a cancellation request is pending and the user presses Enter or Option/Alt+Enter
- **THEN** no prompt is sent and the draft remains intact
- **AND** after cancellation settles, a normal submission uses fixed Steer rather than any Queue override from the refused attempt

The surface SHALL name the agent it is talking to, taking that name from what the agent reports rather than from fixed copy. Text presented to the user SHALL NOT assume a particular agent, so that installing a different agent changes the name shown and nothing else.

The way of working a prompt runs under SHALL be presented as a **mode** — the agent's own named ways of working, such as building or planning. It SHALL NOT be called an agent, because that word names the program Chat talks to.

A control the surface offers the user to start an operation — a picker such as the mode or model chooser — SHALL be presented only when the agent declares the capability behind it. Where that capability is undeclared, the control SHALL be absent rather than shown inert, shown empty, or shown with an error. Reactive interaction controls — those that appear only in response to an agent-raised request, governed by "Users can resolve agent interaction requests in context" — are not covered here: an agent that lacks a capability raises no request of that kind, so the control has nothing to appear for. Absence of a capability SHALL NOT degrade any capability the agent does declare.

#### Scenario: Empty prompt is not submitted
- **WHEN** the composer contains only whitespace and no pending attachments
- **THEN** the send action is unavailable and no mutation is sent

#### Scenario: An image-only message is submittable
- **WHEN** the composer contains only whitespace but at least one pending attachment
- **THEN** the send action is available and the message submits with empty text

#### Scenario: Follow-up queues while the agent works
- **WHEN** the user submits a prompt with queue delivery while the selected conversation is running
- **THEN** the message is held by the workspace rather than delivered to the agent
- **AND** it is presented adjacent to the composer, labelled as queued

#### Scenario: Follow-up on an agent without steering always queues
- **WHEN** the conversation's agent does not declare `steering` and the user submits a prompt while it is running
- **THEN** the message is held and labelled as queued
- **AND** no steer choice is offered

#### Scenario: Commands always queue
- **WHEN** the user submits a skill, a slash command, or `/reload` while the conversation is running, whatever the selected delivery
- **THEN** it is held in the workspace's queue in submission order
- **AND** it is not delivered to the agent mid-turn

#### Scenario: Queued messages stay with the composer while output streams
- **WHEN** the agent continues streaming output after messages were queued
- **THEN** the pending messages remain adjacent to the composer
- **AND** no pending message appears between items of the running turn

#### Scenario: A queued message is delivered when the turn ends
- **WHEN** the running turn completes on its own while messages are held
- **THEN** the workspace delivers the oldest held message to the agent under its submission-time model, mode, and variant
- **AND** it leaves the dock and starts its own turn at the end of the timeline

#### Scenario: A queued message can be removed
- **WHEN** the user removes a message that is still held
- **THEN** it disappears from the dock on every client
- **AND** it is never delivered to the agent

#### Scenario: A full queue refuses further submissions
- **WHEN** a conversation's pending steers and queued messages together are at the bound and the user submits another prompt while the agent works
- **THEN** the submission is refused and the draft is preserved
- **AND** the pending messages are unaffected

#### Scenario: A queued message can be edited
- **WHEN** the user edits a message that is still held
- **THEN** it disappears from the dock on every client and is never delivered
- **AND** the invoking client's composer receives its text and attachments

#### Scenario: Removing an already-delivered message is refused
- **WHEN** a removal arrives for a message the workspace has already delivered to the agent
- **THEN** the removal is refused without altering the conversation
- **AND** the client learns the message is no longer held

#### Scenario: Cancellation preserves completed content
- **WHEN** the user cancels a running turn
- **THEN** OpenCode is asked to abort that turn without resuming
- **AND** content and tool activity already received remain in the timeline with an interrupted outcome

#### Scenario: Cancellation leaves the queue dormant
- **WHEN** the user cancels a running turn while messages are pending
- **THEN** the pending messages remain visible and removable, presented as paused
- **AND** none of them is delivered as a consequence of the cancellation

#### Scenario: A new submission resumes a dormant queue
- **WHEN** the user submits a prompt while the conversation is idle and messages are held from before a cancellation
- **THEN** the new message joins the end of the queue
- **AND** delivery resumes from the head of the queue in submission order

#### Scenario: Submitting while idle sends at once
- **WHEN** the conversation is idle and nothing is held
- **THEN** a submitted prompt starts its turn immediately whatever the selected delivery

#### Scenario: The surface names its agent
- **WHEN** a conversation is open and the agent has reported its identity
- **THEN** the surface names that agent
- **AND** no user-visible text names a different agent

#### Scenario: Ways of working are presented as modes
- **WHEN** the agent offers more than one way of working, such as building and planning
- **THEN** the user selects between them as modes
- **AND** they are not labelled agents

#### Scenario: An undeclared proactive control leaves nothing behind
- **WHEN** the agent does not declare the capability behind a control the surface offers the user to start an operation, such as a mode or model picker
- **THEN** that control is absent from the surface
- **AND** the controls for declared capabilities are unaffected

### Requirement: Users can attach images to a prompt

Where image attachments are supported, the composer SHALL accept paste, drop, and visible file-picker intake, display removable thumbnails, and submit them with or without text. Unsupported files and bound violations SHALL preserve the draft; model limitations SHALL remain discoverable.

#### Scenario: A user pastes, drops, or selects a supported image and submits with or without text
- **WHEN** the user pastes, drops or selects a supported image, or submits pending images with or without text
- **THEN** The Chat composer SHALL accept image attachments in the image formats the agent supports (PNG, JPEG, GIF, WebP) through three intakes: pasting from the clipboard, dragging onto the composer, and an explicit attach control backed by a file picker.
- **AND** The attach control SHALL be visible without hover or keyboard affordances, so touch-only devices can attach images.
- **AND** Pending attachments SHALL be presented at the composer as thumbnails, each removable before send, and SHALL be submitted with the composer text as one message.
- **AND** Text is not a precondition: a message with attachments and no text SHALL be submittable, because the agent accepts image-only prompts.

#### Scenario: A paste contains text and images, or an intake has an unsupported type or exceeds a bound
- **WHEN** a paste contains text and images, or an intake has an unsupported type or exceeds a bound
- **THEN** A paste that carries both text and images SHALL keep both: the text enters the composer and the images become pending attachments.
- **AND** Files of an unsupported type SHALL be refused with a visible explanation, without altering the draft text or the attachments already pending.
- **AND** The number of attachments per message and the size per attachment SHALL be bounded; an intake that would exceed a bound SHALL be refused with a visible explanation, leaving the draft and already-pending attachments unchanged.

#### Scenario: The agent attachment capability or selected model's image support changes
- **WHEN** the agent attachment capability or selected model's image support changes
- **THEN** The attach intakes SHALL be presented only when the agent declares the capability behind them, consistent with the existing capability-gating rule.
- **AND** When the agent declares the capability but the selected model does not report image input support, the attach control SHALL remain visible but inactive with an explanation naming the model as the reason, because switching models changes the answer and a hidden control would make that change undiscoverable.

#### Scenario: Pasting an image stages a pending attachment
- **WHEN** the user pastes clipboard content containing an image into the composer
- **THEN** the image appears as a removable thumbnail at the composer
- **AND** any text in the same paste enters the draft unchanged

#### Scenario: Dropping an image on the composer stages it
- **WHEN** the user drags an image file onto the composer and drops it
- **THEN** the image appears as a removable thumbnail at the composer
- **AND** the draft text is unchanged

#### Scenario: The attach control opens a file picker
- **WHEN** the user activates the attach control and picks a supported image
- **THEN** the image appears as a removable thumbnail at the composer

#### Scenario: A pending attachment can be removed before send
- **WHEN** the user removes a pending attachment's thumbnail
- **THEN** the attachment is not part of the next submission
- **AND** the draft text and other pending attachments are unchanged

#### Scenario: An unsupported file type is refused
- **WHEN** the user pastes, drops, or picks a file that is not a supported image format
- **THEN** the file is refused with a visible explanation
- **AND** the draft and pending attachments are unchanged

#### Scenario: An intake beyond the bounds is refused
- **WHEN** an intake would exceed the per-message attachment count or per-attachment size bound
- **THEN** the excess is refused with a visible explanation
- **AND** the draft and already-pending attachments are unchanged

#### Scenario: Attach affordances are absent without the capability
- **WHEN** the agent does not declare the attachments capability
- **THEN** no attach control, paste intake, or drop intake for images is offered

#### Scenario: A model without image support inactivates the control
- **WHEN** the agent declares the attachments capability but the selected model does not report image input support
- **THEN** the attach control is visible but inactive, with an explanation naming the model
- **AND** paste and drop intakes for images are refused with the same explanation

### Requirement: Attachment bytes stay out of the conversation transport

Attachments SHALL upload once at attach time and travel thereafter as opaque references, never bytes in conversation transport. Storage SHALL remain outside watched roots, and serving SHALL enforce conversation authorization without interpreting identifiers as paths.

#### Scenario: A client attaches an image and later submits, queues, projects, or streams its message
- **WHEN** a client attaches an image, submits its message, queues it, or receives its projection or events
- **THEN** An attached image SHALL be transferred from the client to the workspace once, at attach time, and referenced by an opaque identifier thereafter.
- **AND** Prompt submissions, queued messages, conversation projections, and the event stream SHALL carry attachment references, never image bytes.
- **AND** Stored attachments SHALL live outside every watched root, so the file watcher, the repository change sweep, and the ignore engine never observe them.

#### Scenario: A client uploads an oversized or unsupported attachment or requests stored attachment bytes
- **WHEN** a client uploads an oversized or unsupported attachment or requests stored attachment bytes
- **THEN** Serving a stored attachment SHALL require the same authorization as the conversation API, and SHALL resolve only identifiers the workspace itself issued: a request whose identifier does not match an issued attachment SHALL be refused without filesystem interpretation of the identifier.
- **AND** An upload that exceeds the size bound or carries an unsupported type SHALL be refused with a client-visible reason.

#### Scenario: A prompt references its attachments by id
- **WHEN** a message with attachments is submitted
- **THEN** the prompt request carries attachment identifiers, not image bytes

#### Scenario: Stored attachments are invisible to the watch pipeline
- **WHEN** an attachment is uploaded and stored
- **THEN** no file event, change-overview entry, or search result arises from it

#### Scenario: Serving requires conversation authorization
- **WHEN** a request for a stored attachment lacks the workspace's required authorization
- **THEN** the attachment is not served

#### Scenario: A hostile attachment identifier is refused
- **WHEN** a request names an attachment identifier containing path traversal or one the workspace never issued
- **THEN** the request is refused without touching the filesystem path it implies

#### Scenario: An oversized upload is refused
- **WHEN** an upload exceeds the per-attachment size bound
- **THEN** the upload is refused with a client-visible reason
- **AND** nothing is stored

### Requirement: Attached images reach the agent with their prompt

Dispatched prompts SHALL deliver stored images alongside text through the agent's attachment interface without Uatu-owned format conversion. Agent refusal SHALL use existing failure presentation and restore both text and attachments.

#### Scenario: A queued or immediate message with attachments is dispatched and accepted or refused
- **WHEN** a queued or immediate message with attachments is dispatched and accepted or refused
- **THEN** When a message with attachments is dispatched, the workspace SHALL deliver the stored images to the agent as attachments of that prompt, in the form the agent's own interface defines, alongside the message text.
- **AND** Image scaling and model-format concerns SHALL be left to the agent, which owns them.
- **AND** If the agent refuses the prompt, the outcome SHALL be reported through the existing failure presentation, and the message — text and attachments — SHALL be restorable to the composer as the existing failure path provides for text.

#### Scenario: Attachments accompany the dispatched prompt
- **WHEN** a message with attachments is delivered to the agent
- **THEN** the agent receives the images as prompt attachments together with the text
- **AND** uatu performs no image re-encoding of its own

#### Scenario: Agent refusal is surfaced like any prompt failure
- **WHEN** the agent refuses a prompt that carries attachments
- **THEN** the failure is presented through the existing prompt-failure path
- **AND** the draft, including its attachments, is restored to the composer

### Requirement: Attached images render in the conversation and survive replay

Attached images SHALL appear as workspace-served thumbnails in timeline, optimistic, and queue presentations and survive history replay. Hostile names SHALL remain inert, and missing bytes SHALL produce labeled placeholders.

#### Scenario: An attached user message is rendered live, optimistically, in the queue, or after history replay
- **WHEN** an attached user message is rendered live, optimistically, in the queue, or after history replay
- **THEN** A user message with attachments SHALL present its images as thumbnails with the message text, in the timeline, in the optimistic draft presentation, and in the queue presentation.
- **AND** The presentation SHALL come from the workspace's own attachment serving, and SHALL remain correct after a reload or reconnection replays the conversation from the agent's stored history.
- **AND** Attachment names SHALL be treated as hostile input and rendered inert.
- **AND** An attachment whose stored bytes are no longer available SHALL degrade to a labeled placeholder rather than a broken presentation.

#### Scenario: A sent message shows its images
- **WHEN** a message with attachments is accepted
- **THEN** its timeline item presents the message text and image thumbnails

#### Scenario: A thumbnail opens the image full size in place
- **WHEN** the user activates an attachment thumbnail, wherever it renders
- **THEN** the image presents full size within the surface, dismissible by Escape or a click
- **AND** no navigation leaves the conversation

#### Scenario: Replay restores attachment presentation
- **WHEN** a client reloads and the conversation replays from stored history
- **THEN** user messages with attachments present the same thumbnails as before

#### Scenario: A hostile filename is inert
- **WHEN** an attachment name contains markup or script
- **THEN** the name renders as text with no markup interpretation

#### Scenario: Missing bytes degrade to a placeholder
- **WHEN** a rendered message references an attachment whose bytes are no longer available
- **THEN** the thumbnail is replaced by a labeled placeholder
- **AND** the rest of the message renders normally

### Requirement: Held messages keep their attachments

Pending messages SHALL retain their attachment references and thumbnails across holding, steering, delivery changes, editing, and delivery. Removal SHALL discard their references; later model changes MUST NOT alter frozen attachments.

#### Scenario: A message with attachments is held, steered, removed, edited, switched, or delivered after a model change
- **WHEN** a message with attachments is held, steered, removed, edited, switched or delivered, whether or not the composer's model has since changed
- **THEN** A message submitted with attachments while the conversation is running SHALL keep its attachments while it is pending, whether it is held or steered.
- **AND** The dock SHALL show the message's thumbnails.
- **AND** Removal of a pending message SHALL discard the message together with its attachment references.
- **AND** Editing a pending message SHALL return its attachments to the composer with its text.
- **AND** Changing a pending message's delivery SHALL keep its attachments.
- **AND** Delivery SHALL carry the attachments exactly as submitted.
- **AND** Switching the composer's model after a message is held SHALL NOT alter the held message's attachments: held messages deliver under their frozen configuration.

#### Scenario: A queued message shows its thumbnails
- **WHEN** a message with attachments is held or steered while the agent works
- **THEN** the dock shows the message with its image thumbnails

#### Scenario: Removing a held message discards its attachments
- **WHEN** the user removes a pending message that has attachments
- **THEN** the message and its attachment references leave the dock on every client
- **AND** the message is never delivered

#### Scenario: A held message delivers with its attachments
- **WHEN** the running turn ends and a held message with attachments is delivered
- **THEN** the agent receives the message text and its attachments under the configuration frozen at submission

#### Scenario: Editing a pending message returns its attachments
- **WHEN** the user edits a pending message that has attachments
- **THEN** the invoking client's composer receives the message's text and its attachments

#### Scenario: Switching delivery keeps attachments
- **WHEN** the user switches a pending message with attachments between steer and queue
- **THEN** the message keeps its attachments
- **AND** delivers with them

### Requirement: Timeline order follows the conversation's message order

Timeline messages SHALL follow provider-assigned order regardless of update arrival, and parts SHALL follow provider delivery order until a fresh snapshot supplies positions. Late updates MUST NOT move an earlier message behind later messages.

#### Scenario: Updates arrive out of order and clients compare live event application with fresh snapshots
- **WHEN** updates arrive in or out of order, or a client loads a fresh snapshot of the same conversation
- **THEN** The Chat timeline SHALL present items in the conversation's own order — parent messages in their provider-assigned order, and within a message, parts in the order the provider delivers them — regardless of the order in which updates arrived.
- **AND** An update belonging to an earlier message MUST NOT render after items of a later message.
- **AND** A client that applied a conversation's events live SHALL present the same cross-message order as a client that loaded the same conversation from a fresh snapshot.
- **AND** Within one message, live events carry no provider position, so parts the provider itself delivered out of order remain in delivery order until the next snapshot load.

#### Scenario: A late update for an earlier message keeps its place
- **WHEN** an update arrives for a message that precedes items already shown
- **THEN** the item renders in its parent message's position
- **AND** it does not appear at the end of the timeline

#### Scenario: Live and reloaded timelines agree
- **WHEN** one client watched a conversation stream live and another loads it fresh
- **THEN** both present the same messages and their items in the same cross-message order

### Requirement: Conversation inventory stays current across clients

Workspace conversation inventory SHALL reconcile live lifecycle indications and recover after interruptions or page suspension, excluding children and foreign workspaces. Failures SHALL preserve the current conversation and permit later retry.

#### Scenario: Top-level conversation membership or displayed metadata may have changed
- **WHEN** top-level conversation membership or displayed metadata may have changed
- **THEN** The authenticated workspace Chat API SHALL provide a live indication when the authoritative set or displayed metadata of top-level conversations in the selected workspace may have changed.
- **AND** A connected Chat client SHALL reconcile that indication against the authoritative conversation list without requiring a page reload.
- **AND** Inventory synchronization MUST remain confined to the server-selected workspace directory and MUST continue to exclude subagent child sessions.

#### Scenario: Inventory or provider transport is interrupted, a suspended page resumes, or reconciliation fails
- **WHEN** inventory or provider transport is interrupted, a suspended page resumes, or reconciliation fails
- **THEN** Inventory synchronization SHALL recover after transport interruption, provider-event interruption, and restoration of a suspended page by reconciling the authoritative list.
- **AND** Repeated or duplicated lifecycle indications MUST converge without duplicating conversations.
- **AND** A synchronization failure MUST leave the current conversation usable and SHALL be retried on a later lifecycle indication, reconnection, Chat activation, or page resume.

#### Scenario: Conversation created on another client appears live
- **WHEN** one client creates a top-level conversation in a workspace while another client has Chat loaded for that workspace
- **THEN** the other client adds the conversation to its chooser without a page reload
- **AND** the other client does not switch away from its selected conversation

#### Scenario: Current presentation survives an inventory update
- **WHEN** another conversation is added, renamed, or removed while a client has a different conversation selected
- **THEN** the selected conversation, draft, staged attachments, staged configuration, timeline position, and active turn remain unchanged

#### Scenario: External rename updates the chooser
- **WHEN** a top-level conversation is renamed by another client or compatible OpenCode surface
- **THEN** connected workspace clients display the new title for that conversation without reopening it or reloading the page

#### Scenario: External deletion removes an unselected conversation
- **WHEN** an unselected top-level conversation is deleted elsewhere
- **THEN** connected workspace clients remove it from the chooser without changing their selection

#### Scenario: Selected conversation is deleted elsewhere
- **WHEN** the conversation selected by a client is deleted elsewhere
- **THEN** Chat explicitly reports that the conversation is no longer available
- **AND** Chat does not silently select another conversation
- **AND** the user can explicitly choose or create a conversation

#### Scenario: Selected conversation returns to top-level inventory
- **WHEN** the selected conversation temporarily becomes a child session and later returns to the authoritative top-level inventory
- **THEN** Chat removes the unavailable state without switching to another conversation
- **AND** Chat reloads the conversation and resumes its event stream
- **AND** the local draft, staged attachments, and staged configuration remain available

#### Scenario: Subagent lifecycle does not change the inventory
- **WHEN** OpenCode creates, updates, or deletes a child session for a subagent
- **THEN** the child does not appear in the conversation chooser
- **AND** the child does not contribute to conversation-inventory awareness

#### Scenario: Foreign-workspace lifecycle is ignored
- **WHEN** the OpenCode event source reports a session belonging to another canonical workspace directory
- **THEN** the client inventory for the current workspace does not change

#### Scenario: Reconnection repairs missed lifecycle events
- **WHEN** a conversation is created, renamed, or deleted while the inventory subscription or provider event source is interrupted
- **THEN** reconnection reconciles the complete authoritative conversation list
- **AND** the client converges on the current inventory without duplicate entries

#### Scenario: Resuming a suspended page repairs the inventory
- **WHEN** a loaded workspace page becomes visible after being suspended while conversation lifecycle changes occurred
- **THEN** Chat reconciles the authoritative conversation list

#### Scenario: Inventory refresh failure is non-destructive
- **WHEN** an inventory reconciliation fails while the selected conversation remains available
- **THEN** Chat keeps the selected conversation and its controls usable
- **AND** a later lifecycle indication, reconnection, Chat activation, or page resume can retry reconciliation

### Requirement: Newly discovered conversations are announced without taking focus

Newly discovered top-level conversations SHALL raise client-local unseen awareness without changing focus, selection, or Chat visibility. Explicit inventory interaction SHALL acknowledge the set; bootstrap, locally selected creations, and removed conversations SHALL not inflate it.

#### Scenario: Reconciliation discovers a top-level conversation after the initial inventory baseline
- **WHEN** reconciliation discovers a top-level conversation after the initial inventory baseline
- **THEN** After a client establishes its initial conversation inventory, each top-level conversation first discovered by a later reconciliation SHALL be marked unseen on that client unless that client explicitly created and selected it.
- **AND** Chat SHALL expose the unseen count beside the conversation chooser while Chat is visible and SHALL expose an attention indicator on the touch Chat tab or collapsed desktop Chat affordance while Chat is hidden.
- **AND** These indicators MUST NOT move focus, open Chat, or change the selected conversation.

#### Scenario: The user reveals Chat, activates awareness or the chooser, selects an unseen conversation, or inventory membership changes
- **WHEN** the user reveals Chat, activates awareness or the chooser, selects an unseen conversation, or inventory membership changes
- **THEN** Merely revealing Chat SHALL NOT acknowledge unseen conversations because the additional chooser options remain undisclosed.
- **AND** Activating the visible unseen indicator, activating the conversation chooser, or explicitly selecting an unseen conversation SHALL acknowledge the current unseen set.
- **AND** Removed conversations SHALL cease contributing to the unseen count.
- **AND** The initial inventory established during page bootstrap SHALL be the baseline and SHALL NOT be reported as unseen.

#### Scenario: New conversation raises awareness without switching
- **WHEN** a client discovers a top-level conversation created elsewhere after its initial inventory was established
- **THEN** Chat increments the unseen-conversation count
- **AND** the selected conversation and keyboard focus remain unchanged

#### Scenario: Hidden Chat exposes an attention indicator
- **WHEN** a client discovers an unseen conversation while the touch Chat tab is inactive or the desktop Chat panel is collapsed
- **THEN** the corresponding Chat entry point exposes an attention indicator
- **AND** its accessible name communicates that new conversations are available

#### Scenario: Visible Chat exposes the unseen count
- **WHEN** Chat is visible and one or more conversations are unseen
- **THEN** the conversation controls expose the number of unseen conversations
- **AND** an assistive-technology announcement communicates the updated count without moving focus

#### Scenario: Opening Chat alone does not acknowledge the inventory
- **WHEN** Chat has unseen conversations and the user opens the touch Chat tab or expands the desktop Chat panel without activating the conversation chooser
- **THEN** the unseen state remains

#### Scenario: Explicit interaction acknowledges the current set
- **WHEN** the user activates the visible unseen indicator or the conversation chooser while conversations are unseen
- **THEN** Chat clears the current unseen set and its indicators
- **AND** a conversation arriving after that acknowledgement can raise the indicator again

#### Scenario: Locally created conversation is not unseen
- **WHEN** a client creates a conversation and Chat selects the returned conversation as the direct result of that action
- **THEN** that conversation does not contribute to the creating client's unseen count

#### Scenario: Initial inventory is a silent baseline
- **WHEN** Chat establishes its first authoritative conversation list after page bootstrap
- **THEN** existing conversations appear in the chooser
- **AND** none are marked unseen solely because they were present in that initial list

### Requirement: Background work is a distinct conversation state

Subagent worker rows SHALL report truthful latest execution model and effort, cumulative tokens, and authoritative cumulative child-session USD cost. Missing values SHALL remain unreported, aliases MUST NOT duplicate receipt spend, and existing recovery SHALL refresh metadata without per-render polling.

#### Scenario: Worker execution metadata or authoritative child-session totals arrive, change, or are recovered
- **WHEN** worker execution metadata or authoritative child-session totals arrive, change, or are recovered
- **THEN** Subagent worker rows on desktop and touch SHALL show the latest child-execution model and reasoning effort together, cumulative tokens, and cumulative child-session cost in source-reported USD.
- **AND** Effort SHALL come only from assistant execution metadata, never the parent/configured selection or model-name inference.
- **AND** A newer execution without effort SHALL clear the older effort.
- **AND** Execution reports SHALL NOT claim independent downstream-provider confirmation.
- **AND** Cost SHALL use authoritative cumulative session snapshots, including compaction and reverted spend, exclude parent/descendant spend, and repeat one session snapshot across aliases/reused-child occurrences without adding those snapshots to receipts.
- **AND** Unreported/incomplete cost or effort SHALL show a compact dash labeled "not reported" accessibly; reported zero SHALL remain zero.
- **AND** Shell work SHALL NOT claim subagent effort or session cost.
- **AND** Sub-cent costs SHALL retain useful precision.
- **AND** Existing child-history recovery/inspection reads SHALL refresh this metadata without adding per-render history polling.
- **AND** Wide desktop rows SHALL remain aligned single lines; touch SHALL retain 44px Stop targets and use minimal metadata wrapping on very narrow screens without hiding tokens/model.

#### Scenario: Latest effort and cumulative session cost remain truthful
- **WHEN** a child runs high then medium and produces multiple priced assistant calls
- **THEN** medium is shown with the latest model and cost uses the authoritative cumulative session snapshot
- **AND** a later model lacking effort clears medium rather than inheriting it
- **AND** missing cost shows not reported while explicit reported zero shows zero
- **AND** history recovery/inspection retains the same model/effort and cost semantics

#### Scenario: Latest execution changes effort or model
- **WHEN** a child runs high then medium, followed by another model with no reported effort
- **THEN** its row shows medium after the second execution and not-reported effort with the new model after the third
- **AND** the parent's configured effort never substitutes for missing child effort

#### Scenario: Session cost is not a partial message sum or duplicated task cost
- **WHEN** native cumulative session totals arrive, including compaction and reverted spend
- **THEN** each snapshot replaces the prior total rather than adding to it
- **AND** launcher aliases/repeated child occurrences do not add another cost to receipts
- **AND** a provider without an authoritative aggregate remains not reported even when message prices are available, while explicit reported zero remains zero

Where an agent declares that it can run work in the background, Chat SHALL present live background tasks as a state of the conversation distinct from working and idle: the composer status SHALL name how many tasks run, a list SHALL name each task with its description and progress where reported, each confirmed running and controllable task SHALL offer a stop action, and a settled task SHALL appear in the timeline as a row with its outcome and summary. The state SHALL be populated when an existing conversation with live background work is opened, and SHALL clear when the agent authoritatively reports no live tasks. An agent that does not declare the capability SHALL show none of it.

Background tasks SHALL remain visible while the parent also has a foreground turn, subject to the compact touch visibility rules in "Background inspection and controls remain accessible and workspace-confined". When only background work remains, the parent composer SHALL remain usable without requiring those workers to finish. If recovery cannot establish current task state, Chat SHALL distinguish last-known state from current evidence, show that status is unavailable, and withhold controls whose target cannot be verified. Missing or failed reads alone MUST NOT be reported as successful completion or cancellation. A later successful reconciliation SHALL clear the uncertainty.

#### Scenario: Background tasks are listed while they run
- **WHEN** a conversation's agent reports one or more live background tasks
- **THEN** the composer status names the count
- **AND** each confirmed running and controllable task is listed with a stop action

#### Scenario: A settled task lands in the timeline
- **WHEN** a background task completes, fails, or is stopped
- **THEN** a timeline row records the outcome and the agent's summary
- **AND** the task leaves the live list

#### Scenario: A reopened conversation shows its live work
- **WHEN** the user opens a conversation whose agent still reports live background tasks
- **THEN** the background-work state is shown from that report

#### Scenario: Foreground and background coexist
- **WHEN** the parent is generating a response while two detached workers run
- **THEN** the parent reads as working and both workers remain listed
- **AND** when the parent ends, its background-work summary still names two live workers and its composer accepts new input

#### Scenario: Recovery cannot establish liveness
- **WHEN** a previously running task cannot be reconciled because provider reads fail or evidence is incomplete
- **THEN** Chat labels its state as unavailable rather than asserting a terminal outcome
- **AND** it preserves inspectable known content and offers recovery feedback without an unverified stop action

### Requirement: Persistent-approval scope copy is the owning agent's

Persistent-approval copy SHALL describe only the owning agent's actual scope and lifetime. Choosing it SHALL open an accessible confirmation with verbatim agent patterns; only explicit Confirm SHALL send the persistent reply, and cancellation SHALL leave the request pending.

#### Scenario: An owning agent offers an approval that outlives the current request
- **WHEN** an owning agent offers an approval that outlives the current request
- **THEN** When a permission card offers an approval that outlives the request, the sentence stating what that approval covers SHALL describe the owning agent's actual persistence semantics and SHALL name only that agent.
- **AND** Two agents with different semantics SHALL have different sentences.

#### Scenario: The reader opens, confirms, cancels, or presses Escape in persistent-approval confirmation, or the request resolves elsewhere
- **WHEN** the reader opens, confirms, cancels, or presses Escape in persistent-approval confirmation, or the request resolves elsewhere
- **THEN** Choosing that approval SHALL open a confirmation step on the card rather than reply.
- **AND** The confirmation SHALL name the action being authorized, list each future-approval pattern the owning agent supplied, verbatim and in that agent's own syntax, visibly apart from the request's own resources, and state the approval's lifetime in the owning agent's terms.
- **AND** The list SHALL be what the agent supplied; the surface MUST NOT derive it from the displayed request.
- **AND** When the agent supplied a single wildcard covering the whole permission, the confirmation SHALL state that every request of that action will be allowed, naming the action.
- **AND** When the agent supplied no reusable pattern, the confirmation SHALL state that confirming covers only this request.
- **AND** The confirmation SHALL offer explicit Confirm and Cancel choices; only Confirm SHALL send the persistent reply, once.
- **AND** Cancel, and Escape while the confirmation has keyboard focus, SHALL return the card to its pending choices without sending any reply and without changing the request's state.
- **AND** When the confirmation opens, keyboard focus SHALL move into it.
- **AND** If the request resolves while the confirmation is open, the card SHALL recede as a resolved request does.
- **AND** The single-occurrence approval, rejection, and agent-provided approval intents SHALL be unaffected.

#### Scenario: Each agent's card states its own reach
- **WHEN** a permission card is shown for a conversation owned by a given agent
- **THEN** its scope sentence describes that agent's persistent-approval lifetime
- **AND** no other agent is named on the card

#### Scenario: Choosing the persistent approval asks for confirmation
- **WHEN** the user chooses the persistent approval on a pending request
- **THEN** no reply is sent
- **AND** the card shows the action, the agent-supplied patterns apart from the request's resources, the agent's lifetime sentence, and Confirm and Cancel

#### Scenario: Confirm sends the persistent reply once
- **WHEN** the user chooses Confirm on the confirmation
- **THEN** the agent receives its persistent-approval reply exactly once
- **AND** the card records the persistent approval as it did before this change

#### Scenario: Cancel returns to the pending choices
- **WHEN** the user chooses Cancel on the confirmation
- **THEN** the card shows its pending choices again
- **AND** no reply has been sent and the request is still pending

#### Scenario: Escape cancels the confirmation
- **WHEN** the confirmation has keyboard focus and the user presses Escape
- **THEN** the card shows its pending choices again
- **AND** no reply has been sent

#### Scenario: A sole wildcard names the whole action
- **WHEN** the agent's only future-approval pattern is a wildcard covering the whole permission
- **THEN** the confirmation states that every request of that action will be allowed, naming the action
- **AND** it does not present the wildcard as though it were one command

#### Scenario: No reusable pattern is said plainly
- **WHEN** the agent supplied no future-approval pattern for the request
- **THEN** the confirmation states that confirming covers only this request
- **AND** it does not present the displayed command as the pattern

#### Scenario: A request resolved elsewhere closes its confirmation
- **WHEN** the request resolves while its confirmation is open
- **THEN** the card recedes as a resolved request
- **AND** Confirm and Cancel are no longer offered

#### Scenario: The other choices are unchanged
- **WHEN** the user chooses the single-occurrence approval, rejection, or an agent-provided approval intent
- **THEN** the reply is sent on that choice without a confirmation step

### Requirement: Timeline marks conversation compaction
Where an agent reports that it compacted the conversation's context, Chat SHALL place a marker in the timeline at that point stating that compaction happened and, where reported, the before and after token figures. Content before the marker SHALL remain readable.

#### Scenario: A compaction marker appears in place
- **WHEN** the agent reports a compaction between two turns of activity
- **THEN** the timeline shows a compaction marker between them with the figures reported
- **AND** the earlier content remains in the timeline

### Requirement: Chat transport recovery is observable and self-correcting

Chat streams SHALL maintain idle liveness and bounded reconnection, recognizing a replacement open without application events. Page/network resume SHALL reconcile inventory and the selected stream without losing drafts, position or content. Hidden Chat SHALL save drafts and remain able to resubscribe. While interrupted, Chat SHALL offer recovery; when it succeeds in place, that action MUST NOT discard drafts, timeline position or received content.

#### Scenario: An idle conversation or inventory stream emits keepalives or opens after an interruption
- **WHEN** an idle conversation or inventory stream emits keepalives or opens after an interruption
- **THEN** The conversation and inventory event streams SHALL maintain transport liveness during normal idle periods and SHALL reconnect with bounded backoff after interruption.
- **AND** Opening a replacement stream MUST count as successful transport recovery even when no application event is immediately available: it SHALL reset consecutive-failure accounting and clear only the connection-interruption status owned by that stream.
- **AND** Keepalives MUST NOT appear as conversation or inventory events and MUST NOT alter projections, unread state, or timeline content.

#### Scenario: A replacement stream succeeds or a suspended page or network connection resumes
- **WHEN** a replacement stream succeeds or a suspended page or network connection resumes
- **THEN** The Chat surface MUST NOT continue to claim that it is reconnecting after its replacement stream has opened successfully.
- **AND** A later independent interruption MAY be reported normally.
- **AND** Resuming a suspended page or restoring network connectivity SHALL trigger authoritative inventory reconciliation and ensure the selected conversation's stream is current without discarding drafts, timeline position, or already received content.

#### Scenario: The browser hides Chat and later returns to a still-running page
- **WHEN** the browser hides Chat and later returns to a still-running page
- **THEN** A hidden page SHALL NOT permanently close the Chat surface.
- **AND** Chat MAY release its streams whenever the page is hidden, however the browser announces it, and MUST continue to save drafts on that signal, but it MUST remain able to resubscribe so that returning to a still-running page restores conversation and inventory delivery.
- **AND** Chat MUST NOT stay closed for the life of a document that is still running.

#### Scenario: Chat reports a connection interruption
- **WHEN** Chat reports a connection interruption on any device
- **THEN** While Chat reports a connection interruption, it SHALL offer the user an action that attempts recovery, so a stalled surface is never a dead end on a device with no browser reload control.
- **AND** That action MUST NOT discard drafts, timeline position, or content already received when recovery succeeds in place.

#### Scenario: Idle reconnect clears stale interruption status
- **WHEN** a Chat stream is interrupted, reports a reconnecting status, and then opens successfully while no conversation event is emitted
- **THEN** the reconnecting status is cleared promptly
- **AND** the client does not wait for later assistant output to recognize recovery

#### Scenario: Successful open resets failure accounting
- **WHEN** a replacement Chat stream opens after one or more failed attempts
- **THEN** consecutive-failure accounting resets for that stream
- **AND** a later interruption begins a new recovery sequence rather than inheriting the old failure count

#### Scenario: Keepalive has no presentation effect
- **WHEN** an idle conversation or inventory stream emits a transport keepalive
- **THEN** no timeline item, inventory change, unread marker, or user-facing activity is produced

#### Scenario: Suspended Chat resumes from authoritative state
- **WHEN** a suspended page resumes after missing inventory or conversation events
- **THEN** Chat reconciles the authoritative inventory and ensures the selected conversation stream is current
- **AND** preserves drafts, timeline position, and content already received

#### Scenario: A backgrounded standalone Chat resubscribes when reopened
- **WHEN** a page installed to the home screen is backgrounded, the browser announces the hide in a form that does not promise a later restore, and the user reopens the still-running page
- **THEN** Chat resubscribes its inventory and selected conversation streams
- **AND** the composer draft written before the page was backgrounded is still present

#### Scenario: An interrupted Chat offers a way back
- **WHEN** Chat reports a connection interruption to the user
- **THEN** an action that attempts recovery is available from that report
- **AND** recovering in place leaves the draft, timeline position, and received content intact

#### Scenario: Client recoveries are independent
- **WHEN** one of multiple clients viewing the same conversation loses and restores its transport
- **THEN** that client resumes from its retained cursor or reconciles from a fresh snapshot as required
- **AND** the other clients' streams continue without interruption

### Requirement: Conversation subscriptions ride the brokered stream

Hub-served conversation and subagent subscriptions SHALL share the brokered live connection as conversation topics. Per-topic cursor replay and resync SHALL remain intact, and successful open SHALL clear only Chat-owned interruption status.

#### Scenario: A Hub-served page selects a conversation, opens a child transcript, or reconnects its brokered stream
- **WHEN** a Hub-served page selects a conversation, opens a child transcript, or reconnects its brokered stream
- **THEN** When a session is served through the hub, a selected conversation's ordered events — and an open subagent transcript's — SHALL be delivered as `conversation` topics of the hub's brokered live stream, subscribed and unsubscribed on the open connection as the selection changes.
- **AND** The cursor and resync semantics of conversation updates SHALL hold per topic: a retained cursor replays later events once in order, and a non-replayable cursor requires a fresh snapshot for that conversation only.
- **AND** Selecting a conversation MUST NOT open an additional HTTP connection, and the reconnect-status ownership rules for the chat surface SHALL apply to the brokered stream: a successful open clears only the chat surface's connection-interruption status.

#### Scenario: Switching conversations reuses the connection
- **WHEN** a user selects a different conversation on a hub-served page
- **THEN** the previous conversation's topic is unsubscribed and the new one subscribed from its snapshot cursor
- **AND** no HTTP connection is opened or closed

#### Scenario: A subagent drill-down is one more topic
- **WHEN** a user opens a subagent transcript from the parent conversation
- **THEN** the transcript's events arrive as a second conversation topic on the same stream
- **AND** closing it unsubscribes that topic and leaves the parent's subscription intact

### Requirement: OpenCode history reuse preserves authoritative pagination

Verified unchanged OpenCode history SHALL be reused within bounded, workspace-isolated limits without repeated full traversal. Native history SHALL remain authoritative, and invalidation, reconciliation, ordering, accounting, attribution, and snapshot-to-stream boundaries SHALL remain correct.

#### Scenario: A client repeatedly pages verified unchanged history or native history changes beyond reuse limits
- **WHEN** a client pages verified unchanged history, reuse limits are exceeded, or native history changes within or beyond those limits
- **THEN** Repeated paging through a verified unchanged OpenCode conversation within the documented reuse limits SHALL avoid a complete provider-history traversal for each page.
- **AND** Reusable history SHALL be bounded in memory and isolated by workspace and conversation.
- **AND** Eviction or a history larger than those limits SHALL fall back to authoritative reads without losing content.
- **AND** Native provider history remains authoritative: content edits, new messages, undo, redo, revert, restore, deletion, and replay gaps SHALL invalidate or reconcile affected reusable state before it is represented as current.
- **AND** When freshness cannot be established, the system SHALL perform authoritative reconciliation rather than return an unverified history snapshot as current.

#### Scenario: History reuse merges provider stores and serves older-page cursors
- **WHEN** history reuse merges provider stores and serves older-page cursors
- **THEN** History optimization MUST preserve the existing merge of supported provider stores, normalized ordering, accounting, child attribution, and the snapshot-to-stream boundary.
- **AND** Older-page cursors SHALL either deliver correctly ordered, nonduplicated history or explicitly require a fresh snapshot when no longer applicable.

#### Scenario: Repeated reads of unchanged history
- **WHEN** a client requests adjacent pages of a retained conversation within the reuse limits whose source version is verified unchanged
- **THEN** the server reuses the verified history without traversing all provider pages again for each request
- **AND** page boundaries contain no duplicates or omissions

#### Scenario: History changes after reuse was established
- **WHEN** a history mutation, external edit, or replay gap invalidates previously read history
- **THEN** the next authoritative snapshot reflects the changed history
- **AND** incompatible older cursors do not silently skip or repeat messages

#### Scenario: Compatibility history remains complete
- **WHEN** supported provider stores contain different portions of a conversation
- **THEN** optimized history includes the same merged content as authoritative reconciliation
- **AND** an unavailable store is not silently treated as empty unless its response is an established missing-store condition

### Requirement: Remembered conversation restoration survives an empty startup inventory

After empty startup inventory, Chat SHALL retain an unsuperseded remembered selection and restore it once when it appears. Explicit selection or confirmed creation SHALL win; failed reads SHALL require explicit retry, and restoration MUST NOT steal focus or change awareness behavior.

#### Scenario: Bootstrap inventory is empty and a later successful inventory contains the remembered conversation
- **WHEN** bootstrap inventory is empty and a later successful inventory contains the remembered conversation
- **THEN** When Chat bootstrap receives an empty conversation inventory and this client has a remembered conversation selection that has not been superseded by a user action, Chat SHALL retain the intent to restore that exact conversation.
- **AND** If a later successful inventory includes it, Chat SHALL open its history and resume its live updates without requiring a page reload, a manual conversation switch, or a new conversation.
- **AND** After the read succeeds, its saved draft SHALL be restored and its composer SHALL obey the normal conversation controls rather than remaining disabled because restoration was skipped.

#### Scenario: Inventory updates repeat before or after deferred restoration or its opening read fails
- **WHEN** inventory updates repeat before or after deferred restoration or its opening read fails
- **THEN** Deferred restoration SHALL be attempted only once per bootstrap intent.
- **AND** Repeated inventory updates before or after the attempt SHALL NOT duplicate the opening read or live subscription.
- **AND** A failed opening read SHALL expose the normal actionable read error and explicit retry; inventory updates alone SHALL NOT automatically retry that failed read.

#### Scenario: The user explicitly selects a conversation, confirms creation, or dismisses agent choice during restoration
- **WHEN** the user explicitly selects a conversation, confirms creation, or dismisses agent choice during restoration
- **THEN** An explicit conversation selection or a user-confirmed new-conversation action SHALL supersede deferred restoration.
- **AND** This precedence SHALL apply while creation is in flight and SHALL remain in effect if creation fails.
- **AND** Dismissing the agent-choice menu without choosing an agent SHALL NOT count as a confirmed creation action.
- **AND** A delayed result from an obsolete opening read SHALL NOT replace a subsequently selected conversation.

#### Scenario: The remembered conversation stays absent, no selection was remembered, or Chat is hidden
- **WHEN** the remembered conversation stays absent, no selection was remembered, or Chat is hidden
- **THEN** While restoration is pending, repeated inventories that omit the remembered conversation SHALL NOT turn that pending intent into a deletion-recovery attempt or select an unrelated conversation.
- **AND** without a remembered selection, a later inventory discovery does not automatically open the newly discovered conversation
- **AND** This behavior SHALL NOT change existing bootstrap selection from a nonempty inventory, force Chat open, move keyboard focus, or alter inventory-awareness acknowledgement.

#### Scenario: A saved OpenCode conversation arrives after cold startup
- **GIVEN** this client remembers an OpenCode conversation with persisted history and a local draft
- **AND** the initial workspace conversation inventory is empty while OpenCode starts
- **WHEN** a later inventory includes the remembered conversation and no user action has superseded restoration
- **THEN** Chat selects and loads that conversation's history and subscribes to its live updates
- **AND** the saved draft is restored and normal composer actions become available after loading
- **AND** the user does not need to switch conversations or reload the page

#### Scenario: Repeated inventories do not duplicate restoration
- **GIVEN** a remembered conversation's deferred opening read is pending or has succeeded
- **WHEN** more inventory updates contain the same conversation
- **THEN** those updates do not issue another opening read or add another live subscription

#### Scenario: The remembered conversation remains absent for several reads
- **GIVEN** deferred restoration is pending after an empty startup inventory
- **WHEN** subsequent inventories are empty or contain only other conversations
- **THEN** Chat keeps restoration pending without fetching the absent conversation or opening a different one
- **AND** the user can explicitly select or create a conversation
- **AND** a later inventory containing the remembered conversation can still complete restoration if no user action superseded it

#### Scenario: Manual selection wins over late restoration
- **GIVEN** deferred restoration of a remembered conversation is pending
- **WHEN** the user explicitly selects another conversation before the remembered conversation arrives
- **THEN** later inventory updates do not open the remembered conversation
- **AND** the user's selected conversation and local draft remain in place

#### Scenario: Creation wins before its response arrives
- **GIVEN** deferred restoration is pending
- **WHEN** the user confirms creation of a new conversation and the remembered conversation appears while that creation request is in flight
- **THEN** Chat does not open the remembered conversation
- **AND** successful creation selects the newly created conversation through the normal creation flow

#### Scenario: Failed creation does not re-arm restoration
- **GIVEN** a confirmed creation action has superseded deferred restoration
- **WHEN** creation fails and a later inventory includes the remembered conversation
- **THEN** Chat retains the creation error and does not automatically open the remembered conversation
- **AND** the user can explicitly select a conversation or retry creation

#### Scenario: Dismissing agent choice does not abandon restoration
- **GIVEN** deferred restoration is pending and creation requires choosing an agent
- **WHEN** the user dismisses the agent-choice menu without choosing one
- **THEN** no creation request is made
- **AND** the remembered conversation can still be restored when its inventory entry arrives

#### Scenario: Failed restoration offers explicit read retry
- **GIVEN** the remembered conversation has arrived and its deferred opening read fails
- **WHEN** Chat reports that failure and another inventory update includes the conversation
- **THEN** Chat keeps an actionable read error with explicit retry rather than appearing successfully loaded
- **AND** that inventory update does not retry history automatically
- **AND** explicit read retry loads the same conversation without creating a conversation or submitting a prompt

#### Scenario: A late history response does not undo a newer selection
- **GIVEN** deferred restoration has started loading the remembered conversation
- **WHEN** the user selects another conversation before that history response arrives
- **THEN** the obsolete response cannot replace the newer selection, timeline, draft, or subscription

#### Scenario: No saved selection does not introduce auto-selection
- **GIVEN** the initial inventory is empty and this client has no remembered conversation
- **WHEN** conversations appear in later inventory updates
- **THEN** Chat lists them without automatically opening one under deferred-restoration behavior

#### Scenario: Existing startup selection and attention behavior remain unchanged
- **WHEN** bootstrap receives a nonempty inventory
- **THEN** Chat uses its existing saved-selection or initial fallback behavior without arming deferred restoration
- **AND** subsequent inventory updates preserve that selection

#### Scenario: Deferred restoration does not take over another surface
- **GIVEN** restoration is pending and the user has hidden Chat or focused another control
- **WHEN** the remembered conversation arrives and restoration completes
- **THEN** Chat does not open itself or move keyboard focus
- **AND** existing inventory-awareness acknowledgement rules remain unchanged

### Requirement: Chat serves whichever OpenCode generation the workspace has installed

Chat SHALL support installed OpenCode 1.x and 2.x through the same identities, routes, and operations, selecting generation from readiness for each server lifetime. Normalization and pending-request recovery SHALL follow each generation's contracts, and 2.x calls and events SHALL remain directory-confined.

#### Scenario: The workspace starts or restarts an OpenCode server, including after binary replacement
- **WHEN** the workspace starts or restarts an OpenCode server, including after binary replacement
- **THEN** UatuCode SHALL converse through an OpenCode 1.x server and through an OpenCode 2.x server with the same Chat surface, the same agent identity, and the same conversation operations.
- **AND** The generation is a property of the spawned server, decided by its readiness answer, and SHALL be fixed for that server's lifetime; a later start — a retry, a restart after an unexpected exit — SHALL decide again, so a binary replaced on disk is served by the matching generation without a workspace restart.
- **AND** Conversation identifiers, capability declarations, and the chat routes SHALL NOT change form between generations; a capability the running generation cannot back SHALL be left undeclared rather than declared and broken.

#### Scenario: Either generation announces activity or a 2.x form, permission, or MCP request is loaded or recovered
- **WHEN** either generation announces activity or has a live or recovered permission/MCP request, or a 2.x structured form is loaded or recovered
- **THEN** Normalization SHALL recognize each generation's event vocabulary — 1.x's cumulative and incremental announcements and 2.x's typed session events — and produce the same ordered conversation events for the same activity: text and reasoning, tool lifecycle, shell commands, permission requests and replies, structured questions and their answers, compaction, staged and committed reverts, usage, turn status, cancellation, completion, and errors.
- **AND** A 2.x structured form SHALL be presented as a structured question: each field becomes one question, a field with options offers those options, a field allowing custom input offers a free-form answer, and answering or rejecting it sends exactly one reply to the form OpenCode is waiting on.
- **AND** Loading a conversation SHALL reconcile pending requests against the running generation's own pending sets — permission requests and forms on 2.x — so a request announced while the stream was interrupted is still answerable.
- **AND** A 2.x permission request names the tool call it belongs to; normalization SHALL carry that reference onto the request, from the live announcement and from the pending set alike, so the surface can show the call.
- **AND** A 1.x request that carries no such reference SHALL be unaffected by its absence.
- **AND** On either generation, a request whose action is an MCP tool's registered name SHALL carry the MCP server and tool it resolves to, resolved against the servers that generation reports, from the live announcement and from the pending set alike.

#### Scenario: A 2.x call or event names a directory served by the same server
- **WHEN** a 2.x call or event names a directory served by the same server
- **THEN** Every call to a 2.x server SHALL be scoped to the workspace directory, and events for another directory served by the same server MUST NOT reach the workspace's conversations.

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

#### Scenario: A 2.x MCP permission is tied to its tool call
- **WHEN** a 2.x agent asks permission to call an MCP tool and names the tool call the request belongs to
- **THEN** the request carries that call's reference
- **AND** the request carries the MCP server and tool the action resolves to
- **AND** the card shows the call's arguments

#### Scenario: A 2.x request missed by the stream is recovered on load
- **WHEN** a 2.x server raised a permission request or a form while the event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered
- **AND** a recovered permission that names its tool call carries that reference

#### Scenario: Another directory's activity on a 2.x server stays out
- **WHEN** a 2.x server announces events for a session in a directory other than the workspace's
- **THEN** no conversation in the workspace changes

#### Scenario: A 2.x event the server does not handle is counted, not fatal
- **WHEN** a 2.x server emits an event type normalization does not handle
- **THEN** the event is skipped and counted by type, and later events are delivered

### Requirement: Skills are offered as slash commands on every OpenCode generation

Skills SHALL appear as labeled commands on both OpenCode generations. The 2.x inventory SHALL merge catalogs with explicit precedence, and dispatch SHALL attach native skill IDs with correct invocation text while handling removed skills without unsafe prose fallback.

#### Scenario: Chat loads commands and skills from either OpenCode generation
- **WHEN** Chat loads commands and skills from either OpenCode generation
- **THEN** The command inventory Chat reports for an OpenCode agent SHALL include the skills OpenCode has loaded for the workspace, each as a command of kind `skill`, on both the 1.x and the 2.x generation.
- **AND** On 2.x, where OpenCode keeps skills in a catalog apart from its config commands, Chat SHALL read both catalogs and present their union together with Chat's own built-in commands; a name present in more than one source SHALL appear once, with a config command taking precedence over a skill of the same name and a built-in yielding to either.
- **AND** The slash palette SHALL mark a skill entry with a visible "skill" label so a skill and a command with similar names are told apart.

#### Scenario: A 2.x skill is submitted with or without arguments and catalog membership changes before dispatch
- **WHEN** a 2.x skill is submitted with or without arguments, whether or not catalog membership changes before dispatch
- **THEN** Submitting `/<skill> <arguments>` on 2.x SHALL invoke the skill the way OpenCode's own 2.x clients do: as a prompt that carries the skill as an attachment identified by the skill's id, whose text is the skill mention followed by the arguments (`@<skill-id> <arguments>`, or `@<skill-id>` alone when there are none).
- **AND** The resulting user turn SHALL read as that invocation in the live timeline and after the conversation's history is reloaded.
- **AND** Whether a `/<name>` is a command or a skill SHALL be decided when the message is sent, against the agent's current commands and skills: a name that is no longer either is sent as ordinary text, as any unknown `/<name>` is.
- **AND** A skill OpenCode drops after that decision but before it runs SHALL be refused in the conversation the way an invalid command is, and MUST NOT be sent as prose.
- **AND** Skill dispatch on 1.x is unchanged.

#### Scenario: A 2.x skill appears in the palette
- **WHEN** the workspace's OpenCode is 2.x and it has loaded a skill named `openspec-apply-change`
- **THEN** typing `/openspec` lists `/openspec-apply-change` with the skill's description and a "skill" label
- **AND** OpenCode's config commands and Chat's built-ins are listed alongside it

#### Scenario: A 2.x skill is invoked with arguments
- **WHEN** the user submits `/openspec-apply-change my-change` on a 2.x conversation
- **THEN** OpenCode receives a prompt with the skill attached and the text `@openspec-apply-change my-change`
- **AND** the conversation shows a user turn reading `@openspec-apply-change my-change`
- **AND** reopening the conversation shows the same user turn

#### Scenario: A skill removed before the message is sent goes out as text
- **WHEN** the user submits `/<skill>` for a skill that was in the palette but is no longer one of the agent's commands or skills when the message is sent
- **THEN** the text is sent as an ordinary prompt, as any unknown `/<name>` is

#### Scenario: A skill OpenCode drops as it is dispatched is refused
- **WHEN** a skill is still listed when the message is sent but OpenCode no longer has it when uatu dispatches it
- **THEN** the conversation shows OpenCode's refusal and no prose is sent

#### Scenario: A 1.x skill is unchanged
- **WHEN** the workspace's OpenCode is 1.x
- **THEN** skills are listed and dispatched as before this change, now with the "skill" label in the palette

### Requirement: Users can reload OpenCode's configuration on 2.x

On OpenCode 2.x, /reload SHALL reload workspace configuration without interrupting running turns or reaching the model. Chat SHALL report confirmed, failed, or bounded unconfirmed outcomes and refresh catalogs for the initiating and other clients; 1.x SHALL not offer it.

#### Scenario: A user submits /reload to a generation with or without configuration reload support
- **WHEN** a user submits /reload to a generation with or without configuration reload support
- **THEN** When the running OpenCode generation offers configuration reload (2.x), Chat SHALL offer a built-in `/reload` command that asks OpenCode to reload its configuration for the workspace.
- **AND** It MUST NOT be offered on a generation without that operation (1.x).
- **AND** Reload applies to every conversation served by that OpenCode server; it requires no confirmation and SHALL NOT interrupt a running turn, which OpenCode continues under the reloaded configuration.

#### Scenario: A reload proceeds, fails, exceeds confirmation time, or succeeds while other clients remain open
- **WHEN** a reload proceeds, fails, exceeds confirmation time, or succeeds while other clients remain open
- **THEN** The conversation in which `/reload` was submitted SHALL show that the reload is in progress, then its outcome: success, or failure with the message OpenCode reported.
- **AND** Success means OpenCode has confirmed its rebuilt commands, skills, models, and agents; a reload OpenCode does not confirm within a bounded time SHALL be reported as unconfirmed, not as success.
- **AND** The `/reload` turn SHALL NOT remain in the timeline as a user prompt and MUST NOT be sent to the model.
- **AND** Arguments after `/reload` are ignored: `/reload now` reloads the same way.
- **AND** After a successful reload, the client that invoked it SHALL re-read the agent's commands (including skills), models, and modes so the palette and pickers reflect the new configuration without a page reload.
- **AND** Any other open client SHALL show the reloaded catalogs no later than when it next starts a slash query, opens the configuration picker, or selects a conversation, without a page reload.

#### Scenario: Reload succeeds
- **WHEN** the user submits `/reload` on a 2.x conversation after adding a skill to the workspace's OpenCode configuration
- **THEN** the conversation shows the reload in progress and then "Configuration reloaded"
- **AND** the new skill appears in the palette without reloading the page

#### Scenario: Reload fails
- **WHEN** OpenCode refuses or fails the reload
- **THEN** the conversation shows the failure with OpenCode's message
- **AND** the catalogs shown are the ones from before the attempt

#### Scenario: A reload queued behind a running turn refreshes when it completes
- **WHEN** the user submits `/reload` while a turn in the same conversation is running, so the reload is queued
- **THEN** the running turn's completion does not count as the reload's
- **AND** the invoking client re-reads its catalogs when the reload itself completes

#### Scenario: Reload while another conversation is running
- **WHEN** a turn is running in another conversation of the same workspace and the user submits `/reload`
- **THEN** the reload proceeds without a confirmation prompt
- **AND** the running conversation is not interrupted

#### Scenario: Another open client sees the reloaded catalogs
- **WHEN** a second client has the same workspace's Chat open and another client's `/reload` added a skill
- **THEN** typing that skill's name after `/` in the second client lists it, without reloading the page

#### Scenario: Reload is not offered on 1.x
- **WHEN** the workspace's OpenCode is 1.x
- **THEN** `/reload` is not in the palette and submitting it is treated as ordinary prompt text

### Requirement: The conversation timeline marks the day its content happened

Parent and subagent timelines SHALL show sticky reader-local day separators from provider timestamps, handling unknown and future times safely. Separators SHALL remain distinct from timeline items, avoid obscuring content, and relabel at midnight without new activity.

#### Scenario: Live or replayed content crosses reader-local days, the reader scrolls or navigates, or local midnight passes
- **WHEN** live or replayed content crosses reader-local days, the reader scrolls or navigates, or local midnight passes
- **THEN** For every agent's conversations, the timeline — the main transcript and a subagent drill-down alike — SHALL place a day separator at the start of each run of content that happened on one local calendar day of the reader, including the first day shown.
- **AND** Content with no known time — none reported, or a placeholder time before the year 2001 — SHALL be treated as belonging to the day of the content before it and SHALL NOT start a separator.
- **AND** Content whose reported time is later than the reader's clock SHALL be treated as happening now, so that no separator names a day after the reader's current day.
- **AND** A separator SHALL read "Today" or "Yesterday" for those days, and otherwise the short weekday and the ISO date (`YYYY-MM-DD`), such as "Sun 2026-09-20"; days SHALL be those of the reader's time zone, and only the weekday name MAY follow the reader's locale.
- **AND** Replayed or paged-in history SHALL be separated by the same rule as live content, from the times each agent reports for it.

#### Scenario: A day's pinned label leaves conversation content reachable
- **GIVEN** the timeline contains reader-local day separators
- **WHEN** the reader scrolls through a day or navigates to content within it
- **THEN** While the reader scrolls through a day's content, that day's separator SHALL remain visible at the top of the transcript until the next day's separator replaces it.
- **AND** Only the pinned separator's label SHALL cover the transcript: content beside the label SHALL stay visible and reachable by taps and selection, and at most one day's label SHALL be visible at the top at a time.
- **AND** Content scrolled to — by prompt navigation, by revealing an item, or by find — SHALL come to rest below the pinned separator rather than under it, and a separator that is not pinned SHALL NOT cover any part of the content before it.
- **AND** Separators SHALL NOT be treated as timeline items: they SHALL NOT participate in scroll anchoring, activity grouping, item actions, or find matches.

#### Scenario: Existing day labels roll over without another message
- **WHEN** the reader's local calendar day changes with a conversation still shown
- **THEN** When the reader's local day changes while a conversation is shown, the existing separators SHALL be relabelled without waiting for new content.

#### Scenario: Messages on different days are separated
- **WHEN** a conversation has messages from two days ago, yesterday, and today
- **THEN** the timeline shows a separator with the short weekday and ISO date, such as "Wed 2026-09-23", before the first of the oldest day's content
- **AND** a "Yesterday" separator before yesterday's first content
- **AND** a "Today" separator before today's first content

#### Scenario: A single-day conversation from the past states its day
- **WHEN** the reader reopens a conversation whose content all happened on one earlier day
- **THEN** one separator naming that day appears above its first content

#### Scenario: Replayed history is dated
- **WHEN** the reader opens a Claude Code or OpenCode conversation whose history is read back from the agent's stored transcript
- **THEN** its day separators reflect the times the agent recorded for that content, not the time it was read

#### Scenario: The day stays visible while scrolling back
- **WHEN** the reader scrolls up through a long day of content so that its separator has scrolled out of view
- **THEN** that day's separator remains visible at the top of the transcript
- **AND** it is replaced by the earlier day's separator once the reader scrolls past that day's boundary

#### Scenario: Only the day label covers the transcript
- **WHEN** a day's separator is pinned at the top of the transcript while the reader scrolls through that day
- **THEN** the transcript text to the left and right of the label stays visible and can be tapped or selected
- **AND** when the next day's separator reaches the top, only one day's label is visible, never one behind the other

#### Scenario: Separators follow the reader's time zone
- **WHEN** two messages were sent at 23:50 and 00:10 in the reader's time zone
- **THEN** a day separator appears between them, regardless of the agent's or server's time zone

#### Scenario: A time slightly ahead of the reader's clock is today
- **WHEN** it is 23:59 for the reader and a message arrives stamped 00:01 of the next day by an agent whose clock runs ahead
- **THEN** the message appears under the "Today" separator
- **AND** no separator names the next day

#### Scenario: Scrolled-to content is not hidden under the pinned day
- **WHEN** the reader jumps to a prompt, or find reveals a match, inside a day whose separator is pinned at the top of the transcript
- **THEN** the prompt or the match comes to rest below the pinned separator

#### Scenario: Find does not match day separators
- **WHEN** the reader searches the conversation for "Today" or "Yesterday"
- **THEN** only occurrences in the conversation's content are counted, not the separators' labels
- **AND** a separator relabelled at midnight does not change the count of an open search

#### Scenario: Labels roll over at midnight
- **WHEN** a conversation stays open across the reader's local midnight
- **THEN** the separator that read "Today" reads "Yesterday" and the one that read "Yesterday" reads the short weekday and ISO date, without new content arriving

#### Scenario: Separators do not disturb reading position
- **WHEN** a new day's first content arrives while the reader is paused above the end of the timeline
- **THEN** the reader's anchored position is preserved as for any other appended content

### Requirement: Slash-command suggestions show their descriptions in full

Slash suggestions SHALL show complete wrapped names, descriptions, and argument hints for every agent without horizontal scrolling. Highlighted entries SHALL stay visible, and argument tokens SHALL remain whole unless wider than the entire list.

#### Scenario: Desktop or touch slash suggestions contain long names, descriptions, or argument hints and the highlight moves
- **WHEN** desktop or touch slash suggestions are displayed with long names, descriptions or argument hints, or the highlight moves
- **THEN** Slash-command suggestions, for every agent, SHALL wrap a command's name, description, and argument hint onto further lines rather than truncating them, and every suggestion SHALL show its complete description whether or not it is highlighted.
- **AND** The suggestion list SHALL remain scrollable, SHALL NOT scroll horizontally in desktop or touch layouts, and SHALL keep the highlighted suggestion in view as the highlight moves.
- **AND** When a long command name leaves too little room beside it, the argument hint SHALL move onto its own line rather than wrapping into a narrow column.
- **AND** An argument hint SHALL wrap only at its spaces, keeping each space-separated token whole, unless a single token is wider than the whole suggestion list.

#### Scenario: A long description wraps
- **WHEN** the user types `/code` and the agent offers `/code-review` with a description longer than one line of the suggestion list
- **THEN** the description continues onto further lines instead of ending in an ellipsis on one line

#### Scenario: Every suggestion shows its full description
- **WHEN** the suggestion list shows several commands with multi-line descriptions
- **THEN** each suggestion shows its complete description, highlighted or not

#### Scenario: The highlight stays in view among tall suggestions
- **WHEN** the user moves the highlight with the keyboard past suggestions whose descriptions span several lines
- **THEN** the highlighted suggestion is scrolled into view within the list

#### Scenario: Both agents wrap alike
- **WHEN** a Claude Code conversation and an OpenCode conversation each offer a command with a long description
- **THEN** both suggestion lists wrap that description the same way

#### Scenario: A long name does not squeeze the argument hint
- **WHEN** a narrow touch layout offers a command whose name is nearly as wide as the suggestion list, with an argument hint
- **THEN** the argument hint is shown on its own line at a readable width rather than wrapping one character per line

#### Scenario: An argument hint wraps only at its spaces
- **WHEN** a narrow touch layout offers a command whose argument hint, such as `[path/to/a/long/argument] [--comment]`, does not fit on one line
- **THEN** the hint wraps between its tokens, so `[--comment]` stays whole and no `]` is left on a line of its own
- **AND** only a token wider than the whole suggestion list is broken inside

### Requirement: OpenCode 2.x conversations can steer the running turn

OpenCode 2.x SHALL declare steering and support fixed steer/queue actions, safe withdrawal and uncertainty handling, paused-batch resume, and agent-owned pending reconciliation. The dock SHALL retain ordered user entries and accessible, bounded, responsive pending controls without changing unsupported-agent semantics.

#### Scenario: An agent declares whether it can deliver, withdraw, or switch input at a running turn's safe step boundary
- **WHEN** an agent declares whether it can deliver, withdraw, or switch input at a running turn's safe step boundary
- **THEN** An agent that can deliver a message into its running turn at the next safe step boundary, and can withdraw or switch a message before then, SHALL declare the `steering` capability.
- **AND** The OpenCode 2.x agent SHALL declare it.
- **AND** The OpenCode 1.x agent and the Claude Code agent SHALL NOT declare it.

#### Scenario: A steering conversation is running or has pending input and the user chooses Send, keyboard delivery, or hold-to-queue
- **WHEN** a steering conversation is running or has pending input and the user chooses Send, keyboard delivery, or hold-to-queue
- **THEN** While a conversation whose agent declares `steering` is running or has pending messages, the composer SHALL offer two deliveries through fixed actions.
- **AND** Tap Send and desktop Enter SHALL steer.
- **AND** Touch Enter SHALL insert a newline, idle or busy, including while a command candidate is shown; Ctrl/Command+Enter SHALL explicitly steer. ⌥Enter (Option/Alt+Enter) SHALL queue where the choice is offered.
- **AND** Steer SHALL be the fixed keyboard default, not a per-device setting; legacy saved delivery choices SHALL be ignored without deleting browser settings.
- **AND** There SHALL be no delivery-default Settings path, Send dropdown, replacement selector or added layout height.
- **AND** The existing Send hold SHALL arm for 500ms, count down for two seconds and queue once at 2500ms; release during the armed countdown SHALL cancel.
- **AND** Commands and attachment-bearing drafts SHALL retain mandatory queue semantics, and idle submission SHALL retain immediate delivery.
- **AND** Explicit HTTP delivery and dock delivery actions, capability gates and unsupported agents' queued follow-ups SHALL remain unchanged.

#### Scenario: A steer is admitted, remains pending with the agent, or is delivered into the timeline
- **WHEN** a steer is admitted, remains pending with the agent, or is delivered into the timeline
- **THEN** A steer SHALL be handed to the agent at once and kept pending by the agent until the agent delivers it.
- **AND** Steers SHALL be delivered before any held message.
- **AND** The expanded dock SHALL list the user's pending steers, from any client of the conversation, labelled "Steer", and SHALL NOT list the agent's own internal inbox entries.
- **AND** A steer SHALL NOT appear in the timeline until the agent reports it delivered, at which point it SHALL appear as an ordinary user message.
- **AND** Outside compact keyboard/short-landscape mode, pending steers SHALL carry the dock note that they run with the conversation's model and mode as they stand when they are delivered.

#### Scenario: The user switches, edits, or removes a pending steer or queued entry
- **WHEN** the user switches, edits, or removes a pending steer or queued entry
- **THEN** For each pending entry, the user SHALL be able to:
  - switch a queued message to steer, which hands it to the agent as a steer at once; on a dormant queue or an idle conversation this is how a held message is sent now;
  - switch a steer back to queue, which withdraws it from the agent and holds it in the workspace's queue in its submission order;
  - edit or remove a steer, which withdraws it from the agent.

#### Scenario: Withdrawal races native delivery and the agent confirms or refuses cancellation
- **WHEN** a steer withdrawal is requested and the agent confirms or refuses it, including a race with native delivery
- **THEN** Withdrawing a steer SHALL complete only when the agent confirms the withdrawal.
- **AND** If the agent delivers the steer first, the withdrawal SHALL fail, the message SHALL stay delivered, and the user SHALL be told it was already delivered.
- **AND** A message SHALL never be delivered twice.

#### Scenario: Native withdrawal is unconfirmed or the client retries withdrawal-specific uncertainty
- **WHEN** native withdrawal is unconfirmed or the client retries withdrawal-specific uncertainty
- **THEN** An unconfirmed withdrawal SHALL keep the pending entry and private draft visible.
- **AND** Absence from a passive inbox/history snapshot SHALL NOT by itself confirm cancellation.
- **AND** A client with withdrawal-specific uncertainty SHALL offer **Retry withdrawal**, which explicitly repeats only native cancellation of the same inbox ID.
- **AND** It SHALL NOT edit, convert, resubmit the original input, automatically retry any mutation, or allow concurrent actions on that entry.
- **AND** Admission/resume uncertainty SHALL NOT grant withdrawal retry.
- **AND** Resume uncertainty SHALL remain read-only; settled unknown admission MAY offer only the token-fenced local discard defined below.

#### Scenario: A skill, slash command, or /reload is pending in the queue
- **WHEN** a skill, slash command, or /reload is pending in the queue
- **THEN** Skills, slash commands, and `/reload` in the queue SHALL NOT offer the switch to steer.

#### Scenario: Turn cancellation pauses pending steers and the reader resumes the paused batch or submits a new steer
- **WHEN** turn cancellation pauses pending steers and the reader resumes the paused batch or submits a new steer
- **THEN** Cancelling the turn SHALL leave pending steers with the agent and SHALL present them as paused.
- **AND** A steer is paused when it was pending before the conversation last became idle.
- **AND** The dock SHALL offer one action labelled `Send N paused steers now`, which resumes the agent so that it delivers every pending steer.
- **AND** Submitting a new steer SHALL also resume delivery of paused steers.

#### Scenario: Worker and pending cards share constrained desktop or touch dock space
- **WHEN** worker and pending cards share constrained desktop or touch dock space
- **THEN** The pending card SHALL have an always-visible count header outside its own contained content scrollport.
- **AND** Worker and pending cards SHALL share only a height budget, never an aggregate scroller, as specified by Desktop work shares measured panel space.
- **AND** With both cards collapsed, desktop normally uses 40% of measured panel height capped at 25rem; touch normally uses 35% of visual height, 25% at tablet widths from 48rem, or 24% during hardware editing.
- **AND** with either card expanded, the dock uses measured remaining panel space and the small transcript reserve from Desktop work shares measured panel space instead of those collapsed caps and the earlier 40% phone/35% tablet transcript reserves
- **AND** The pending list SHALL show a bottom fade only while content remains below.
- **AND** Entries SHALL retain distinct Steer/Queue badges, Paused chips and existing timing labels.
- **AND** Pending actions SHALL retain the approved compact 32px touch / 36px desktop targets, independent 8px gaps, visible focus outlines and contextual accessible names.
- **AND** Successful mutations SHALL not add confirmation notices; refusals and unknown receipts SHALL retain operation-scoped feedback without duplicate red errors.

#### Scenario: Pending messages coexist with software-keyboard mode, short touch landscape, or growing dock content
- **WHEN** pending messages coexist with software-keyboard mode, short touch landscape, or growing dock content
- **THEN** When pending messages exist, software-keyboard mode or short touch landscape SHALL collapse the work dock to a pending-count summary rather than hide it.
- **AND** Any paused-steer batch Send action SHALL retain a 44px target, and the count-only replacement warning SHALL remain readable while typing or editing a pending entry.
- **AND** Entry details and the routine model-at-delivery note MAY be hidden in this compact state; the replacement warning SHALL NOT be hidden.
- **AND** Dock growth SHALL reserve its final bounded layout height before a visual reveal, respect reduced motion, and preserve a remote-update reading anchor and deliberate bottom pinning.
- **AND** Sending a prompt SHALL retain the existing explicit jump-to-latest behavior.

#### Scenario: The workspace attaches to a conversation or reconnects to the owning agent
- **WHEN** the workspace attaches to a conversation or reconnects to the owning agent
- **THEN** When the workspace attaches to a conversation, or reconnects to the agent, it SHALL reconcile the pending steers with the agent's own list, so the dock shows steers raised while the stream was interrupted or by another client.

#### Scenario: Hidden delivery does not erase an uncertain withdrawal
- **WHEN** a withdrawal is unconfirmed and a later inbox read is empty while V2 history hides reverted messages
- **THEN** the original pending entry and attachments remain inspectable, and no removal is published based on that absence

#### Scenario: An explicit withdrawal retry does not resend input
- **WHEN** the user activates Retry withdrawal
- **THEN** only cancellation of the original inbox ID is requested again, with no prompt or new message ID
- **AND** confirmed cancellation removes the entry, confirmed delivery removes it with an already-delivered warning, and an inconclusive result keeps it visible

#### Scenario: Short desktop budgets use the panel rather than the window
- **WHEN** six long pending messages occupy a 1280px-wide desktop window at 600px or 480px height, or the panel is shorter than its window
- **THEN** the queue is bounded by the measured panel height and Send and Stop remain inside that panel and hit-testable

#### Scenario: Keyboard retains pending safety information
- **WHEN** a replacement is staged with paused steers, or a pending message is edited into the focused touch composer
- **THEN** compact pending counts remain visible while typing
- **AND** any paused-steer batch Send action and replacement warning remain available above the composer

#### Scenario: Dock growth preserves reading intent with either motion preference
- **WHEN** remote work grows the dock while the user reads an earlier message, then the user deliberately returns to latest and submits a prompt
- **THEN** the earlier reading anchor survives the remote update and the submitted exchange remains bottom-pinned through dock growth
- **AND** reduced motion omits the reveal animation without changing these positioning rules

#### Scenario: Steering is offered only where declared
- **WHEN** a running conversation's agent declares `steering`
- **THEN** the composer offers steer and queue delivery
- **AND** on a conversation whose agent does not declare it, no steer choice appears and busy submissions queue

#### Scenario: Desktop Enter always steers ordinary text
- **WHEN** the desktop user presses Enter with an ordinary-text draft while a steering agent works, including with a legacy saved Queue default
- **THEN** the message is handed to the agent as a steer
- **AND** the dock lists it labelled "Steer", ahead of any queued messages

#### Scenario: Option+Enter explicitly queues
- **WHEN** the user presses ⌥Enter while the steering delivery choice is offered, including with a legacy saved Queue default
- **THEN** the message is held in the workspace's queue labelled "Queue"

#### Scenario: Legacy delivery defaults are ignored after reload
- **WHEN** a browser with a saved Queue default opens or reloads a steering conversation
- **THEN** desktop Enter or touch Ctrl/Command+Enter steers ordinary text and Alt/Option+Enter queues where offered
- **AND** hints describe these fixed shortcuts without changing saved browser settings or adding a configuration control

#### Scenario: Touch Enter is always a newline
- **WHEN** a touch user presses unmodified Enter while idle, busy, or viewing a command candidate
- **THEN** a newline is inserted without a prompt mutation
- **AND** Send or Ctrl/Command+Enter remains the explicit submission path

#### Scenario: The delivery menu is available on touch
- **WHEN** the user opens the separate delivery selector while the agent works
- **THEN** both Steer and Queue are offered by name
- **AND** the action rail keeps its layout

#### Scenario: Selecting delivery is not submission
- **WHEN** the user chooses Queue or Steer with an existing draft
- **THEN** the selector shows the choice, the draft remains, and focus returns to the composer
- **AND** no prompt or cancellation request is made until the corresponding explicit action is activated

#### Scenario: A steer joins the turn at the next step
- **WHEN** a steer is pending and the agent reaches its next step boundary
- **THEN** the agent delivers the steer into the running turn
- **AND** it leaves the dock and appears in the timeline as a user message

#### Scenario: A steer shown pending is not yet in the timeline
- **WHEN** a steer has been handed to the agent but not delivered
- **THEN** it appears only in the dock
- **AND** the timeline contains no user message for it

#### Scenario: Duplicate or image-only entries remain distinguishable
- **WHEN** pending entries have duplicate text or only attachments
- **THEN** their action names include distinct human-readable pending-message numbers
- **AND** a pending entry retains its number across reordering, delivery switches and sibling removal during the current client view

#### Scenario: Repeated successful mutations each announce once
- **WHEN** the user successfully removes, moves or sends two pending messages in succession
- **THEN** each success produces one polite live update even if the words are identical
- **AND** later routine paints do not replay the retained note

#### Scenario: Pending steers note the model they run with
- **WHEN** at least one steer is pending outside compact keyboard/short-landscape mode
- **THEN** the dock says that steers run with the conversation's model and mode at delivery

#### Scenario: A queued message is switched to steer
- **WHEN** the user switches a held message to steer while the agent works
- **THEN** the message leaves the workspace's queue and is handed to the agent as a steer with its attachments
- **AND** every client shows it labelled "Steer"

#### Scenario: A steer is switched back to queue
- **WHEN** the user switches a pending steer to queue and the agent confirms the withdrawal
- **THEN** the message is held in the workspace's queue in its submission order, labelled "Queue"
- **AND** the agent does not deliver it mid-turn

#### Scenario: A steer delivered before it could be withdrawn
- **WHEN** the user switches, edits, or removes a pending steer and the agent delivers it before confirming the withdrawal
- **THEN** the user is told the message was already delivered
- **AND** it appears once in the timeline and is not held, returned to the composer, or delivered again

#### Scenario: A steer is edited
- **WHEN** the user edits a pending steer and the agent confirms the withdrawal
- **THEN** the steer leaves the dock on every client
- **AND** the invoking client's composer receives its text and attachments

#### Scenario: Commands cannot be steered
- **WHEN** a skill, slash command, or `/reload` is held in the queue
- **THEN** its entry offers no switch to steer
- **AND** submitting one with the steer delivery holds it in the queue

#### Scenario: Cancel pauses pending steers
- **WHEN** the user cancels the running turn while steers are pending
- **THEN** the agent is not resumed and no steer is delivered
- **AND** the steers remain in the dock presented as paused

#### Scenario: Send now wakes paused steers together
- **WHEN** steers are paused and the user chooses the dock's Send N paused steers now action
- **THEN** the agent resumes and delivers every paused steer
- **AND** the control said beforehand that all paused steers go together

#### Scenario: A new steer resumes paused steers
- **WHEN** steers are paused and the user submits a new steer
- **THEN** the paused steers and the new one are delivered

#### Scenario: Pending steers survive a reload
- **WHEN** a client reloads while steers are pending
- **THEN** the dock lists the same pending steers, with the same paused states

#### Scenario: Steers raised while disconnected are recovered
- **WHEN** a steer was handed to the agent while the workspace's stream was interrupted
- **THEN** after reconnecting, the dock lists it as pending

#### Scenario: Internal inbox entries are not shown
- **WHEN** the agent holds a pending entry that is not a user message, such as a synthetic note, a compaction, or a move
- **THEN** the dock does not list it

### Requirement: A paused or idle queued message can be sent now

Where send-now is declared, held messages SHALL be deliverable ahead of the queue under agent-specific steering rules. Sending with paused steers SHALL name and confirm the batch effect while preserving the remaining held queue.

#### Scenario: An OpenCode 2.x, Claude Code, or OpenCode 1.x agent reports send-now support
- **WHEN** an OpenCode 2.x, Claude Code, or OpenCode 1.x agent reports send-now support
- **THEN** An agent that can deliver a held message ahead of the rest of the queue SHALL declare the `send-now` capability.
- **AND** The OpenCode 2.x and Claude Code agents SHALL declare it.
- **AND** The OpenCode 1.x agent SHALL NOT declare it.
- **AND** A held message SHALL offer Send now only when its agent declares `send-now`.

#### Scenario: Send now targets held input on a steering agent while running, dormant, or idle
- **WHEN** Send now targets held input on a steering agent while running, dormant, or idle
- **THEN** On an agent that declares `steering`, Send now SHALL hand the held message to the agent as a steer.
- **AND** This is the same operation as switching it to steer, and it is available while the turn runs, while the queue is dormant, and while the conversation is idle.

#### Scenario: A queued Send now would also deliver paused steers and the reader confirms or cancels
- **WHEN** a queued Send now would also deliver paused steers and the reader confirms or cancels
- **THEN** When paused steers exist, the queued Send now control SHALL explicitly name that it also sends paused steers and SHALL confirm that batch effect before submission.
- **AND** Cancelling the confirmation SHALL leave all pending messages unchanged.
- **AND** The remaining held queue SHALL stay dormant.

#### Scenario: Send now targets an agent that supports send-now without steering
- **WHEN** Send now targets an agent that supports send-now without steering
- **THEN** On an agent that declares `send-now` but not `steering`, Send now SHALL be offered only while the held queue is dormant or the conversation is idle, never while a turn runs.
- **AND** Send now SHALL deliver that message immediately, ahead of the other held messages, under the configuration fixed at its submission.
- **AND** The other held messages SHALL remain held in submission order.

#### Scenario: Claude Code sends a dormant queued message now
- **WHEN** a Claude Code conversation's queue is dormant after a cancellation and the user chooses Send now on a held message
- **THEN** that message is delivered and starts its turn
- **AND** the other held messages remain held in submission order

#### Scenario: Send now is unavailable while a Claude Code turn runs
- **WHEN** a Claude Code conversation is running
- **THEN** held messages offer no Send now

#### Scenario: OpenCode 2.x Send now steers
- **WHEN** an OpenCode 2.x conversation has held messages and the user chooses Send now on one
- **THEN** the message is handed to the agent as a steer

#### Scenario: OpenCode 1.x offers no Send now
- **WHEN** the conversation's agent is OpenCode 1.x, which does not declare `send-now`
- **THEN** held messages offer no Send now
- **AND** a direct send-now request is refused without changing the queue

### Requirement: OpenCode V2 background workers have a lifecycle independent of their launchers

Native V2 background workers SHALL have independent, occurrence-specific lifecycles rather than inherit launcher success. Counts and outcomes SHALL converge across surfaces without stale evidence settling another task or changing configured agent/model defaults.

#### Scenario: A native V2 launcher reports a running worker and that worker later settles
- **WHEN** a native V2 launcher reports a running worker, or that worker later completes, fails or is cancelled
- **THEN** For native V2 background subagents, Uatu SHALL track the worker independently of the launching tool call.
- **AND** A successful launcher that reports a running worker SHALL NOT make the subagent appear finished.
- **AND** Confirmed worker completion, error, and cancellation SHALL appear as completed, failed, and stopped respectively, consistently across the launch card, subagent track, background list, and open child view.
- **AND** The worker SHALL remain associated with its parent, chosen agent, and child identity without altering configured agent/model defaults or requiring project instructions.

#### Scenario: Duplicate launch representations overlap or a child session is reused for another task
- **WHEN** duplicate launch representations overlap or a child session is reused for another task
- **THEN** The subagent track SHALL retain one row per task as specified by its existing counting contract, with the compact touch summary exception below.
- **AND** Multiple representations or overlapping calls known to share one live worker SHALL NOT inflate the count of independently running workers.
- **AND** A later task in a reused child session SHALL have a distinct occurrence from its earlier completed task; stale progress or terminal evidence for one occurrence MUST NOT reopen or settle another.
- **AND** Launcher running metadata alone SHALL NOT establish current activity.

#### Scenario: Completed launcher still has a running child
- **WHEN** OpenCode returns a completed background launcher with child metadata reporting running and current evidence confirms that task's activity
- **THEN** the launch is recorded as accepted and the worker remains visibly Working
- **AND** launch instruction text is not presented as the child's finished report

#### Scenario: Terminal outcomes override launcher success
- **WHEN** the same worker subsequently reports completed, error, or cancelled
- **THEN** every presentation of that occurrence shows the corresponding completed, failed, or stopped worker outcome in words
- **AND** its tool launch is not incorrectly reclassified as a failed launch

#### Scenario: Reused child and duplicate frames
- **WHEN** a child completes a task, later starts another task, and old completion or progress frames are replayed
- **THEN** the earlier task remains terminal and the new task remains in its independently established state
- **AND** duplicate representations do not create additional live workers or report rows

#### Scenario: Foreground default remains unchanged
- **WHEN** the chosen agent launches a subagent without requesting background execution and no qualifying accepted Hub steer or explicit background action occurs
- **THEN** the call retains its native foreground behavior
- **AND** Uatu does not inject instructions, change launch policy, or convert it on an ordinary send

### Requirement: OpenCode V2 worker notifications become correlated inspectable results

Structured provider-authored V2 worker notifications SHALL produce one correlated, inspectable canonical result per confirmed occurrence. Replay and delivery SHALL not duplicate results, enter synthetic prompts into the dock, resume the parent independently, or emit child completion as top-level push success.

#### Scenario: A confirmed worker completion, error, or cancellation notification is pending or present in parent history
- **WHEN** a confirmed worker completion, error, or cancellation notification is pending or present in parent history
- **THEN** Uatu SHALL recognize provider-authored synthetic worker completion records using their structured source, identity, and state, including records still pending in the parent's inbox.
- **AND** It SHALL present one readable settled task/result per confirmed occurrence with a link to the associated launch and available child transcript.
- **AND** The report body SHALL have a single canonical presentation; other worker surfaces SHALL expose its outcome and a link rather than duplicate the report.
- **AND** Raw provider envelopes and background-launch instruction text MUST NOT stand in for the report.
- **AND** Error and cancellation SHALL retain their explanation and SHALL NOT be presented as successful worker completion.

#### Scenario: Worker notification enqueue, delivery, history, or replay is reconciled
- **WHEN** worker notification enqueue, delivery, history, or replay is reconciled
- **THEN** Notification enqueue, delivery, history, and replay SHALL converge without duplicate results or synthetic user prompts.
- **AND** Worker notifications MUST NOT enter the editable user steer/queue dock.
- **AND** Uatu MUST NOT inject another completion into OpenCode or independently resume the parent.
- **AND** Child completion and historical recovery SHALL continue to be excluded from successful top-level-turn push notifications; a real subsequent parent turn follows existing notification rules.

#### Scenario: Notification arrives before delivery to the parent
- **WHEN** a worker completion is in the provider's pending synthetic inbox but has not entered parent history
- **THEN** Uatu shows the worker's outcome and report without waiting for a user prompt
- **AND** later delivery and history reads update the same logical result rather than add another

#### Scenario: Worker start predates the launcher row
- **WHEN** a settled worker retains a start timestamp earlier than its correlated launcher row
- **THEN** the timeline presents its result after its launcher, without changing canonical report identity or duplicating its body

#### Scenario: A synthetic result wakes the parent
- **WHEN** OpenCode resumes an idle parent to consume a worker notification
- **THEN** Uatu shows the correlated result and the actual resumed parent activity
- **AND** it sends neither a duplicate notification nor an extra resume operation

#### Scenario: Untrusted lookalike content
- **WHEN** a human message or ordinary tool text contains a subagent-looking envelope without matching provider-authored metadata
- **THEN** it remains inert content and changes no worker state
- **AND** markup and unsafe links in genuine reports remain inert under the existing rendering rules

#### Scenario: Correlation is ambiguous
- **WHEN** a notification names a reused child but the available evidence cannot distinguish which task occurrence it completes
- **THEN** the report remains readable and linked to the verified child without speculatively settling a different occurrence
- **AND** affected state is visibly uncertain until authoritative evidence resolves it

#### Scenario: Worker completion is not a top-level push completion
- **WHEN** a child finishes or an old result is recovered on reconnect
- **THEN** no successful top-level-turn push notification is emitted for that event

### Requirement: OpenCode V2 worker state recovers without relying on provider event replay

V2 work SHALL recover read-only from history, pending notifications and current execution evidence, preserving snapshot/stream agreement without inferring terminal state or durable execution from missing/pre-restart evidence. Note: [#608](https://github.com/tjakobsson/uatu/issues/608) defers the later root-only positive-to-zero descendant refresh after a changed launcher recovers a current positive receipt; zero accounting remains intended, not claimed implemented for that second rewrite.

#### Scenario: A conversation opens, returns, reconnects after missed provider events, or replaces an expired Uatu cursor
- **WHEN** a conversation opens, returns, reconnects after missed provider events, or replaces an expired Uatu cursor
- **THEN** Opening or returning to a conversation, reconnecting after missed provider events, or replacing an expired Uatu stream cursor SHALL reconcile its known background work against provider-owned history, pending notifications, and available current execution evidence.
- **AND** The final snapshot and subsequent stream SHALL agree without duplicate workers or state regression.
- **AND** Recovery SHALL include launches and results outside the initially visible history page and work launched from another client.
- **AND** Parent idleness, an absent child from an active-only listing, or a failed read SHALL NOT alone establish a worker's terminal state.

#### Scenario: Recovery never changes execution
- **WHEN** background work is reconciled on opening, return, reconnect, cursor replacement or restart
- **THEN** recovery sends no prompt, interruption, relaunch or background operation
- **AND** after a service/workspace restart, completed provider history remains inspectable and unresolved work is revalidated without promising execution from a pre-restart launch alone

#### Scenario: Completion is missed while disconnected
- **WHEN** a worker completes while the V2 event connection is absent and the provider offers no replay
- **THEN** reconnect recovers its terminal result from history or pending notification state
- **AND** the worker does not remain running indefinitely or become falsely cancelled from list absence

#### Scenario: Completion races a stale snapshot
- **WHEN** a worker terminal event arrives while recovery is reading an older running launch
- **THEN** applying recovery and the event stream leaves one terminal worker with its report

#### Scenario: A concurrent delivery update omits the original client nonce
- **WHEN** a covered history read owns the original native-message-to-request correlation and a newer concurrent native user row without that client nonce wins the live merge, including under projection or cache pressure
- **THEN** history and the following subscription retain the original request identity for that exact native message while preserving the newer content
- **AND** unrelated native messages do not acquire that identity, and correlation retention remains bounded

#### Scenario: An oversized settled result is unchanged across handoff
- **WHEN** a recovered snapshot contains a settled worker result larger than the replay retention window, covers the current accounting/progress updates, and no further updates intervene
- **THEN** subscribing from that snapshot cursor does not request a retention-gap resync merely because the snapshot includes the oversized result
- **AND** genuine later progress that exceeds replay retention can still require authoritative resynchronization

#### Scenario: Navigation and pagination preserve the worker
- **WHEN** the user switches sessions or workspaces, then returns to a parent whose launch is on an older page
- **THEN** current worker state and its child inspection link are available without manually loading every older page
- **AND** loading older pages does not duplicate the worker

#### Scenario: Another client launches work
- **WHEN** native background work is launched in a confined parent by another OpenCode client while Uatu is disconnected
- **THEN** Uatu discovers that work when it next reconciles the parent or workspace activity

#### Scenario: Restart has inconclusive execution evidence
- **WHEN** persisted history contains a background launch but current provider evidence cannot establish whether it survived a restart
- **THEN** Uatu reports uncertainty and retains available history without claiming durable execution or fabricating a final result

#### Scenario: Child lookups are unavailable while parent history is readable
- **WHEN** the parent's authoritative session and transcript reads succeed but child ownership or execution-history enrichment is unavailable, including under lookup-capacity pressure
- **THEN** the parent's own transcript remains readable without waiting indefinitely for child enrichment
- **AND** unavailable child checks neither expose unverified child content or controls nor establish completion, cancellation, or complete worker inventory
- **AND** a later successful read can restore verified child details without restarting the agent

#### Scenario: Required parent history is unavailable
- **WHEN** the parent's authoritative transcript or required session read fails, or the caller cancels the read
- **THEN** Uatu reports a failed or cancelled read rather than presenting a successful empty or incomplete parent transcript

#### Scenario: Saturated ownership capacity cannot make optional accounting progress
- **WHEN** retained work is reconciled while cancelled but unsettled ownership lookups still occupy every optional lookup slot
- **THEN** parent history remains readable without repeatedly restarting recovery because its own optional accounting reads confirm an unchanged association
- **AND** genuine concurrent ownership counterproof still invalidates affected reads, and later reads can recover details after capacity becomes available

#### Scenario: Optional and required readers share a child transcript
- **WHEN** optional enrichment and a required history reader share a pending child transcript read, and the optional reader's deadline expires first
- **THEN** the required reader can still receive the healthy transcript within its own read window without a duplicate transport request
- **AND** each reader's cancellation releases only its own interest; shared transport is retired when no reader remains
- **AND** cancelled or superseded shared reads cannot populate current history reuse or remove a newer pending read

#### Scenario: Partial child enrichment preserves native revert visibility
- **WHEN** child enrichment fails for either the visible prefix or the complete transcript while a native revert boundary is staged
- **THEN** missing child metadata alone does not authorize removal of a worker whose native origin remains visible
- **AND** a previously projected settled worker whose native origin is hidden does not merge back into the transcript merely because its child metadata is unavailable
- **AND** independently verified live detached work retains its existing visibility and control protections

#### Scenario: Undo replacement receives incomplete worker enrichment
- **WHEN** undo hides a later user message while an earlier settled worker's native origin remains visible and child enrichment is temporarily unavailable
- **THEN** reversible projection replacement and the next subscription snapshot retain the worker's appropriate verified presentation, known accounting, and inspection identity rather than deleting them from page absence alone
- **AND** explicit hidden-origin exclusions still remove reverted work, with existing independently live-work overrides
- **AND** retained presentation does not renew Stop authority, bypass current contradictions, or allow cancelled or superseded reconciliation to replace current state

#### Scenario: Another client commits a revert before the staged view is read
- **WHEN** current authoritative native history has already dropped a reverted suffix before Uatu reads any staged boundary or exclusions
- **THEN** replacement does not resurrect discarded settled workers, their reports, accounting presentation, or inspection targets from the retained projection merely because current history has no exclusions
- **AND** separate exact raw-native-origin coverage distinguishes committed-away origins from visible workers omitted by optional enrichment; normalized page absence, shared child identity, and projected ordering alone do not authorize deletion or retention
- **AND** positively recovered inbox work and independently live work retain their existing provenance, uncertainty, and control safeguards

#### Scenario: Foreground metadata survives unavailable child enrichment
- **WHEN** an exact earlier foreground subagent tool remains visible during undo and its previously verified child enrichment is temporarily unavailable
- **THEN** replacement and subscription retain the tool's known child inspection identity, model, and accounting rather than treating stripped optional fields as authoritative deletion
- **AND** hidden origins, changed occurrences, current ownership contradictions, returned-page authority, and newer live metadata keep their existing precedence; retained metadata grants no new Stop authority

#### Scenario: Older foreground accounting remains on the first page
- **WHEN** a previously verified foreground subagent is older than the newest history page and child enrichment is temporarily unavailable during reconnect
- **THEN** the first snapshot includes that exact visible foreground accounting carrier and agrees with the following subscription, while preserving the newest message page and older cursor
- **AND** cold or unrelated retained rows, changed or ambiguous occurrences, hidden origins, and contradicted associations are not admitted; current accounting and newer live metadata retain precedence

#### Scenario: Expired accounting does not price a changed foreground invocation
- **WHEN** completeness expires for a previously priced foreground launcher, its input or occurrence changes, child ownership succeeds, and current optional accounting expires
- **THEN** history and the following subscription do not assign the earlier invocation's cached task usage or model to the changed launcher, including for a single-row cohort
- **AND** exact retained membership and launcher bindings may preserve unchanged task receipts, including siblings and bindings reconstructed before opening the child timeline; last-known worker-session aggregates remain separate
- **AND** a native tool update processed before history begins does not make its changed binding provenance for older retained accounting, while its newer presentation remains visible
- **AND** accounting-transcript eviction does not allow retained projection merging to restore a withdrawn stale task receipt in the following subscription
- **AND** late responses and usage/model restatements do not reauthorize changed task accounting; completed current accounting restores verified task values, including authoritative zero, under the existing source and publication fences

#### Scenario: A source-current child rewrite reprices an exact launcher
- **WHEN** a successful child undo reconstructs reduced task accounting for an already-priced exact foreground launcher
- **THEN** the parent projection, history, and following subscription reflect the current verified task amount, including authoritative zero, without clearing negative cohort restrictions
- **AND** an ancestor-only view can reprice that exact nested receipt without opening intermediate conversations; retained path bindings, incoming ownership, source leases and visibility remain current through actual queued publication under the existing optional deadline
- **AND** mixed projected/unprojected ancestor paths receive the same current receipt: one accepted publication from the exact bounded rewrite does not invalidate its remaining ancestor publications, while independent updates retain their existing precedence and fences
- **AND** a deeper branch hidden by the same undo is selectively withdrawn only from complete current own topology, preserving visible and temporarily unavailable descendants
- **AND** changed or unresolved launcher bindings, positive membership deficits, incoming ownership counterproof, cancellation, superseded generations, and newer live presentation keep their existing safeguards

#### Scenario: Incomplete descendants preserve promptly verified own accounting
- **WHEN** a native child's own accounting returns under current source and owner evidence but optional descendant reconstruction exceeds its bounded window or descendant ownership is unavailable
- **THEN** direct and ancestor-first recovery retain usable own task cost/model while leaving descendant completeness unset and unavailable descendant amounts unknown
- **AND** usable own prompt/accounting proof does not establish complete outgoing topology, clear a positive cohort deficit, authorize deeper parent-task bindings, or permit hidden-branch withdrawal
- **AND** without current outgoing topology, deeper binding requires an exact immutable retained relation matching both current launcher occurrences, scope and native prompt identity; changed parent occurrences, copied lines or ID/positional matching cannot mint that proof, while unchanged exact receipts remain available
- **AND** readable current native tool occurrence, prompt-origin and visibility evidence invalidates stale cached launchers even when unavailable ownership strips the normalized child association; this evidence does not admit unverified children or establish topology completeness
- **AND** a verified live launcher arriving after the accounting snapshot invalidates the older reconstruction through final publication and causes bounded retry rather than losing its edge or falsely stamping descendant completeness; immediate healthy recovery does not wait for the completeness cache to expire
- **AND** later recovery retries incomplete descendants, while expired or changed owners, source leases, incoming associations, and generations do not authorize stale publication or control authority

#### Scenario: Concurrent foreground progress preserves complete attribution order
- **WHEN** two foreground calls share a child and one call receives a newer native update while optional child enrichment is unavailable
- **THEN** the complete attribution order includes the current exact association so the other call does not absorb the child's entire known usage or double-count spend after the live merge
- **AND** ordering evidence neither overwrites the newer row nor admits it through fallback carrier restoration; occurrence, visibility, contradiction, cancellation, generation, and control safeguards remain intact
- **AND** if only one call changes occurrence or input and the child's allocation cohort is no longer proven complete, history and live decoration withhold aggregate redistribution rather than charging it to the surviving sibling; exact current values remain available, mismatched values stay unknown, and fresh authoritative accounting retains precedence
- **AND** after degraded history withdraws an association, a subsequent usage/model restatement or successful ownership lookup alone does not restore allocation eligibility; only coherent current cohort evidence can do so, within the existing bounded attribution lifetime
- **AND** recursive ancestor attribution applies the same eligibility checks at each child edge, preserving known own spend and exact current descendant amounts without restoring withdrawn or mismatched attribution
- **AND** deeper descendants retain only proven current parent-task bindings, including occurrence identity; a blocked or unresolved cohort does not provide positional binding authority at any depth

#### Scenario: A pending fallback outlives optional inventory recovery
- **WHEN** a confined result remains pending in the inbox, required transcript and pending-inbox reads succeed, and optional active-worker recovery expires before delivery
- **THEN** history and the following subscription retain the current pending fallback text, including authoritative payload updates
- **AND** enqueue-only materialization does not authorize deletion from stored-history absence; stored/delivered provenance and pending evidence remain distinct
- **AND** pending text grants no inspection, completeness, activity, or Stop authority, while failed required pending reads still reject recovery without erasing known presentation

#### Scenario: Pending delivery changes the fallback presentation clock
- **WHEN** an exact pending fallback is delivered while disconnected and its stored result has a different timestamp
- **THEN** a recovered verified worker supersedes the previously recorded exact fallback relation in history and subscription, including removal for existing subscribers
- **AND** observed stored provenance follows that exact native result so a later committed removal cannot restore the old pending notice
- **AND** changed or unrelated notice content, result/child mismatches, and concurrent newer changes do not acquire removal authority from timestamp tolerance

#### Scenario: A reverted result was previously a fallback notice
- **WHEN** unavailable child ownership caused a delivered result to be retained as a fallback notice, and a later native revert hides that result
- **THEN** authoritative removals include the fallback identity whether ownership remains unavailable or recovers and changes the result's normalized identity
- **AND** neither the history response nor the next subscription snapshot exposes the hidden fallback result
- **AND** visible-prefix origins and independently verified live work retain their existing safeguards

#### Scenario: A visible launcher and its result straddle a revert boundary
- **WHEN** a worker's launch remains visible but its later stored result is authoritatively hidden or committed away
- **THEN** replacement retains only the appropriate visible-launch presentation, not the discarded result's report or result-derived terminal fields, whether optional enrichment succeeds or is unavailable
- **AND** independently current inbox or execution evidence keeps its own visibility and control safeguards

#### Scenario: Fresh ownership evidence contradicts a retained child association
- **WHEN** a fresh child lookup positively reports a different parent or workspace during replacement reconciliation
- **THEN** retained worker and tool presentations do not restore that contradicted child inspection or accounting association
- **AND** parent-owned historical text can remain without the contradicted association, while unavailable optional lookups alone do not establish that contradiction
- **AND** cancelled or superseded reads cannot revoke or restore associations on behalf of a newer view

#### Scenario: A visible result changes presentation during enrichment recovery
- **WHEN** a retained or recovered verified worker and a fallback notice represent the same native result, either after a healthy result degrades during reconnect or after a cold degraded read recovers
- **THEN** history and subscription snapshots contain one presentation of that result rather than both rows
- **AND** the fallback notice is superseded in the retained projection and its removal is delivered to existing subscribers
- **AND** notices without a corresponding verified worker and unrelated notices/results remain visible, while canonical worker aliases, stream fences, ownership/Stop, and native live/revert safeguards remain intact

#### Scenario: Current report text changes during unavailable child enrichment
- **WHEN** a retained completed worker's native pending or stored report changes text while child ownership enrichment is unavailable
- **THEN** current parent-owned report text remains visible in history and subscription; matching result/child identity alone does not let the worker's old summary suppress the fresh fallback
- **AND** unchanged normalized report content can still be superseded across delivery-clock changes, without granting new activity, inspection, accounting, ownership, or control authority

#### Scenario: Authoritative history is slower than a worker check
- **WHEN** the parent's authoritative history succeeds within its bounded history-read window but takes longer than the short worker-recovery budget
- **THEN** the conversation loads without treating that short worker budget as a deadline for the entire transcript
- **AND** history timeout or loss of the covering event-stream generation still rejects the read rather than returning an unfenced snapshot

#### Scenario: Child accounting is unavailable after ownership succeeds
- **WHEN** the parent's authoritative history and child ownership reads succeed but reconstructing child accounting or nested accounting does not complete within its bounded optional-read window
- **THEN** the parent history read succeeds with the accounting already available rather than failing or reporting missing amounts as zero or complete
- **AND** late results from a cancelled, expired, or superseded accounting read do not overwrite current accounting or mark an incomplete reconstruction complete
- **AND** a later successful read can restore verified accounting without restarting the agent or replaying a mutation

#### Scenario: Visible descendant enrichment is temporarily incomplete
- **WHEN** child history returns known own accounting but unavailable optional enrichment leaves its visible descendant topology incomplete on any reconstruction page
- **THEN** Uatu retains the known own accounting without marking the descendant reconstruction complete
- **AND** a later parent refresh retries the incomplete reconstruction and can restore verified nested accounting immediately after ownership recovers, without waiting for the completeness cache to expire
- **AND** if a previously complete nested tree becomes incomplete on refresh, its older completeness stamp does not make the current reconstruction or its ancestors complete
- **AND** enrichment failures confined to a reverted hidden suffix do not make the visible accounting tree incomplete

### Requirement: Users explicitly continue the parent while all eligible blocking jobs run

Supported V2 SHALL offer Continue while workers run only for verified eligible blockers, using native parent-wide backgrounding and protected bounded unknown-preserving receipts, no replay. It MUST NOT cancel work, send/clear drafts, change preferences, flush queues or manufacture steers. Sending or delivery selection SHALL NOT implicitly background work except under the verified personal Hub accepted-steer exception. Unsupported agents SHALL lack Continue. Receipt persistence is not required.

#### Scenario: A V2 parent with backgrounding support has eligible running blockers and the user invokes Continue while workers run
- **WHEN** a V2 parent with backgrounding support has pending, generating, blocking, detached, settled or uncertain work, or the user invokes Continue while workers run
- **THEN** For OpenCode V2 that declares backgrounding support, Chat SHALL offer a distinct action labelled `Continue while workers run` only while an active parent has running blocking tool/command or confirmed foreground-task evidence.
- **AND** Pending tools, a merely generating parent, and launchers already correlated to detached, settled or uncertain workers SHALL NOT expose it.
- **AND** A tooltip and collapsed explanation SHALL state that it backgrounds all eligible blocking jobs in that parent, including shell commands, without stopping them.
- **AND** It SHALL use the provider's native parent-wide background operation and MUST NOT imply selected-child scope or an exact eligible count the provider does not report.
- **AND** If nothing remains eligible when the request reaches the provider, the action SHALL be a harmless accepted no-op.
- **AND** Accepted feedback SHALL clear once the parent and workers settle and no background request is in flight.

#### Scenario: A protected background mutation is duplicated or its dispatched response is lost
- **WHEN** a protected background mutation is duplicated or its dispatched response is lost
- **THEN** The mutation SHALL be authenticated, workspace-confined, origin-protected under cookie authentication, and agent-qualified.
- **AND** It SHALL deduplicate a client request identifier while its in-memory receipt is retained.
- **AND** Its acceptance SHALL NOT be represented as proof that a specific worker is running.
- **AND** If the provider may have applied a dispatched mutation but its response is lost, Uatu SHALL retain an explicit unknown outcome within the same bounded receipt lifetime rather than discard it as an ordinary retryable error.
- **AND** A retained unknown outcome SHALL produce explanatory uncertainty, not a false acceptance, and retries against that retained receipt SHALL not dispatch again.
- **AND** Concurrent duplicate actions SHALL be suppressed within that retention scope.

#### Scenario: A background receipt expires, is evicted, or is lost on adapter or process recreation
- **WHEN** a background receipt expires, is evicted, or is lost on adapter or process recreation
- **THEN** Receipt retention SHALL be bounded: the default settled lifetime is up to 15 minutes, capacity eviction can end it sooner, and adapter recreation or process restart ends it entirely.
- **AND** after any of those retention boundaries, an old identifier with no retained receipt may be handled as a new request rather than deduplicated
- **AND** The client SHALL NOT automatically replay an uncertain mutation on reconnect or reload, including with the same identifier.
- **AND** It SHALL recover state read-only and require a fresh explicit action before making another attempt.

#### Scenario: Continue is invoked with drafts, pending input, or delivery preferences present
- **WHEN** Continue is invoked with drafts, pending input, or delivery preferences present
- **THEN** The action MUST NOT cancel a parent or worker, send or clear a draft, change model/mode/delivery preferences, flush a held queue, or manufacture steers.

#### Scenario: Sending and delivery selection do not invoke Continue
- **WHEN** a user sends input or selects a delivery mode outside the verified personal Hub accepted-steer exception
- **THEN** no implicit native background operation is requested
- **AND** unsupported agents expose no Continue action

#### Scenario: Mixed blocking jobs become background work
- **WHEN** the parent is blocked by two eligible subagents and a native shell job and the user activates Continue while workers run
- **THEN** one parent-wide background operation is requested for all eligible jobs, not only one selected child
- **AND** provider-confirmed background jobs remain visible and inspectable while the parent can continue
- **AND** no interrupt or prompt is sent by the action

#### Scenario: No eligible blocker remains
- **WHEN** all blockers finish just before the background request reaches OpenCode
- **THEN** the accepted no-op neither invents running workers nor raises a task failure

#### Scenario: A busy parent has no running blocker
- **WHEN** the parent is generating, has only pending tools, or has already detached its workers
- **THEN** Continue is absent rather than suggesting another background operation

#### Scenario: Retrying a lost response does not affect newer jobs
- **WHEN** Uatu has recorded the outcome, the browser response is lost, and the same client request identifier is retried while that receipt is still retained after another blocker appears
- **THEN** Uatu returns the recorded outcome without issuing the operation again or affecting the newer blocker

#### Scenario: Upstream response is lost after application
- **WHEN** OpenCode applies the background request but the response to Uatu is lost and the provider call fails ambiguously
- **THEN** Uatu retains an unknown outcome instead of deleting the receipt as a retryable failure
- **AND** a same-identifier retry while that receipt is retained returns uncertainty without a second native operation, even if newer blockers have appeared

#### Scenario: Receipt retention ends
- **WHEN** an operation's receipt expires, is evicted for capacity, or is lost with adapter recreation or process restart
- **THEN** Uatu does not claim that resubmitting the old identifier is deduplicated
- **AND** the client does not automatically replay an uncertain request, but refreshes state and requires a new explicit action before another attempt

#### Scenario: Draft and steering state are preserved
- **WHEN** Continue while workers run is activated with a staged draft, attachments, a pending steer, and held queued messages
- **THEN** those values remain intact and no pending user input is edited, removed, or sent by that action
- **AND** subsequent provider lifecycle transitions follow the existing steering and queue rules

#### Scenario: Unsupported or foreign request
- **WHEN** an unsupported agent, unauthorized client, cross-origin cookie request, or foreign-workspace parent is targeted
- **THEN** Uatu rejects the mutation without contacting a worker or revealing foreign session content

### Requirement: Parent stop and worker stop have explicit separate effects

Parent Stop and worker Stop SHALL have separate verified scopes and truthful outcomes. Touch parent-stop and native shell removal SHALL require the specified confirmations; bounded stop receipts, race handling, and unavailable output SHALL never fabricate cancellation or retarget a newer occurrence.

Worker-stop receipts share backgrounding's retention bounds; expiry, eviction, adapter recreation or restart ends deduplication guarantees.

#### Scenario: Parent Stop is offered or invoked while V2 foreground and detached background work coexist
- **WHEN** parent Stop is displayed or invoked for V2 work, with or without current foreground execution or detached workers
- **THEN** For V2 background work, Chat SHALL distinguish parent interruption from stopping one verified worker.
- **AND** Parent Stop SHALL interrupt the current parent execution without explicitly waking pending input, leave held queue/steer behavior governed by the existing cancellation contract, and not stop detached workers.
- **AND** The UI SHALL explain that still-blocking foreground work can be cancelled by parent interruption and that future provider-owned worker notifications can wake the parent again.
- **AND** With no parent execution, parent Stop SHALL remain disabled rather than become a stop-all-workers action.

#### Scenario: A touch reader activates Stop parent while worker records exist
- **WHEN** a touch reader activates Stop parent while worker records exist
- **THEN** On touch, activating Stop parent with worker records SHALL first open an in-app scope explanation and confirmation.
- **AND** Cancelling SHALL make no cancellation request; confirmation SHALL recheck that the same parent still has live work before acting.
- **AND** Desktop parent-stop behavior and native cancellation scope remain unchanged.

#### Scenario: Worker Stop targets a verified task or races settlement, target reuse, or an ambiguous transport outcome
- **WHEN** Worker Stop targets a verified task or races settlement, target reuse, or an ambiguous transport outcome
- **THEN** Worker Stop SHALL resolve the selected task under its verified parent/workspace and target only that worker's native execution.
- **AND** A known stale, settled, uncertain, foreign, or unrelated task target SHALL be refused without redirecting the request to a newer child occurrence.
- **AND** while a worker-stop receipt is retained, retries return its retained outcome without redispatch; a transport-ambiguous dispatched outcome remains explicitly unknown and reconnect/reload does not replay it
- **AND** its default settled retention ends by 15 minutes, capacity eviction can end it sooner, and adapter recreation or process restart ends it entirely
- **AND** after receipt expiry, capacity eviction, adapter recreation or process restart, an identifier with no retained receipt may be handled as a new request
- **AND** An accepted interruption SHALL show pending stopping feedback until authoritative settlement; it SHALL NOT overwrite a confirmed completed result with stopped.
- **AND** Native effects on a worker's own blocking descendants remain provider semantics, not a new stop-all operation.

#### Scenario: Native shell Stop explains removal before activation and reports capture races truthfully
- **WHEN** native shell Stop is offered
- **THEN** the UI explains before activation that Stop removes the provider's shell record and output, output can become unavailable and the provider may report a failed result rather than cancellation
- **WHEN** the confirmed Stop removes the shell record, including a race with final capture or completion
- **THEN** removal acknowledgement or a missing output record alone does not establish a cancelled job
- **AND** Uatu SHALL preserve a confirmed completed result if capture and completion already won the race; if removal prevents the final capture and the provider reports error, it SHALL present failed with output-unavailable context rather than force completed or stopped.

#### Scenario: The reader opens, confirms, cancels, or presses Escape in shell-stop confirmation
- **WHEN** the reader opens, confirms, cancels, or presses Escape in shell-stop confirmation
- **THEN** Shell Stop SHALL use an in-app confirmation with Cancel initially focused.
- **AND** Escape SHALL cancel that confirmation without closing the child/output view, restore the invoking control or surviving equivalent, and send no mutation.
- **AND** Confirmation SHALL revalidate current task state before dispatch.

#### Scenario: Touch parent-stop confirmation explains detached work
- **WHEN** a touch user activates Stop parent with worker records present
- **THEN** the confirmation explains still-blocking work, continuing detached workers and possible later provider wakeup
- **AND** Cancel leaves work untouched while confirmation cancels only the same still-live parent execution

#### Scenario: Stop parent with mixed workers
- **WHEN** the parent has both still-blocking foreground children and detached background children and the user selects Stop parent
- **THEN** the parent is interrupted and foreground dependencies follow native cancellation semantics
- **AND** detached workers continue, stay inspectable, and held user input is not resumed by that stop

#### Scenario: Stop one detached child
- **WHEN** the user stops one verified running background child
- **THEN** only that child's execution is targeted and sibling detached workers are not interrupted
- **AND** the parent is not explicitly interrupted or resumed by Uatu

#### Scenario: Completion wins a stop race
- **WHEN** a completed worker result is confirmed before the requested interruption settles
- **THEN** its confirmed completed result remains completed rather than being overwritten with an optimistic stopped outcome

#### Scenario: Worker-stop response is lost upstream
- **WHEN** OpenCode may have applied a child interruption or shell removal but Uatu loses its response
- **THEN** Uatu retains an unknown receipt outcome within the bounded retention scope and reconciles state without an automatic mutation retry
- **AND** same-identifier retries while retained do not issue another interruption or removal

#### Scenario: Removal prevents a shell's final capture
- **WHEN** shell removal deletes its record/output before the plugin completes its result capture, including after the process has exited, and the provider reports error
- **THEN** the task shows failed with stop-request and output-unavailable context, not invented cancellation or success
- **AND** record deletion or a removal acknowledgement is not itself treated as a terminal job notification

#### Scenario: Shell result capture wins the removal race
- **WHEN** the provider has captured and confirmed a completed shell result before removal makes further output reads unavailable
- **THEN** the completed result is retained without an optimistic stopped outcome
- **AND** unavailable additional output is disclosed independently of the completed result

#### Scenario: Stop acknowledgement precedes settlement
- **WHEN** the provider acknowledges interruption before its cleanup and terminal notification finish
- **THEN** the task shows Stopping feedback and suppresses duplicate stop requests
- **AND** its final outcome follows confirmed provider evidence

#### Scenario: Old stop target has been superseded
- **WHEN** a stop references an old task and reconciliation already identifies a newer execution in that same child session
- **THEN** the stop is refused without interrupting the newer execution

#### Scenario: Late completion notification resumes a stopped parent
- **WHEN** OpenCode subsequently wakes the parent for a detached worker's notification after the user stopped an earlier parent turn
- **THEN** Chat shows that actual new parent activity without claiming that Stop permanently disabled future wakeups

### Requirement: Background inspection and controls remain accessible and workspace-confined

Background inspection and controls SHALL preserve parent state, child ownership, safe output, and accessible independent actions. Responsive worker/pending docks SHALL retain bounded space, focus, and pending safety information; unavailable child reads or removed output SHALL be explained without foreign access or false recovery promises.

No persistent output archive is required.

#### Scenario: A verified V2 background child is opened while running or settled and its read succeeds or fails
- **WHEN** a verified V2 background child is opened while running or settled and its read succeeds or fails
- **THEN** V2 background children SHALL open through the existing parent drill-down while running and after settlement, by their verified child identity rather than top-level picker membership.
- **AND** The parent selection, draft, attachments, reading state, and return path SHALL be preserved.
- **AND** A failed child read SHALL retain the parent and provide actionable Retry feedback rather than navigate to a different conversation or leave a dead control.
- **AND** Child permissions/questions SHALL remain reachable through existing interaction handling.
- **AND** the child view offers no direct child messaging control

#### Scenario: Native shell work is inspected or stopped after backgrounding or provider output removal
- **WHEN** native shell work is inspected or stopped after backgrounding or provider output removal
- **THEN** Native shell work affected by backgrounding SHALL retain inspectable already-received output and outcome through the task inspection surface within their existing retained view/history lifetime; reads and stops SHALL verify its workspace and parent ownership and SHALL NOT accept arbitrary output paths.
- **AND** When provider removal deletes output, the surface SHALL explain that further output is unavailable, preserve what is still locally available, and not promise that lost bytes can be recovered after reload.
- **AND** Both task inspection and result rendering SHALL preserve existing output safety and distinguish upstream truncation from output removal.

#### Scenario: Pointer, keyboard, or touch users inspect, background, stop, open, or return from worker views
- **WHEN** pointer, keyboard, or touch users inspect, background, stop, open, or return from worker views
- **THEN** Desktop pointer, keyboard, and touch users SHALL be able to inspect workers, return to the parent, request backgrounding, and stop a verified worker using labelled controls with visible focus, at least 44 CSS pixel targets and 8 CSS pixel gaps between adjacent mutation actions.
- **AND** State and failure SHALL be conveyed in words, not colour or animation alone.
- **AND** Reduced-motion preferences SHALL be respected.
- **AND** Dynamic updates SHALL NOT steal focus, discard reading position, or replace the separate Send and Stop actions and fixed keyboard/hold delivery paths.
- **AND** Opening a child SHALL move focus into its view; return SHALL restore the invoking control or a logical surviving equivalent.
- **AND** Layered output Escape SHALL NOT also dismiss its owning child view.

#### Scenario: The touch composer enters software-keyboard mode or short landscape while workers and pending input exist
- **WHEN** the touch composer has workers or pending input, including software-keyboard mode or short landscape
- **THEN** The live worker list SHALL remain reachable through the bounded scrollable work dock while composing without a software keyboard, except in short touch landscape.
- **AND** With the software keyboard open, or in a visual band at most 390px high and at least 600px wide, worker/subagent tracks and Continue SHALL be hidden to preserve conversation and composer space; dismissing the keyboard or leaving short landscape SHALL restore access.
- **AND** Compact pending counts, any paused-batch Send action and replacement warnings follow the steering dock's safety rules and SHALL remain available while typing.
- **AND** Touch SHALL use one deliberate compact worker disclosure rather than duplicate pinned worker presentations.
- **AND** Worker Stop and parent Stop SHALL be distinctly labelled; routine worker appearance SHALL preserve the reserved composer control geometry.
- **AND** Expanded touch work tracks SHALL keep the prompt rail from covering worker actions.

#### Scenario: The shared touch work dock allocates space during hardware editing or expanded-card presentation
- **WHEN** the shared touch work dock allocates space with collapsed or expanded cards, including hardware-keyboard editing
- **THEN** the tracks share one visual-height budget, reserve their final bounded layout height before visual reveal and honor reduced motion rather than each taking a separate budget
- **AND** both collapsed cards during hardware-keyboard editing use the 24% cap, while either expanded card uses the measured small-strip allocation
- **AND** layout changes leave worker execution, ownership, stop targets and the existing interaction-request answering flow unchanged

#### Scenario: A child excluded from the picker opens reliably
- **WHEN** a user opens a verified background child from its running task or historical result on desktop or touch
- **THEN** its exact transcript opens with the parent still selected and a first-class way back
- **AND** settlement while it is open updates the task outcome without closing the transcript

#### Scenario: A temporary child read failure is recoverable
- **WHEN** opening a child fails transiently
- **THEN** the parent and draft remain intact and Retry can open the same child after recovery

#### Scenario: Keyboard and touch control separation
- **WHEN** a narrow desktop or touch user navigates visible task controls by keyboard or taps adjacent action targets and gaps
- **THEN** inspection, Continue, worker Stop, Send, and parent Stop remain distinguishable and reachable without overlapping hit regions
- **AND** focus restoration and status announcements do not submit a draft or trigger another action

#### Scenario: Continue is first-touch usable while composing
- **WHEN** the touch composer is focused in a layout where Continue is visible and the user taps Continue while workers run
- **THEN** that first tap submits exactly one background request without losing the composing draft or its focus

#### Scenario: Keyboard and short landscape defer worker controls, not pending safety
- **WHEN** a touch parent composer enters software-keyboard mode or short landscape with live workers and pending messages
- **THEN** worker tracks and Continue are hidden while the compact pending counts, paused-batch Send and replacement warning remain available as applicable
- **AND** leaving that compact state restores worker access without stopping work or losing the draft

#### Scenario: Foreground work becomes a duplicate background presentation
- **WHEN** foreground work is detached on touch
- **THEN** the one compact worker disclosure updates without opening itself or adding a duplicate pinned track
- **AND** a deliberately expanded worker disclosure remains open

#### Scenario: Automatic expansion survives a conversation switch
- **WHEN** desktop conversation A automatically opens its worker card and the user selects B without touching A's disclosure
- **THEN** B uses its own active-batch state without inheriting A's automatic expansion or deliberate choices, and detachment does not close its canonical worker card
- **AND** returning to A restores A's page-local state; touch choices remain separately deliberate per conversation

#### Scenario: Shell settles while confirmation is open
- **WHEN** settlement removes the invoking shell Stop control before the user dismisses its confirmation
- **THEN** Escape keeps the inspection open, sends no removal and restores its surviving result action or logical inspection equivalent before the composer

#### Scenario: Shell output and stop remain owned by the task
- **WHEN** a native shell job is backgrounded alongside subagents
- **THEN** its available output and terminal outcome remain inspectable, and stopping it targets only its verified shell execution
- **AND** another session's shell identity or arbitrary filesystem output path is refused

### Requirement: V2 background work participates in workspace activity without false completion

Confirmed live V2 background work SHALL keep workspace activity working independently of parent selection or idleness. Needs-answer priority and bounded authenticated content-free reporting SHALL remain intact; failed recovery MUST NOT fabricate a finished transition.

#### Scenario: Confirmed V2 background work continues, needs input, settles, or becomes uncertain while workspace activity is summarized
- **WHEN** confirmed V2 background work continues, needs input, settles, or becomes uncertain while workspace activity is summarized
- **THEN** Confirmed live V2 background work SHALL keep the existing workspace activity summary working even while its parent is idle, unselected, or viewed from another workspace.
- **AND** Requests needing user input SHALL retain existing needs-answer priority.
- **AND** Once all confirmed work settles and no parent turn remains, normal finished/unviewed behavior SHALL apply once.
- **AND** A failed or incomplete reconciliation SHALL NOT create a finished transition merely by dropping unknown tasks.
- **AND** Activity messages SHALL retain their existing bounded, content-free contract and authenticated workspace scope.

#### Scenario: Unselected parent still has work
- **WHEN** the parent finishes its response but a detached child continues while the user views another workspace
- **THEN** the owning workspace remains working in the activity summary
- **AND** returning to it exposes the same live child without another launch

#### Scenario: Worker needs input while the parent is idle
- **WHEN** a detached worker raises a permission request or question
- **THEN** the owning workspace reports needs-answer and the request remains reachable from the parent

#### Scenario: Last worker settles or recovery fails
- **WHEN** the last confirmed worker settles with no parent turn active
- **THEN** normal workspace-finished behavior occurs once
- **AND** a later replay, duplicate notice, or failed refresh does not create another completion

### Requirement: Touch pending messages and workers use compact deliberate disclosures

Pending messages and workers SHALL use canonical, bounded disclosures with truthful visible-row counts and retained per-conversation choices. Touch SHALL default collapsed; desktop SHALL auto-open new active batches subject to deliberate collapse. Accessible row density, safe actions, dismissal, and independent reading ownership SHALL remain intact.

The collapsed touch defaults are an explicit exception to desktop automatic expansion.

#### Scenario: Touch Chat shows pending messages and working, unresolved, or finished worker occurrences across updates and reselection
- **WHEN** touch Chat renders empty or nonempty pending-message and worker sets, including updates or reselection
- **THEN** Touch chat SHALL show at most one initially collapsed pending-message summary and one initially collapsed worker summary, omitting an empty summary.
- **AND** Pending text SHALL identify only nonzero steer/queued categories without repeating the total, such as `1 queued` or `2 steers · 1 queued`.
- **AND** Its header and inline pending actions SHALL use the approved 32px minimum density exception with independent 8px gaps including before Remove, preserving existing confirmations.
- **AND** Cards SHALL share compact delivery labels and message content on a line where space permits rather than forcing three rows; long messages and warnings SHALL remain readable.

#### Scenario: Touch worker summaries distinguish current activity from uncertainty
- **WHEN** a touch worker summary includes current, unverified, dismissed, or settled occurrences
- **THEN** Worker text SHALL identify Working, Unresolved and Finished occurrences, omitting zero-count groups; Finished SHALL include confirmed terminal failures/stops without implying successful completion.
- **AND** Checking status and unverified task activity SHALL count under Unresolved, not Working or Finished.
- **AND** A request positively linked to the current task SHALL show Needs your answer and count under Working.
- **AND** Dismissed counts SHALL NOT be visible; when no visible workers remain the whole worker card SHALL be absent.

#### Scenario: Touch disclosure choices survive work updates and navigation
- **GIVEN** touch Pending and Workers have their own summaries
- **WHEN** work changes, history replays, or the reader returns to the conversation
- **THEN** New work, replay and settlement SHALL update the summaries without automatically expanding touch details.
- **AND** Deliberate per-conversation expansion SHALL survive repaint, reselection and viewport changes within the page without leaking to other conversations.

#### Scenario: Pending messages use multiline, image-containing, or enlarged-text presentations
- **WHEN** pending messages use multiline, image-containing, or enlarged-text presentations
- **THEN** Pending message leading SHALL scale with text size, preserving 14px type/20px leading at default size and 28px/40px at 200% root text.
- **AND** Multiline glyph rectangles SHALL remain vertically separated; enlarged multiline and image-containing cards SHALL grow naturally within the existing dock scroller without horizontal overflow or reduced mutation targets.

#### Scenario: Replacement changes pending actions or paused-batch Send remains available with entries collapsed
- **WHEN** replacement changes pending actions or paused-batch Send remains available with entries collapsed
- **THEN** After replacement changes the available actions, pending footers and action groups SHALL shrink to their card's content width and long labels such as `Send now + paused steers` SHALL wrap without clipping or truncation.
- **AND** Cards and their shared height budget SHALL NOT acquire horizontal scrolling.
- **AND** Actions SHALL retain at least 32px targets and independent 8px gaps, and SHALL be fully exposable within all clipping ancestors.
- **AND** Paused-batch Send SHALL retain a 44px target in Pending's independent content pane, available even with entries collapsed; the count header SHALL remain visible outside that pane.
- **AND** Existing confirmation wording, cancellation without mutation and confirmed paused-batch delivery semantics SHALL remain unchanged.

#### Scenario: The reader expands pending or worker details while replacement, batch, or operation warnings exist
- **WHEN** pending or worker details are expanded or collapsed, with or without replacement, batch or operation warnings
- **THEN** Expanded pending details SHALL retain delivery order and existing edit/remove/convert/Send now actions.
- **AND** Expanded worker details SHALL retain inspection, truthful terminal outcomes, available shell output and existing parent/worker-stop safeguards.
- **AND** Replacement consequences, paused-batch warnings and applicable batch Send, and actionable operation failure/uncertainty SHALL remain visible outside collapsed details.

#### Scenario: Desktop UI mode receives a new active batch, a deliberate collapse, repaint, mode switch, or temporary null selection
- **WHEN** desktop UI mode receives a new active batch, a deliberate collapse, repaint, mode switch, or temporary null selection
- **THEN** In selected desktop UI mode, Workers SHALL automatically open when a new batch of visible Working or Unresolved occurrences first appears, and Pending SHALL automatically open for a new nonempty batch, including paused entries.
- **AND** Deliberate collapse SHALL hold until that card's visible Working/Unresolved or pending batch becomes empty; further arrivals SHALL NOT reopen it.
- **AND** Ending a batch SHALL leave its current open state alone and clear the collapse veto for the next batch.
- **AND** Finished-only history SHALL NOT invent a new active batch.

#### Scenario: Desktop disclosure retention distinguishes gestures from refresh
- **GIVEN** the reader has an active desktop worker or pending batch
- **WHEN** conversation selection, UI mode, repaint, or a native disclosure event changes
- **THEN** Choices SHALL be retained separately per conversation and UI mode in a page-local cache bounded to 200 conversations, without inheriting another conversation's choice or treating automatic expansion, mode changes or delayed programmatic toggle echoes as user gestures.
- **AND** Null selection during refresh SHALL NOT end a batch.
- **AND** Native pointer/keyboard changes SHALL survive a live repaint before their deferred toggle event arrives.
- **AND** Policy SHALL follow `data-ui-mode`, not fine-pointer density; tablet desktop mode SHALL use desktop defaults.
- **AND** Canonical rows, independent pane offsets, focus and reading-anchor ownership SHALL remain unchanged.

#### Scenario: Expanded worker details render active, unresolved, settled, and stoppable occurrences
- **WHEN** expanded worker details render any active, unresolved, settled or stoppable occurrences
- **THEN** Expanded worker details SHALL show one flat list: Working and Unresolved workers first, then Finished history ordered newest first from available execution timestamps, without a separate Finished disclosure.
- **AND** Each occurrence SHALL have one whole-row inspection target.
- **AND** Names SHALL remain readable at at least 14px and metadata at at least 13px, subject to the documented compact-density exceptions.
- **AND** Occurrences offering Stop SHALL use two lines within the existing 44px action height: task title first, then the actual reported agent, model and explicitly cumulative Σ usage.
- **AND** Missing metadata SHALL NOT be invented.
- **AND** Settled and inspection-only rows SHALL retain the approved single-line density exception of at most 28px at default text scale.
- **AND** State-specific glyphs SHALL distinguish working, unresolved, finished, failed and stopped; required activity/evidence wording SHALL remain readable without redundant repeated terminal labels.
- **AND** Unresolved and settled glyphs SHALL NOT imply live execution.
- **AND** Stop SHALL remain a separate 44px target with an 8px gap and a semantic accessible name identifying its worker; its visible label SHALL be Stop, or Stopping… while pending.
- **AND** Existing compact desktop target exceptions SHALL remain unchanged.

#### Scenario: Worker summary dismissal, Stop authority, parent labeling, or operation feedback changes
- **WHEN** worker summary dismissal, Stop authority, parent labeling, or operation feedback changes
- **THEN** The compact main header SHALL use a small chevron rather than a native triangle, expose its expanded state accessibly, and contain Dismiss finished on the right in the same row, without a footer or duplicate finished count.
- **AND** Dismiss finished SHALL persist view-only hiding through the personal per-conversation dismissal seam without displaying hidden counts or deleting provider history.
- **AND** Short or empty lists SHALL NOT reserve unused height after dismissal.
- **AND** Restore finished SHALL be absent, with no replacement visible control.
- **AND** Settled results and inspection SHALL remain reachable from the timeline.

#### Scenario: Worker action authority remains independent of display wording
- **WHEN** worker metadata and native validation determine which Stop actions can be enabled
- **THEN** Enabled Stop worker SHALL require current ownership, retained exact-occurrence authorization and fresh native validation.
- **AND** Only confirmed live background workers or verified unsettled native shell jobs after process exit SHALL offer this action.
- **AND** Unverified control SHALL disable Stop independently of activity wording.
- **AND** Only verified live workers SHALL cause the parent Stop label to read Stop parent.

#### Scenario: Dock feedback and counts stay consistent across UI modes
- **WHEN** sends, dock mutations, or automatic-background actions settle on desktop or touch
- **THEN** Successful sends, dock mutations and automatic-background outcomes SHALL be silent; failed, unavailable and meaningful unknown guidance SHALL remain persistent.
- **AND** Desktop and touch SHALL use the same worker state groups and visible-row counts.

#### Scenario: Loaded touch chat starts compact
- **WHEN** a touch conversation has two pending steers, one queued message, two working and four confirmed terminal worker occurrences
- **THEN** its pending and worker summaries are collapsed and show their respective counts
- **AND** no second pinned worker list duplicates the same work

#### Scenario: Desktop new work is reachable without disclosure
- **WHEN** visible Working/Unresolved workers or pending entries first appear in desktop UI mode, including on touch-first hardware explicitly using desktop mode
- **THEN** the corresponding canonical card opens without moving focus
- **AND** finished-only worker hydration stays initially collapsed and touch still starts collapsed

#### Scenario: Desktop manual collapse belongs to its current batch
- **WHEN** the user closes a desktop card and more Working/Unresolved workers or pending entries arrive before its batch empties
- **THEN** the card remains closed, including when repaint precedes the native toggle event
- **AND** settlement leaves its current state alone, while the next batch after empty opens again

#### Scenario: Mode changes and refresh do not create disclosure choices
- **WHEN** a user switches UI modes or conversations, returns, or refresh temporarily clears selection while a batch remains active
- **THEN** each conversation and mode retains its own page-local choice without automatic or delayed-toggle choice leakage
- **AND** temporary null selection does not end the current desktop collapse veto

#### Scenario: Work changes without opening details
- **WHEN** a worker appears or settles, or the conversation rehydrates while its touch details are collapsed
- **THEN** summary counts and outcome/uncertainty wording update without opening the details or moving focus

#### Scenario: Expanded details preserve actions and deliberate state
- **WHEN** the user expands details, changes conversations, returns and receives live updates
- **THEN** the original conversation retains its deliberate disclosure state and existing pending/worker actions
- **AND** another conversation does not inherit that deliberate state

#### Scenario: Replacement and batch risks remain readable while collapsed
- **WHEN** Undo/revert has staged a replacement and paused steers would resume together with the replacement or batch Send
- **THEN** pending counts, the applicable batch action and the full replacement/batch consequence remain readable without expanding details, including while typing
- **AND** no hidden warning is treated as user confirmation

#### Scenario: Settled and uncertain workers remain truthful
- **WHEN** the retained worker set includes a failure, a stopped worker and one unresolved outcome
- **THEN** the confirmed terminal occurrences contribute to Finished with their individual outcomes available in details
- **AND** the unresolved occurrence contributes only to Unresolved, not Finished or successful

#### Scenario: Expanded workers retain the pending overview
- **WHEN** six or more workers and pending messages are expanded on touch or desktop, including while the touch keyboard is open
- **THEN** one bordered canonical worker card contains its header and rows, and a separate compact Pending disclosure follows the card before the composer, without duplicate desktop subagent/background summaries
- **AND** Workers and Pending keep separate bounded content scrollports in every disclosure combination, including replacement warnings and the explicit desktop work sheet; neither header nor the outer dock scrolls
- **AND** summary action identity, composing focus, reading anchors, safe areas and existing transcript budgets are preserved
- **AND** insufficient short bands yield transcript space and prioritize the pane selected by its header or content; both headers remain visible and Pending never appears between the worker header and its rows

#### Scenario: Enlarged question options remain readable beneath date history
- **WHEN** question options intersect a sticky date marker on a 390px touch viewport at 200% root text size
- **THEN** the marker does not paint over the interactive question content and keyboard answering remains available without changing scroll-anchor geometry

#### Scenario: Dismissing finished workers preserves timeline history
- **WHEN** the user dismisses finished workers and reloads the conversation
- **THEN** those overview rows remain hidden without a Restore finished button or replacement menu
- **AND** their retained reports and existing transcript inspection remain reachable in the timeline, without provider history deletion

### Requirement: Compact touch composition preserves safe targets and conversation space

Compact touch Chat SHALL retain inline primary actions, one configuration/context pill, safe targets and bounded independent work cards without manual Continue UI. Viewport layout, safe areas, menus, reading anchors and request answering SHALL preserve reachable controls/drafts. Visible controls SHALL activate on the first tap during composition, with or without live updates. No manual Continue supersedes earlier availability/suppression rules without changing delivery/background API semantics.

#### Scenario: Touch Chat presents composer actions and configuration, with or without Hub automatic-steer policy
- **WHEN** touch Chat presents composer actions and configuration, with or without Hub automatic-steer policy
- **THEN** Touch chat SHALL keep inline Attach, one two-line agent/mode/model/effort and actual-context pill, Send with described Space-hold Queue access, and separate Stop.
- **AND** The pill SHALL directly open the existing single adaptive configuration picker and SHALL show actual occupancy plus used/limit where known, explicitly distinguishing unreported/estimated values from cumulative usage.
- **AND** The top Options trigger/panel and duplicate touch context circle SHALL be absent.
- **AND** Unique account usage SHALL remain reachable.
- **AND** Manual Continue and What continues UI SHALL be absent in all chat modes, including standalone, with no replacement menu; the existing background API and authenticated automatic-steer policy SHALL remain unchanged.
- **AND** Standalone SHALL NOT gain automatic Hub policy.
- **AND** Visible composer action targets SHALL be at least 44×44 CSS pixels, with at least 8px separation between adjacent mutation actions, visible focus and non-overlapping hit regions.
- **AND** Unsupported actions SHALL be absent.
- **AND** Fixed keyboard delivery SHALL follow the approved Steer default; touch Enter newline semantics SHALL remain unchanged.

#### Scenario: Touch worker or pending cards expand, collapse, or change while viewport geometry, focus, or text size changes
- **WHEN** touch worker or pending cards expand, collapse, or change while viewport geometry, focus, or text size changes
- **THEN** When both cards are collapsed, the in-flow dock SHALL retain its normal aggregate visual-height caps: 35%, 25% from 48rem width, and 24% during hardware-keyboard editing.
- **AND** Loaded collapsed phone layouts SHALL leave at least 40% of the visual band for the transcript, and tested collapsed tablet layouts at least 35%, wherever measured minimum headers, whole action rows and composer physically permit it.
- **AND** When either card is expanded, the measured expanded-card policy below SHALL replace those caps and reading shares.
- **AND** In insufficient short bands the transcript SHALL yield space while both card headers and composer remain visible; touch SHALL NOT introduce a Show work fallback or hide either header.
- **AND** The worker disclosure SHALL remain below the transcript and above the composer through focus, repaint, keyboard show/hide, viewport resize and pan, rather than implicitly becoming a top sheet or reordering those regions.
- **AND** The sibling cards SHALL have independently scrolling content panes and no shared outer scroller, remaining content-sized for short lists.
- **AND** Opening and closing details SHALL preserve composing drafts and owned focus without forced keyboard blur.
- **AND** Composer Attach/picker/Send/Stop and existing pending replacement/batch safety SHALL remain reachable.
- **AND** Safe-area handling, measured desktop geometry, explicit bottom pinning, remote reading anchors and interaction-request answering SHALL be preserved.
- **AND** Larger text SHALL retain readable warnings and reachable primary controls using scrolling/reduced secondary content rather than shrunken targets.

#### Scenario: Menus fit and dismiss without activating underlying controls
- **WHEN** a reader opens, navigates or dismisses a menu
- **THEN** the menu fits the visual viewport and supports keyboard navigation and one-layer Escape with invoker restoration
- **AND** outside touch dismissal is consumed without activating the underlying action

#### Scenario: Visible controls activate on the first tap throughout composition
- **WHEN** a reader first taps any visible control during composition, whether incoming live updates are arriving or not
- **THEN** the control activates on that first tap without discarding the draft or attachment/configuration state

#### Scenario: Live and reduced-motion presentation preserve focus and truthful announcements
- **WHEN** Chat presents live updates or reduced-motion presentation
- **THEN** it does not steal focus or fabricate completion announcements

#### Scenario: Keyboard and landscape keep conversation space
- **WHEN** loaded touch chat uses 390px width with a 380px or 450px visual band, or 844px landscape width with a 230px visual band and the existing safe-area fixtures
- **THEN** Attach, the real picker, Send and Stop fit inside the visual band with their minimum targets/gaps
- **AND** collapsed cards leave at least 40% wherever measured minimum chrome permits it; expanded cards use the measured small-strip policy, and insufficient short bands retain both headers and reachable pending replacement/batch safety instead

#### Scenario: Two closed cards in the insufficient landscape keyboard band
- **WHEN** a 230px visual band has a 44px app header, 46px composer and two closed cards plus spacing requiring 72px
- **THEN** 68px remains for conversation rather than the infeasible 92px normal floor
- **AND** both card headers and composer actions remain fully visible without a touch Show work fallback

#### Scenario: Hardware keyboard and tablet budgets stay bounded
- **WHEN** loaded 390×844 chat is focused without a software keyboard, or the tested 768×1024 and 1024×768 tablet layouts are used
- **THEN** collapsed cards respect their applicable height cap and expanded cards use the measured small-strip policy, retaining the bottom safe inset
- **AND** the transcript keeps the applicable collapsed share or expanded strip without outer-surface scrolling

#### Scenario: Options dismiss without executing an underlying action
- **WHEN** a touch user taps outside the configuration picker over Revert, Send or Stop
- **THEN** only the picker dismisses and no underlying mutation is sent
- **AND** Escape closes only the top layer and restores its invoker or surviving equivalent

#### Scenario: Disclosure changes preserve the reading intention
- **WHEN** pending/worker details expand, collapse or settle while the reader is remotely scrolled or explicitly bottom-pinned
- **THEN** the current reading anchor or explicit bottom-pin intention is preserved respectively
- **AND** controls remain hit-testable after final layout reservation and reduced-motion handling

### Requirement: Desktop work shares measured panel space

Worker and Pending cards SHALL share measured layout capacity, not a scroller, with matching persistent headers and independent content panes. Collapsed cards SHALL retain normal budgets; expanded cards SHALL use measured remaining space and the specified transcript reserve and emergency floor.

#### Scenario: Worker and pending content is scrolled, grows, or collapses within desktop or touch dock space
- **WHEN** worker and pending content is scrolled, grows, or collapses within desktop or touch dock space
- **THEN** Worker and pending cards SHALL share a measured height budget, not a scrollport.
- **AND** Their headers SHALL match in height, padding, typography, custom chevron, border, radius and color.
- **AND** Each header SHALL remain outside its independently scrolling content pane; scrolling either pane SHALL NOT move the other pane's header or scroll offset, the transcript, or the composer.
- **AND** The outer dock SHALL NOT scroll.
- **AND** Long content SHALL share available space and short or collapsed content SHALL yield unused space.
- **AND** With both cards collapsed, desktop's normal budget remains 40% of actual panel height capped at 25rem, reserving the lesser of 12rem or 35% for the transcript; touch retains its normal phone/tablet reading budget and safe insets.

#### Scenario: Either card expands and measured chrome, warnings, composer, and safe areas constrain remaining panel height
- **WHEN** either card expands and measured chrome, warnings, composer, and safe areas constrain remaining panel height
- **THEN** With either card expanded, the dock SHALL use the remaining measured panel height after all in-flow chrome, warnings, composer and safe-area padding, not a fixed viewport height.
- **AND** The preferred transcript reserve SHALL be 20% of that remaining region, bounded to 32–96 CSS pixels.
- **AND** Whole measured headers/actions MAY reduce that reserve, retaining at least the lesser of 16px or 10% of the remaining region where physically possible.
- **AND** The remaining capacity SHALL be available to the cards without forcing short lists to fill it.
- **AND** Both expanded long lists SHALL partition that capacity; a short or collapsed sibling SHALL yield its unused share.
- **AND** Collapsing both SHALL restore the normal reading budget without blank card height or a forced conversation jump.
- **AND** Expanded desktop cards SHALL NOT require Show work when their measured actions fit beside the small conversation strip.

#### Scenario: Expanded pending entries grow while the keyboard is hidden
- **WHEN** the touch composer remains focused without a software keyboard and expanded pending work grows from one to two to five entries beside busy workers
- **THEN** the expanded measured budget supersedes the collapsed hardware-editing cap, making complete entries/actions visible wherever the remaining capacity permits
- **AND** short or collapsed cards return unused height to the transcript

Physically insufficient space SHALL prioritize a whole actionable row in the explicitly focused/touched pane while retaining both headers and the unobstructed composer. The emergency transcript strip MAY yield to zero to fit those measured minima. If primary chrome, both whole headers and that action still physically exceed the visual band, native vertical outer scrolling SHALL expose the controls without shrinking enlarged type: the touch surface or the explicit desktop overlay region. This physical-minimum exception supersedes the unconditional no-outer-scroll statements above; card bodies SHALL retain independent scrollports and touch SHALL NOT add Show work. The existing explicit desktop Show work fallback MAY cover the chat header but SHALL NOT overlap the composer; its own available region SHALL include Close work and all margins/gaps in its allocation. Disclosure state, keyed controls, focus and independent reading offsets SHALL survive unrelated worker/pending updates. Replacement warnings SHALL reveal once inside the pending pane, never by scrolling the shared dock in fitting geometry.

#### Scenario: Enlarged physical minima exceed the visual band
- **WHEN** 200% text at 390px width has only a 200px visual band and measured chrome, both headers and a whole selected action cannot fit
- **THEN** native vertical surface scrolling exposes both cards and composer actions without reducing text, hiding a header or forcing a touch overlay
- **AND** each card body retains its own scrollport and native header activation selects its actionable body without programmatic focus assistance
- **AND** while this measured exception is active, viewport and foreground resync preserve native surface scrolling and keyboard focus reveal; when it ends, normal zero-offset surface behavior resumes

#### Scenario: Enlarged explicit desktop work owns its budget
- **WHEN** Show work opens with 200% text and twenty workers and pending messages at 1100×700 or 1440×480
- **THEN** its measured region above the composer budgets Close work, both headers and independently scrolling action panes, using outer overlay scrolling only if their physical minima cannot fit

#### Scenario: Independent saturated work cards
- **WHEN** twenty workers and twenty pending messages coexist in any of the four disclosure combinations, including enlarged text
- **THEN** wheel and touch scrolling within either open content pane leave the other pane and transcript offsets unchanged
- **AND** both headers remain fully visible, pending actions can be fully exposed through every clipping ancestor, and Send/Stop remain accessible

#### Scenario: Header taps expose constrained actions without focus assistance
- **WHEN** both panels are expanded in a 230px landscape keyboard band at normal or 200% text and the user activates either header
- **THEN** the selected pane receives enough independent scroll space to fully expose its action targets, without requiring programmatic action focus
- **AND** both headers and composer actions remain visible, worker Stop stays reachable by selecting Workers, and parent Stop/Cancel remains operable

#### Scenario: Pending disclosure scroll remains conversation-local
- **WHEN** a reader scrolls Pending, closes and reopens it, or returns from another conversation
- **THEN** its saved session offset is restored after allocation without replacing keyed controls or changing the sibling or transcript offsets
- **AND** another conversation does not inherit that offset

#### Scenario: Detached worker and pending steer coexist in a short split
- **WHEN** default-split desktop chat has a running turn, one pending steer and one detached worker at 1280×600 or 1280×480
- **THEN** Send and Stop are fully inside the measured panel and center-hit-testable without collapsing tracks
- **AND** the transcript retains its reserved space, the draft/focus survives resizing, and a subsequent Revert reveals its replacement consequence

#### Scenario: Long history cannot compress actionable work into a sliver
- **WHEN** long history, a live worker and pending input coexist in a short desktop panel
- **THEN** non-empty work reserves at least max(52px, 3.25rem) when feasible, yielding transcript space down to its reserved floor first
- **AND** keyboard navigation can expose the full 44px worker action and its visible focus outline within every clipping ancestor
- **AND** if the measured remaining space cannot fit that minimum, an accessible 44px Show work entry opens a scrollable sheet above the composer, with Close work/Escape restoring the entry while retaining drafts and warnings

### Requirement: Accepted Hub steer actions can automatically background eligible work

Confirmed Hub steer actions with authoritative ON preference and current-instance policy trust SHALL permit at most one automatic native background-all follow-up for verified eligible blockers. Primary admission SHALL precede follow-up, and other sends, standalone contexts, and unsupported agents SHALL not acquire implicit backgrounding. Its UI SHALL NOT promise immediate delivery, atomic admit-and-background or preservation of every foreground worker across native resume.

#### Scenario: An initiating Hub account with authoritative ON preference confirms an eligible steer action or paused-batch resume
- **WHEN** an initiating Hub account with authoritative ON preference confirms an eligible steer action or paused-batch resume
- **THEN** For an initiating Hub account whose authoritative personal preference is ON, chat SHALL consider one automatic native background-all follow-up after a confirmed steer action on an agent supporting both steering and background-blocking-work.
- **AND** This includes new composer steers, Queue → Steer, Send now of held input or paused steers, and submitted Undo/revert replacement steers.
- **AND** A paused batch resume SHALL result in at most one follow-up per accepted user action, not per resumed message.
- **AND** The initiating user's policy SHALL apply even in a workspace shared with users having different preferences, without changing those users' settings.

#### Scenario: A steer is otherwise accepted but the workspace child lacks verified current-instance Hub policy authority
- **WHEN** a steer is otherwise accepted but the workspace child lacks verified current-instance Hub policy authority
- **THEN** Automatic follow-up SHALL additionally require verified Hub policy authority bound to the current child instance, independent of the workspace/terminal credential.
- **AND** Missing bootstrap trust SHALL produce explanatory automatic-background-unavailable state rather than infer ON or trust unsigned principal metadata.
- **AND** This SHALL NOT undo an otherwise accepted steer or weaken existing primary-action access checks; a valid workspace credential alone SHALL NOT grant Hub principal authority.

#### Scenario: Primary admission or resume is confirmed and current parent blocker evidence is evaluated for follow-up
- **WHEN** primary admission or resume is confirmed and current parent blocker evidence is evaluated for follow-up
- **THEN** The primary admission/resume SHALL be confirmed first; an optimistic message, timeout or staged replacement SHALL NOT count as acceptance.
- **AND** The automatic follow-up SHALL use current verified parent-scoped running-blocker evidence.
- **AND** Merely generating, pending, already detached, settled or uncertain work SHALL NOT force a background request; absent evidence SHALL NOT schedule a later job-start follow-up.
- **AND** Native eligibility racing to empty SHALL be an accepted no-op, not failure.
- **AND** The native operation affects all jobs still eligible when executed, including shell commands; it SHALL NOT be described as targeting one selected child or a fixed snapshot of workers.

#### Scenario: Sending, menu selection, replacement staging, job events, or unsupported contexts do not meet the Hub accepted-steer exception
- **WHEN** sending, menu selection, replacement staging, job events, or unsupported contexts do not meet the Hub accepted-steer exception
- **THEN** no automatic native background follow-up is triggered outside confirmed Hub steer actions with ON policy and both capabilities
- **AND** Ordinary queued/idle sends, job starts, preference/menu selection, Undo/revert staging alone, repeated no-op conversion, standalone and unsupported agents SHALL retain existing behavior.

#### Scenario: Automatic follow-ups preserve input and native delivery semantics
- **WHEN** an accepted Hub steer action qualifies for automatic backgrounding with authoritative ON policy, verified current-instance trust and both required agent capabilities
- **THEN** the automatic follow-up creates no steer or new agent, does not flush the Uatu queue, and leaves staged configuration and delivery preferences unchanged
- **AND** native steer next-step delivery, paused-batch behavior and resume/interruption semantics remain authoritative
- **AND** the UI promises neither immediate delivery nor atomic admission-and-backgrounding nor preservation of every foreground worker across native resume

#### Scenario: Each accepted steer action qualifies once
- **WHEN** an ON Hub account confirms a new composer steer, Queue → Steer, held-message Send now or submitted replacement steer while verified eligible blocking evidence remains
- **THEN** its primary admission and pending transition complete before at most one native background-all attempt for the same parent
- **AND** the accepted message and attachments remain intact independently of the follow-up outcome

#### Scenario: Send now resumes a paused batch
- **WHEN** an ON Hub account successfully sends one paused steer now and native resume wakes all paused steers
- **THEN** the existing batch behavior is preserved without admitting duplicate prompts
- **AND** the action makes at most one post-resume eligible background attempt, with no promise that resume preserved still-blocking foreground work

#### Scenario: Admission has not been confirmed
- **WHEN** a steer is refused, pending admission exceeds its bound, or a resume outcome is ambiguous
- **THEN** no automatic background mutation follows that action
- **AND** uncertainty is reconciled without automatically resending or later backgrounding on a job event

#### Scenario: Private policy trust is unavailable after child replacement
- **WHEN** an ON account's steer is otherwise accepted but the replacement child has not established verified current-instance Hub policy trust
- **THEN** no automatic follow-up is authorized using a workspace credential, old-instance signature or unsigned principal metadata
- **AND** the accepted steer is preserved with explanatory unavailable feedback and the existing background API remains available where permitted

#### Scenario: Nothing qualifies after acceptance
- **WHEN** an accepted steer leaves no verified running-blocker evidence, or workers are only detached/settled/uncertain
- **THEN** no automatic background call is forced and no future job-start watcher is installed

#### Scenario: Mixed eligible jobs race with native execution
- **WHEN** an accepted steer is followed by one background request while eligible subagents and shell jobs block that parent
- **THEN** native all-eligible behavior is used rather than a subagent-only operation
- **AND** a race to no eligible jobs is harmless while a new blocker present at native execution is not promised exclusion

#### Scenario: OFF, unsupported and non-steer actions do not trigger automation
- **WHEN** the preference is OFF, no Hub account context exists, either capability is absent, or the action is a queue/idle send, menu choice, job start, replacement staging or no-op conversion
- **THEN** no automatic background request occurs and existing delivery/background API behavior is preserved without a manual Continue UI

### Requirement: Automatic background outcomes never erase or resend accepted steer actions

Automatic-background outcomes SHALL remain separate from accepted primary steer/resume outcomes without restoring, resending, or rolling back accepted input. Account-scoped bounded receipts SHALL retain uncertainty and prevent replay while retained; recovery and persistent guidance SHALL remain read-only and page-local.

#### Scenario: A primary steer or resume is accepted and automatic backgrounding succeeds, fails, times out, or remains ambiguous
- **WHEN** a primary steer or resume is accepted and automatic backgrounding succeeds, fails, times out, or remains ambiguous
- **THEN** Affected action responses SHALL distinguish the primary steer/resume outcome from any automatic-background outcome.
- **AND** Once primary acceptance is confirmed, a follow-up refusal, unavailable evidence, timeout or ambiguous response SHALL preserve and report the accepted primary action through the unchanged API; it SHALL NOT restore it as a failed draft, roll it back to the queue, or resend it.
- **AND** Background acknowledgement SHALL mean only request acceptance, not a count of affected workers, immediate steer delivery or worker completion.
- **AND** Successful outcomes SHALL produce no UI confirmation notice.
- **AND** Actionable partial/unknown outcome text SHALL remain visible outside collapsed details with read-only state recovery, without manual Continue/help UI or automatic mutation retry.

#### Scenario: A composite action is retried while its account-scoped receipt is retained or its receipt lifetime ends
- **WHEN** a composite action is retried while its account-scoped receipt is retained or its receipt lifetime ends
- **THEN** The composite operation SHALL share original admission ordering and retain primary plus follow-up results under an initiating-account-scoped receipt.
- **AND** While retained, a same-identifier retry SHALL return the same result without repeating primary admission/resume or backgrounding, reevaluating a changed preference or affecting later blockers.
- **AND** A primary-unknown or follow-up-unknown outcome SHALL be retained rather than treated as a retryable deleted failure; no follow-up SHALL start after a timed-out primary or from late evidence.
- **AND** The client SHALL NOT automatically replay uncertain mutations across reconnect/reload.
- **AND** Receipt expiry, capacity eviction, adapter recreation or restart end deduplication; the system SHALL NOT promise durable exactly-once execution across those boundaries.

#### Scenario: Native steer admission or resume becomes unconfirmed without usable automatic-policy context or after browser transport failure or server 5xx
- **WHEN** native steer admission or resume becomes unconfirmed without usable automatic-policy context or after browser transport failure or server 5xx
- **THEN** Native steer/resume unknown retention SHALL remain active without automatic-policy context, including degraded Hub and standalone operations.
- **AND** Queue → Steer and held/paused Send now browser transport failures or server 5xx SHALL produce persistent page-local unconfirmed guidance and read-only reconciliation, without changing an unrelated composing draft or retrying the mutation.
- **AND** Definite refusals SHALL retain their existing handling.

#### Scenario: Background fails after steer acceptance
- **WHEN** the provider confirms the steer but definitively refuses its background follow-up
- **THEN** the action reports the accepted steer and failed/unavailable follow-up separately with explanatory text
- **AND** the accepted message is neither restored to the draft nor requeued/resubmitted

#### Scenario: Uncertain action feedback identifies its source and actual status read
- **WHEN** a primary or automatic-background outcome is unknown
- **THEN** the warning names the originating action and bounded safe plain-text excerpt or short attachment-only identifier
- **AND** checking language follows the real read-only snapshot request and changes to checked-but-unconfirmed or check-unavailable when it settles, never implying that the read confirmed the mutation
- **AND** unrelated success does not dismiss the warning; notices remain bounded and page-local, without persisted receipts, automatic resend or duplicate controls

#### Scenario: Upstream background response is lost after application
- **WHEN** native backgrounding may have applied but Uatu cannot confirm its response
- **THEN** the accepted primary result retains an unknown follow-up receipt and neutral uncertainty feedback
- **AND** retrying the same identifier while retained issues neither a second steer/resume nor another background request

#### Scenario: Browser loses a known composite result
- **WHEN** Uatu retained the accepted composite result but the browser lost its response, another blocker appeared and the account changed its preference
- **THEN** the same-account same-identifier retry returns the original result/policy without repeating either native mutation

#### Scenario: Primary admission response is unknown
- **WHEN** the provider may have accepted a steer/resume but its acknowledgement is lost
- **THEN** the primary-unknown receipt is retained, no background request is made and the action's message/attachments remain available as unconfirmed rather than automatically resubmittable failed input
- **AND** same-identifier retries while retained do not duplicate the primary action

#### Scenario: Late response and ended receipt lifetime
- **WHEN** a timed-out native operation later settles, or its receipt expires, is evicted or is lost on adapter/process recreation
- **THEN** read-side evidence can update visible state without initiating a delayed follow-up or automatic mutation replay
- **AND** old request identifiers are not claimed to remain deduplicated after receipt loss

#### Scenario: Shared-workspace users reuse an identifier
- **WHEN** A and B issue actions in the same conversation using the same client request identifier but opposite personal preferences
- **THEN** neither receives the other's personal action receipt or policy metadata
- **AND** each action uses its own authenticated initiating-account scope while conversation/worker state remains shared

#### Scenario: Unrelated mutations preserve unresolved operation feedback

- **WHEN** Remove, a delivery change or a later successful steer follows an unknown, failed or unavailable automatic-background outcome
- **THEN** the unresolved feedback remains tied to its source operation and is not cleared by the unrelated result or ordinary status settlement
- **AND** constrained touch layouts retain visible, scrollable feedback without consuming the usable draft field or hiding the inline picker

#### Scenario: Settings browser cannot read saved policy

- **WHEN** the Settings browser fails to read personal preferences
- **THEN** it reports that it cannot confirm the saved setting, without promising automation is disabled
- **AND** saved server policy continues to govern independently admitted steers in other tabs or devices

#### Scenario: Unknown retention survives unavailable bootstrap
- **WHEN** native steer admission or resume applies but its acknowledgement is lost while private Hub policy trust is unavailable
- **THEN** an immediate same-account same-identifier retry retains unknown with only one native primary mutation
- **AND** no automatic background request or unsigned policy context is introduced

#### Scenario: Queue action loses its browser acknowledgement
- **WHEN** a Queue → Steer, held Send now or paused-batch Send now result is lost to browser transport failure or a server 5xx
- **THEN** unconfirmed guidance remains visible through read-only reconciliation and later paints
- **AND** the unrelated composing draft stays unchanged and reconnect/reload sends no automatic mutation retry

### Requirement: Unknown steer admission has an explicit local-only escape
A settled unknown steer admission SHALL offer confirmed local-only discard through a fresh server-owned `admissionUncertaintyId`. Discard SHALL preserve original unknown receipts and native evidence, leave other messages queued, and never cancel, resend or claim non-delivery of the original. Generic uncertainty, resume/withdrawal uncertainty and still-pending requests SHALL NOT authorize discard.

#### Scenario: Eligibility identifies admission uncertainty rather than its delivery label
- **WHEN** a pending steer or a held Queue entry's attempted steer admission settles unknown
- **THEN** its eligible local record exposes a fresh opaque admission token
- **AND** generic `unconfirmed`, confirmed admission and resume/withdrawal uncertainty do not grant this action or withdrawal retry

#### Scenario: An indefinitely pending transport stays protected
- **WHEN** Uatu times out but the upstream admission request remains pending indefinitely
- **THEN** no discard token is exposed until that request actually settles unknown
- **AND** neither local-ownership retirement, cancellation nor replay occurs automatically

#### Scenario: A held unconfirmed admission truthfully pauses blocked followers
- **WHEN** a held entry's unconfirmed steer admission blocks automatic delivery of later held entries
- **THEN** snapshots and live queue updates mark the blocked suffix paused and use truthful delivery wording
- **AND** confirmation evidence can clear that presentation without sending or cancelling input
- **AND** pending-map uncertainty alone does not pause otherwise deliverable held entries

#### Scenario: Confirmation explains local-only removal
- **WHEN** the user chooses Discard local record
- **THEN** confirmation explains that delivery is unconfirmed, the original may still arrive, local removal neither cancels nor resends it, and other messages wait for Send now, a newly accepted message submission, or a later normal idle transition
- **AND** Cancel initially receives focus and conflicting per-entry actions are prevented

#### Scenario: Target validation and retained receipts identify the exact action
- **WHEN** the server receives a local-discard request
- **THEN** it validates the exact token, local entry and submission/native-admission identity atomically with other queue admissions
- **AND** retained receipts distinguish caller scope, conversation, message, token and request identifier without acknowledging another target

#### Scenario: Nothing landed but the admission outcome remains unknown
- **WHEN** a steer admission settles unknown, inbox/history remain empty, and another message is held behind it
- **THEN** a token-eligible local discard can remove the uncertain local copy without restarting the workspace
- **AND** no native send or cancellation occurs, the original receipt remains unknown, and the other message stays queued
- **AND** no provider lookup, resume or background action occurs and removal is not reported as acceptance or non-delivery

#### Scenario: Confirmation is cancelled or its target changes
- **WHEN** the user cancels confirmation or the entry/token changes before confirmation completes
- **THEN** no discard mutation is sent for the cancelled or changed target
- **AND** the unrelated composing draft and other pending messages remain intact

#### Scenario: Stale tokens and ineligible uncertainty are refused
- **WHEN** a discard names an old token, another target, a confirmed/in-flight admission, or resume/withdrawal uncertainty
- **THEN** the server refuses it without removing another record or invoking the provider

#### Scenario: Discard does not release a previously scheduled drain
- **WHEN** an idle drain was scheduled before local discard and runs afterward
- **THEN** remaining held messages stay queued
- **AND** explicit Send now, a newly accepted user submission, or a later normal idle transition can deliver eligible remaining messages without replaying the discarded original
- **AND** derived recovery completion or failed-action status rollback does not count as that transition

#### Scenario: Fresh Queue admission resumes held input after Stop and discard
- **WHEN** Stop and local discard leave an idle conversation's remaining queue paused, and a new Queue submission passes validation and is accepted
- **THEN** it joins the held queue and authorizes FIFO delivery from the existing head without replaying the discarded original
- **AND** rejected submissions, cached retries and discard alone do not authorize this handoff

#### Scenario: Late native evidence remains truthful
- **WHEN** old reads or acknowledgements finish after discard, or the original later appears in native inbox/history
- **THEN** the discarded held copy is not recreated and the original is not resent
- **AND** genuine native evidence can be shown without claiming that local discard cancelled delivery
- **AND** late evidence does not schedule delayed backgrounding

### Requirement: Read-only uncertain-work recovery is bounded and progressive
Read-only recovery SHALL distinguish failed reads from successful inconclusive evidence, bound unchanged successful probes to three per external cycle, and apply safe independent results under ongoing updates. New evidence, explicit refresh or reconnect SHALL permit recovery again. Budget exhaustion SHALL preserve uncertainty, not imply completion, cancellation, non-delivery or terminal failure. Recovery SHALL NOT replay mutations.

#### Scenario: Successful inconclusive reads stop polling without inventing an outcome
- **WHEN** three successful recovery reads in one external cycle leave the same uncertainty unresolved
- **THEN** no further unchanged self-scheduled successful probe occurs and bounded exhaustion metadata remains parked outside the runnable drain
- **AND** uncertainty remains visible rather than being reported as completion or non-application

#### Scenario: Unrelated activity cannot repeatedly replenish exhausted cycles
- **WHEN** unrelated tool, content or interaction events continue after an inconclusive cycle is exhausted
- **THEN** an externally triggered restart occurs no sooner than 30 seconds after exhaustion, without a recurring poll in a quiet session
- **AND** genuinely new source worker evidence that changes retained knowledge, explicit refresh or reconnect can restart recovery immediately
- **AND** unchanged rediscovery, recovery's own updates and bookkeeping do not replenish the budget
- **AND** parked metadata has a count bound and deletion, eviction, disposal and generation cleanup

#### Scenario: Failed reads retain backoff and later evidence rearms recovery
- **WHEN** a recovery read fails, or new evidence/refresh/reconnect follows an exhausted inconclusive cycle
- **THEN** failures retain their backoff and an eligible new external cycle can recover state
- **AND** reconnect does not inherit a timer from the previous stream generation

#### Scenario: Only genuine discovery progress extends the probe budget
- **WHEN** recovery discovers verified new execution progress, or merely alternates omission and rediscovery of an unchanged known worker
- **THEN** only genuine progress can extend the current cycle, not retries, housekeeping or unchanged rediscovery
- **AND** saturated native-provider discovery remains recoverable without requiring reconnect

#### Scenario: Dirty bursts do not starve independent recovery results
- **WHEN** source events continue while recovery verifies an independent worker
- **THEN** coalesced follow-ups remain throttled and the safe verified result is applied
- **AND** newer rows, deleted parents, reverted boundaries and replacement generations are not overwritten or resurrected
- **AND** dirty updates coalesce with a fixed 100ms throttle rather than a starvation-prone trailing-only debounce

### Requirement: Worker Stop availability requires retained occurrence proof
Worker Stop SHALL target a retained, verified native occurrence. Display-record cleanup and reconnect SHALL NOT erase known revocations. Missing, revoked or overflowed control proof SHALL withhold Stop and expose control uncertainty independently of activity verification; fresh history alone SHALL NOT restore control trust. Healthy targets whose proof remains retained SHALL remain controllable without reconnect after projection saturation. A Working label SHALL NOT itself authorize Stop.

#### Scenario: New post-gap occurrences do not inherit global permanent refusal
- **WHEN** a new live subscription positively observes native birth and matching invocation evidence for a genuinely new worker after an observation gap
- **THEN** fresh ownership/current-state validation can admit that occurrence within the existing control budget without clearing pre-gap revocations
- **AND** an observed ephemeral shell creation can anchor shell birth under the native live-only, non-replaying stream contract; a later content snapshot, unseen identifier or timestamp alone cannot
- **AND** old identities, unresolved gaps and actual capacity closure remain protected, and in-flight authorizations are invalidated

#### Scenario: Shell birth contradictions fence both retained and first-seen targets
- **WHEN** a native shell birth contradicts a retained occurrence or a first-seen launcher claiming the same shell identifier
- **THEN** the old or mismatched target remains control-unverified and Stop sends no native removal, even if fresh shell inventory confirms ownership
- **AND** an exact retained consumed birth replay is distinguished from a new or conflicting native proof
- **AND** compatible tool creation and shell start clocks need not be equal; identity arrival or timestamps alone do not resolve a command contradiction

#### Scenario: User-shell notes do not consume worker-control admission
- **WHEN** typed user-command shell transcript events identify shell completion notes that are not background-worker reports
- **THEN** command rendering is preserved without retaining each note in worker control observations or unpublished worker-report storage
- **AND** unresolved prelaunch presentation payload has count/byte bounds while genuine worker notification-before-launch correlation and control contradictions remain safe

#### Scenario: Retained controls remain usable after projection saturation
- **WHEN** display/correlation records saturate but a worker's compatible control evidence remains retained and fresh validation succeeds
- **THEN** that worker remains controllable after read-only recovery without reconnecting or clearing the projection recovery-only latch
- **AND** Stop targets only that verified occurrence, never another run using the same child

#### Scenario: Unverifiable control is shown consistently
- **WHEN** control evidence is missing, revoked or overflowed
- **THEN** live updates, history and reconciliation consistently withhold Stop and explain the unavailable control in task details
- **AND** recovery return paths recheck current control proof after visibility awaits, including historically ended but unsettled shell jobs; an older enabled-control snapshot cannot outlive known revocation
- **AND** separately verified current task activity can show Working without restoring missing Stop proof
- **AND** workers continue running and message delivery remains available

#### Scenario: Verified shell job remains removable after process exit
- **WHEN** a native shell process has exited but its job remains unsettled and current ownership and retained exact-occurrence authorization remain valid
- **THEN** the row keeps Ended · result unavailable under Unresolved without live animation or a growing execution timer
- **AND** the existing Stop/removal flow remains available subject to fresh native validation of that exact job
- **AND** task details and explicit confirmation explain that removal can delete its job record/output and prevent final result capture
- **AND** a settled job or missing, revoked, gap-invalidated or overflowed proof withholds the action without retargeting another occurrence

#### Scenario: Normal owned launches retain Stop through compatible readback
- **WHEN** retained live native birth and invocation evidence authorize the exact owned worker occurrence and current native validation confirms that target
- **THEN** compatible stored readback supplying missing launcher fields preserves normal Stop availability
- **AND** history alone does not create missing authority, overwrite contradictory facts, clear revocation or retarget a reused occurrence

#### Scenario: Metadata repaint preserves only the surviving owned inspection action
- **WHEN** task-inspection metadata repaints while its result or Stop action has focus and the same occurrence/action target survives
- **THEN** the equivalent enabled visible action retains focus without deferred retries or a new fallback selection
- **AND** changed occurrence, execution, launch reference, child conversation or output targets do not inherit that focus
- **AND** composer, other-worker and modal focus are not taken over, while unchanged legacy targets retain their existing behavior

#### Scenario: Current shell inventory contradicts the retained command before replacement birth arrives
- **WHEN** fresh authoritative inventory returns the retained shell ID and parent but a different known command before the replacement's live birth event is observed
- **THEN** Stop for the old occurrence is revoked and any in-flight validation refuses the mutation without removing the replacement job or output
- **AND** a retained end for the old execution does not override that contradiction or authorize removal of the replacement
- **AND** missing or failed inventory is not treated as positive command contradiction, while unrelated healthy workers remain controllable

#### Scenario: Same-command replacement contradicts retained native shell-birth identity
- **WHEN** a fresh native read returns the same shell ID, parent and command but positively contradicts retained immutable native birth fields such as its native start or output identity before a replacement birth event arrives
- **THEN** old Stop authority and in-flight validation are refused without removing the replacement job or output, including when the old execution has already ended
- **AND** native birth fields are compared within their own native domain rather than equated with launcher or envelope clocks
- **AND** a current or historical lookup alone cannot manufacture missing retained birth proof, while missing/incomplete reads do not invent permanent contradictions

#### Scenario: Control proof has a bounded share of the live evidence budget
- **WHEN** the provider retains control evidence alongside live display/correlation records
- **THEN** control evidence uses at most 1 MiB and 2,048 entries within the existing aggregate 4 MiB and 8,192 live-entry budget
- **AND** complete retained payload, aliases, witnesses, observations, indexes and stubs are accounted as serialized logical payload, not a claim about JavaScript heap size

#### Scenario: Overflow does not silently readmit an old identity
- **WHEN** a target's control evidence cannot be retained or grows beyond its budget
- **THEN** its Stop remains unavailable or its control record compacts to a reserved unavailable/revoked stub without disabling healthy retained targets
- **AND** age, eviction, progress, alias folding or lagging history cannot erase the contradiction and readmit that identity
- **AND** unretained targets may remain uncontrollable for the provider lifetime; no automatic restart, cancellation or data deletion occurs

#### Scenario: Revocation survives recovery and stream replacement
- **WHEN** a known occurrence is superseded or revoked before Stop or during its validation, followed by progress, history recovery or reconnect
- **THEN** the old target is refused without redirecting to a newer execution
- **AND** stream replacement invalidates in-flight authorization but does not erase retained revocation; disposal ends the in-memory provider ownership lifetime

#### Scenario: Concurrent agent Stops observe contradictory ownership
- **WHEN** one fresh validation positively observes foreign ownership of the retained agent while another Stop still awaits its final ownership response
- **THEN** the contradiction revokes the retained occurrence and aliases so the second Stop cannot dispatch an interrupt from an older owned response
- **AND** missing or incomplete ownership responses withhold that action without manufacturing a permanent foreign-owner contradiction
- **AND** occurrence-aware reverted visibility, stream ownership and output reads apply the same positive-contradiction revocation, so their observations cannot leave another Stop authorized by an older response
- **AND** a positively foreign child or retained parent workspace remains a private ownership contradiction rather than being reduced to missing data; ordinary readers still receive no foreign record, and absent workspace facts remain inconclusive

#### Scenario: Proven replay differs from ambiguous old-looking evidence
- **WHEN** a previously consumed invocation is identified by matching native identity, stamp, semantic fingerprint and its established occurrence link
- **THEN** that proven replay does not invalidate an otherwise verified target
- **AND** a first-seen ambiguous report or new/contradictory invocation is not treated as historical merely because its timestamp looks old

### Requirement: Fresh worker activity survives normal first-launch ordering
Uatu SHALL associate a uniquely owned new child and its first native execution with the accepted launcher when positive evidence establishes that relationship, including child creation during launch and first execution after launcher completion. It SHALL NOT reject such activity solely for these orderings. Ambiguous or contradictory associations SHALL remain unresolved without weakening Stop safeguards.

#### Scenario: Child is born during the accepted launch
- **WHEN** one accepted launcher creates its new, correctly parented child during execution and current native evidence verifies that task is active
- **THEN** the task shows Working through live updates and fresh reconciliation
- **AND** a launcher creation time before child birth is not itself a revocation

#### Scenario: Initial execution starts after launch returns
- **WHEN** the unique newborn child's first execution starts after its accepted launcher completes, with no competing invocation or intervening execution
- **THEN** positive first-execution association and current activity produce Working rather than permanently unverified status
- **AND** a duplicate start or launcher restatement creates no extra worker

#### Scenario: Reuse or ownership contradicts first-launch attribution
- **WHEN** another invocation, execution boundary, foreign parent or workspace makes the association ambiguous or contradictory
- **THEN** Uatu does not assign current activity or terminal results to the old task based only on a shared child ID
- **AND** a stop of that old target never redirects to the newer execution
- **AND** retained prelaunch birth or verified-ownership evidence already constitutes a known association: an ordinary positive contradiction before launcher success fences delayed admission rather than being forgotten until a row exists
- **AND** identified session inventory records apply the same observation before workspace filtering, while true parent identity/workspace contradictions fence directly verified prelaunch children even without birth/task rows

#### Scenario: Parent-only contradiction preserves a healthy nested worker cohort
- **WHEN** an ordinary or occurrence-aware lookup changes C's parent from A to B within the same workspace while C independently owns a verified worker D
- **THEN** A's old C association loses its activity/reference and Stop authority without invalidating D's unchanged Working, launch continuity or retained controls
- **AND** actual identity/workspace contradictions retain their appropriate subtree protection, while missing relationship facts remain inconclusive

### Requirement: Worker activity confidence is independent of control authorization
Worker presentation SHALL distinguish verified task activity from active-session-only evidence and unavailable task status. Current evidence of a task's activity SHALL allow Working independently of Stop authorization. Historical running metadata or an active reused session alone SHALL NOT prove task activity. Unavailable Stop reasons SHALL be readable in task details with keyboard and touch, not only a hover tooltip.

#### Scenario: Active task has no retained control proof
- **WHEN** current native evidence independently verifies the owned task's activity but retained Stop proof is unavailable
- **THEN** the row shows Working and contributes once to Working
- **AND** Stop remains disabled with its reason accessible in task details on desktop and mobile

#### Scenario: Partial live references do not override current native shell activity
- **WHEN** a fresh native read verifies that the current shell launch belongs to the conversation and is running, without conflicting ownership, command or execution evidence
- **THEN** a partial live reference alone does not downgrade that task from Working to Unresolved
- **AND** activity and session/output inspection do not require complete Stop authorization
- **AND** real reuse, contradictory evidence and observation gaps remain protected without enabling Stop

#### Scenario: Later recovery observations invalidate an earlier Working snapshot
- **WHEN** reverted-worker visibility or a concurrent authoritative read observes a positive occurrence contradiction after the initial recovery snapshot, including while final visibility validation is pending
- **THEN** the returned old occurrence no longer carries Working or its obsolete launch reference and cannot keep a growing execution clock
- **AND** mere absence of private Stop-grade proof does not downgrade otherwise independently verified activity

#### Scenario: Sparse success enriches a fresh owned agent observation
- **WHEN** a fresh owned child execution is positively associated with its launcher and a live tool-success record omits timing anchors later supplied compatibly by stored history
- **THEN** current native activity remains Working instead of becoming session-active/task-unverified solely because those anchors were initially absent
- **AND** conflicting immutable anchors or a different child execution remain unverified for that task

#### Scenario: Unresolved workers do not fabricate workspace completion
- **WHEN** a previously verified background worker becomes unavailable, session-active without task attribution, checking, or ended without a result after its parent settles
- **THEN** it contributes to Unresolved rather than verified workspace Working
- **AND** child-to-Hub activity preserves a bounded content-free unresolved fact so loss of verification does not create a workspace-finished badge or successful completion notification
- **AND** canonical pending requests retain their attention priority

#### Scenario: Genuine settlement follows an unresolved interval
- **WHEN** a workspace observed Working later becomes unresolved without awaiting attention and eventually settles with no verified work, pending request or unresolved worker
- **THEN** the Hub can record its genuine finish without requiring an intervening return to Working
- **AND** observing only unresolved or quiet state after startup does not invent a prior observed-work epoch
- **AND** the existing Awaiting policy remains unchanged: attention cancels prior completion eligibility, and merely clearing a request does not create a finish without later positive Working
- **AND** the public workspace-summary shape remains unchanged

#### Scenario: Reused session is active but task attribution is ambiguous
- **WHEN** a child session is currently active but evidence cannot establish which old task owns that execution
- **THEN** affected unverified rows show Session active · task unverified and count only under Unresolved
- **AND** no old row gains a running animation, growing execution timer, successful outcome or enabled Stop from that fact

### Requirement: Worker status checks are bounded and recover automatically
Worker recovery SHALL be read-only and automatic, preserving existing probe budgets and backoff. Checking status… SHALL count under Unresolved and end within a finite deadline even when reads fail or hang. An unobservable task SHALL show Status unavailable with a truthful last-seen time when known, no live execution animation and no growing execution timer. No worker Check again control SHALL be introduced.

#### Scenario: Verification fails or exhausts its cycle
- **WHEN** current verification fails, exceeds its deadline or finishes inconclusively within the bounded recovery cycle
- **THEN** Checking status… ends and the row shows Status unavailable · last seen followed by the last verified observation time, or explicitly states that last-seen time is unavailable
- **AND** neither elapsed waiting time nor a stale launch timestamp is presented as ongoing execution

#### Scenario: Authoritative evidence later returns
- **WHEN** new worker evidence or normal reconnect/navigation recovery verifies current activity after status became unavailable
- **THEN** the row and count recover automatically without a manual status action, restart or native mutation
- **AND** unrelated events do not create unbounded probing or permanent Checking status…

### Requirement: Worker rows link blocking requests without duplicating interaction flows
A blocking permission or question positively associated with the current worker execution SHALL label its row Needs your answer and count under Working. The existing main-session request SHALL retain its identity, attention notification and answering flow. Linking SHALL NOT create another request or reply path. Session-only attribution to a reused child SHALL NOT attach a request to an old task.

#### Scenario: Worker is waiting for a permission or question
- **WHEN** an existing pending request is positively linked to the current owned task
- **THEN** its worker row shows Needs your answer and reveals the same canonical request for answering
- **AND** the main session still shows that request with the same identifier and existing notification behavior
- **AND** answering from the canonical flow sends one provider reply and updates both presentations

#### Scenario: Request cannot be attributed to an occurrence
- **WHEN** a pending child request belongs to a reused session but cannot be tied to the displayed old task
- **THEN** the main-session request and existing attention flow remain available
- **AND** the old worker row does not acquire Needs your answer or Working from session identity alone

### Requirement: Ended executions without results remain unresolved
When occurrence-specific evidence proves execution ended but no correlated terminal outcome is available, Uatu SHALL show Ended · result unavailable under Unresolved without live animation or a growing execution timer. It SHALL infer neither success, failure nor cancellation. Parent idleness, active-list absence, a failed read and aggregate child-session outcomes SHALL NOT alone establish that task's end or result.

#### Scenario: Execution end is known and report is missing
- **WHEN** an authoritative execution boundary is positively linked to the task and no correlated outcome is available
- **THEN** the row shows Ended · result unavailable, remains inspectable and offers presentation-only dismissal
- **AND** recovery return paths incorporate a compatible retained native end observed during visibility validation, using its known end clock rather than returning an older Working snapshot
- **AND** it does not contribute to Finished or emit a successful-completion notification

#### Scenario: Correlated result arrives later
- **WHEN** a genuine terminal result becomes attributable to the ended execution
- **THEN** the retained task acquires its actual outcome without duplicating its canonical report or settling another occurrence

### Requirement: Worker dismissal changes only summary visibility
Users SHALL be able to dismiss unavailable and ended-without-result rows individually, as well as finished history, without stopping work, deleting provider history or marking an unresolved task finished. Summaries SHALL count only visible rows. Verified task activity and positively linked blocking requests SHALL be visible despite prior dismissal. New executions SHALL NOT inherit old dismissals. There SHALL be no Restore interface.

#### Scenario: Unavailable entry is dismissed
- **WHEN** the user dismisses an unavailable or ended-without-result task
- **THEN** only its summary row/count disappear and retained timeline/inspection data remains available
- **AND** no provider prompt, stop, deletion, request reply or terminal-state transition occurs

#### Scenario: Dismissed work is active again
- **WHEN** current task activity or its positively linked pending request is verified after dismissal
- **THEN** the row automatically resurfaces on every connected client for that account
- **AND** an older dismissal cannot hide this evidence or a different execution of the same child

#### Scenario: All summary entries are dismissed
- **WHEN** no visible worker rows remain
- **THEN** the worker card disappears without a dismissed count or Restore action
- **AND** pending interaction cards and operation-uncertainty guidance remain governed by their own visibility rules
### Requirement: Receipt token figures read at their scale
A receipt's token figures SHALL render with compact scale formatting whose
suffix matches the count's magnitude — billion-scale sums included, with a
`B` suffix — and each compact figure SHALL keep the exact count reachable
through the cell's title.

#### Scenario: A billion-scale line item reads in billions
- **WHEN** a receipt line's token sum reaches one billion
- **THEN** the cell reads with the `B` suffix rather than thousands of millions
- **AND** the exact figure remains in the cell's title

### Requirement: Touch conversation actions share the picker row

Touch conversation titles SHALL truncate within the picker row without displacing Rename or New conversation or reducing their touch targets. Native selection, focus, desktop behavior, and transcript-edge paint/hit containment SHALL remain intact.

#### Scenario: Long or enlarged touch conversation titles and short transcript navigation coexist with picker-row actions
- **WHEN** touch picker-row actions are displayed, including long or enlarged titles or a transcript strip shorter than its floating navigation
- **THEN** Touch selected conversation titles SHALL truncate inside the paint-contained picker wrapper and SHALL NOT push Rename or New conversation onto another row.
- **AND** Both actions SHALL retain at least 44×44px touch targets and their existing accessible names.
- **AND** New conversation MAY use an SVG-only presentation.
- **AND** Native select option strings, browser-owned popup and keyboard selection, the external wrapper focus ring and desktop text-button behavior SHALL remain intact.
- **AND** No Options panel SHALL be added.
- **AND** Transcript-edge floating navigation SHALL NOT paint or receive hits over the header or sibling work controls when the reading strip becomes shorter than the floater.

#### Scenario: Long selected titles preserve same-row actions
- **WHEN** a 320px or 390px touch viewport shows a long spaced or unbroken selected title at normal or 200% root text size
- **THEN** the picker, Rename and New conversation stay on one row without horizontal painted overflow
- **AND** both actions retain full touch targets, keyboard access and the native option list's complete titles

#### Scenario: Enlarged landscape navigation cannot obstruct header actions
- **WHEN** an 844×390px touch viewport at 200% text allocates a short transcript strip while Latest is shown
- **THEN** Rename and New conversation remain hit-testable at their centers and block edges
- **AND** floating transcript navigation remains within its transcript paint/hit boundary rather than covering header or work controls

### Requirement: Desktop density follows input capability and actual pane width

Compact desktop density SHALL follow selected UI mode, primary fine-pointer hover capability, and actual pane width. Composer, worker, and pending controls SHALL retain the specified compact target exceptions, metadata, fixed delivery guidance, and safe wrapping without altering comfortable/touch behavior.

These desktop target exceptions supersede the comfortable 44px target rules above.

#### Scenario: A fine-pointer desktop pane changes width while composer, worker, and pending controls are present
- **WHEN** composer, worker or pending controls are displayed in desktop or comfortable/touch mode, including at changing pane widths or input capabilities
- **THEN** Compact desktop density SHALL require selected desktop UI mode and a primary fine pointer with hover.
- **AND** Explicit touch/comfortable mode and touch-first hybrid devices SHALL retain existing comfortable targets.
- **AND** Composer actions SHALL use consistent 32px controls, one row where the actual pane fits and a deliberate two-row layout below 34rem, retaining Attach, model/mode/effort, context, Send and Stop.
- **AND** At actual work-pane widths of at least 40rem active worker rows SHALL align status, agent, task, model, cumulative tokens and a separate 28px Stop; narrower panes SHALL retain two lines without removing metadata.
- **AND** Pending actions SHALL be 32px with 4px/8px padding and independent 8px gaps, inline when they fit and wrapped otherwise.
- **AND** Delivery and Paused labels, edit/replacement safeguards and unknown receipts SHALL remain available.
- **AND** No hidden counts, success notices or replacement action menu SHALL be introduced.

#### Scenario: Resizing the pane on a desktop does not turn it into touch UI
- **WHEN** a fine-pointer desktop chat pane narrows inside a wide viewport
- **THEN** composer controls deliberately reflow and worker metadata uses two lines while Stop remains separate and reachable
- **AND** explicit comfortable mode retains its existing targets regardless of viewport width

#### Scenario: Desktop keyboard guidance uses fixed delivery
- **WHEN** steering/queueing is offered for an ordinary desktop message-field draft
- **THEN** visible Enter and Alt+Enter hints SHALL state steer and queue respectively, ignoring legacy saved delivery choices
- **AND** idle or non-choice drafts SHALL show ordinary send/newline guidance without changing pointer hold timing

### Requirement: Desktop expanded work retains a useful conversation band
Compact desktop expanded cards SHALL prefer 35% of measured remaining layout height for conversation, bounded to 200–280px, rather than the comfortable 20%/32–96px reserve above. Whole measured headers/actions MAY reduce this reserve to the existing lesser-of-16px-or-10% emergency floor. Independent panel scrolling, headers, selected-pane short-window priority and reachable composer/Stop SHALL remain intact. Comfortable/touch expanded allocation SHALL remain unchanged.

#### Scenario: Expanded desktop work shares remaining space with conversation
- **WHEN** two long work panels expand with 720px remaining after fixed chrome and fitting action minima
- **THEN** conversation retains 252px and the cards share 468px through separate scrollports
- **AND** short windows yield conversation space to measured whole headers/actions rather than clipping Stop

### Requirement: Side answers minimise without losing their answer

Desktop side answers SHALL use bounded nonmodal readers with Minimise and retained page-local answers and reading offsets. Other controls SHALL remain usable, Escape and focus restoration SHALL respect ownership, and conversation switches SHALL hide the reader without changing content safety policies.

These window/minimisation rules supersede earlier modal-only Escape wording; sanitization and file/external-link policies remain unchanged.

#### Scenario: A desktop or mobile side answer opens, minimizes, reopens, receives Escape, or loses its selected conversation
- **WHEN** a desktop or mobile side answer opens, minimizes, reopens, receives Escape, or loses its selected conversation
- **THEN** Desktop side answers SHALL open a larger nonmodal native dialog without a blocker or focus trap; other app controls SHALL remain interactive.
- **AND** The window SHALL fit actual viewport and safe-area bounds and SHALL NOT cover the entire app or become a permanent pane.
- **AND** Mobile MAY retain its modal reader.
- **AND** Both SHALL offer Minimise, replacing the old hide-only Close action rather than duplicating it.
- **AND** Minimise SHALL retain the page-local answer and reading offset and make the existing conversation notice available to reopen without generation, foreground admission or history mutation.
- **AND** Desktop Escape SHALL minimise only from inside the reader; unrelated composing keys SHALL remain owned by the composer.
- **AND** Focus restoration SHALL not override unrelated current interaction.
- **AND** Switching conversation SHALL hide the reader, retain its reading offset, and preserve the existing conversation/file-action ownership guards.

#### Scenario: Reading continues while the main app remains usable
- **WHEN** a desktop side answer is open
- **THEN** the user can click and type in the composer, act on pending messages and invoke Stop without dismissing the answer
- **AND** minimising and reopening on either desktop or mobile restores the same answer/offset without another inference

#### Scenario: Live UI-mode changes minimise the current native reader
- **WHEN** the shell changes desktop to touch or touch to desktop while a side reader is open, including an explicit override on coarse-pointer hardware
- **THEN** the existing UI-mode event SHALL minimise the reader, release native modal inertness and retain its answer/reading offset without taking focus from the shell's next interaction
- **AND** deliberate reopening SHALL use native modal touch or nonmodal desktop semantics matching the newly chosen UI mode, not an ARIA-only substitution, without another generation or timeline mutation

### Requirement: Pointer Send steers and an armed two-second countdown queues

Send SHALL use fixed steer shortcuts and mandatory queue exceptions without saved delivery defaults or menus. A 500ms arm plus two-second pointer or Space countdown SHALL queue once at 2500ms, with safe cancellation, immutable draft ownership, accessible guidance, and fixed viewport-owned visual bounds.

These rules supersede earlier per-device delivery-default, visible delivery-selector, saved keyboard-default and envelope-growth clauses.

#### Scenario: A steering-capable user sends ordinary busy text, commands, or attachment-bearing drafts by pointer or keyboard
- **WHEN** a steering-capable user sends ordinary busy text, commands, or attachment-bearing drafts by pointer or keyboard
- **THEN** For steering-capable agents, tapping Send, desktop Enter and touch Ctrl/Command+Enter SHALL explicitly steer ordinary busy text.
- **AND** Alt/Option+Enter SHALL queue where already offered; touch plain Enter SHALL remain newline.
- **AND** Steer SHALL be the fixed keyboard default, not configurable.
- **AND** Legacy saved delivery choices SHALL be ignored without deleting browser settings, including after reload.
- **AND** No delivery-default Settings path, dropdown, replacement selector or added layout height SHALL be introduced.
- **AND** Busy commands and attachment-bearing composer drafts SHALL queue with truthful labels; native staged-replacement semantics, explicit HTTP/dock delivery and unsupported agents' queued/idle behavior SHALL remain unchanged.

#### Scenario: A pointer or focused-Send Space hold starts, arms, counts down, releases, or is invalidated by interaction or page changes
- **WHEN** a pointer or focused-Send Space hold starts, arms, counts down, releases, or is invalidated by interaction or page changes
- **THEN** A continuous pointer or focused-Send Space hold SHALL arm silently for 500ms, then run a two-second countdown and automatically submit Queue once at 2500ms, without waiting for release.
- **AND** Release before 500ms SHALL steer once; release from 500ms until 2500ms SHALL cancel without sending.
- **AND** Before 500ms no extension or progress countdown SHALL render.

#### Scenario: A Send hold loses its owned target or input
- **GIVEN** a pointer or focused-Send Space hold is pending
- **WHEN** its target, input identity, page activity, capture, focus, or submission lock changes
- **THEN** Drag outside the original fixed Send bounds, movement of the target, pointercancel, lost capture, window blur, page hiding, Escape, changed draft/attachments/configuration/selection, or active submission/cancellation locks SHALL invalidate the gesture and all stale timers.
- **AND** Keyboard focus leaving Send SHALL cancel its Space hold.
- **AND** Every timer/frame SHALL recheck current page visibility/focus and owned immutable draft identity before dispatch.

#### Scenario: An armed Send hold paints a fixed viewport-owned countdown
- **WHEN** a valid Send hold reaches arming and continues through its countdown
- **THEN** At arming, the viewport-owned pointer-transparent visual envelope SHALL appear at its full fixed height, extending 104px above the original target, bounded by visible viewport space.
- **AND** Its bottom SHALL match Send's bottom and its width SHALL match Send.
- **AND** The outer bounds SHALL remain fixed throughout the countdown; only the green fill SHALL move bottom-to-top while the above-finger countdown runs from 2.0s to zero.
- **AND** There SHALL be no envelope growth or size transition.
- **AND** It SHALL escape composer/dock clipping without shifting layout or enlarging the hit area.
- **AND** Reduced motion SHALL retain the same fixed bounds, progress and countdown.

#### Scenario: Keyboard and idle delivery retain fixed accessible semantics
- **WHEN** a reader accesses Send instructions, activates it by keyboard, or completes an idle Queue hold
- **THEN** Send SHALL expose concise aria-describedby instructions for arming/hold/cancel and fixed keyboard shortcuts; Enter on Send SHALL activate immediately.
- **AND** There SHALL be no visible Send/Steer/Queue dropdown or replacement menu.
- **AND** Idle held Queue SHALL dispatch using existing normal idle semantics, not create fake pending input.
- **AND** Existing authoritative personal background policy SHALL govern accepted steer actions without a second browser background request.

#### Scenario: Fixed and client viewport origins differ during a hold
- **WHEN** a valid Send hold is painted with a nonzero fixed/client origin difference, including keyboard pan or magnification
- **THEN** its visual bottom and horizontal anchor SHALL match the unchanged Send rectangle without applying the viewport displacement twice
- **AND** keyboard opening/closing, pan or toolbar changes that move Send SHALL cancel without a later queued submission

#### Scenario: Ongoing hold calibration does not alternate paint writes and layout reads
- **WHEN** the unchanged Send target is held across animation frames
- **THEN** fixed-origin geometry SHALL be read from a stable inert zero-size probe sharing the visual's fixed containing block before that frame's paint writes, without resetting the visible envelope for measurement
- **AND** origin changes SHALL be sampled during the hold rather than using a stale gesture-start origin
- **AND** the page-owned probe and visual SHALL be removed together on pagehide and restored for a retained page or subsequent gesture

#### Scenario: Quick tap and intentional hold have distinct outcomes
- **WHEN** a busy ordinary draft is released before 500ms, released during the 500ms–2499ms countdown, or continuously held for 2500ms
- **THEN** it respectively steers once, sends nothing, or queues automatically once before release
- **AND** subsequent click, release and timer events cannot duplicate that action

#### Scenario: First eligible busy draft teaches queueing once
- **WHEN** an unlearned browser has a valid ordinary-text draft while working and hold-to-queue is supported
- **THEN** compact accessible copy says “Tap to steer · hold to queue” without a menu
- **AND** only an accepted held queue submission retires it for this browser/base path; cancellation, refusal, uncertainty and tap do not
- **AND** unavailable browser storage falls back to page-local learning without an account API

#### Scenario: A stale or inactive hold never sends
- **WHEN** the tab loses visibility/focus, a pointer is cancelled or leaves the original button, Escape is pressed, or the owned conversation/draft/configuration changes
- **THEN** the hold and any delayed timer are cancelled without steering or queueing
- **AND** the draft and attachments remain available

#### Scenario: Accessible keyboard and idle holds stay truthful
- **WHEN** the user holds Space on Send for 500ms arming plus two seconds of countdown, or completes an idle pointer hold
- **THEN** the existing adapter decides held versus normal idle dispatch without inventing pending messages
- **AND** Escape cancels without a later native Space click and Enter on Send remains immediate

### Requirement: Native side answers stay outside foreground conversation admission

Native side generation SHALL use verified one-shot context generation outside foreground admission, history, and agent tool execution. Protected bounded requests and page-local responses SHALL preserve drafts, reject unsupported agents and attachments, and avoid inference replay or shared receipts.

User-installed native plugin hooks remain outside this tool-loop guarantee. No provider-history persistence or durable exactly-once inference is promised.

#### Scenario: A supported OpenCode V2 user invokes /btw for native one-shot context generation
- **WHEN** a supported OpenCode V2 user invokes /btw for native one-shot context generation
- **THEN** Only an agent with verified native one-shot context generation SHALL declare `side-generation` and offer `/btw <question>`.
- **AND** OpenCode V2 SHALL use `session.generate`, with the native TUI's concise-answer/no-tools/no-actions instruction, without prompt admission, history mutation, foreground interrupt/resume/background, or an agent tool execution loop.
- **AND** The implementation SHALL NOT substitute a foreground prompt or a new child agent.
- **AND** Native generation may advertise tool definitions but SHALL NOT execute a returned tool call; empty text SHALL be explained honestly.

#### Scenario: A side request is validated, submitted, fails, or completes while drafts or conversation selection change
- **WHEN** a side request is validated, submitted, fails or completes, whether or not drafts or conversation selection change
- **THEN** The internal aside action SHALL retain existing authentication, origin, base-path, qualified-agent and workspace-ownership gates, accept a closed `{requestId, question}` body with nonempty question bounded to 16,384 UTF-8 bytes, and return closed `{text}` with no-store.
- **AND** Unsupported providers SHALL refuse honestly; V1/Claude SHALL not offer the command, and a typed `/btw` SHALL not fall through into ordinary prompt admission.
- **AND** Pending attachments SHALL be refused and retained.
- **AND** The initiating page SHALL prevent concurrent duplicate side requests, preserve newer composing drafts on failure and never automatically replay inference.
- **AND** Responses SHALL remain page-local and not be cached in shared workspace action receipts.
- **AND** Completion SHALL expose a deliberate answer-opening action without stealing composing focus.

#### Scenario: A side question does not interrupt foreground work
- **WHEN** a V2 conversation is running and the user submits `/btw` with a question
- **THEN** one native generate request answers from current context without prompt/interrupt/background calls
- **AND** provider history, pending inputs and foreground running state remain unchanged

#### Scenario: Unsupported side generation never becomes a prompt
- **WHEN** V1/Claude receives a typed `/btw`, or a side question has pending attachments
- **THEN** the surface refuses and keeps the draft/attachments without any foreground admission or fallback agent call

#### Scenario: Side answers are personal page state
- **WHEN** side inference completes while the user is composing another draft or has switched conversations
- **THEN** the answer remains associated with its initiating conversation without focus theft or draft loss
- **AND** no shared receipt exposes one user's side response to another user reusing an identifier

### Requirement: Side answers use a compact notice and safe Markdown reader

Side answers SHALL use a compact deliberate notice and safe Markdown reader scoped to their originating conversation. Completion SHALL preserve composing state and reading anchors; viewport, Escape and superseding nonmodal/minimization behavior SHALL retain existing ownership and safety contracts.

Later desktop nonmodal/Minimise behavior supersedes this requirement's modal-only Escape and close wording. One-shot/no-history/no-tool-loop/no-retry behavior remains unchanged.

#### Scenario: A side answer works, completes, fails, opens in its reader, or becomes stale during conversation navigation
- **WHEN** a side answer works, completes, fails, opens in its reader, or becomes stale during conversation navigation
- **THEN** Working, ready and failed side answers SHALL use a small transcript-edge notice outside the composer feedback block, with a 44px activation target that does not cover worker Stop controls.
- **AND** Completion SHALL preserve composing selection, drafts and the reading anchor.
- **AND** Opening the reader SHALL be deliberate and associated with the originating conversation; stale callbacks SHALL NOT expose an answer in another conversation.
- **AND** The reader SHALL use the normal chat Markdown renderer and sanitizer, support selectable headings, emphasis, links, inline/fenced code and tables, and reject scripts, event handlers and unsafe URL schemes.
- **AND** Wide tables/code SHALL scroll inside the reader without horizontally panning the surface.
- **AND** Reader bounds SHALL follow the visual viewport through keyboard resize/pan; Escape SHALL close only that modal and restore its surviving invoker.
- **AND** Switching conversations SHALL close a stale reader without moving focus to an unrelated notice.

#### Scenario: A formatted side answer arrives during composition
- **WHEN** inference completes while the user is reading older messages and selecting text in a newer draft
- **THEN** a small ready notice appears without changing that selection, draft, reading anchor or foreground work
- **AND** its deliberate reader renders safe formatted content, containing large-table scrolling within its visual-viewport bounds

#### Scenario: A side answer references a watched workspace file
- **WHEN** a user activates a resolved workspace file reference by pointer, Enter or Space in the current conversation's side reader
- **THEN** the normal chat decorator, watched-root resolver and existing in-app preview action are used, including qualified paths and line suffixes
- **AND** the reader closes before preview navigation without app reload, lost draft/conversation/answer, duplicate inference or another prompt admission
- **AND** Hub workspace prefixes remain intact, safe external links retain normal new-tab semantics, and malformed/traversing/unrecognized references are not promoted into file actions

### Requirement: Native questions retain explicit answer ownership
Pending native tool questions SHALL remain explicit forms, not automatically answered, cancelled or treated as detachable jobs. Already detached child work and existing parent mirroring/reply routing for child questions SHALL remain unchanged. A side-generation response SHALL NOT complete an unanswered tool question or launch a new orchestrated task.

#### Scenario: A pending question does not become background work
- **WHEN** a native foreground question awaits an answer while detached children run or settle
- **THEN** the question remains available for an explicit answer and is neither answered nor cancelled automatically
- **AND** no Continue UI is offered; detached children can continue independently and existing child-question mirroring remains intact
