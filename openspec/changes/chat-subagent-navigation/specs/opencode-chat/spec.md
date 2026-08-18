## ADDED Requirements

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
