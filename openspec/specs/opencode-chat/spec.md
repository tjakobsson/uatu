# opencode-chat Specification

## Purpose
Define workspace-scoped OpenCode conversations and the responsive web chat surface through which authenticated users can inspect, direct, interrupt, and resume coding-agent work.

## Requirements

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

### Requirement: Conversation updates are structured and reconnectable
The server SHALL normalize OpenCode activity into ordered conversation events covering user and assistant content, reasoning, tool lifecycle, permission requests and resolutions, structured questions and resolutions, context compaction, reverted work, turn status, cancellation, completion, warnings, and errors. Normalization SHALL recognize each of these regardless of which of OpenCode's event-naming generations announced it, and when one logical occurrence is announced more than once the timeline SHALL contain a single entry for it.

Changes to a conversation's held-message queue — a message held, a message removed, a message delivered to the agent — SHALL be announced on the same ordered event stream, so every connected client presents the same queue at the same point in the conversation.

An event the server does not recognize, or whose payload it cannot parse, SHALL be skipped without ending or restarting the event stream, and SHALL be counted by type so an operator can discover what a running workspace is discarding. Counting MUST NOT record event payloads.

A history snapshot SHALL identify a stream cursor; reconnecting from a retained cursor SHALL replay every later event in order before delivering live events. If the cursor is no longer replayable or belongs to an earlier server generation, the server SHALL explicitly require a fresh snapshot. Applying a snapshot followed by its event stream MUST NOT duplicate message content or tool entries.

#### Scenario: Stream reconnect replays missed output
- **WHEN** the event connection drops during an assistant response and reconnects with a retained cursor
- **THEN** every event after that cursor is replayed once in order before live output continues

#### Scenario: Queue changes reach every connected client
- **WHEN** a message is held, removed, or delivered while more than one client watches the conversation
- **THEN** each client receives the change on the ordered event stream
- **AND** all clients present the same held messages in the same order

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
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. Every activity row SHALL name what it acted on where the agent reported it, including a shell command's command line, a file operation's path, and a search's pattern, so a row and any group summary it joins are legible without being opened. While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, and its elapsed time SHALL be shown where the agent reports progress without output, so long-running activity shows progress. A finished non-shell tool's output SHALL retain its summary and bounded preview with a way to see the rest. Shell tools and normalized command items SHALL instead present a summary and one bounded-height scrollback viewport containing all available provider-supplied output, while running and after completion. Earlier shell output SHALL be reachable by scrolling rather than a separate preview or "Show more lines" disclosure. A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

While a turn is running, the trailing run of activity SHALL be collapsed behind a single working line rather than rendered as flat rows. The line SHALL carry a live indicator, the elapsed time of the turn, and the step currently in flight, and SHALL be present from the moment the prompt is accepted, before any step has arrived, so the same line carries the turn from waiting to done. Opening the working line SHALL reveal its member rows with their live state, and a running member with output SHALL still open itself so its output viewport is visible. Shell output SHALL initially follow the bottom and respect subsequent reader scrolling. A working line the reader opened SHALL remain open when the turn finishes and the line settles into the finished group summary. Popping out or resizing shell output SHALL count as the reader opening both the output and its containing activity group. That output and group SHALL remain open on completion or failure. A group line SHALL carry a status indicator, live while its turn runs, neutral when every member finished cleanly, and failed when any member failed. A failed outcome MUST NOT rely on colour alone. The line SHALL also state in words that a step failed, in text that is visible and part of the line's accessible name, without the group being opened. The live indicator's motion SHALL honour the reader's reduced-motion preference.

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

### Requirement: Shell output reads as the terminal would render it
Where a tool's output carries terminal escape sequences, Chat SHALL interpret them rather than show them. Select-graphic-rendition styling, including the 16 standard colours, 256-colour and truecolour foreground and background, bold, dim, italic, underline, inverse, and strikethrough, SHALL be rendered as styling. Carriage-return overwrites and erase-line sequences SHALL be applied so a line that was rewritten in place shows only its final content, and any other control sequence SHALL be removed from the shown text. Interpreting escapes MUST NOT create active markup or script execution, whatever the sequences or the text around them contain.

A shell command's output block SHALL be presented with the embedded terminal's background, foreground, 16-colour palette, and font, so the same bytes read the same in Chat and in the terminal pane. The palette SHALL be the one central set of terminal colour variables, not a second copy. Lines in a shell output block SHALL NOT be broken mid-token. A line longer than the block SHALL scroll horizontally, as it would in the terminal.

