# opencode-chat Specification

## Purpose
Define workspace-scoped OpenCode conversations and the responsive web chat surface through which authenticated users can inspect, direct, interrupt, and resume coding-agent work.

## Requirements

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

#### Scenario: Installation guidance leads when OpenCode is absent
- **WHEN** Chat is unavailable because no `opencode` executable could be resolved
- **THEN** the surface leads with the instruction to install OpenCode rather than presenting retry as the remedy
- **AND** retry remains available as a secondary action, because the workspace caches the unavailable state and a completed installation must be discoverable without restarting the workspace

#### Scenario: Concurrent retries are joined
- **WHEN** a retry is in flight and another retry is triggered
- **THEN** the second retry joins the in-flight attempt
- **AND** only one OpenCode process is started

### Requirement: Every conversation is confined to the server-selected workspace directory
The chat backend SHALL select the workspace's canonical first watch root as the OpenCode working directory and SHALL use that directory for conversation discovery, creation, history, prompts, and tools. Browser requests MUST NOT provide or override a filesystem working directory. Before exposing or resuming an OpenCode session, UatuCode SHALL verify that the session's canonical directory matches the selected workspace directory; a session belonging to another directory MUST NOT be exposed, resumed, or mutated through that workspace.

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
The authenticated workspace API SHALL list resumable OpenCode conversations associated with the selected workspace directory, create a new conversation, and return paginated normalized history for a selected conversation. Conversation identity and durable provider history SHALL remain owned by OpenCode; UatuCode SHALL retain only the provider identifiers and presentation state needed to reconnect and render them. Restarting UatuCode or its workspace-scoped OpenCode service MUST NOT by itself erase completed conversation history.

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
The normalized Chat API SHALL expose the effective model, mode, and reasoning variant of a conversation when the agent can determine them. This configuration SHALL be conversation state rather than physical client presentation state: opening the conversation from another authenticated client or after a workspace restart SHALL restore the same known configuration without relying on that client's browser storage.

An absent configuration field SHALL mean that the agent's effective value is unknown or has not been explicitly selected. The surface MUST NOT replace an absent field with the first available option or claim that a default is the conversation's current value. Sending a prompt without a staged selection SHALL preserve the agent's effective configuration rather than silently switching it.

A client MAY stage a different offered model, mode, or variant for its next prompt without changing another client. Once the agent accepts that prompt, the accepted configuration SHALL become the conversation's shared effective state and SHALL be published to subscribed clients. A client with no unsubmitted local selection SHALL update its controls from that publication; an explicitly staged selection remains local until submitted or discarded.

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
Where the agent declares conversation renaming, the authenticated workspace API SHALL let a user replace a workspace conversation's title with a non-empty bounded title, and the Chat surface SHALL provide a rename affordance for the selected conversation. Renaming SHALL preserve the conversation identity, history, active turn, and effective configuration. The mutation SHALL be origin-protected under cookie authentication, workspace-confined, and idempotent under a client-generated request identifier.

A successful rename SHALL update the conversation inventory and every subscribed client that displays that conversation. Where the agent does not declare renaming, the affordance SHALL be absent rather than inert. Automatic first-prompt title generation MAY still name a conversation that the user has not manually renamed, but SHALL NOT overwrite a user-supplied title.

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
The workspace API SHALL provide authenticated operations to list, create, and read conversations; start a prompt turn; cancel the active turn; answer a pending permission; and answer or reject a structured question. Mutation requests SHALL be origin-protected under cookie authentication, SHALL validate conversation ownership against the workspace directory, and SHALL use client-generated request identifiers to make network retries idempotent. Provider-specific payloads and credentials MUST NOT be exposed as the public contract when a normalized UatuCode representation exists.

The API SHALL report which agent a workspace's Chat is talking to, and which capabilities that agent declares. A capability is declared only when the agent actually supports it; the absence of a declaration SHALL be a normal, expected state rather than an error or an empty result. Consumers SHALL be able to decide what to present from the declaration alone, without probing an operation to discover whether it works.

The API SHALL name a way of working a **mode**, and SHALL name the program Chat talks to an **agent**. These two SHALL NOT share a name in the route table, because they are not the same thing and a reader cannot tell them apart from the route alone.

#### Scenario: Retried prompt does not run twice
- **WHEN** a client retries a prompt mutation with the same request identifier after losing the response
- **THEN** the server returns the original accepted result or current outcome
- **AND** OpenCode receives the prompt at most once

