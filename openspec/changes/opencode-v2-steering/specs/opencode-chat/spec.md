## RENAMED Requirements

- FROM: `### Requirement: Chat composer actions keep a stable one-line layout`
- TO: `### Requirement: Chat composer actions keep a stable responsive layout`

## MODIFIED Requirements

### Requirement: Chat composer actions keep a stable responsive layout
The Chat composer SHALL present context usage, one flexible configuration trigger, routine status, a persistent visible Send action, and a separate Stop action, subject to the compact touch layout below. A capability-gated delivery selector SHALL precede Send where supported. Send SHALL NOT become Stop while work runs. Each submission control SHALL have a target at least 44×44 CSS pixels with at least 8px separation from adjacent submission controls and a visible keyboard-focus indicator. Stop SHALL remain in place but disabled when no turn is live. Routine lifecycle changes and opening the delivery menu MUST NOT move or resize these controls at unchanged panel dimensions and keyboard/editing state.

Wide panels SHALL use one non-wrapping rail. At narrow widths steering-capable composers SHALL use two deliberate rails: context/configuration/status above delivery/Send/Stop. Composers without a delivery selector SHALL keep one compact rail without reserving an empty delivery row. The configuration label SHALL truncate as needed, without shrinking submission targets or causing horizontal overflow. Resizing MAY switch the entire rail arrangement; individual controls MUST NOT wrap independently. Actionable failures SHALL remain explanatory text outside the routine status footprint, without horizontally reordering the controls. Textarea autosizing remains independent of rail stability.

When the touch software-keyboard visual band is at most 450px, or a touch landscape band is at most 390px with width at least 600px, the composer SHALL instead use compact input and submission rows, retaining the current inline picker and primary actions. Short touch headers SHALL omit the identity row. Parent-composer viewport handling SHALL keep the header and submission controls within the available visual band without scrolling the outer surface wherever measured physical minima fit; the compact-chat-background-steering physical-minimum exception SHALL govern impossible enlarged bands. Transcript and dock body scrolling remain separate. Existing interaction-request answering behavior is unchanged. Hardware-keyboard editing SHALL retain the bottom safe-area inset without doubling it under a software keyboard.

#### Scenario: Routine lifecycle keeps trailing controls stationary
- **WHEN** a prompt moves through ready, sending, working, cancelling, and ready states at unchanged Chat-panel dimensions and keyboard/editing state
- **THEN** the status, Send, Stop, and supported delivery selector retain their dimensions and positions
- **AND** Stop is enabled only during live work and unavailable during its cancellation request

#### Scenario: Narrow desktop panel truncates configuration
- **WHEN** a desktop or non-compact touch Chat panel is too narrow for one rail
- **THEN** the submission controls occupy one separate non-wrapping row below settings/status
- **AND** their minimum target sizes and separation are preserved without horizontal overflow
- **AND** the configuration label truncates to its available width

#### Scenario: Non-steering narrow composer stays compact
- **WHEN** an agent without steering is shown in a composer at most 30rem wide outside compact touch keyboard/short-landscape mode
- **THEN** settings, status, Send and Stop share one rail with no empty selector row

#### Scenario: Delivery choice explains its shortcuts and restores focus
- **WHEN** the delivery menu opens
- **THEN** its current choice has a visible check and the device-appropriate submit hint (Enter on desktop, Send / Ctrl+Enter on touch), and the other choice has Alt+Enter
- **AND** Escape restores the previously focused control, including the composer on touch
- **AND** the selector title explains Send's delivery and whether Enter submits or adds a newline, or why selection is disabled while idle
- **AND** busy Send's accessible name says Send as steer, Send to queue, or Queue message as appropriate
- **AND** enabled Send text has at least 4.5:1 contrast in light and dark themes

#### Scenario: Context usage does not displace the trailing action
- **WHEN** context usage becomes available or its displayed value changes
- **THEN** it does not move the routine status, Send, or Stop
- **AND** it does not change the number of action rows

#### Scenario: Failure remains explanatory
- **WHEN** sending, cancellation, or the active turn fails
- **THEN** Chat displays explanatory failure text
- **AND** the action rails keep their horizontal ordering

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
- **AND** with both cards collapsed at least 40% remains wherever measured minimum chrome physically permits; expanded cards use the measured small-strip policy in Desktop work shares measured panel space

