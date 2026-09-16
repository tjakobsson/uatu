## ADDED Requirements

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