#### Scenario: Cross-origin mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to prompt, cancel, or answer an agent request
- **THEN** the workspace rejects it without changing the conversation

#### Scenario: Base-path deployment uses relocated chat routes
- **WHEN** Chat is served under a workspace base path such as `/s/project-a/`
- **THEN** every chat request and stream URL resolves through that base path
- **AND** the hub proxies it without exposing the loopback OpenCode service

#### Scenario: The API reports its agent and that agent's capabilities
- **WHEN** a client asks a workspace for its chat status
- **THEN** the response identifies the agent Chat is talking to
- **AND** states which capabilities that agent declares

#### Scenario: An undeclared capability is not an error
- **WHEN** an agent does not declare a capability
- **THEN** the status response omits it rather than reporting a failure
- **AND** the client can tell the difference between "not supported" and "supported but empty"

#### Scenario: Modes are listed under a route named for modes
- **WHEN** a client lists the ways of working a prompt can run under
- **THEN** the route names them modes
- **AND** no route names them agents

### Requirement: Conversation updates are structured and reconnectable
The server SHALL normalize OpenCode activity into ordered conversation events covering user and assistant content, reasoning, tool lifecycle, permission requests and resolutions, structured questions and resolutions, context compaction, reverted work, turn status, cancellation, completion, warnings, and errors. Normalization SHALL recognize each of these regardless of which of OpenCode's event-naming generations announced it, and when one logical occurrence is announced more than once the timeline SHALL contain a single entry for it.

An event the server does not recognize, or whose payload it cannot parse, SHALL be skipped without ending or restarting the event stream, and SHALL be counted by type so an operator can discover what a running workspace is discarding. Counting MUST NOT record event payloads.

A history snapshot SHALL identify a stream cursor; reconnecting from a retained cursor SHALL replay every later event in order before delivering live events. If the cursor is no longer replayable or belongs to an earlier server generation, the server SHALL explicitly require a fresh snapshot. Applying a snapshot followed by its event stream MUST NOT duplicate message content or tool entries.

#### Scenario: Stream reconnect replays missed output
- **WHEN** the event connection drops during an assistant response and reconnects with a retained cursor
- **THEN** every event after that cursor is replayed once in order before live output continues

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
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. While a tool runs, its output SHALL be shown as it streams rather than only on completion, so a long-running tool shows progress. A finished tool's output SHALL be bounded — presented as a summary and a bounded preview with a way to see the rest — rather than shown whole or hidden whole. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

#### Scenario: Assistant answer remains visually primary
- **WHEN** a turn contains assistant text interleaved with multiple tool calls
- **THEN** the answer reads as a coherent conversation
- **AND** tool activity can be expanded for detail without being mistaken for assistant prose

#### Scenario: Streaming tool lifecycle updates in place
- **WHEN** a tool moves from running to completed or failed
- **THEN** its existing activity entry updates state instead of adding a duplicate entry

#### Scenario: A running tool shows its output as it streams
- **WHEN** a tool is running and the agent streams its output
- **THEN** the surface shows that output as it arrives
- **AND** it updates the tool's existing entry in place

#### Scenario: A finished tool's output is bounded with a way to see the rest
- **WHEN** a completed tool produced more output than the bounded preview shows
- **THEN** the entry shows a summary and a bounded preview
- **AND** offers a way to see the full output
- **AND** does not render the whole output by default

#### Scenario: Hostile content remains inert
- **WHEN** assistant Markdown or tool output contains script-capable markup or a JavaScript URL
- **THEN** the rendered conversation does not execute it or expose an active unsafe link

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting. Where a permission would change a file, the request SHALL show what it would change — the pending diff — where the choice is made, so the user sees the change before allowing it. A permission with nothing to show a diff for is unaffected. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form. Submitting a response more than once MUST NOT produce multiple provider replies.

A request raised by a subagent SHALL additionally appear in the conversation that launched that subagent, and SHALL be answerable there. The subagent's own conversation remains the single owner of the request: an answer given from the launching conversation SHALL be directed to the owning conversation, so exactly one response reaches OpenCode however many places the request was shown. Resolving it SHALL resolve it everywhere it appears.

Only the active unresolved request of a given conversation MAY accept a response. Where requests from more than one conversation are shown together, they SHALL each be governed by the conversation that owns them, so a request awaiting a user in one conversation does not block answering a request owned by another.

