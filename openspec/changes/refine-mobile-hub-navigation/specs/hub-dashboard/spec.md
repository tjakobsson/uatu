## MODIFIED Requirements

### Requirement: Settings manages Hub credentials and tool readiness
The authenticated `/settings` page SHALL provide a Credentials area that lists credential type, declared purpose, public identifier, lock/readiness state, workspace assignments, and required-tool status. Desktop credential cards SHALL remain collapsed by default, retain their expanded state across catalog refreshes, and summarize name, type, enabled state, useful lock state, aggregate readiness, and deduplicated assigned workspace names and count without interactive controls in the summary. Touch presentation SHALL provide equivalent collapsed summaries leading to grouped details or scoped task sheets, retaining the same information and operations. Generate, import, unlock, lock, disable, test, delete, and public-key operations SHALL remain available as applicable to each actual credential type; every submitted secret SHALL use a masked input and stored private keys or tokens MUST NOT be redisplayed.

Assignment management SHALL remain workspace-oriented and initially collapsed. Workspaces with assignments SHALL list authentication and signing credentials with their roles, applicable hosts, and removal controls. The existing ability to select separate authentication and signing credentials together for any registered workspace SHALL remain available. Forms SHALL keep their layout stable, state replacement behavior, and keep the authentication-host control visible but disabled until an authentication credential is selected. Missing or incompatible tooling SHALL show an actionable explanation, detected path, optional absolute-path override, and Test action. The shared-UID advisory SHALL remain on `/settings` and `/clone`, use the existing per-user browser dismissal across both pages, and MUST NOT require repeated confirmation during assignment. Assignment presence MUST NOT be presented as credential readiness or an access-isolation boundary.

The dashboard SHALL contain sessions and workspaces only, apart from shared chrome and entry actions. Desktop shared navigation SHALL retain Dashboard, Clone, Settings, and sign out. Touch navigation SHALL use Hub and Settings destinations with Add Workspace as a Hub action and sign out reachable in Settings; `/clone` and all its operations SHALL remain reachable.

Removing an assignment from a running workspace SHALL warn that stopping terminates its shells. Disabling or confirming deletion of a provider CLI token SHALL warn that running workspaces still using the token may stop, without claiming that current assignment rows identify which sessions projected it. Confirming SHALL stop the required workspace or workspaces before changing the assignment or provider token catalog; cancelling or a failed stop SHALL leave the catalog unchanged.

Credential create/import forms, each credential action and assignment area, and each tool override row SHALL have a contextual alert for failures from their own controls. The page-level alert SHALL be reserved for load failures. SSH import SHALL prefer file upload, retain paste as a secondary option, require exactly one source, reject files larger than 1 MiB before reading them, and clear file and secret inputs after each attempt.

Running and stopped workspace rows SHALL show a neutral summary of assigned authentication and signing credential names, deduplicated by role, or `No credentials assigned` when both roles are empty. Before starting or resuming a stopped workspace with no assignments, the dashboard SHALL use an explicit confirmation that Git authentication and signing may be unavailable but the workspace can still start. Cancelling MUST NOT start it. This confirmation MUST NOT appear when any assignment exists and MUST NOT treat assignment presence as readiness. If assigned credentials require unlock, Resume SHALL request masked passphrases in context and continue the same start operation only after every unlock succeeds. Disabled or otherwise unavailable assignments SHALL remain startup errors.

#### Scenario: User tests a configured signing tool
- **WHEN** an authenticated user opens Credentials, configures a signing-tool path, and activates Test
- **THEN** Settings reports binary, agent, and signing readiness separately with sanitized diagnostics

#### Scenario: Stored token is never redisplayed
- **WHEN** a user returns to a saved HTTPS/provider credential
- **THEN** Settings shows its host, capabilities, state, and assignments
- **AND** no response or form value contains the saved token

#### Scenario: SSH import validates its source locally
- **WHEN** a user submits both an uploaded key and pasted key, neither source, or a file larger than 1 MiB
- **THEN** the error appears next to SSH import without reading an oversized file or replacing it with a page-level error

#### Scenario: User resumes a workspace without credential assignments
- **WHEN** a stopped workspace has no authentication or signing assignments and the user activates Resume
- **THEN** the dashboard asks whether to continue without assigned Git authentication or signing
- **AND** cancelling leaves it stopped while continuing uses the normal start operation

