## MODIFIED Requirements

### Requirement: Dashboard and login follow uatu's visual language
Hub login, dashboard, onboarding, Settings, and session-unavailable pages SHALL retain current UatuCode branding and system-responsive light/dark and accessibility behavior. Touch/mobile presentation SHALL reproduce the screen composition, visual hierarchy, icon-and-label navigation, grouped surfaces, task sheets, spacing, and restrained translucent materials of `design/hub-mobile/refined.html` and its refined screenshots according to this change's `reference-contract.md`. The current UatuCode name and logo SHALL replace the reference's prototype branding. Fictional text and data SHALL not be treated as production facts. Reference fidelity MUST NOT be reduced to rounded desktop panels, text-only navigation, or a generic iOS-inspired palette.

The touch Hub SHALL use the reference's system-sans typographic hierarchy and subordinate human-readable path treatment; code and technical detail surfaces SHALL retain appropriate monospace typography. Existing workspace interiors SHALL not be restyled to imitate historical screenshot content. Unpictured screens and states SHALL extend the same visual language and be explicitly presented for review. Reduced motion, reduced transparency, enlarged text, forced colors, safe areas, and keyboard constraints SHALL have identifiable accessible adaptations rather than silently redefining the default visual target.

Fine-pointer desktop and native Desktop presentation SHALL retain their existing layout, typography, header treatment, and titlebar-inset behavior. Appearance changes MUST NOT disclose authenticated version or workspace information on unauthenticated pages.

#### Scenario: Both color schemes render correctly
- **WHEN** Hub pages are viewed under light and dark system schemes
- **THEN** surfaces, text, borders, disabled state, and controls adapt legibly
- **AND** dark Hub states without a direct reference image are reviewed as extensions of the same design language

#### Scenario: The dashboard reads as uatu
- **WHEN** a user familiar with the workspace SPA opens the touch dashboard
- **THEN** current UatuCode branding remains recognizable and the reference's mobile composition is reproduced
- **AND** branding preservation is not used as an exemption from navigation icons, row hierarchy, or grouped Settings

#### Scenario: Desktop presentation stays intact
- **WHEN** the Hub is opened in a desktop browser or native Desktop WebView
- **THEN** existing desktop layout, branding, native inset, and zoom behavior are not replaced by mobile chrome

#### Scenario: Default material and accessibility alternative
- **WHEN** normal light-mode Preview file controls are shown
- **THEN** their soft translucent treatment matches the refined reference rather than a dark outlined control
- **AND** an explicitly requested contrast or transparency adaptation can use a legible alternative without changing the default

### Requirement: Dashboard lists sessions and workspaces with live status
The hub SHALL serve an authenticated dashboard listing running sessions and stopped registered workspaces. Every row SHALL use the mutable workspace display name as its title and show the source path as secondary text; stable ids MAY appear as advanced URL details but MUST NOT be the primary label. Each running session SHALL provide a live shell summary sourced from the child's terminal session inventory (shell count, attached/detached, best-effort foreground-process label); desktop rows SHALL retain their existing summary placement, while touch cards SHALL expose the summary through a clearly reachable workspace-information detail without crowding the reference's identity/status/primary-action hierarchy. Each stopped workspace SHALL offer Start. Activating Open for a running session SHALL address its canonical `/s/<id>/` URL, retaining the same mounted instance when the mobile continuity context already owns that workspace. The dashboard SHALL be served under the hub origin so it shares the PWA installation with the sessions it links to.

#### Scenario: Running session shows live shell detail
- **WHEN** a session has two shells, one running a long-lived TUI, and the user opens its dashboard information
- **THEN** the desktop row or touch workspace-information detail reports the shells and the foreground-process label under its workspace display name

#### Scenario: Jump into a session
- **WHEN** the user activates Open on a running session's entry
- **THEN** the frontend addresses that session's stable `/s/<id>/` URL
- **AND** it reveals its retained mobile instance when present, otherwise loading the workspace through the normal entry path

#### Scenario: Resume a stopped workspace
- **WHEN** the user activates Start on a stopped workspace
- **THEN** the hub starts a session for it via the workspace's backend and the entry becomes running

### Requirement: Settings manages Hub credentials and tool readiness
The authenticated `/settings` page SHALL provide a Credentials area that lists credential type, declared purpose, public identifier, lock/readiness state, workspace assignments, and required-tool status. Desktop credential cards SHALL remain collapsed by default, retain their expanded state across catalog refreshes, and summarize name, type, enabled state, useful lock state, aggregate readiness, and deduplicated assigned workspace names and count without interactive controls in the summary. Touch presentation SHALL provide equivalent collapsed summaries leading to grouped details or scoped task sheets, retaining the same information and operations. Generate, import, unlock, lock, disable, test, delete, and public-key operations SHALL remain available as applicable to each actual credential type; every submitted secret SHALL use a masked input and stored private keys or tokens MUST NOT be redisplayed.

