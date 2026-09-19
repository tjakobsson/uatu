## MODIFIED Requirements

### Requirement: Notifications require explicit device opt-in
Hub-served Uatu SHALL offer an Enable notifications action in supported secure browser contexts. Permission SHALL be requested only following that action, never on installation, page load, or receipt of an agent event. The UI SHALL report the actual permission and subscription state and SHALL explain denied permission, unsupported environments, and HTTPS requirements without blocking ordinary use. On iPhone and iPad environments requiring a Home Screen installation, the UI SHALL explain that prerequisite before attempting enrollment. Enrollment SHALL use feature detection and SHALL work from the hub dashboard and a hub-served workspace. Enrollment SHALL succeed only when the hub knows the current notification-feed position of every selected running workspace; otherwise the hub SHALL refuse with a retryable error naming the workspace(s) it could not reach, SHALL leave the device's existing enrollment unchanged, and the UI SHALL present that refusal rather than reporting the device enabled.

#### Scenario: Installed iPhone app enrolls
- **WHEN** a user opens Uatu as a Home Screen app over HTTPS on a supported iPhone and taps Enable notifications
- **THEN** the system permission request follows that interaction
- **AND** granting permission and successfully registering the device enables notifications

#### Scenario: Supported desktop browser enrolls without installation
- **WHEN** a user enables notifications in a supported desktop browser over a secure connection
- **THEN** enrollment succeeds without requiring PWA installation

#### Scenario: Installation alone does not prompt
- **WHEN** a user installs or opens Uatu without enabling notifications
- **THEN** Uatu does not request notification permission

#### Scenario: Unavailable notification support remains understandable
- **WHEN** Uatu is opened on plain HTTP at a remote LAN address, in an unsupported browser, or in an iPhone browser context that requires Home Screen installation
- **THEN** the UI explains the applicable prerequisite and does not claim that notifications are enabled
- **AND** chat and document browsing continue to work

#### Scenario: Denied permission is not repeatedly requested
- **WHEN** notification permission is denied
- **THEN** the UI explains how to change the browser or OS permission and does not repeatedly invoke the permission prompt

#### Scenario: A running workspace's feed does not answer in time
- **WHEN** a user enrolls or updates a device selecting a running workspace whose notification feed has not answered within the hub's settle bound
- **THEN** the hub refuses with a retryable service-unavailable error that names that workspace
- **AND** no device record is created or changed and no cutoff is stamped
- **AND** the UI shows the refusal and leaves the device's previous state intact
- **AND** a retry after the feed answers succeeds with a cutoff no earlier than the feed position

#### Scenario: Stopped workspaces do not delay enrollment
- **WHEN** a user enrolls selecting only stopped workspaces, or a mix in which every running workspace's feed answers in time
- **THEN** enrollment succeeds without waiting on the stopped workspaces

### Requirement: Notifications describe live agent events
Uatu SHALL produce needs-answer notifications for newly pending questions and permission requests and completion notifications for successful completion of a top-level agent turn in a selected workspace. Events SHALL identify the workspace, agent-qualified conversation, event kind, and stable source occurrence. OpenCode and Claude SHALL follow the same behavior. A new pending interaction SHALL remain distinguishable from an earlier pending interaction in the same workspace. Transcript replay, initial state hydration, unchanged status snapshots, individual tool completion, child-agent completion, failure, cancellation, and a transition into background work SHALL NOT produce a successful-turn-completion notification. An already resolved interaction SHALL be discarded before its unsent notification is dispatched when its resolution is known. A resolution SHALL carry the same identity as the pending event it resolves, regardless of which conversation reported the resolution.

#### Scenario: Another question appears while one is pending
- **WHEN** a second distinct question becomes pending while the workspace already has an unanswered question
- **THEN** the second question produces its own eligible needs-answer event

#### Scenario: One conversation finishes while another runs
- **WHEN** one top-level conversation successfully completes a turn and another conversation in the workspace remains running
- **THEN** the completed turn produces an eligible notification identifying the completed conversation

#### Scenario: History is reopened
- **WHEN** Uatu replays old questions, tools, or completed turns while loading a conversation
- **THEN** those historical records do not create new notifications

#### Scenario: A turn fails or leaves work in the background
- **WHEN** a turn fails, is cancelled, or moves into a background-work state
- **THEN** Uatu does not describe that transition as successful completion

#### Scenario: A subagent's request is resolved through its parent
- **WHEN** a subagent's question or permission request was announced as pending and its answer is later known only through the parent conversation — an answer given from the parent's transcript, or a parent reconciliation that no longer lists the request
- **THEN** the resolution identifies the subagent conversation and request that were announced, not the parent
- **AND** the request is no longer pending in the workspace feed
- **AND** an unsent delivery for that request is discarded