Shell scrollback SHALL operate on the lines as rendered after overwrites are applied, so a progress bar that rewrote one line many times counts as one line, not as many. The viewport SHALL retain all available provider-supplied output for the item during its retained view lifetime, without a client-side preview or tail limit discarding earlier output. This contract SHALL apply to shell tools and normalized command items in both parent and subagent conversations, while running and after completion or failure. It SHALL NOT require recovery of output truncated upstream by the provider. Non-shell output SHALL retain its existing preview behavior.

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
Each shell tool and normalized command item's output in a parent or subagent conversation SHALL offer inline height adjustment through both pointer and keyboard controls. The resize control SHALL be focusable, have an accessible name, expose its current size and bounds, and show visible keyboard focus. Applied inline height SHALL be finite and clamped between a usable minimum and the available layout height. A layout smaller than the preferred minimum SHALL take precedence so output cannot force controls outside the available area. The reader's chosen inline height SHALL be retained while output is popped out and restored on return inline, subject to those bounds.

On desktop, an accessible Pop out control SHALL move the same output into one nonmodal in-app floating window. The reader SHALL be able to drag the window and resize its width and height, with keyboard equivalents for movement and both resize dimensions. Its bounds SHALL be the UatuCode work area, not the Chat column, panel, or transcript area. The window SHALL be able to exceed the Chat width while keeping its controls reachable within the work area. Uncovered parts of the app SHALL remain usable without dismissing the window. Pop out MUST NOT open a separate browser window or use browser fullscreen.

Maximize SHALL fill the UatuCode work area. Restore size SHALL return a maximized window to its previous floating position and dimensions, clamped only as needed to fit the current work area. In touch mode, Pop out SHALL present a full-area output view within the UatuCode work area instead of floating drag and resize interactions. Maximized and touch full-area output MAY cover Preview, the composer, and request controls, but controls to return to chat SHALL remain reachable. Covered app controls MUST NOT receive keyboard focus while covered.

Each Chat surface SHALL have at most one popped-out shell output across its parent and child transcripts. Popping out another item SHALL return the previous item inline with its reading state retained before opening the selected item. Return to chat and Escape from the output SHALL return it directly inline, including from maximized or touch full-area presentation. They SHALL restore focus to the invoking control when available or a logical control for the same item without stealing the current outer reading anchor. Escape handled by output MUST NOT also close the subagent transcript. Pop out SHALL place keyboard focus within the output controls. All controls SHALL have accessible names and visible focus, and keyboard movement and resize controls SHALL expose their current values and bounds.

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
Popped-out output SHALL remain bound to the specific immutable conversation and item identity selected by the reader. It SHALL show the command, conversation label, and provider-reported running, completed, failed, or cancelled status. It SHALL show the provider's completion time when known and MUST NOT fabricate a completion time when unknown. Disconnection MUST NOT be presented as completion. Completion, failure, cancellation, activity regrouping, and later commands SHALL NOT dismiss the output or automatically switch it to another item. Output and status updates SHALL continue to apply only to its owning item.

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
Shell reading state SHALL belong to the local client's immutable conversation and item identity during the retained view lifetime. It SHALL include the output's horizontal position, vertical reading anchor and offset, chosen inline height, follow state, reader-opened status, and floating position and dimensions. These values SHALL survive output updates, moves between inline and popped-out views, Maximize, Restore size, desktop/touch presentation changes, and command lifecycle changes, subject to available content and layout bounds. Temporary maximized or touch full-area geometry MUST NOT overwrite the retained floating bounds. Updates to other items or conversations MUST NOT overwrite this state. This contract SHALL NOT require persistence across reloads.

Explicitly switching the selected conversation SHALL close any popped-out shell output and release its old focus, movement, resize, and keyboard ownership so it cannot act on the new conversation. Leaving or closing a child transcript SHALL likewise release output owned by that child. Removing the owning item or disposing its view SHALL close its output and release those interactions. Popped-out output SHALL NOT remain pinned across conversations. Retained per-item reading state SHALL remain scoped to its owning conversation if it survives navigation, and returning SHALL NOT automatically reopen the prior popped-out view. A newly created view without retained state SHALL start with the default bounded inline height and bottom following.

Hiding Chat without changing the selected conversation SHALL hide its output window and defer output painting under the existing hidden-Chat behavior. Returning to the same retained Chat view SHALL restore the window's presentation and reconcile its owning item's latest output and status. It SHALL NOT display an independent output inspector over another active app tab.

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
The activity chrome — the working line while a turn runs, a finished group's summary line, each member row's label and subject, and the rule and neutral dot that tie a group's members together — SHALL use a colour that is visibly stronger than the surface's secondary-label colour and visibly quieter than assistant prose, in both the light and the dark theme, so steps are readable and told apart from each other and from the answer without being the answer's equal. Status words and outcome indicators (running, failed) keep their own colours.

#### Scenario: Steps are readable in light and dark
- **WHEN** a turn has produced a working line with several member rows, in either theme
- **THEN** the line and its rows meet at least the contrast the surface's body text meets against the same background
- **AND** they remain distinguishable from the assistant prose around them

