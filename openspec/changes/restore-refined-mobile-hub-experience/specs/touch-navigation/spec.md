## MODIFIED Requirements

### Requirement: Navigation presentation preserves the existing session lifecycle
Within a workspace, navigation presentation and surface switching SHALL preserve the existing live client state and terminal attachments. In an eligible touch/mobile Hub context, ordinary navigation from one retained workspace to Hub, Settings, or their detail/task views and back SHALL remain in the same document according to `mobile-hub-continuity`, preserving the same workspace instance and its ongoing client work without iframes. This client-retention behavior MUST NOT change server-owned session lifetime or treat retention as authorization.

Opening a different workspace, a genuine document reload, and existing desktop or standalone navigation SHALL retain their existing lifetime and restoration boundaries rather than claiming multiple resident workspaces. Authentication invalidation, explicit Stop, and workspace removal SHALL override retention and produce truthful recovery. A cosmetic navigation action MUST NOT stop a workspace, spawn or kill a PTY, dispose a provider's accepted work, or add an implicit takeover. The UI MUST NOT claim that a genuinely unloaded browser view or interrupted client-only operation remained mounted.

#### Scenario: Hub navigation is not Stop
- **WHEN** the user follows the Hub action from a running workspace in an eligible touch/mobile context
- **THEN** Hub is presented in the same document without calling Stop, terminating server-owned resources, or disposing the retained workspace client
- **AND** Return reveals that same workspace instance without an automatic shell, duplicate attachment, or restarted client upload

#### Scenario: Surface switching is not page navigation
- **WHEN** the user switches among Files, Preview, Chat, and Terminal
- **THEN** the current workspace document remains active with its existing surface instances and background state

#### Scenario: Desktop and cross-workspace boundaries remain distinct
- **WHEN** the user navigates through the existing desktop or standalone presentation, opens another workspace, or reloads the document
- **THEN** existing navigation and restoration semantics apply at that boundary
- **AND** the mobile Hub-detour guarantee is not presented as survival of an unloaded document or retention of multiple workspace instances

#### Scenario: Explicit invalidation overrides retention
- **WHEN** the retained workspace is stopped or removed, or its authentication session becomes invalid
- **THEN** the frontend invalidates its retained access and presents the appropriate recovery state
- **AND** history or stale responses cannot silently start a session or restore unauthorized content