A request's state SHALL be distinguishable without reading its body — whether it awaits the user now, awaits its turn behind another request of the same conversation, or is resolved. That distinction MUST NOT rely on colour alone. A request awaiting its turn MUST NOT be presented as obsolete, superseded, or otherwise not needing an answer, because it will require one.

The surface SHALL report how many requests are outstanding across everything it is showing, and SHALL offer a way to reach an outstanding request without hunting for it.

A choice that grants authority beyond the request being answered SHALL state the scope and lifetime of that authority where the choice is offered, so a user learns what they are granting before granting it rather than afterwards. In particular, OpenCode's persistent approval carries past the answered request into later conversations served by the same OpenCode instance and covers the request's saved pattern rather than only the resource displayed, and it is lost when that instance restarts. It MUST NOT be presented as limited to the current conversation, nor as outliving the OpenCode instance that granted it.

A pending request SHALL remain discoverable and answerable even when the server did not observe its live announcement — because the event stream was interrupted, restarted, or the conversation was not being tracked at the time. Loading a conversation SHALL reconcile its unresolved requests against OpenCode's own pending set, so a request that OpenCode is still waiting on is never permanently invisible.

#### Scenario: Permission is approved once
- **WHEN** OpenCode requests permission for a command and the user chooses one-time approval
- **THEN** the response is sent once to the matching pending request
- **AND** the card records that the request was approved for that occurrence

#### Scenario: An edit permission shows its diff before approval
- **WHEN** a pending permission would change a file
- **THEN** the card shows the change it would apply
- **AND** the diff is shown where the approve and reject choices are

#### Scenario: A non-edit permission shows no diff
- **WHEN** a pending permission has no file change to show
- **THEN** the card presents its choices without a diff

#### Scenario: An answered request recedes
- **WHEN** a permission or question has been answered
- **THEN** what was asked and what was decided remain legible
- **AND** the request occupies less of the transcript than it did while it needed an answer
- **AND** the resources it named remain reachable from it

#### Scenario: A subagent's request reaches the conversation that launched it
- **WHEN** a subagent raises a permission request while its parent conversation is open
- **THEN** the request appears in the parent conversation
- **AND** it is answerable there without first opening the subagent's transcript

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

#### Scenario: Persistent approval is still sent as OpenCode's persistent reply
- **WHEN** the user chooses persistent approval
- **THEN** OpenCode receives its persistent-approval reply once for that request
- **AND** the recorded outcome is unchanged from before this correction

#### Scenario: A request missed by the event stream is recovered on load
- **WHEN** OpenCode raised a permission request while the server's event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered
- **AND** answering it resolves the request OpenCode is waiting on

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable

### Requirement: Structured questions follow OpenCode custom-answer semantics
For every structured question, Chat SHALL support a custom answer unless OpenCode explicitly reports `custom === false`. An omitted `custom` value MUST enable custom answers for both live question announcements and pending questions recovered from OpenCode. An explicit false value MUST suppress the custom-answer choice.

Where custom answers are supported, Chat SHALL append a UI-only choice labelled "Type your own answer" to the provider's options. Selecting that choice SHALL reveal and focus a text input. The synthetic label MUST NOT be submitted to OpenCode. Chat SHALL trim the entered text and submit the non-empty result as an ordinary string in that question's answer array.

For a single-select question, the custom choice SHALL be mutually exclusive with provider options. For a multi-select question, it SHALL be selectable alongside provider options and its entered text SHALL be appended as one additional answer string. Deselecting the custom choice SHALL hide its input and exclude its text from submission, but MUST preserve the text while the pending question remains mounted so selecting it again restores the draft.

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
A question form containing one single-select question SHALL retain the selected option without submitting it when the option is clicked. Chat SHALL expose an explicit Answer action and SHALL submit only when the user activates that action or performs the form's equivalent explicit submission. This rule SHALL apply whether custom answers are enabled or disabled.

Existing multi-question stepping SHALL remain unchanged: intermediate confirmation advances to the next question, the final action submits all ordered answers, and earlier answers remain revisitable. Existing multi-select questions SHALL continue to require explicit confirmation and SHALL allow more than one selected answer.

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

