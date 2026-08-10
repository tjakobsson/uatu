## Purpose

Define the Progressive Web App installation capability for UatuCode: a valid web app manifest, raster icons, a stable default port, and the installability criteria needed for Chromium-based browsers to surface their native install affordance — installability comes from the manifest and icons alone.

## Requirements

### Requirement: App is installable as a Progressive Web App
The UI SHALL meet Chromium's installability criteria so that Edge, Chrome, and Brave surface their native install affordance ("install app" pill, omnibox icon, or app menu entry) when a user visits the uatu URL, and SHALL do so from a valid manifest alone, without registering a service worker. uatu has no useful offline behavior, so installability MUST NOT depend on offline capability. The no-service-worker state SHALL hold for profiles upgraded from a version that did register one: at boot the UI SHALL unregister service workers left behind by an earlier uatu, identified by the scopes uatu previously registered under (the session's base path and the origin root) together with the script path it previously registered. A worker outside that identification MUST NOT be unregistered, because the origin may be shared with an unrelated application. The cleanup SHALL be safe where the API is unavailable — an insecure origin, or a browser without service worker support — and SHALL NOT block or delay boot.

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

#### Scenario: A legacy uatu worker is unregistered on an upgraded profile
- **WHEN** a browser profile that loaded an earlier uatu still has that version's service worker installed and controlling its scope, and the current UI loads
- **THEN** the legacy registration is unregistered
- **AND** `navigator.serviceWorker.getRegistrations()` resolves to an empty list for the app's scope

#### Scenario: An unrelated worker on the same origin is left alone
- **WHEN** the origin also hosts a service worker that uatu never registered — a different scope, or a different script path
- **THEN** that registration is left installed and controlling its scope

#### Scenario: Boot is unaffected where the API is unavailable
- **WHEN** the UI loads on an origin that is not a secure context, or in a browser without service worker support
- **THEN** boot completes normally with no error surfaced and no cleanup attempted

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

### Requirement: Server serves PWA icons
The server SHALL serve raster icons at `/assets/icon-192.png` and `/assets/icon-512.png` derived from the existing `uatu-logo.svg`, with appropriate `Content-Type: image/png` headers and a long `Cache-Control` lifetime.

#### Scenario: 192px icon is reachable
- **WHEN** a client requests `/assets/icon-192.png`
- **THEN** the response status is 200
- **AND** the `Content-Type` header is `image/png`
- **AND** the response body is a valid PNG image with width and height of 192 pixels

#### Scenario: 512px icon is reachable
- **WHEN** a client requests `/assets/icon-512.png`
- **THEN** the response status is 200
- **AND** the `Content-Type` header is `image/png`
- **AND** the response body is a valid PNG image with width and height of 512 pixels

### Requirement: Server uses a stable default port
The server SHALL bind to a stable default port (4711) when no `--port` flag is provided. If the default port is in use, the server SHALL pick the next available port and log the rolled port to stderr. Users SHALL be able to override the default with `--port <n>`, including `--port 0` to opt into ephemeral port behavior.

#### Scenario: Default port is used when free
- **WHEN** the user runs `uatu watch .` and port 4711 is free
- **THEN** the server binds to 4711
- **AND** the printed URL is `http://127.0.0.1:4711`

#### Scenario: Default port rolls when occupied
- **WHEN** the user runs `uatu watch .` and port 4711 is already in use
- **THEN** the server binds to a free port above 4711
- **AND** writes a warning to stderr indicating the rolled port

#### Scenario: Explicit port is honored
- **WHEN** the user runs `uatu watch . --port 9000`
- **THEN** the server binds to 9000

#### Scenario: Ephemeral port via --port 0
- **WHEN** the user runs `uatu watch . --port 0`
- **THEN** the server binds to a kernel-assigned ephemeral port
