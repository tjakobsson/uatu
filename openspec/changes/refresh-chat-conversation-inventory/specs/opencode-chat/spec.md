## ADDED Requirements

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