#### Scenario: Chrome stays quieter than the answer
- **WHEN** a finished group sits between two assistant messages
- **THEN** the group's summary and rows read as secondary to the messages
- **AND** a failed step's status is still shown in the failure colour

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting. Where a permission would change a file, the request SHALL show what it would change — the pending diff — where the choice is made, so the user sees the change before allowing it. A permission with nothing to show a diff for is unaffected. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form. Submitting a response more than once MUST NOT produce multiple provider replies.

A request raised by a subagent SHALL additionally appear in the conversation that launched that subagent, and SHALL be answerable there. The subagent's own conversation remains the single owner of the request: an answer given from the launching conversation SHALL be directed to the owning conversation, so exactly one response reaches OpenCode however many places the request was shown. Resolving it SHALL resolve it everywhere it appears.

When a subagent-owned request appears outside its owning transcript, the request SHALL identify the specific launching subagent from the best available structured attribution and SHALL offer direct navigation to the owning transcript. If the specific attribution has not arrived or cannot be resolved, the request MUST use a truthful generic subagent label rather than inventing an identity, while retaining transcript navigation whenever the agent supports subagent transcripts. The origin and transcript control SHALL remain available after resolution so the decision can be audited. A conversation's own requests MUST NOT be labeled as coming from a subagent.

Only the active unresolved request of a given conversation MAY accept a response. Where requests from more than one conversation are shown together, they SHALL each be governed by the conversation that owns them, so a request awaiting a user in one conversation does not block answering a request owned by another.

A request's state SHALL be distinguishable without reading its body — whether it awaits the user now, awaits its turn behind another request of the same conversation, or is resolved. That distinction MUST NOT rely on colour alone. A request awaiting its turn MUST NOT be presented as obsolete, superseded, or otherwise not needing an answer, because it will require one.

The surface SHALL report how many requests are outstanding across everything it is showing, and SHALL offer a way to reach an outstanding request without hunting for it.

A choice that grants authority beyond the request being answered SHALL state the scope and lifetime of that authority where the choice is offered, so a user learns what they are granting before granting it rather than afterwards. In particular, OpenCode's persistent approval carries past the answered request into later conversations served by the same OpenCode instance and covers the request's saved pattern rather than only the resource displayed, and it is lost when that instance restarts. It MUST NOT be presented as limited to the current conversation, nor as permanent, nor as outliving the OpenCode instance that granted it.

Choosing the persistent approval SHALL NOT send a reply. It SHALL open a confirmation step on the same request that lists the future-approval patterns OpenCode supplied for that request, the patterns its persistent reply installs, verbatim and apart from the request's own resources, so the user can see where the two differ. The surface MUST NOT derive or shorten a pattern from the displayed command; a request whose patterns are unknown SHALL say so rather than present the command as the scope. The patterns SHALL be carried on the request wherever it is shown, including a request recovered from OpenCode's pending set after its live announcement was missed.

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

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable

### Requirement: Chat supports reversible conversation undo and redo
When the connected agent declares reversible-history support, Chat SHALL offer local `/undo` and `/redo` commands that operate on the selected conversation and MUST NOT send those command strings as ordinary prompts or provider-defined slash commands. Each visible user turn in the main transcript SHALL also offer a direct Revert message action. Undo SHALL stage the previous visible user turn as the conversation's revert boundary; direct Revert SHALL stage the selected visible user turn in one boundary mutation rather than repeated Undo mutations. Both SHALL hide the boundary turn and all later work from the current transcript and restore affected workspace files through the agent's revert operation. The invoking client SHALL receive the boundary turn's non-synthetic prompt text and any still-available attachments as an editable composer draft; other clients' private drafts MUST NOT be overwritten.

If work is running, Undo SHALL interrupt it before changing the boundary. Messages queued behind that work MUST NOT be admitted between interruption and the completed revert. Existing queued messages SHALL remain visible and removable but paused while a revert is staged; they SHALL resume only after Redo clears the revert or after the user submits a replacement prompt, with that replacement admitted before the older queue resumes.

Repeated Undo SHALL move the boundary backward one visible user turn at a time. While a boundary is staged, Chat SHALL list the hidden user turns from the boundary onward and offer a Restore message action for each. Redo SHALL move forward one hidden user turn at a time. Restoring a selected hidden turn SHALL make history current through that turn in one mutation by staging the following hidden user turn, or SHALL clear the boundary when the selected turn is newest. The invoking client's composer SHALL receive the next boundary turn when one remains and SHALL clear when the original transcript is fully restored. Submitting a replacement prompt while a revert is staged SHALL commit the reverted history before starting the replacement turn, after which the hidden turns can no longer be restored by Redo or Restore.

