## Purpose

Define the Progressive Web App installation capability for UatuCode: a valid web app manifest, raster icons, a minimal pass-through service worker, a stable default port, and the installability criteria needed for Chromium-based browsers to surface their native install affordance.

## Requirements

### Requirement: App is installable as a Progressive Web App
The UI SHALL meet Chromium's installability criteria so that Edge, Chrome, and Brave surface their native install affordance ("install app" pill, omnibox icon, or app menu entry) when a user visits the uatu URL.

#### Scenario: Install affordance appears in Edge
- **WHEN** a user visits `http://127.0.0.1:<port>/` in Microsoft Edge with no prior install
- **THEN** within 5 seconds the address bar shows the install icon
- **AND** clicking it offers to install "UatuCode"

#### Scenario: Installed app launches in standalone window
- **WHEN** the user installs the PWA and launches it from the OS launcher
- **THEN** uatu opens in a standalone window with no browser address bar, tabs, or back/forward chrome

### Requirement: Server serves a valid web app manifest
The server SHALL serve `/manifest.webmanifest` with `Content-Type: application/manifest+json`, declaring at minimum `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, and an `icons` array including 192x192 and 512x512 PNG entries with `purpose: "any"`. The HTML shell SHALL link to this manifest from `<head>`.

#### Scenario: Manifest is reachable and well-typed
- **WHEN** a client requests `/manifest.webmanifest`
- **THEN** the response status is 200
- **AND** the `Content-Type` header is `application/manifest+json`
- **AND** the JSON parses and contains `display: "standalone"` and at least one 192x192 and one 512x512 icon entry

#### Scenario: HTML links the manifest
- **WHEN** a client requests `/`
- **THEN** the returned HTML contains `<link rel="manifest" href="/manifest.webmanifest">` inside `<head>`

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

### Requirement: A minimal service worker is registered
The HTML shell SHALL register a service worker at the site root scope. The service worker SHALL declare a `fetch` handler that passes requests through to the network without caching. It SHALL NOT serve stale UI bundles, state, or terminal traffic from cache.

#### Scenario: Service worker registers on load
- **WHEN** a user loads the UI in a browser that supports service workers
- **THEN** within 5 seconds `navigator.serviceWorker.controller` is non-null
- **AND** the active worker's script URL ends in `/sw.js`

#### Scenario: Fetch is pass-through
- **WHEN** the service worker intercepts a request
- **THEN** it returns the result of `fetch(event.request)` without consulting any cache

#### Scenario: API and WebSocket traffic untouched
- **WHEN** the page fetches `/api/state` or upgrades `/api/terminal`
- **THEN** the service worker does not transform, cache, or block the request

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
