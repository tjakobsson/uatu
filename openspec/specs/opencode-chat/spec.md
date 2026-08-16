# opencode-chat Specification

## Purpose
Define workspace-scoped OpenCode conversations and the responsive web chat surface through which authenticated users can inspect, direct, interrupt, and resume coding-agent work.

## Requirements

### Requirement: Chat uses the workspace's OpenCode installation and identity
When chat is first needed in a running workspace, UatuCode SHALL discover the `opencode` executable available to that workspace process and start a loopback-only OpenCode service whose lifetime is owned by the workspace server. The service SHALL use OpenCode's existing user configuration and authentication; UatuCode MUST NOT request, copy, persist, or transmit provider API keys. If OpenCode is unavailable, cannot start, or is not authenticated, the workspace and all non-chat capabilities SHALL remain usable and the Chat surface SHALL report an actionable unavailable state.

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

### Requirement: The workspace API exposes normalized chat operations
The workspace API SHALL provide authenticated operations to list, create, and read conversations; start a prompt turn; cancel the active turn; answer a pending permission; and answer or reject a structured question. Mutation requests SHALL be origin-protected under cookie authentication, SHALL validate conversation ownership against the workspace directory, and SHALL use client-generated request identifiers to make network retries idempotent. Provider-specific payloads and credentials MUST NOT be exposed as the public contract when a normalized UatuCode representation exists.

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

### Requirement: Conversation updates are structured and reconnectable
The server SHALL normalize OpenCode activity into ordered conversation events covering user and assistant content, reasoning, tool lifecycle, permission requests and resolutions, structured questions and resolutions, turn status, cancellation, completion, warnings, and errors. A history snapshot SHALL identify a stream cursor; reconnecting from a retained cursor SHALL replay every later event in order before delivering live events. If the cursor is no longer replayable or belongs to an earlier server generation, the server SHALL explicitly require a fresh snapshot. Applying a snapshot followed by its event stream MUST NOT duplicate message content or tool entries.

#### Scenario: Stream reconnect replays missed output
- **WHEN** the event connection drops during an assistant response and reconnects with a retained cursor
- **THEN** every event after that cursor is replayed once in order before live output continues

#### Scenario: Stale cursor requests resynchronization
- **WHEN** a client reconnects with a cursor outside retained history or from an earlier workspace-server generation
- **THEN** the stream reports that a new snapshot is required rather than silently omitting events

#### Scenario: Cumulative and incremental provider updates do not duplicate text
- **WHEN** OpenCode reports overlapping cumulative part state and text deltas for one assistant part
- **THEN** the normalized timeline contains each text segment exactly once

### Requirement: Chat presents turns as readable conversation with inspectable activity
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

#### Scenario: Assistant answer remains visually primary
- **WHEN** a turn contains assistant text interleaved with multiple tool calls
- **THEN** the answer reads as a coherent conversation
- **AND** tool activity can be expanded for detail without being mistaken for assistant prose

#### Scenario: Streaming tool lifecycle updates in place
- **WHEN** a tool moves from running to completed or failed
- **THEN** its existing activity entry updates state instead of adding a duplicate entry

#### Scenario: Hostile content remains inert
- **WHEN** assistant Markdown or tool output contains script-capable markup or a JavaScript URL
- **THEN** the rendered conversation does not execute it or expose an active unsafe link

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the available one-time approval, session approval, and rejection choices supported by OpenCode. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. Only the active unresolved request MAY accept a response, and submitting a response more than once MUST NOT produce multiple provider replies.

#### Scenario: Permission is approved once
- **WHEN** OpenCode requests permission for a command and the user chooses one-time approval
- **THEN** the response is sent once to the matching pending request
- **AND** the card records that the request was approved for that occurrence

#### Scenario: User rejects a structured question
- **WHEN** OpenCode asks a structured question and the user rejects or dismisses it
- **THEN** OpenCode receives one rejection response
- **AND** the resolved card can no longer submit an answer

#### Scenario: Stale request response is refused
- **WHEN** a client attempts to answer a request that is already resolved or no longer active
- **THEN** the server rejects it without forwarding another response to OpenCode

### Requirement: Users can prompt, steer, and cancel the active conversation
The Chat composer SHALL submit non-empty text to the selected conversation and clearly distinguish ready, sending, running, interrupted, and failed states. While OpenCode supports steering a running session, a subsequent submitted prompt SHALL be presented as a steer of the active turn rather than an unrelated concurrent turn. The user SHALL be able to cancel an active turn without deleting its completed history, and transport failure SHALL preserve the draft until acceptance is known.

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

### Requirement: Chat adapts to desktop, touch, and software-keyboard viewports
In desktop mode Chat SHALL occupy the main content surface while preserving the existing sidebar and independently dockable terminal. A visible workspace control SHALL switch between Preview and Chat without remounting or losing either surface's state. In touch mode Chat SHALL occupy its own full-screen tab surface. The composer SHALL remain reachable above the visual viewport and safe-area inset while the software keyboard is present, and keyboard opening, resizing, or dismissal MUST NOT hide the input or cause the current reading position to jump.

#### Scenario: Desktop switches between Preview and Chat
- **WHEN** a desktop user switches from an open conversation to Preview and back
- **THEN** the same conversation, draft, loaded history, and reading position are retained
- **AND** terminal attachment and visibility are unchanged

#### Scenario: iPhone keyboard keeps composer visible
- **WHEN** a touch user focuses the Chat composer and the software keyboard reduces the visual viewport
- **THEN** the composer remains fully visible above the keyboard and bottom safe area
- **AND** the timeline resizes without placing the active content behind the composer

### Requirement: Conversation file references navigate through UatuCode safely
Workspace-relative file references in assistant content or normalized file-change activity SHALL offer navigation to the corresponding UatuCode document preview when the target is within the watched roots. Activating such a reference SHALL switch to Preview and reveal the referenced line when supplied. Absolute paths outside the watched roots, traversal attempts, and unresolved targets MUST NOT be exposed as navigable workspace links.

#### Scenario: Assistant references a watched source line
- **WHEN** assistant content references `src/app.ts:42` and that file is in the watched workspace
- **THEN** activating the reference opens that document in Preview at line 42

#### Scenario: Outside path is not navigable
- **WHEN** provider output references an absolute path outside every watched root or contains traversal outside the workspace
- **THEN** Chat renders it as inert text rather than a UatuCode navigation action