Every successful boundary change SHALL reconcile the authoritative conversation so all connected clients agree on visible history and workspace state. Mutation retries MUST be idempotent. If interruption or the requested boundary change fails, Chat SHALL report the failure and MUST NOT claim that history or files changed.

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
- **WHEN** Undo succeeds while messages are queued
- **THEN** the queued messages remain visible and removable
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
- **AND** the replacement is admitted before previously queued messages resume
- **AND** Redo no longer restores the discarded branch

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

### Requirement: Timeline position remains stable under streaming and navigation
The Chat timeline SHALL remain pinned to the latest content only while the user is at or near its end. Once the user scrolls away, streaming, tool updates, image or code layout, and activity expansion MUST NOT steal the reading position; an accessible latest-content affordance SHALL indicate unseen updates and return to the end. Prepending older history SHALL preserve the same visible content and offset. Opening a conversation SHALL restore that client's last reading position when possible, otherwise it SHALL open at the latest turn.

Each shell viewport SHALL have a follow state independent of the outer timeline and other shell items. It SHALL initially follow the bottom. Any upward reader scroll SHALL stop following, including a movement smaller than a near-bottom threshold. Returning to the bottom or activating the viewport's accessible latest-output control SHALL resume following. Incoming output while following SHALL keep the bottom visible without resetting the horizontal offset. While following is paused, incoming output SHALL preserve the visible rendered content and its vertical offset, and the latest-output control SHALL indicate unseen output.

Output updates, layout resize, inline height adjustment, Pop out, Maximize, Restore size, Return to chat, changes between desktop and touch presentation, and completion or failure SHALL preserve the shell item's horizontal position, vertical reading anchor, chosen inline height, and follow state. Position and applied size SHALL be clamped only where the available content or layout cannot accommodate them. A layout change that clamps position to the bottom MUST NOT itself resume paused following. Resizing or popping out shell output SHALL preserve the outer timeline's reading anchor, and returning inline SHALL preserve its current reading anchor, including any deliberate outer scrolling while the nonmodal window was open. Shell scrolling and its latest-output control MUST NOT independently move the outer timeline to its end. Long shell output SHALL preserve long-chat responsiveness, text selection, copying, and find over available rendered output.

Following SHALL be stable in both parent and child outer timelines and in each shell output viewport, whether inline or popped out. While following during passive append-only updates, automatic movement MUST NOT alternate upward and downward when the scroll extent is not shrinking. Activating the relevant latest-content or latest-output control during streaming SHALL settle at the current bottom and continue following without oscillation between smooth movement and snapping. Any upward manual scroll SHALL interrupt automatic movement immediately and pause following, even during movement initiated by a latest control. Resize effects and programmatic scroll echoes MUST NOT change the reader's follow intent. A shrinking layout or content extent MAY cause a legitimate position clamp without being treated as follow jitter or resuming paused following.

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

The context report SHALL be legible without the user opening anything, and MAY expand to the breakdown the agent reports — input, cache, and output, or the agent's own categories when it reports them. It reports the live window fill after the latest model call, not lifetime spend and not a sum over a turn, and SHALL be populated when an existing conversation is opened, not only after a new turn is taken. When the agent reports that it compacted the conversation, the fill SHALL follow the post-compaction figure. Where the agent reports plan utilization, the readout MAY present it alongside the fill, distinct from it.

A subagent's attribution SHALL reflect the subagent's own session — a subagent may run a different model from its parent — and SHALL state the tokens that subagent consumed, aggregated from its child session onto the launching conversation. The model MAY be shown before any usage is known. When the agent has not reported usage for a subagent, the row SHALL stay readable and SHALL NOT assert a figure it does not have.

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

#### Scenario: A subagent without reported usage stays readable
- **WHEN** a subagent has not yet reported usage, or the agent does not report it
- **THEN** the row still names the subagent and its status
- **AND** no token figure is asserted for it

#### Scenario: An undeclared context capability leaves nothing behind
- **WHEN** the agent does not declare the context capability
- **THEN** the context indicator and the subagent token figure are absent
- **AND** the capabilities the agent does declare are unaffected

### Requirement: Chat reports what an OpenCode conversation has cost
Where OpenCode reports a cost for an assistant message, Chat SHALL present the conversation's accumulated cost in the same place and form a Claude Code conversation's session totals appear: the composer's usage chip reads the conversation's cost when the agent reports no plan windows, and the usage readout's conversation block states the total and a per-model breakdown of tokens and cost. The figure SHALL be the sum of the cost OpenCode reported per assistant message, in the currency OpenCode reports it, counted once per message however many times the message was restated while it streamed.