#### Scenario: Assigned credential is not treated as missing
- **WHEN** a stopped workspace has a locked, disabled, or unavailable assigned credential
- **THEN** the dashboard does not show the no-assignment confirmation
- **AND** a locked credential opens a masked unlock flow that resumes the same operation after successful unlock
- **AND** backend validation reports disabled or otherwise unavailable credentials

#### Scenario: Mobile credential management has full parity
- **WHEN** Settings is presented on a touch device
- **THEN** every supported credential type, capability, role, host selection, tool override, readiness check, and applicable action remains reachable
- **AND** simplified visual summaries do not replace detailed diagnostics or remove functionality absent from the mockup

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a Hub, identified by both a Hub-session-shaped base path and a Hub API answering at the origin root, the sidebar header SHALL retain its workspace switcher naming the current workspace by display name. Its menu SHALL link the dashboard and every registered workspace by display name with running or stopped state and retain sign out. Duplicate display names SHALL be disambiguated with path or stable-id detail. Touch workspace navigation SHALL additionally provide the separate Hub action specified by touch-navigation without replacing the sidebar's existing controls or content. Outside a Hub, including plain serve and an arbitrary base-path invocation without a Hub, both Hub affordances MUST stay hidden. The Hub's desktop brand header SHALL retain its centered logo, wordmark beneath, and absence of a tagline; touch Hub pages SHALL use the compact brand treatment defined for mobile presentation.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user in a Hub session opens the workspace switcher
- **THEN** they see the dashboard and sibling workspaces by display name and real running/stopped state
- **AND** a running workspace navigates to its stable session URL while a stopped workspace offers the existing Start flow

#### Scenario: Duplicate names are distinguishable
- **WHEN** two registered workspaces share a display name
- **THEN** path or stable-id detail distinguishes them without requiring unique names

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under plain serve or a base path without an answering Hub
- **THEN** neither the workspace switcher nor a Hub selector action is shown

### Requirement: Dashboard and login follow uatu's visual language
Hub login, dashboard, onboarding, Settings, and session-unavailable pages SHALL use Uatu branding, the existing assets, system-responsive light/dark colors, sans-serif body typography, and monospace for paths and code. Touch presentation SHALL use the approved iOS-inspired grouped surfaces, compact header, legible status, and restrained translucent controls without importing a fixed-scheme mock palette. Fine-pointer desktop and native Desktop presentation SHALL retain their existing layout, header treatment, and titlebar-inset behavior. Appearance changes MUST NOT disclose authenticated version or workspace information on unauthenticated pages.

#### Scenario: Both color schemes render correctly
- **WHEN** Hub pages are viewed under light and dark system schemes
- **THEN** surfaces, text, borders, disabled state, and controls adapt without illegible fixed-scheme colors

#### Scenario: The dashboard reads as uatu
- **WHEN** a user familiar with the workspace SPA opens the dashboard
- **THEN** branding and status language remain recognizably Uatu while touch presentation uses the approved grouped mobile layout

#### Scenario: Desktop presentation stays intact
- **WHEN** the Hub is opened in a desktop browser or native Desktop WebView
- **THEN** existing desktop layout, branding, native inset, and zoom behavior are not replaced by mobile chrome

### Requirement: Dashboard lists and revokes device sessions
The authenticated Hub SHALL expose the signed-in user's active device sessions through Settings, reachable from the dashboard: device label, issue time, and the current-session marker. It SHALL offer a revoke action per session. Revocation SHALL take effect server-side immediately for every transport; revoking the current session SHALL behave as sign-out. Revocation SHALL remain a POST guarded like other state-changing endpoints. Issue time MUST NOT be labeled as last activity unless the API actually provides that separate fact.

#### Scenario: Another device's session is revoked
- **WHEN** a user revokes another device's listed session
- **THEN** that device's next request is unauthenticated and the current session remains signed in

#### Scenario: The current session is marked
- **WHEN** the device list renders
- **THEN** the current session is visibly identified and its timestamp is described accurately

#### Scenario: Revoking the current session signs out
- **WHEN** a user revokes the session marked current
- **THEN** the cookie is cleared and the client lands on the login page through the existing sign-out flow

## ADDED Requirements

