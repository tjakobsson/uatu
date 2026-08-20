## ADDED Requirements

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
