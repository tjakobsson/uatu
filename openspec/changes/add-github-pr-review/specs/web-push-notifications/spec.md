## MODIFIED Requirements

### Requirement: Notifications require explicit device opt-in
Hub-served Uatu SHALL offer feature-detected notification opt-in in supported secure contexts from the Hub's pages, Settings included, and from no workspace page. Permission SHALL be requested only following Enable notifications. The UI SHALL report permission/subscription state and explain enrollment prerequisites without blocking ordinary use. Enrollment SHALL require current feed positions for every covered running workspace and preserve existing enrollment on refusal.

#### Scenario: Permission enrollment follows explicit supported-context intent
- **WHEN** Enable notifications is activated
- **THEN** permission SHALL be requested only after that action, never at installation, page load, or agent-event receipt
- **AND** enrollment SHALL use feature detection on the Hub's pages

#### Scenario: Enrollment lives in the Hub's Settings, not the workspace sidebar
- **WHEN** a hub-served workspace is shown in desktop mode, with the sidebar collapsed to its rail, or in touch mode's Files tab
- **THEN** it shows no Notifications control
- **AND** Settings (reached from the workspace menu) shows the Notifications control, whose dialog lists every accessible workspace for this device
- **AND** a workspace page still keeps an existing enrollment's push worker registered, without prompting

#### Scenario: Permission and platform information precedes enrollment
- **WHEN** notification controls are displayed, before Enable notifications is activated as well as afterwards
- **THEN** the UI SHALL report actual permission/subscription state and explain denied permission, unsupported environments, and HTTPS requirements without blocking normal use
- **AND** iPhone/iPad Home Screen installation prerequisites SHALL be explained before enrollment when required

#### Scenario: Enrollment requires every covered running feed position
- **WHEN** enrollment covers selected workspaces or all accessible workspaces under All workspaces
- **THEN** success SHALL require the hub to know every covered running workspace's current notification-feed position
- **AND** otherwise the hub SHALL refuse retryably naming unreachable workspaces, leave existing enrollment unchanged, and the UI SHALL present refusal rather than enabled state

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

#### Scenario: All workspaces enrollment waits for every running workspace
- **WHEN** a user enrolls or updates a device with All workspaces on while several accessible workspaces are running
- **THEN** the hub waits, within one settle bound, for the feed position of each running workspace before stamping any cutoff
- **AND** a running workspace whose feed does not answer in time is named in the refusal exactly as it would be for a per-workspace enrollment
- **AND** stopped workspaces are covered without waiting

### Requirement: Device preferences select workspaces and event categories
Each enrolled profile/app SHALL have authenticated-user-associated, device-specific preferences. For each device the user SHALL choose one workspace mode: All workspaces or explicit accessible-workspace selection. Users SHALL be able to toggle needs-answer and successful-turn-completion notifications independently for that device in either mode. All workspaces SHALL be a standing access rule, not an inventory snapshot; explicit selections and other devices SHALL remain independent.

#### Scenario: Enrollment defaults and submission record a device's explicit choices
- **WHEN** the enrollment form opens
- **THEN** it SHALL offer All workspaces or explicit accessible-workspace selection and independently toggle needs-answer and successful-turn-completion categories in either mode
- **AND** both categories SHALL default selected, All workspaces off, and no workspace preselected
- **AND** submitting SHALL confirm choices

#### Scenario: Reported device state always identifies its workspace selection
- **WHEN** device state is reported to a client
- **THEN** it SHALL name the mode and the explicit selection

#### Scenario: Workspace mode changes retain selective history and live access coverage
- **WHEN** All workspaces is saved
- **THEN** it SHALL stand for every workspace accessible at each event, including later registrations, and SHALL NOT store the then-existing inventory list
- **WHEN** All workspaces is turned off
- **THEN** the prior explicit selection SHALL return, or none if absent
- **WHEN** notifications are disabled on one device
- **THEN** future sends SHALL stop there without affecting the user's other devices

#### Scenario: Explicit mode never automatically subscribes new workspaces
- **WHEN** a new workspace becomes accessible to a device in explicit mode, whether or not its mode has changed
- **THEN** that workspace SHALL NOT be subscribed automatically

#### Scenario: Phone and desktop have different preferences
- **WHEN** a user selects two workspaces on their phone and only one on their desktop browser
- **THEN** each device receives only events matching its own workspace and category preferences

#### Scenario: A workspace is added later
- **WHEN** a new workspace becomes accessible after enrollment on a device in the explicit mode
- **THEN** it is absent from the device's notification selection until explicitly selected

#### Scenario: A workspace is added later under All workspaces
- **WHEN** a device has All workspaces on and a new workspace is registered on the hub afterwards
- **THEN** the device receives that workspace's events in its enabled categories without the user revisiting notification settings
- **AND** reopening the settings on that device still shows All workspaces on, not a list expanded to include the new workspace

#### Scenario: One device covers everything while another stays selective
- **WHEN** a user's phone has All workspaces on and their desktop selects one workspace, and an agent asks a question in a workspace the desktop did not select
- **THEN** the phone is notified and the desktop is not

#### Scenario: Switching from All workspaces back to a selection
- **WHEN** a user who previously saved workspaces alpha and beta turns All workspaces on, saves, and later turns it off again
- **THEN** the form shows alpha and beta selected and saving restores that selection
- **AND** a workspace registered while All workspaces was on is not part of the restored selection

#### Scenario: Disable on one device
- **WHEN** a user disables notifications on their phone
- **THEN** future sends and queued unsent notifications for that enrollment stop
- **AND** enrollment on their desktop remains active