The cost SHALL be populated when an existing conversation is opened, from its stored history, not only after a new turn is taken; it SHALL NOT be qualified as "since" a later time, because the stored history carries every message's cost. When every message in the conversation reports a cost of zero — a model OpenCode has no price for — Chat SHALL show no cost rather than a zero figure. A message for which OpenCode reports no cost contributes nothing and SHALL NOT be presented as zero.

The cost SHALL be attributed per agent as well as per model. The conversation block SHALL list the main agent's own spend and one row per subagent — labelled by the subagent's kind and description, with the model it ran, its tokens, and its cost — and the total, the chip's figure, and the per-model rows SHALL count subagent work, so the figure presented is what the whole conversation cost. A subagent's timeline row and the header of its opened transcript SHALL state the subagent's cost in context. A subagent whose child session reported no cost SHALL be listed without a figure, not with zero.

#### Scenario: The chip reads the conversation's cost
- **WHEN** an OpenCode conversation has exchanged turns and OpenCode reported a cost for its assistant messages
- **THEN** the composer's usage chip reads the accumulated cost as "this conversation"
- **AND** opening the readout shows the total and one row per model with that model's tokens and cost

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
- **THEN** the conversation block lists the main agent's own spend and one row per subagent with its label, model, tokens, and cost
- **AND** the chip's figure and the model row for that model include the subagents' spend

#### Scenario: A subagent row states its cost in context
- **WHEN** a subagent's child session reported cost with its tokens
- **THEN** the subagent's timeline row states that cost
- **AND** opening the subagent's transcript shows the same cost in its header

#### Scenario: An unpriced subagent is listed without a figure
- **WHEN** a subagent's child session reported tokens but no cost
- **THEN** its row in the conversation block names it and its tokens and asserts no cost

#### Scenario: Cost rides the usage wire
- **WHEN** a client validates a conversation snapshot or update carrying a usage record with a cost
- **THEN** the record is accepted under the workspace API revision that introduced it

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

### Requirement: Users can prompt, queue, and cancel the active conversation
The Chat composer SHALL submit a message with content — non-empty text, at least one image attachment, or both — to the selected conversation and clearly distinguish ready, sending, running, interrupted, and failed states. A prompt submitted while the conversation is running SHALL be held in a workspace-owned queue rather than delivered to the agent mid-turn. Held messages SHALL be presented adjacent to the composer, in submission order, visibly marked as queued, and SHALL NOT appear as part of the running turn's timeline. While the agent continues to stream output, held messages SHALL remain adjacent to the composer rather than drifting into the transcript. The queue SHALL be bounded per conversation; a submission that would exceed the bound SHALL be refused without altering the held messages, with the draft preserved.

When the running turn ends on its own, the workspace SHALL deliver held messages to the agent one at a time in submission order; a delivered message SHALL leave the queue presentation and begin its own turn at the end of the timeline. The user SHALL be able to remove any message that is still held; a removed message is never delivered. Removal of a message that has already been delivered SHALL be refused without altering the conversation.

The user SHALL be able to cancel an active turn without deleting its completed history. Cancellation SHALL NOT deliver held messages: they remain queued, removable, and visible, and the queue stays dormant until the user next submits a prompt, which joins the end of the queue and resumes delivery from its head. Transport failure SHALL preserve the draft until acceptance is known.

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
- **WHEN** the user submits a prompt while the selected conversation is running
- **THEN** the message is held by the workspace rather than delivered to the agent
- **AND** it is presented adjacent to the composer, marked as queued

#### Scenario: Queued messages stay with the composer while output streams
- **WHEN** the agent continues streaming output after messages were queued
- **THEN** the held messages remain adjacent to the composer
- **AND** no held message appears between items of the running turn

#### Scenario: A queued message is delivered when the turn ends
- **WHEN** the running turn completes on its own while messages are held
- **THEN** the workspace delivers the oldest held message to the agent
- **AND** it leaves the queue presentation and starts its own turn at the end of the timeline

#### Scenario: A queued message can be removed
- **WHEN** the user removes a message that is still held
- **THEN** it disappears from the queue on every client
- **AND** it is never delivered to the agent

#### Scenario: A full queue refuses further submissions
- **WHEN** a conversation's held queue is at its bound and the user submits another prompt while the agent works
- **THEN** the submission is refused and the draft is preserved
- **AND** the messages already held are unaffected

#### Scenario: Removing an already-delivered message is refused
- **WHEN** a removal arrives for a message the workspace has already delivered to the agent
- **THEN** the removal is refused without altering the conversation
- **AND** the client learns the message is no longer held

#### Scenario: Cancellation preserves completed content
- **WHEN** the user cancels a running turn
- **THEN** OpenCode is asked to abort that turn
- **AND** content and tool activity already received remain in the timeline with an interrupted outcome