#### Scenario: Loaded hardware-keyboard portrait preserves conversation space
- **WHEN** the 390×844 touch parent composer is focused without a software keyboard, with 47px top and 34px bottom safe insets, workers and pending messages
- **THEN** with both cards collapsed the aggregate dock is capped at 24% of visual height and the transcript retains at least 40% of visual height in the standard-size layout; with either expanded, measured small-strip capacity replaces those percentages
- **AND** the composer respects the bottom safe inset and its submission controls remain reachable

### Requirement: The workspace API exposes normalized chat operations
The workspace API SHALL provide authenticated operations to list, create, and read conversations; start a prompt turn; remove a queued message; change a pending message's delivery; send a pending message now; cancel the active turn; answer a pending permission; and answer or reject a structured question. Mutation requests SHALL be origin-protected under cookie authentication, SHALL validate conversation ownership against the workspace directory, and SHALL use client-generated request identifiers to make network retries idempotent. Provider-specific payloads and credentials MUST NOT be exposed as the public contract when a normalized UatuCode representation exists.

A prompt MAY name its delivery, steer or queue. A prompt that names steer SHALL be accepted as a steer only when the owning agent declares the `steering` capability, the conversation is running, and the text is not a command. Otherwise it SHALL be handled as a queued prompt. A prompt that names no delivery SHALL be handled as a queued prompt. A prompt accepted while the conversation is running SHALL be reported as pending, identifying the message and its delivery so that a client can later remove it or change its delivery. Conversation reads SHALL include the currently pending messages in delivery order, each with its delivery and whether it is paused. A client that joins or reloads mid-run therefore presents the same dock as a client that watched it build.

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

#### Scenario: Retried delivery change is applied once
- **WHEN** a client retries a change of a pending message's delivery, or a send-now, with the same request identifier after losing the response
- **THEN** the server reports the original outcome
- **AND** the message is delivered to the agent at most once

#### Scenario: A reload shows the queue as it stands
- **WHEN** a client loads a conversation snapshot while messages are pending
- **THEN** the response identifies the pending messages in delivery order, each with its delivery and paused state
- **AND** the client can present, remove, and switch them without having observed their submission

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
The server SHALL normalize OpenCode activity into ordered conversation events covering user and assistant content, reasoning, tool lifecycle, permission requests and resolutions, structured questions and resolutions, context compaction, reverted work, turn status, cancellation, completion, warnings, and errors. Normalization SHALL recognize each of these regardless of which of OpenCode's event-naming generations announced it, and when one logical occurrence is announced more than once the timeline SHALL contain a single entry for it.

Changes to a conversation's pending messages SHALL be announced on the same ordered event stream, so every connected client presents the same dock at the same point in the conversation. Those changes are: a message held, a message accepted as a steer, a message removed, a message's delivery changed, a message paused or resumed, and a message delivered to the agent.

An event the server does not recognize, or whose payload it cannot parse, SHALL be skipped without ending or restarting the event stream, and SHALL be counted by type so an operator can discover what a running workspace is discarding. Counting MUST NOT record event payloads.

A history snapshot SHALL identify a stream cursor; reconnecting from a retained cursor SHALL replay every later event in order before delivering live events. If the cursor is no longer replayable or belongs to an earlier server generation, the server SHALL explicitly require a fresh snapshot. Applying a snapshot followed by its event stream MUST NOT duplicate message content or tool entries.

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

### Requirement: Users can prompt, queue, and cancel the active conversation
The Chat composer SHALL submit a message with content — non-empty text, at least one image attachment, or both — to the selected conversation and clearly distinguish ready, sending, running, interrupted, and failed states. A prompt submitted while the conversation is running SHALL be held in a workspace-owned queue rather than delivered to the agent mid-turn. The exception is a prompt the user explicitly submits as a steer to an agent that declares `steering`, which "OpenCode 2.x conversations can steer the running turn" governs. Pending messages, steers and queued messages alike, SHALL be presented adjacent to the composer as one list in delivery order, with steers listed before queued messages. Each SHALL be visibly labelled with its delivery and SHALL NOT appear as part of the running turn's timeline. While the agent continues to stream output, pending messages SHALL remain adjacent to the composer rather than drifting into the transcript. Pending messages SHALL be bounded per conversation, with steers and queued messages counted together. A submission that would exceed the bound SHALL be refused without altering the pending messages, with the draft preserved.