### Requirement: Users can prompt, steer, and cancel the active conversation
The Chat composer SHALL submit non-empty text to the selected conversation and clearly distinguish ready, sending, running, interrupted, and failed states. While OpenCode supports steering a running session, a subsequent submitted prompt SHALL be presented as a steer of the active turn rather than an unrelated concurrent turn. The user SHALL be able to cancel an active turn without deleting its completed history, and transport failure SHALL preserve the draft until acceptance is known.

The surface SHALL name the agent it is talking to, taking that name from what the agent reports rather than from fixed copy. Text presented to the user SHALL NOT assume a particular agent, so that installing a different agent changes the name shown and nothing else.

The way of working a prompt runs under SHALL be presented as a **mode** — the agent's own named ways of working, such as building or planning. It SHALL NOT be called an agent, because that word names the program Chat talks to.

A control the surface offers the user to start an operation — a picker such as the mode or model chooser — SHALL be presented only when the agent declares the capability behind it. Where that capability is undeclared, the control SHALL be absent rather than shown inert, shown empty, or shown with an error. Reactive interaction controls — those that appear only in response to an agent-raised request, governed by "Users can resolve agent interaction requests in context" — are not covered here: an agent that lacks a capability raises no request of that kind, so the control has nothing to appear for. Absence of a capability SHALL NOT degrade any capability the agent does declare.

#### Scenario: Empty prompt is not submitted
- **WHEN** the composer contains only whitespace
- **THEN** the send action is unavailable and no mutation is sent

#### Scenario: Follow-up steers a running turn
- **WHEN** the user submits another prompt while the selected OpenCode conversation is running and steering is available
- **THEN** the prompt is associated with the active turn and the UI identifies it as a steer

#### Scenario: Cancellation preserves completed content
- **WHEN** the user cancels a running turn
- **THEN** OpenCode is asked to abort that turn
- **AND** content and tool activity already received remain in the timeline with an interrupted outcome

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

### Requirement: Timeline position remains stable under streaming and navigation
The Chat timeline SHALL remain pinned to the latest content only while the user is at or near its end. Once the user scrolls away, streaming, tool updates, image or code layout, and activity expansion MUST NOT steal the reading position; an accessible latest-content affordance SHALL indicate unseen updates and return to the end. Prepending older history SHALL preserve the same visible content and offset. Opening a conversation SHALL restore that client's last reading position when possible, otherwise it SHALL open at the latest turn.

#### Scenario: Active reader follows streaming output
- **WHEN** the user is at the end of the timeline as assistant content streams
- **THEN** new content remains visible without repeated manual scrolling

#### Scenario: Reading older content is not interrupted
- **WHEN** the user scrolls above the end while content continues streaming
- **THEN** their visible content remains anchored
- **AND** an affordance reports and navigates to unseen latest content

#### Scenario: Loading older history preserves the viewport
- **WHEN** the user requests an older history page at the top of the loaded timeline
- **THEN** the previously visible first item remains at the same visual offset after insertion

#### Scenario: Expanding activity does not cause an unrelated jump
- **WHEN** the user expands or collapses a tool entry away from the timeline end
- **THEN** the chosen entry remains anchored in the viewport

### Requirement: Desktop presents Preview and Chat as a persistent split
In desktop mode the work area SHALL present Preview and Chat side by side with
a draggable divider between them; Chat SHALL NOT be movable or dockable. The
split position SHALL be persisted as a fraction of the work-area width so
window resizing preserves the proportion, and it SHALL be restored across
reloads. A collapsed Chat SHALL render as a slim strip at the work area's
right edge carrying a visible reopen affordance, and expanding SHALL restore
the retained fraction. When the viewport is too narrow to present both
surfaces at their minimum usable widths, Chat SHALL auto-collapse with its
open preference preserved and SHALL be restored when the viewport grows.
Chat panel state MUST NOT alter the terminal's dock, sizing, visibility, or
persistence behavior: a bottom-docked terminal SHALL span beneath both
Preview and Chat, and a right-docked terminal SHALL keep the work area's
right edge, with Chat between Preview and the terminal.

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
In desktop mode Preview and Chat SHALL be co-visible primary surfaces sharing
the main work area alongside the existing sidebar and independently dockable
terminal; there SHALL NOT be a mode that replaces Preview with Chat.
Collapsing, expanding, or resizing the Chat panel MUST NOT remount either
surface or lose its state. In touch mode Chat SHALL occupy its own
full-screen tab surface. The composer SHALL remain reachable above the visual
viewport and safe-area inset while the software keyboard is present, and
keyboard opening, resizing, or dismissal MUST NOT hide the input or cause the
current reading position to jump.

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

