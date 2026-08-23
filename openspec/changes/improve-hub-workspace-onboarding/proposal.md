## Why

The Hub currently conflates a folder basename, a permanent URL id, and the user-facing workspace name, then combines registration with immediate session startup. Users cannot name a workspace independently, configure credentials before its first start, or create a ready-to-configure workspace under a preferred parent directory.

## What Changes

- Add a mutable workspace display name while preserving the existing stable workspace id and `/s/<id>/` URL.
- Replace the Clone-page folder browser's immediate Add-and-start behavior with an Add workspace configuration flow that registers the workspace stopped by default.
- Let users choose authentication and signing credentials before registration completes, with a separate explicit Add and start action for users who want immediate startup.
- Add a first-class Create workspace flow that creates a visible child directory under a selected parent, initializes Git, records the workspace name and credential assignments, and leaves the workspace stopped.
- Add an administrator-configurable default workspace parent directory in Hub Settings and use it as the initial location for create, clone, and folder-browse flows without restricting workspaces to that root.
- Separate workspace naming from filesystem operations: Rename workspace changes only the display name, while Rename folder changes the path and retains the stable id and display name.
- Make workspace actions reflect lifecycle state: stopped workspaces Start, running workspaces Open, and filesystem deletion remains distinct from Remove from Hub.
- Update clone completion so checkout folder name, workspace display name, retained credentials, and start-after-clone are explicit independent choices.
- Extend the public Hub API and native client models for workspace display names, onboarding configuration, default-parent settings, and atomic create/register configuration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-dashboard`: Replace immediate add/start interactions with explicit workspace configuration, creation, naming, credential selection, and state-aware actions.
- `hub-service`: Persist mutable display names, manage the default workspace parent, and atomically create or register configured stopped workspaces without changing stable ids.
- `hub-credentials`: Allow authentication and signing assignments to be selected and committed as part of workspace creation or registration before first start.

## Impact

- Workspace registry schema, migration defaults, state payloads, session navigation, and folder-mutation metadata preservation.
- Hub dashboard, Clone page, Settings page, stopped-session page, and browser-side interaction tests.
- Workspace registration, creation, clone completion, credential assignment, and lifecycle APIs in `src/hub/server.ts` and supporting services.
- Hub configuration persistence for the default workspace parent directory.
- Public OpenAPI schemas, operation inventory, API compatibility revision analysis, route coverage, guides, and integration fixtures.
- UatuCode Desktop's decoded Hub workspace model and any workspace-facing native presentation.