#### Scenario: Cancellation leaves the queue dormant
- **WHEN** the user cancels a running turn while messages are held
- **THEN** the held messages remain queued, visible, and removable
- **AND** none of them is delivered as a consequence of the cancellation

#### Scenario: A new submission resumes a dormant queue
- **WHEN** the user submits a prompt while the conversation is idle and messages are held from before a cancellation
- **THEN** the new message joins the end of the queue
- **AND** delivery resumes from the head of the queue in submission order

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
The Chat composer SHALL accept image attachments in the image formats the
agent supports (PNG, JPEG, GIF, WebP) through three intakes: pasting from the
clipboard, dragging onto the composer, and an explicit attach control backed
by a file picker. The attach control SHALL be visible without hover or
keyboard affordances, so touch-only devices can attach images. Pending
attachments SHALL be presented at the composer as thumbnails, each removable
before send, and SHALL be submitted with the composer text as one message.
Text is not a precondition: a message with attachments and no text SHALL be
submittable, because the agent accepts image-only prompts.

A paste that carries both text and images SHALL keep both: the text enters
the composer and the images become pending attachments. Files of an
unsupported type SHALL be refused with a visible explanation, without
altering the draft text or the attachments already pending. The number of
attachments per message and the size per attachment SHALL be bounded;
an intake that would exceed a bound SHALL be refused with a visible
explanation, leaving the draft and already-pending attachments unchanged.

The attach intakes SHALL be presented only when the agent declares the
capability behind them, consistent with the existing capability-gating rule.
When the agent declares the capability but the selected model does not
report image input support, the attach control SHALL remain visible but
inactive with an explanation naming the model as the reason, because
switching models changes the answer and a hidden control would make that
change undiscoverable.

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
An attached image SHALL be transferred from the client to the workspace once,
at attach time, and referenced by an opaque identifier thereafter. Prompt
submissions, queued messages, conversation projections, and the event stream
SHALL carry attachment references, never image bytes. Stored attachments
SHALL live outside every watched root, so the file watcher, the repository
change sweep, and the ignore engine never observe them.

Serving a stored attachment SHALL require the same authorization as the
conversation API, and SHALL resolve only identifiers the workspace itself
issued: a request whose identifier does not match an issued attachment SHALL
be refused without filesystem interpretation of the identifier. An upload
that exceeds the size bound or carries an unsupported type SHALL be refused
with a client-visible reason.

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
When a message with attachments is dispatched, the workspace SHALL deliver
the stored images to the agent as attachments of that prompt, in the form the
agent's own interface defines, alongside the message text. Image scaling and
model-format concerns SHALL be left to the agent, which owns them. If the
agent refuses the prompt, the outcome SHALL be reported through the existing
failure presentation, and the message — text and attachments — SHALL be
restorable to the composer as the existing failure path provides for text.

#### Scenario: Attachments accompany the dispatched prompt
- **WHEN** a message with attachments is delivered to the agent
- **THEN** the agent receives the images as prompt attachments together with the text
- **AND** uatu performs no image re-encoding of its own

#### Scenario: Agent refusal is surfaced like any prompt failure
- **WHEN** the agent refuses a prompt that carries attachments
- **THEN** the failure is presented through the existing prompt-failure path
- **AND** the draft, including its attachments, is restored to the composer

### Requirement: Attached images render in the conversation and survive replay
A user message with attachments SHALL present its images as thumbnails with
the message text, in the timeline, in the optimistic draft presentation, and
in the queue presentation. The presentation SHALL come from the workspace's
own attachment serving, and SHALL remain correct after a reload or
reconnection replays the conversation from the agent's stored history.
Attachment names SHALL be treated as hostile input and rendered inert. An
attachment whose stored bytes are no longer available SHALL degrade to a
labeled placeholder rather than a broken presentation.

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
A message submitted with attachments while the conversation is running SHALL
be held with its attachments, per the existing queue behavior: the queue
presentation SHALL show the message's thumbnails, removal of a held message
SHALL discard the message together with its attachment references, and
delivery SHALL carry the attachments exactly as submitted. Switching the
composer's model after a message is held SHALL NOT alter the held message's
attachments: held messages deliver under their frozen configuration.

#### Scenario: A queued message shows its thumbnails
- **WHEN** a message with attachments is held while the agent works
- **THEN** the queue presentation shows the message with its image thumbnails

#### Scenario: Removing a held message discards its attachments
- **WHEN** the user removes a held message that has attachments
- **THEN** the message and its attachment references leave the queue on every client
- **AND** the message is never delivered

#### Scenario: A held message delivers with its attachments
- **WHEN** the running turn ends and a held message with attachments is delivered
- **THEN** the agent receives the message text and its attachments under the configuration frozen at submission