### Requirement: Conversation file references navigate through UatuCode safely
Workspace-relative file references in assistant content or normalized
file-change activity SHALL offer navigation to the corresponding UatuCode
document preview when the target is within the watched roots. Activating such
a reference SHALL open the document in Preview and reveal the referenced line
when supplied; in desktop mode this MUST NOT hide, collapse, or resize the
Chat panel, and in touch mode it SHALL switch to the Preview tab. Absolute
paths outside the watched roots, traversal attempts, and unresolved targets
MUST NOT be exposed as navigable workspace links.

#### Scenario: Assistant references a watched source line
- **WHEN** assistant content references `src/app.ts:42` and that file is in the watched workspace
- **THEN** activating the reference opens that document in Preview at line 42
- **AND** in desktop mode the conversation remains visible beside it

#### Scenario: Outside path is not navigable
- **WHEN** provider output references an absolute path outside every watched root or contains traversal outside the workspace
- **THEN** Chat renders it as inert text rather than a UatuCode navigation action

### Requirement: Chat reads at its own density and tiers its surfaces
The Chat surface SHALL set a reading density of its own rather than inheriting the document preview's prose scale, so that a conversation read in a narrow side panel shows several turns at once. That density MUST apply to the whole surface — transcript, rendered assistant Markdown, requests, pinned tracks, and composer — so that no region is left at a scale that disagrees with the rest. The document preview's own reading scale SHALL be unaffected.

Chat SHALL present its pinned progress tracks as a tier distinct from the transcript entries above them, so a reader can tell at a glance which part of the surface reports the present state. That distinction MUST NOT rely on colour alone, and MUST hold under both the light and the dark colour scheme.

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
Where the agent declares the reasoning-variant capability, Chat SHALL let the user choose how hard the selected model reasons, from the named ways of thinking that model advertises — such as thinking harder or faster. The choice SHALL be scoped to how a prompt runs, sent with the prompt rather than changing the model, and SHALL be remembered per conversation as the model choice is. A model that advertises no such ways offers no choice, and where the capability is undeclared the control is absent rather than shown empty.

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
A subagent's transcript SHALL be reached from its parent conversation — the subagent row that represents it — and SHALL NOT be presented as an entry in the conversation picker, which lists the conversations a user can start and resume. Opening a subagent's transcript SHALL NOT change which conversation the picker shows as selected: the parent remains the selected conversation.

Opening a subagent's transcript SHALL present it as a layer over the parent with a first-class way back to the parent. Where the surface navigates as a stack — a phone — this SHALL be a push with the platform's back gesture returning to the parent. Where the surface shows the parent alongside — the desktop split — the child SHALL open as an inline drill-down that keeps the parent in view, with a return affordance.

While a subagent's transcript is open, the parent SHALL remain reachable and its pending requests answerable, so a request the parent or another subagent is waiting on is not trapped behind the open child.

Returning from a subagent's transcript SHALL restore the parent as it was, without the child persisting as a pseudo-conversation and without the return depending on re-selecting the parent from a list.

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
Where the agent declares the context capability, Chat SHALL report how full the conversation's context window is, against the selected model's limit, and SHALL attribute each subagent with the model it ran and the tokens it consumed. Each SHALL be gated on that declared capability: undeclared, the readout or figure is absent rather than empty, and its absence SHALL NOT degrade the rest.

The context report SHALL be legible without the user opening anything, and MAY expand to the breakdown the agent reports — input, cache, and output. It reports the live window fill, not lifetime spend, and SHALL be populated when an existing conversation is opened, not only after a new turn is taken.

A subagent's attribution SHALL reflect the subagent's own session — a subagent may run a different model from its parent — and SHALL state the tokens that subagent consumed, aggregated from its child session onto the launching conversation. The model MAY be shown before any usage is known. When the agent has not reported usage for a subagent, the row SHALL stay readable and SHALL NOT assert a figure it does not have.

#### Scenario: The context indicator reads without being opened
- **WHEN** a conversation has exchanged turns and the agent declares context reporting
- **THEN** the surface shows how full the context window is against the model's limit
- **AND** the fill is legible without expanding anything