Every message held in the workspace's queue SHALL stay held until delivery, whatever its kind: prompts, skills, slash commands, and `/reload`. When the running turn ends on its own, the workspace SHALL deliver held messages to the agent one at a time in submission order. Each held message SHALL be delivered under the model, mode, and reasoning variant fixed at its submission. A delivered message SHALL leave the dock and begin its own turn at the end of the timeline. The user SHALL be able to remove any message that is still pending; a removed message is never delivered. Removal of a message that has already been delivered SHALL be refused without altering the conversation. The user SHALL be able to edit a pending message: the message leaves the dock under the same rules as removal, and the invoking client's composer receives its text and attachments.

The user SHALL be able to cancel an active turn without deleting its completed history. Cancellation SHALL NOT deliver pending messages. They remain pending, removable, and visible, and are presented as paused. The queue stays dormant until the user next submits a prompt, which joins the end of the queue and resumes delivery from its head. The other ways out of the dormant state are switching an entry to steer and Send now. Transport failure SHALL preserve the draft until acceptance is known.

Send SHALL remain visible while work runs and SHALL steer ordinary text on a steering agent, or queue when steering is unsupported. Explicit Queue submission SHALL remain available through the existing hold and Alt/Option+Enter paths; commands and attachments SHALL retain mandatory queue semantics. No configurable per-device default or delivery selector SHALL be required. A separate Stop button SHALL cancel active work without submitting or discarding an unsent draft. Send SHALL be unavailable for an empty draft, during submission, or while a cancellation request is pending. The shared submit path SHALL also refuse keyboard submission during cancellation, preserving the draft and discarding any one-shot delivery override from the refused attempt.

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

#### Scenario: A queued message can be edited
- **WHEN** the user edits a message that is still held
- **THEN** it disappears from the dock on every client and is never delivered
- **AND** the invoking client's composer receives its text and attachments

#### Scenario: A full queue refuses further submissions
- **WHEN** a conversation's pending steers and queued messages together are at the bound and the user submits another prompt while the agent works
- **THEN** the submission is refused and the draft is preserved
- **AND** the pending messages are unaffected

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

### Requirement: Chat supports reversible conversation undo and redo
When the connected agent declares reversible-history support, Chat SHALL offer local `/undo` and `/redo` commands that operate on the selected conversation and MUST NOT send those command strings as ordinary prompts or provider-defined slash commands. Each visible user turn in the main transcript SHALL also offer a direct Revert message action. Undo SHALL stage the previous visible user turn as the conversation's revert boundary; direct Revert SHALL stage the selected visible user turn in one boundary mutation rather than repeated Undo mutations. Both SHALL hide the boundary turn and all later work from the current transcript and restore affected workspace files through the agent's revert operation. The invoking client SHALL receive the boundary turn's non-synthetic prompt text and any still-available attachments as an editable composer draft; other clients' private drafts MUST NOT be overwritten.

If work is running, Undo SHALL interrupt it before changing the boundary. Messages queued behind that work MUST NOT be admitted between interruption and the completed revert. Existing pending messages SHALL remain visible and removable but paused while a revert is staged. They SHALL resume only after Redo clears the revert or after the user submits a replacement prompt, with that replacement admitted before the older held queue resumes. When the agent declares `steering`, the replacement SHALL be sent as a steer. Messages held in the workspace's queue SHALL stay pending rather than being discarded. Steers already pending with the agent SHALL be delivered together with the replacement, the oldest first. When Undo succeeds while steers are pending, Chat's undo confirmation SHALL count those steers without repeating their message text and say that they will be delivered together with the replacement.

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

