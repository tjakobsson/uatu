## Why

The Hub directory browser can register and clone into existing folders, but users must leave Uatu to perform basic folder organization. Allowing authenticated users to create, rename, and remove empty folders from the same browser completes that workflow while keeping registered workspace identity and session state coherent.

## What Changes

- Add directory-browser actions to create an empty child folder, rename a folder, and remove an empty folder.
- Support renaming registered workspaces while preserving their stable workspace ids and updating every affected registered path, including registered descendants of a renamed folder.
- Require affected registered workspaces to be stopped before rename or removal, while offering an explicit confirmation that stops running sessions and continues the requested action.
- Remove the registration and associated personal and credential-assignment state when an empty registered workspace folder is removed.
- Reject unsafe or conflicting mutations, including invalid names, destination collisions, non-empty removal, active starts, and conflicts with clone targets.
- Extend the authenticated public Hub API contract for folder mutations and surface actionable filesystem errors in the dashboard.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-dashboard`: Extend the server-side directory browser with create, rename, and empty-folder removal actions, including stop-and-continue confirmations for active registered workspaces.
- `hub-service`: Coordinate filesystem mutations with stable workspace registrations, session lifecycles, personal state, credential assignments, clone reservations, and the public Hub API.

## Impact

- Hub page rendering and browser-side interactions in `src/hub/pages.ts`.
- Authenticated Hub routing and filesystem operations in `src/hub/server.ts`.
- Workspace registry mutation semantics and session lifecycle coordination in `src/hub/registry.ts` and `src/hub/sessions.ts`.
- Clone-target conflict detection and registered workspace metadata cleanup.
- Hub integration, page, registry, and session tests.
- The published Hub OpenAPI contract, route coverage, and contract fixtures; additive operations do not require a Hub API revision bump unless implementation changes an existing public operation incompatibly.