#### Scenario: The indicator is populated on opening an existing conversation
- **WHEN** the user opens a conversation that already has assistant turns
- **THEN** the context fill is shown from that history, before any new turn

#### Scenario: The context breakdown expands
- **WHEN** the user opens the context indicator
- **THEN** it shows the input, cache, and output the agent reported

#### Scenario: A subagent row names its model and tokens
- **WHEN** a subagent has run and the agent reports its model and token counts
- **THEN** its row states which model it ran and how many tokens it consumed

#### Scenario: A subagent without reported usage stays readable
- **WHEN** a subagent has not yet reported usage, or the agent does not report it
- **THEN** the row still names the subagent and its status
- **AND** no token figure is asserted for it

#### Scenario: An undeclared context capability leaves nothing behind
- **WHEN** the agent does not declare the context capability
- **THEN** the context indicator and the subagent token figure are absent
- **AND** the capabilities the agent does declare are unaffected

### Requirement: Chat composer actions keep a stable one-line layout
The Chat composer SHALL place context usage, one configuration trigger, routine status, and the Send/Cancel action in a deliberate non-wrapping action rail. The configuration trigger SHALL take the flexible space and truncate its visible label when necessary. Routine status and the trailing action SHALL keep fixed footprints, and routine lifecycle changes MUST NOT move either control or reorder the rail. Deliberate panel resizing can change the flexible label width but MUST NOT make individual controls jump between rows.

Actionable failures SHALL remain visible as explanatory text outside the routine status footprint. Displaying or dismissing that text can change composer height but MUST NOT horizontally reorder the action rail. Textarea autosizing remains independent of action-rail stability.

#### Scenario: Routine lifecycle keeps trailing controls stationary
- **WHEN** a prompt moves through ready, sending, working, cancelling, and ready states at an unchanged Chat-panel width
- **THEN** the routine status and Send/Cancel controls retain their dimensions and positions
- **AND** the configuration trigger remains on the same row

#### Scenario: Narrow desktop panel truncates configuration
- **WHEN** the desktop Chat panel narrows while remaining open
- **THEN** the configuration trigger label truncates to the available width
- **AND** context, status, and Send/Cancel remain on one action row

#### Scenario: Context usage does not displace the trailing action
- **WHEN** context usage becomes available or its displayed value changes
- **THEN** it does not move the routine status or Send/Cancel action
- **AND** it does not create another action row

#### Scenario: Failure remains explanatory
- **WHEN** sending, cancellation, or the active turn fails
- **THEN** Chat displays explanatory failure text
- **AND** the action rail keeps its horizontal ordering

### Requirement: Chat configuration uses one adaptive searchable picker
Chat SHALL expose model, mode, and reasoning configuration through one configuration trigger rather than separate composer controls. The trigger SHALL summarize the displayed model when model selection is supported and SHALL have an accessible name that identifies every displayed configuration value. A capability the active agent does not declare MUST be absent from both the trigger summary and picker.

The picker SHALL use one interaction layer. On desktop it SHALL remain constrained to the Chat panel and appear in relation to the trigger. In touch mode it SHALL appear as a bottom sheet sized to the current visual viewport above global Chat navigation. It MUST NOT open a second nested sheet for model selection.

Model search SHALL operate on the already available model inventory and match case-insensitively across model name, provider name, provider identifier, and model identifier. Results SHALL identify the human-readable model first, show provider and provider/model identifiers as secondary information, group available models by provider, expose a result count, and distinguish the displayed selection without relying on colour alone. Empty groups SHALL disappear when filtering, and an empty result SHALL be stated explicitly.

Choosing model, mode, or reasoning SHALL update the displayed staged configuration immediately and SHALL preserve the existing rule that staged values travel with the next prompt. An unavailable effective value SHALL remain identifiable but MUST NOT be offered as a newly selectable value. Where no explicit model override exists, the picker SHALL describe the agent-controlled choice without claiming a model Uatu does not know.

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
Each fenced code block inside completed assistant content SHALL offer an accessible copy action that writes only the code content with its source line breaks, excluding syntax markup, fence delimiters, and controls. Completed assistant messages MUST NOT present a whole-answer copy action.

Code-block copy controls SHALL be keyboard operable and directly reachable on coarse-pointer devices. Success and failure feedback SHALL be perceivable without resizing the message, code block, or composer. Clipboard failure MUST leave conversation content unchanged and MUST NOT produce an uncaught error.

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