### Requirement: Held messages keep their attachments
A message submitted with attachments while the conversation is running SHALL keep its attachments while it is pending, whether it is held or steered. The dock SHALL show the message's thumbnails. Removal of a pending message SHALL discard the message together with its attachment references. Editing a pending message SHALL return its attachments to the composer with its text. Changing a pending message's delivery SHALL keep its attachments. Delivery SHALL carry the attachments exactly as submitted. Switching the composer's model after a message is held SHALL NOT alter the held message's attachments: held messages deliver under their frozen configuration.

#### Scenario: A queued message shows its thumbnails
- **WHEN** a message with attachments is held or steered while the agent works
- **THEN** the dock shows the message with its image thumbnails

#### Scenario: Removing a held message discards its attachments
- **WHEN** the user removes a pending message that has attachments
- **THEN** the message and its attachment references leave the dock on every client
- **AND** the message is never delivered

#### Scenario: Editing a pending message returns its attachments
- **WHEN** the user edits a pending message that has attachments
- **THEN** the invoking client's composer receives the message's text and its attachments

#### Scenario: Switching delivery keeps attachments
- **WHEN** the user switches a pending message with attachments between steer and queue
- **THEN** the message keeps its attachments
- **AND** delivers with them

#### Scenario: A held message delivers with its attachments
- **WHEN** the running turn ends and a held message with attachments is delivered
- **THEN** the agent receives the message text and its attachments under the configuration frozen at submission

## ADDED Requirements

### Requirement: OpenCode 2.x conversations can steer the running turn
An agent that can deliver a message into its running turn at the next safe step boundary, and can withdraw or switch a message before then, SHALL declare the `steering` capability. The OpenCode 2.x agent SHALL declare it. The OpenCode 1.x agent and the Claude Code agent SHALL NOT declare it.

While a conversation whose agent declares `steering` is running or has pending messages, the composer SHALL offer two deliveries through fixed actions. Tap Send and desktop Enter SHALL steer. Touch Enter SHALL insert a newline, idle or busy, including while a command candidate is shown; Ctrl/Command+Enter SHALL explicitly steer. ⌥Enter (Option/Alt+Enter) SHALL queue where the choice is offered. Steer SHALL be the fixed keyboard default, not a per-device setting; legacy saved delivery choices SHALL be ignored without deleting browser settings. There SHALL be no delivery-default Settings path, Send dropdown, replacement selector or added layout height. The existing Send hold SHALL arm for 500ms, count down for two seconds and queue once at 2500ms; release during the armed countdown SHALL cancel. Commands and attachment-bearing drafts SHALL retain mandatory queue semantics, and idle submission SHALL retain immediate delivery. Explicit HTTP delivery and dock delivery actions, capability gates and unsupported agents' queued follow-ups SHALL remain unchanged.

A steer SHALL be handed to the agent at once and kept pending by the agent until the agent delivers it. Steers SHALL be delivered before any held message. The expanded dock SHALL list the user's pending steers, from any client of the conversation, labelled "Steer", and SHALL NOT list the agent's own internal inbox entries. A steer SHALL NOT appear in the timeline until the agent reports it delivered, at which point it SHALL appear as an ordinary user message. Outside compact keyboard/short-landscape mode, pending steers SHALL carry the dock note that they run with the conversation's model and mode as they stand when they are delivered.

For each pending entry, the user SHALL be able to:
- switch a queued message to steer, which hands it to the agent as a steer at once; on a dormant queue or an idle conversation this is how a held message is sent now;
- switch a steer back to queue, which withdraws it from the agent and holds it in the workspace's queue in its submission order;
- edit or remove a steer, which withdraws it from the agent.

Withdrawing a steer SHALL complete only when the agent confirms the withdrawal. If the agent delivers the steer first, the withdrawal SHALL fail, the message SHALL stay delivered, and the user SHALL be told it was already delivered. A message SHALL never be delivered twice.

An unconfirmed withdrawal SHALL keep the pending entry and private draft visible. Absence from a passive inbox/history snapshot SHALL NOT by itself confirm cancellation. A client with withdrawal-specific uncertainty SHALL offer **Retry withdrawal**, which explicitly repeats only native cancellation of the same inbox ID. It SHALL NOT edit, convert, resubmit the original input, automatically retry any mutation, or allow concurrent actions on that entry. Admission/resume uncertainty SHALL remain read-only and SHALL NOT grant withdrawal retry.