Assignment management SHALL remain workspace-oriented and initially collapsed. Workspaces with assignments SHALL list authentication and signing credentials with their roles, applicable hosts, and removal controls. The existing ability to select separate authentication and signing credentials together for any registered workspace SHALL remain available. Forms SHALL keep their layout stable, state replacement behavior, and keep the authentication-host control visible but disabled until an authentication credential is selected. Missing or incompatible tooling SHALL show an actionable explanation, detected path, optional absolute-path override, and Test action. The shared-UID advisory SHALL remain on `/settings` and `/clone`, use the existing per-user browser dismissal across both pages, and MUST NOT require repeated confirmation during assignment. Assignment presence MUST NOT be presented as credential readiness or an access-isolation boundary.

The dashboard SHALL contain sessions and workspaces only, apart from shared chrome and entry actions. Desktop shared navigation SHALL retain Dashboard, Clone, Settings, and sign out. Touch navigation SHALL use Hub and Settings destinations with Add Workspace as a Hub action and sign out reachable in Settings; `/clone` and all its operations SHALL remain reachable.

Removing an assignment from a running workspace SHALL warn that stopping terminates its shells. Disabling or confirming deletion of a provider CLI token SHALL warn that running workspaces still using the token may stop, without claiming that current assignment rows identify which sessions projected it. Confirming SHALL stop the required workspace or workspaces before changing the assignment or provider token catalog; cancelling or a failed stop SHALL leave the catalog unchanged.

Credential create/import forms, each credential action and assignment area, and each tool override row SHALL have a contextual alert for failures from their own controls. The page-level alert SHALL be reserved for load failures. SSH import SHALL prefer file upload, retain paste as a secondary option, require exactly one source, reject files larger than 1 MiB before reading them, and clear file and secret inputs after each attempt.

Running and stopped workspaces SHALL provide a neutral summary of assigned authentication and signing credential names, deduplicated by role, or `No credentials assigned` when both roles are empty. Desktop rows SHALL retain their existing summary placement. Touch cards SHALL keep that information readable in their accessible workspace-information detail, preserving the reference's primary overview hierarchy rather than hiding the information or presenting assignment as readiness. Before starting or resuming a stopped workspace with no assignments, the dashboard SHALL use an explicit confirmation that Git authentication and signing may be unavailable but the workspace can still start. Cancelling MUST NOT start it. This confirmation MUST NOT appear when any assignment exists and MUST NOT treat assignment presence as readiness. If assigned credentials require unlock, Resume SHALL request masked passphrases in context and continue the same start operation only after every unlock succeeds. Disabled or otherwise unavailable assignments SHALL remain startup errors.

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

### Requirement: Mobile navigation preserves real page boundaries and context
Mobile Hub/workspace navigation SHALL preserve canonical Hub and workspace route identities and server-owned session lifetimes, but ordinary navigation between one retained workspace and Hub/Settings SHALL occur within the same document according to `mobile-hub-continuity`. Route boundaries MUST NOT be interpreted as a requirement to reload that live mobile workspace. Back/Forward and the visible Return action SHALL address the same stable identities and preserve Hub view/filter/scroll context. A genuine new document load or page-cache restoration SHALL clear obsolete opening overlays and revalidate session state; saved hints MUST NOT claim to reconstruct memory-only work.

Surface switching and ordinary mobile Hub detours SHALL preserve the current workspace's live client state without frames. Explicit cross-workspace replacement, reload, invalidation, and server Stop remain distinct lifetime boundaries. Desktop and standalone document-navigation behavior SHALL remain unchanged.

#### Scenario: Browser Back and visible Hub action agree
- **WHEN** the user returns to a previously visited Hub view through browser history or the visible Hub action within the retained mobile context
- **THEN** its prior context is restored, stale opening feedback is cleared, and live status is revalidated without replacing the workspace document

#### Scenario: Navigation does not stop background work
- **WHEN** the user leaves the visible workspace for Hub without choosing Stop
- **THEN** no stop/kill operation is invoked and server-owned work follows the existing lifecycle
- **AND** the same mobile workspace client and unfinished client upload remain mounted during that ordinary detour

### Requirement: Mobile Hub navigation is compact without removing operations
Coarse-pointer Hub pages SHALL provide the mobile presentation, with layouts adapting to narrow screens, landscape, and text enlargement. Hub and Settings SHALL be the persistent navigation destinations. Add Workspace SHALL be a Hub action leading to the existing browse/create/clone workflows, not a permanent third tab. Workspace cards SHALL keep identity and running/stopped state readable, expose Open or Start as the primary action, and place secondary actions in an accessible menu or scoped sheet. Their workspace-information detail SHALL retain truthful shell/credential state without crowding the reference's overview composition. Native titlebar and safe-area clearance SHALL remain honored.

