# pwa-install — delta

## MODIFIED Requirements

### Requirement: App is installable as a Progressive Web App
The UI SHALL meet Chromium's installability criteria so that Edge, Chrome, and Brave surface their native install affordance ("install app" pill, omnibox icon, or app menu entry) when a user visits the uatu URL, and SHALL do so from a valid manifest alone, without registering a service worker. uatu has no useful offline behavior, so installability MUST NOT depend on offline capability.

#### Scenario: Install affordance appears in Edge
- **WHEN** a user visits `http://127.0.0.1:<port>/` in Microsoft Edge with no prior install
- **THEN** within 5 seconds the address bar shows the install icon
- **AND** clicking it offers to install "UatuCode"

#### Scenario: Installed app launches in standalone window
- **WHEN** the user installs the PWA and launches it from the OS launcher
- **THEN** uatu opens in a standalone window with no browser address bar, tabs, or back/forward chrome

#### Scenario: No service worker is registered
- **WHEN** the UI finishes loading in a browser that supports service workers
- **THEN** `navigator.serviceWorker.getRegistrations()` resolves to an empty list for the app's scope

### Requirement: Server serves a valid web app manifest
The server SHALL serve `/manifest.webmanifest` with `Content-Type: application/manifest+json`, declaring at minimum `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, and an `icons` array including 192x192 and 512x512 PNG entries with `purpose: "any"`. The HTML shell SHALL link to this manifest from `<head>`. Manifest `scope` SHALL depend on the serving mode: a session served through a uatu hub SHALL declare the origin root (`/`) as its scope while keeping `start_url` and icon paths relocated under the session's base path, so that navigating to the hub dashboard, login, or a sibling session stays inside the installed app; a session served under a generic `--base-path` mount SHALL keep its scope confined to the base path, because a generic mount does not own its origin.

#### Scenario: Manifest is reachable and well-typed
- **WHEN** a client requests `/manifest.webmanifest`
- **THEN** the response status is 200
- **AND** the `Content-Type` header is `application/manifest+json`
- **AND** the JSON parses and contains `display: "standalone"` and at least one 192x192 and one 512x512 icon entry

#### Scenario: HTML links the manifest
- **WHEN** a client requests `/`
- **THEN** the returned HTML contains `<link rel="manifest" href="/manifest.webmanifest">` inside `<head>`

#### Scenario: Hub-served session manifest claims origin scope
- **WHEN** a client requests `/s/<id>/manifest.webmanifest` on a hub-served session
- **THEN** the manifest's `scope` is `/`
- **AND** its `start_url` and icon `src` values remain under `/s/<id>/`

#### Scenario: Generic base-path mount keeps path scope
- **WHEN** a client requests `<base>/manifest.webmanifest` from a session served with `--base-path <base>` outside a hub
- **THEN** the manifest's `scope`, `start_url`, and icon `src` values are all relocated under `<base>`

## REMOVED Requirements

### Requirement: A minimal service worker is registered
**Reason**: The pass-through worker existed solely to satisfy Chromium's historical install heuristic, which no longer requires a service worker for the install affordance. uatu has nothing useful to do offline, and the worker's only observable effects have been costs: it defeats request interception in E2E tests and is the standing first suspect in every stale-asset investigation.
**Migration**: None for users — installability is preserved by the manifest alone (verified as an implementation task before deletion). `src/assets/sw.js`, `registerServiceWorker()`, and the `Server-Worker-Allowed` header plumbing are deleted; browsers drop the existing registration when the script disappears (the deletion task confirms no stale registration keeps controlling pages).