### Requirement: Timeline order follows the conversation's message order
The Chat timeline SHALL present items in the conversation's own order — parent messages in their provider-assigned order, and within a message, parts in the order the provider delivers them — regardless of the order in which updates arrived. An update belonging to an earlier message MUST NOT render after items of a later message. A client that applied a conversation's events live SHALL present the same cross-message order as a client that loaded the same conversation from a fresh snapshot. Within one message, live events carry no provider position, so parts the provider itself delivered out of order remain in delivery order until the next snapshot load.

#### Scenario: A late update for an earlier message keeps its place
- **WHEN** an update arrives for a message that precedes items already shown
- **THEN** the item renders in its parent message's position
- **AND** it does not appear at the end of the timeline

#### Scenario: Live and reloaded timelines agree
- **WHEN** one client watched a conversation stream live and another loads it fresh
- **THEN** both present the same messages and their items in the same cross-message order

### Requirement: Conversation inventory stays current across clients
The authenticated workspace Chat API SHALL provide a live indication when the authoritative set or displayed metadata of top-level conversations in the selected workspace may have changed. A connected Chat client SHALL reconcile that indication against the authoritative conversation list without requiring a page reload. Inventory synchronization MUST remain confined to the server-selected workspace directory and MUST continue to exclude subagent child sessions.

Inventory synchronization SHALL recover after transport interruption, provider-event interruption, and restoration of a suspended page by reconciling the authoritative list. Repeated or duplicated lifecycle indications MUST converge without duplicating conversations. A synchronization failure MUST leave the current conversation usable and SHALL be retried on a later lifecycle indication, reconnection, Chat activation, or page resume.

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
After a client establishes its initial conversation inventory, each top-level conversation first discovered by a later reconciliation SHALL be marked unseen on that client unless that client explicitly created and selected it. Chat SHALL expose the unseen count beside the conversation chooser while Chat is visible and SHALL expose an attention indicator on the touch Chat tab or collapsed desktop Chat affordance while Chat is hidden. These indicators MUST NOT move focus, open Chat, or change the selected conversation.

Merely revealing Chat SHALL NOT acknowledge unseen conversations because the additional chooser options remain undisclosed. Activating the visible unseen indicator, activating the conversation chooser, or explicitly selecting an unseen conversation SHALL acknowledge the current unseen set. Removed conversations SHALL cease contributing to the unseen count. The initial inventory established during page bootstrap SHALL be the baseline and SHALL NOT be reported as unseen.

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
Where an agent declares that it can run work in the background, Chat SHALL present live background tasks as a state of the conversation distinct from working and idle: the composer status SHALL name how many tasks run, a list SHALL name each task with its description and progress where reported, each SHALL offer a stop action, and a settled task SHALL appear in the timeline as a row with its outcome and summary. The state SHALL be populated when an existing conversation with live background work is opened, and SHALL clear when the agent reports no live tasks. An agent that does not declare the capability SHALL show none of it.

#### Scenario: Background tasks are listed while they run
- **WHEN** a conversation's agent reports one or more live background tasks
- **THEN** the composer status names the count
- **AND** each task is listed with a stop action

#### Scenario: A settled task lands in the timeline
- **WHEN** a background task completes, fails, or is stopped
- **THEN** a timeline row records the outcome and the agent's summary
- **AND** the task leaves the live list

#### Scenario: A reopened conversation shows its live work
- **WHEN** the user opens a conversation whose agent still reports live background tasks
- **THEN** the background-work state is shown from that report

### Requirement: Persistent-approval scope copy is the owning agent's
When a permission card offers an approval that outlives the request, the sentence stating what that approval covers SHALL describe the owning agent's actual persistence semantics and SHALL name only that agent. Two agents with different semantics SHALL have different sentences.

Choosing that approval SHALL open a confirmation step on the card rather than reply. The confirmation SHALL name the action being authorized, list each future-approval pattern the owning agent supplied, verbatim and in that agent's own syntax, visibly apart from the request's own resources, and state the approval's lifetime in the owning agent's terms. The list SHALL be what the agent supplied; the surface MUST NOT derive it from the displayed request. When the agent supplied a single wildcard covering the whole permission, the confirmation SHALL state that every request of that action will be allowed, naming the action. When the agent supplied no reusable pattern, the confirmation SHALL state that confirming covers only this request. The confirmation SHALL offer explicit Confirm and Cancel choices; only Confirm SHALL send the persistent reply, once. Cancel, and Escape while the confirmation has keyboard focus, SHALL return the card to its pending choices without sending any reply and without changing the request's state. When the confirmation opens, keyboard focus SHALL move into it. If the request resolves while the confirmation is open, the card SHALL recede as a resolved request does. The single-occurrence approval, rejection, and agent-provided approval intents SHALL be unaffected.

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
The conversation and inventory event streams SHALL maintain transport liveness during normal idle periods and SHALL reconnect with bounded backoff after interruption. Opening a replacement stream MUST count as successful transport recovery even when no application event is immediately available: it SHALL reset consecutive-failure accounting and clear only the connection-interruption status owned by that stream. Keepalives MUST NOT appear as conversation or inventory events and MUST NOT alter projections, unread state, or timeline content.