The mobile layout SHALL preserve folder browsing, empty-folder creation, workspace creation, Git initialization consent, separate display/folder naming, folder rename and empty-folder removal, coordinated stopping of affected nested registrations, default-parent configuration and fallback, clone options/progress/input/cancellation, credential operations, and device/session management. Operations omitted or simplified in the prototype MUST NOT be omitted from production.

#### Scenario: Reach a less-frequent folder operation
- **WHEN** a mobile user browses a registered folder and chooses its secondary actions
- **THEN** applicable folder rename/removal and workspace operations remain reachable with distinct language and existing safeguards

#### Scenario: One-handed primary action
- **WHEN** the dashboard lists running and stopped workspaces on a narrow touch viewport
- **THEN** Open/Start remain comfortable touch targets without crushing workspace names or paths

## ADDED Requirements

### Requirement: Touch Hub overview and tasks form one coherent experience
The touch dashboard SHALL use the refined reference's compact brand header, Workspaces heading, Hub-context and running-count subtitle, Running and Ready to start group labels outside cards, icon-led workspace rows, and plus-led Add Workspace action. Workspace cards SHALL clearly distinguish identity, path, status, primary Open/Start action, and a labeled circular secondary-action affordance. The authenticated version SHALL remain available in subordinate authenticated context without replacing the Hub-context subtitle. Existing shell, assignment, and readiness information SHALL remain reachable without losing the reference's primary hierarchy.

Touch Settings SHALL begin with an identity/status overview and grouped credential, workspace-preference, and account destinations. Detail rows SHALL lead to scoped detail views or focused bottom sheets rather than expanding every administrative form into the overview. Supported credential types, role/host choices, tool readiness, folder and clone operations, device management, and existing operation/cancellation semantics SHALL remain represented. Additional flows absent from the reference SHALL be reviewable extensions, not omitted capabilities.

#### Scenario: Fresh Hub composition
- **WHEN** the user opens the review dashboard with running and stopped synthetic workspaces
- **THEN** the Running and Ready to start groups, counts, folder icons, ellipsis controls, status rows, and primary actions follow the reference composition
- **AND** only Hub and Settings appear in the dock before a genuine workspace visit

#### Scenario: Settings is an overview
- **WHEN** the user opens touch Settings
- **THEN** identity/status and grouped destination rows are visible before detailed editing controls
- **AND** selecting Preview File Controls opens the corresponding bottom sheet without losing the Settings or retained workspace context

#### Scenario: Complete credential workflow remains available
- **WHEN** a reviewer selects SSH, OpenPGP, or a provider-token credential
- **THEN** its applicable existing information, actions, role/host choices, and contextual error states remain reachable through the grouped detail/task presentation
- **AND** unsupported operations are not invented to make all credential types look identical

### Requirement: Mobile docks share a reference-faithful visual vocabulary
Touch Hub and Settings navigation SHALL show icons above destination labels and a clear selected capsule. After a validated workspace visit, Return SHALL be a distinguishable leading segment with a subordinate Return to label and prominent workspace identity, followed by Hub and Settings. Duplicate names and unavailable states SHALL remain understandable. Workspace navigation SHALL retain its separate Hub action, four existing surface tabs, collapsed handle, attention signals, and dismissal rules while using coordinated iconography, geometry, and materials. Hub navigation and task sheets MUST NOT compete with a visible workspace dock for interaction.

#### Scenario: Return hierarchy
- **WHEN** a user returns to Hub after visiting workspace A
- **THEN** the dock distinguishes Return to A from the icon-and-label Hub and Settings destinations
- **AND** long or duplicate names remain readable without reducing targets below accessible size

#### Scenario: Sheet owns interaction
- **WHEN** a bottom sheet is open over Settings
- **THEN** underlying Hub navigation and the retained workspace cannot receive focus or activate through the sheet
- **AND** dismissal restores an appropriate trigger or view focus

### Requirement: Workspace branch presentation distinguishes facts from unavailable state
The mobile frontend SHALL represent named-branch, detached, unborn, non-Git, loading, and unavailable metadata without inventing a branch. A known branch SHALL use the reference's subordinate branch-icon row. Review fixtures SHALL identify these values as synthetic. Real metadata acquisition and its public API publication SHALL remain deferred until the user approves the frontend; the final integration SHALL obtain facts without starting stopped workspaces solely to inspect them.

#### Scenario: Stopped workspace with a known branch
- **WHEN** the mock backend supplies a named branch for a stopped workspace
- **THEN** its card shows that branch in the reference's secondary hierarchy
- **AND** rendering the card issues no workspace-start operation

#### Scenario: Branch unavailable
- **WHEN** metadata is unavailable or the folder is not a Git repository
- **THEN** the frontend presents the appropriate reviewed state instead of displaying a fabricated branch such as main
