# opencode-chat delta: add chat image attachments

## ADDED Requirements

### Requirement: Users can attach images to a prompt
The Chat composer SHALL accept image attachments in the image formats the
agent supports (PNG, JPEG, GIF, WebP) through three intakes: pasting from the
clipboard, dragging onto the composer, and an explicit attach control backed
by a file picker. The attach control SHALL be visible without hover or
keyboard affordances, so touch-only devices can attach images. Pending
attachments SHALL be presented at the composer as thumbnails, each removable
before send, and SHALL be submitted together with the composer text as one
message.

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
