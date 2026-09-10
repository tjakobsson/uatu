## Purpose

Preserve the active workspace's browser-side experience through ordinary touch Hub and Settings visits without frames, while maintaining independent focus, navigation identity, and truthful lifecycle recovery.

## ADDED Requirements

### Requirement: Ordinary mobile Hub round-trips retain the workspace
In the touch/mobile frontend, leaving the active workspace for Hub, Settings, or a Hub detail/task view and returning to that same workspace SHALL retain its browser-side lifetime in the same document without any iframe. The selected Files/Preview/Chat/Terminal surface, document identity, relevant scroll positions, unsent Chat draft, pending File attachments, active upload work, and ongoing client stream state SHALL remain owned by the same workspace instance. The Hub detour MUST NOT reload or remount the workspace, dispose its transports, submit a draft, duplicate a request, or start/stop a server session.

This guarantee applies to ordinary navigation within the live document and one retained workspace. It does not promise survival of browser termination, document reload, authentication invalidation, explicit Stop, or replacement by a different workspace. Recovery after external suspension or transport interruption SHALL remain truthful and MUST NOT be described as uninterrupted background execution.

#### Scenario: Draft and attachment continue during Settings
- **WHEN** a user leaves Chat with unsent text and a pending File upload, visits Hub and Settings, and Returns
- **THEN** the same Chat draft and attachment operation remain present and can complete
- **AND** restoring only a filename or saved text does not satisfy the requirement

#### Scenario: Terminal client continues during Hub visit
- **WHEN** synthetic terminal output arrives while the user is browsing Hub details
- **THEN** the retained terminal client accumulates that output without a new terminal instance or duplicate stream
- **AND** Return restores its selected surface and scroll behavior

#### Scenario: Return does not force Preview
- **WHEN** the retained workspace was on Files, Chat, or Terminal before the Hub detour
- **THEN** Return reveals that same surface and expands the workspace selector without stealing focus

### Requirement: Hub and workspace interaction contexts are isolated
Only the active Hub view, modal sheet, or workspace surface SHALL receive user interaction and accessibility focus. Hidden workspace content SHALL remain inactive for shortcuts and focus without being disposed. Hub styling and form updates MUST NOT change workspace interior appearance, state, selection, or layout measurements. Existing workspace request scope and base path SHALL remain bound to that workspace independently of the Hub location currently displayed.

#### Scenario: Typing in a Hub form
- **WHEN** a retained Terminal is behind a Hub Settings form and the user types or presses Escape
- **THEN** the form or active sheet owns the interaction
- **AND** no terminal bytes or hidden workspace shortcuts are triggered

#### Scenario: Background workspace response
- **WHEN** a response for the retained workspace completes while Settings is active
- **THEN** it updates only its owning workspace state and does not replace Settings, steal focus, or change the Hub form

### Requirement: History preserves route and workspace identity
The mobile frontend SHALL represent Hub, Settings, task/detail location, and the workspace's canonical document/query/hash location coherently in browser history. Ordinary Back/Forward within the same retained workspace context SHALL use that context without a full document navigation. A direct load or reload SHALL use existing explicit-destination precedence and SHALL not infer a live retained instance from history alone. Managing another workspace MUST NOT change the genuine Return target. Browser history MUST NOT issue Start or silently substitute a different workspace.

#### Scenario: Manage B after opening A
- **WHEN** the user opens workspace A, visits Hub to inspect or rename B, and activates Return
- **THEN** the user returns to the retained A instance with its prior surface and document context

#### Scenario: Back from a detail view
- **WHEN** the user navigates workspace to Hub to Settings to a detail view and presses Back
- **THEN** history traverses the intended frontend locations and restores their scroll context
- **AND** workspace document-history handling does not misinterpret a Hub URL as a document selection

#### Scenario: Reload an explicit workspace link
- **WHEN** a workspace document, commit query, or anchor URL is loaded as a new document
- **THEN** that explicit destination takes precedence over saved semantic state
- **AND** the frontend does not claim an old in-memory draft or upload survived the reload

### Requirement: Authentication and explicit lifecycle outcomes override retention
Sign-out, current-session revocation, authoritative unauthorized state, workspace Stop, and workspace removal SHALL invalidate the corresponding retained access and present an appropriate recovery state. Pending responses from an older authentication or workspace generation MUST NOT restore invalid content, Return intent, or actionability. Client retention SHALL never be treated as authorization or evidence of a running server. The frontend-first review SHALL exercise these states synthetically; live enforcement remains an integration-stage acceptance requirement.

#### Scenario: Authentication expires while Settings is open
- **WHEN** the simulated current session is invalidated and a stale successful workspace response arrives later
- **THEN** the frontend shows signed-out recovery and keeps retained protected content inaccessible
- **AND** the stale response cannot restore it

#### Scenario: Retained workspace is stopped
- **WHEN** an explicit simulated Stop completes for the retained workspace
- **THEN** its live presentation becomes unavailable and Return offers the truthful stopped recovery path
- **AND** Back or Return does not start it without explicit activation through the normal start flow

### Requirement: Desktop and standalone presentation remain compatible
The continuity frontend SHALL be confined to its touch/mobile Hub integration. Existing desktop Hub routes, layout, native titlebar handling, and standalone workspace behavior SHALL not be replaced by the mobile shell. Workspace-local UI mode and preference ownership SHALL remain intact; Hub-wide presentation preferences MUST NOT overwrite workspace mode or semantic state.

#### Scenario: Desktop remains unchanged
- **WHEN** the existing Hub is opened in a fine-pointer desktop browser or native Desktop view
- **THEN** it uses the existing desktop presentation rather than the new mobile shell

#### Scenario: Standalone workspace has no Hub host
- **WHEN** a workspace is served outside a confirmed Hub context
- **THEN** no mobile Hub or Return destination is fabricated and existing standalone navigation remains usable
