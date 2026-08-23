# opencode-chat delta: add chat image attachments

## ADDED Requirements

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

## MODIFIED Requirements

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
