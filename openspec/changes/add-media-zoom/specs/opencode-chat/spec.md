# Spec Delta

## MODIFIED Requirements

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
- **THEN** the image opens at fit in the shared fullscreen media viewer, where it can be zoomed and panned
- **AND** the attachment's name is shown as a caption, as inert text
- **AND** the viewer is dismissible by Escape, its close control, or a click on the empty backdrop, and a drag or a click on the image does not dismiss it
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