### Requirement: Mobile Hub navigation is compact without removing operations
Coarse-pointer Hub pages SHALL provide the mobile presentation, with layouts adapting to narrow screens, landscape, and text enlargement. Hub and Settings SHALL be the persistent navigation destinations. Add Workspace SHALL be a Hub action leading to the existing browse/create/clone workflows, not a permanent third tab. Workspace rows SHALL keep identity and truthful shell/credential state readable, expose Open or Start as the primary action, and place secondary actions in an accessible menu or scoped sheet. Native titlebar and safe-area clearance SHALL remain honored.

The mobile layout SHALL preserve folder browsing, empty-folder creation, workspace creation, Git initialization consent, separate display/folder naming, folder rename and empty-folder removal, coordinated stopping of affected nested registrations, default-parent configuration and fallback, clone options/progress/input/cancellation, credential operations, and device/session management. Operations omitted or simplified in the prototype MUST NOT be omitted from production.

#### Scenario: Reach a less-frequent folder operation
- **WHEN** a mobile user browses a registered folder and chooses its secondary actions
- **THEN** applicable folder rename/removal and workspace operations remain reachable with distinct language and existing safeguards

#### Scenario: One-handed primary action
- **WHEN** the dashboard lists running and stopped workspaces on a narrow touch viewport
- **THEN** Open/Start remain comfortable touch targets without crushing workspace names or paths

### Requirement: Return is a validated navigation intent, not a session command
After a browsing context has successfully opened a confirmed authenticated workspace, mobile Hub navigation SHALL expose a leftmost `Return to [display name]` action before Hub and Settings. A valid visit hint copied with an existing browsing session, including an opener-created or duplicated tab when the browser copies that state, SHALL count as inherited context only after fresh authentication and workspace validation. An independent context without a visit hint SHALL show only Hub and Settings. Merely viewing or managing a catalog entry MUST NOT create a visit hint. The return target SHALL be the stable identity of the last opened workspace, never the last row managed. The action SHALL remain available throughout authenticated Hub and Settings subviews while the target remains valid for the current authentication session. Display-name changes SHALL update its label; duplicate names SHALL remain distinguishable.

For a running target, Return SHALL use the existing canonical workspace navigation/resume path. For a stopped target, explicit activation SHALL use the normal credential-aware Start flow, clearly indicating the stopped state and navigating only after success. A missing registration SHALL invalidate the hint. Failed state refresh or lost authentication MUST NOT present a cached label as a verified, actionable live session. Logout, revocation, or authentication-session change SHALL invalidate the hint. Browser history restoration MUST NOT start a stopped workspace or substitute another one.

Return validation SHALL be bounded and non-blocking. It MUST NOT gate workspace boot, surface or selector readiness, or ordinary Hub operations. Pending, expired, timed-out, or failed validation SHALL withhold an actionable Return hint without disabling those other functions. Superseded responses and results from an earlier authentication session MUST NOT restore a cleared hint. Refresh after ordinary navigation, page-cache restoration, or retry SHALL use fresh authenticated state rather than trusting a copied cache alone.

#### Scenario: No Return before a visit
- **WHEN** a browser window opens Hub or Settings without a valid authenticated workspace-visit hint
- **THEN** it shows Hub and Settings without a fabricated Return action

#### Scenario: Return remains in Settings
- **WHEN** the user opens a workspace, returns to Hub, and visits Settings or credential details
- **THEN** Return remains first and addresses that opened workspace

#### Scenario: Copied browsing context is revalidated
- **WHEN** an opener-created or duplicated Hub tab receives a copied hint from a genuine workspace visit
- **THEN** it can show Return only after validating the current authentication session and workspace
- **AND** a copy without a valid hint does not invent one from the catalog

#### Scenario: Reload and Back retain only valid context
- **WHEN** a same-session tab reloads or restores Hub through Back/Forward with a saved visit hint
- **THEN** the hint is revalidated and shown only while it remains valid
- **AND** a different authentication session does not inherit it

#### Scenario: Validation is slow or unavailable
- **WHEN** the requests needed to validate Return are slow, hang, or fail
- **THEN** workspace surfaces, selector readiness, and ordinary Hub controls remain usable
- **AND** the bounded validation ends without showing a falsely verified Return action