#### Scenario: Hidden delivery does not erase an uncertain withdrawal
- **WHEN** a withdrawal is unconfirmed and a later inbox read is empty while V2 history hides reverted messages
- **THEN** the original pending entry and attachments remain inspectable, and no removal is published based on that absence

#### Scenario: An explicit withdrawal retry does not resend input
- **WHEN** the user activates Retry withdrawal
- **THEN** only cancellation of the original inbox ID is requested again, with no prompt or new message ID
- **AND** confirmed cancellation removes the entry, confirmed delivery removes it with an already-delivered warning, and an inconclusive result keeps it visible

Skills, slash commands, and `/reload` in the queue SHALL NOT offer the switch to steer.

Cancelling the turn SHALL leave pending steers with the agent and SHALL present them as paused. A steer is paused when it was pending before the conversation last became idle. The dock SHALL offer one action labelled `Send N paused steers now`, which resumes the agent so that it delivers every pending steer. Submitting a new steer SHALL also resume delivery of paused steers.

The pending card SHALL have an always-visible count header outside its own contained content scrollport. Worker and pending cards SHALL share only a height budget, never an aggregate scroller, as specified by Desktop work shares measured panel space. With both cards collapsed, desktop normally uses 40% of measured panel height capped at 25rem; touch normally uses 35% of visual height, 25% at tablet widths from 48rem, or 24% during hardware editing. With either expanded, the compact-chat-background-steering measured expanded-card policy SHALL supersede these caps and the earlier 40% phone/35% tablet transcript reserves: after measured chrome/composer/safe areas, reserve 20% of the remaining region bounded to 32–96px, yielding to whole actions down to the lesser of 16px or 10% of that region where physically possible. Short lists SHALL yield unused capacity without blank card height, and both collapsed SHALL restore the normal reserves. The pending list SHALL show a bottom fade only while content remains below. Entries SHALL retain distinct Steer/Queue badges, Paused chips and existing timing labels. Pending actions SHALL retain the approved compact 32px touch / 36px desktop targets, independent 8px gaps, visible focus outlines and contextual accessible names. Successful mutations SHALL not add confirmation notices; refusals and unknown receipts SHALL retain operation-scoped feedback without duplicate red errors.

When pending messages exist, software-keyboard mode or short touch landscape SHALL collapse the work dock to a pending-count summary rather than hide it. Any paused-steer batch Send action SHALL retain a 44px target, and the count-only replacement warning SHALL remain readable while typing or editing a pending entry. Entry details and the routine model-at-delivery note MAY be hidden in this compact state; the replacement warning SHALL NOT be hidden. Dock growth SHALL reserve its final bounded layout height before a visual reveal, respect reduced motion, and preserve a remote-update reading anchor and deliberate bottom pinning. Sending a prompt SHALL retain the existing explicit jump-to-latest behavior.

When the workspace attaches to a conversation, or reconnects to the agent, it SHALL reconcile the pending steers with the agent's own list, so the dock shows steers raised while the stream was interrupted or by another client.

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
An agent that can deliver a held message ahead of the rest of the queue SHALL declare the `send-now` capability. The OpenCode 2.x and Claude Code agents SHALL declare it. The OpenCode 1.x agent SHALL NOT declare it. A held message SHALL offer Send now only when its agent declares `send-now`.

On an agent that declares `steering`, Send now SHALL hand the held message to the agent as a steer. This is the same operation as switching it to steer, and it is available while the turn runs, while the queue is dormant, and while the conversation is idle.

When paused steers exist, the queued Send now control SHALL explicitly name that it also sends paused steers and SHALL confirm that batch effect before submission. Cancelling the confirmation SHALL leave all pending messages unchanged. The remaining held queue SHALL stay dormant.

On an agent that declares `send-now` but not `steering`, Send now SHALL be offered only while the held queue is dormant or the conversation is idle, never while a turn runs. Send now SHALL deliver that message immediately, ahead of the other held messages, under the configuration fixed at its submission. The other held messages SHALL remain held in submission order.

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