The Chat surface MUST NOT continue to claim that it is reconnecting after its replacement stream has opened successfully. A later independent interruption MAY be reported normally. Resuming a suspended page or restoring network connectivity SHALL trigger authoritative inventory reconciliation and ensure the selected conversation's stream is current without discarding drafts, timeline position, or already received content.

A hidden page SHALL NOT permanently close the Chat surface. Chat MAY release its streams whenever the page is hidden, however the browser announces it, and MUST continue to save drafts on that signal, but it MUST remain able to resubscribe so that returning to a still-running page restores conversation and inventory delivery. Chat MUST NOT stay closed for the life of a document that is still running.

While Chat reports a connection interruption, it SHALL offer the user an action that attempts recovery, so a stalled surface is never a dead end on a device with no browser reload control. That action MUST NOT discard drafts, timeline position, or content already received when recovery succeeds in place.

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
When a session is served through the hub, a selected conversation's ordered events — and an open subagent transcript's — SHALL be delivered as `conversation` topics of the hub's brokered live stream, subscribed and unsubscribed on the open connection as the selection changes. The cursor and resync semantics of conversation updates SHALL hold per topic: a retained cursor replays later events once in order, and a non-replayable cursor requires a fresh snapshot for that conversation only. Selecting a conversation MUST NOT open an additional HTTP connection, and the reconnect-status ownership rules for the chat surface SHALL apply to the brokered stream: a successful open clears only the chat surface's connection-interruption status.

#### Scenario: Switching conversations reuses the connection
- **WHEN** a user selects a different conversation on a hub-served page
- **THEN** the previous conversation's topic is unsubscribed and the new one subscribed from its snapshot cursor
- **AND** no HTTP connection is opened or closed

#### Scenario: A subagent drill-down is one more topic
- **WHEN** a user opens a subagent transcript from the parent conversation
- **THEN** the transcript's events arrive as a second conversation topic on the same stream
- **AND** closing it unsubscribes that topic and leaves the parent's subscription intact

### Requirement: OpenCode history reuse preserves authoritative pagination

Repeated paging through a verified unchanged OpenCode conversation within the documented reuse limits SHALL avoid a complete provider-history traversal for each page. Reusable history SHALL be bounded in memory and isolated by workspace and conversation. Eviction or a history larger than those limits SHALL fall back to authoritative reads without losing content. Native provider history remains authoritative: content edits, new messages, undo, redo, revert, restore, deletion, and replay gaps SHALL invalidate or reconcile affected reusable state before it is represented as current. When freshness cannot be established, the system SHALL perform authoritative reconciliation rather than return an unverified history snapshot as current.

History optimization MUST preserve the existing merge of supported provider stores, normalized ordering, accounting, child attribution, and the snapshot-to-stream boundary. Older-page cursors SHALL either deliver correctly ordered, nonduplicated history or explicitly require a fresh snapshot when no longer applicable.

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

When Chat bootstrap receives an empty conversation inventory and this client has a remembered conversation selection that has not been superseded by a user action, Chat SHALL retain the intent to restore that exact conversation. If a later successful inventory includes it, Chat SHALL open its history and resume its live updates without requiring a page reload, a manual conversation switch, or a new conversation. After the read succeeds, its saved draft SHALL be restored and its composer SHALL obey the normal conversation controls rather than remaining disabled because restoration was skipped.

Deferred restoration SHALL be attempted only once per bootstrap intent. Repeated inventory updates before or after the attempt SHALL NOT duplicate the opening read or live subscription. A failed opening read SHALL expose the normal actionable read error and explicit retry; inventory updates alone SHALL NOT automatically retry that failed read.

An explicit conversation selection or a user-confirmed new-conversation action SHALL supersede deferred restoration. This precedence SHALL apply while creation is in flight and SHALL remain in effect if creation fails. Dismissing the agent-choice menu without choosing an agent SHALL NOT count as a confirmed creation action. A delayed result from an obsolete opening read SHALL NOT replace a subsequently selected conversation.

While restoration is pending, repeated inventories that omit the remembered conversation SHALL NOT turn that pending intent into a deletion-recovery attempt or select an unrelated conversation. Without a remembered selection, this rule SHALL NOT automatically open newly discovered conversations. This behavior SHALL NOT change existing bootstrap selection from a nonempty inventory, force Chat open, move keyboard focus, or alter inventory-awareness acknowledgement.

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