#### Scenario: Authentication changes during validation
- **WHEN** logout, revocation, or a new authentication session occurs while Return validation is in flight
- **THEN** a late response from the previous attempt cannot restore its hint or metadata

#### Scenario: Management does not retarget history
- **WHEN** the user opens workspace A, returns to Hub, manages workspace B, and uses Back or Forward
- **THEN** workspace identity comes from navigation history and the actual visit, not the management selection
- **AND** a stopped or removed history target is explained without an implicit start or substitution

#### Scenario: Return uses current state
- **WHEN** another client renames, stops, or forgets the return target
- **THEN** fresh Hub state updates the label, offers the correct start flow, or removes the unavailable return hint respectively

### Requirement: Mobile navigation preserves real page boundaries and context
Hub/workspace navigation SHALL continue to use the existing full-page routes and server-owned session lifetimes. Back/Forward and the visible return action SHALL address the same stable workspace identities and preserve Hub page/filter/scroll context where that client already supports restoration. Loading and page-cache restoration SHALL clear obsolete opening overlays and revalidate session state. Surface switching inside a workspace SHALL continue to preserve its live client state; crossing documents SHALL use existing persisted-state and reconnection semantics instead of a new resident-workspace host.

#### Scenario: Browser Back and visible Hub action agree
- **WHEN** the user returns to a previously visited Hub page through browser history or the visible Hub action
- **THEN** its prior context is restored where available, stale opening feedback is cleared, and live status is revalidated

#### Scenario: Navigation does not stop background work
- **WHEN** the user leaves a workspace document for Hub without choosing Stop
- **THEN** no stop/kill operation is invoked and server-owned work follows the existing lifecycle
- **AND** the UI does not claim that the departed browser document or unfinished client upload remained mounted

### Requirement: Mobile forms preserve intent and in-page recovery
Scoped task sheets SHALL provide explicit completion and cancellation, accessible names, focus restoration, validation near the responsible control, and reachable controls with the keyboard or enlarged text. Leaving a dirty form SHALL offer a meaningful keep-editing/discard choice. A form presented as editing an existing credential default SHALL initialize from the current role/host default; an untouched edit form MUST NOT propose replacement. An explicit assign-new flow SHALL instead identify the chosen credential and replacement intent clearly. Backing out of a review confirmation SHALL restore the same non-secret inputs rather than discarding the form.

Unlock recovery SHALL remain within the owning form or otherwise preserve its non-secret draft. Cancelling recovery MUST NOT create a clone or apply a credential change. A separate unlock operation MUST NOT be treated as a new clone submission; continuation of an already explicitly authorized operation SHALL preserve existing semantics and MUST NOT create duplicate work. Secret values and uploaded private-key sources SHALL follow existing masking and clearing rules and MUST NOT enter navigation history or new client preference storage.

#### Scenario: Default form is unchanged
- **WHEN** the user opens a workspace's current authentication default and activates Review without editing it
- **THEN** no replacement is proposed or applied

#### Scenario: Role changes reflect the appropriate current default
- **WHEN** the user changes from authentication for a host to signing
- **THEN** the form shows the signing default, not an unrelated preselected credential

#### Scenario: Clone unlock can be cancelled
- **WHEN** a clone form requires a stored identity to be unlocked and the user cancels that recovery
- **THEN** its non-secret remote, destination, display/folder names, and choices remain available for editing
- **AND** no clone begins as a result of cancellation

### Requirement: Composite actions report partial outcomes honestly
If mobile presentation combines existing operations, it SHALL retain each operation's authorization, ordering, confirmation, and failure semantics. Stop-and-remove SHALL confirm shell termination and registration-state loss separately from keeping files, stop before forgetting, and leave a truthful stopped registration if forgetting fails. Clone and onboarding SHALL distinguish committed configuration from optional start failure and retained checkout recovery. A request being accepted or a stream closing MUST NOT be reported as success without its authoritative outcome.

#### Scenario: Stop succeeds but removal fails
- **WHEN** a confirmed composite action stops the session but cannot forget its registration
- **THEN** the UI reports that it is stopped and still registered, preserves its files and remaining configuration, and offers the appropriate retry

#### Scenario: Clone start fails after registration
- **WHEN** a requested clone start fails after its configuration committed
- **THEN** the UI identifies the preserved stopped workspace and offers correction/retry rather than claiming it was removed
