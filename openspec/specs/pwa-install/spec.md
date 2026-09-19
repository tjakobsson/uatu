## Purpose

Define the Progressive Web App installation capability for UatuCode: a valid web app manifest, raster icons, a stable default port, and the installability criteria needed for Chromium-based browsers to surface their native install affordance — installability comes from the manifest and icons alone.

## Requirements

### Requirement: App is installable as a Progressive Web App
The UI SHALL meet Chromium's installability criteria so that Edge, Chrome, and Brave surface their native install affordance when a user visits the Uatu URL. Installation SHALL depend on a valid manifest and icons, not notification permission, push enrollment, a service worker, or offline capability. A hub-served app SHALL support a push-only service worker for notification enrollment and existing subscription reconciliation; that worker SHALL NOT intercept document/API requests or provide an offline content cache. Boot SHALL clean up only identified legacy Uatu service-worker registrations and SHALL preserve the current push registration and unrelated registrations. Cleanup and notification support detection SHALL be safe where service workers are unavailable and SHALL NOT block or delay boot.

#### Scenario: Install affordance appears in Edge
- **WHEN** a user visits `http://127.0.0.1:<port>/` in Microsoft Edge with no prior install
- **THEN** within 5 seconds the address bar shows the install icon
- **AND** clicking it offers to install "UatuCode"

#### Scenario: Installed app launches in standalone window
- **WHEN** the user installs the PWA and launches it from the OS launcher
- **THEN** Uatu opens in a standalone window with no browser address bar, tabs, or back/forward chrome

#### Scenario: Installation does not require push
- **WHEN** the user has not enabled notifications or has denied notification permission
- **THEN** the PWA remains installable and launches normally

#### Scenario: No service worker is registered
- **WHEN** a fresh browser profile loads a standalone session outside a hub
- **THEN** Uatu registers no service worker for that session
- **AND** installation continues to use the manifest and icons

#### Scenario: Push worker leaves normal requests alone
- **WHEN** the current push worker is registered and the page requests a document, API response, or application asset
- **THEN** the worker does not intercept the request or serve an offline content cache

#### Scenario: A legacy uatu worker is unregistered on an upgraded profile
- **WHEN** a browser profile has an identified legacy Uatu worker installed and the current UI loads
- **THEN** the legacy registration is unregistered
- **AND** a current push registration is preserved or established as part of enrollment reconciliation

#### Scenario: Reload preserves notification enrollment
- **WHEN** an enrolled browser reloads Uatu or opens a sibling hub workspace
- **THEN** legacy cleanup does not unregister its current push worker or invalidate its push subscription

#### Scenario: An unrelated worker on the same origin is left alone
- **WHEN** the origin also hosts a service worker that Uatu never registered
- **THEN** that registration is left installed

#### Scenario: Boot is unaffected where the API is unavailable
- **WHEN** the UI loads on an origin that is not a secure context or in a browser without service worker support
- **THEN** boot completes normally with no cleanup attempted
- **AND** notification settings explain the unavailable capability without a boot error

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
The server SHALL serve raster icons at `/assets/icon-192.png` and `/assets/icon-512.png` derived from the existing `uatu-logo.svg`, with appropriate `Content-Type: image/png` headers and a long `Cache-Control` lifetime. Home Screen icon images SHALL have an opaque white background and preserve the logo's aspect ratio with visible padding. Icons advertised as maskable SHALL keep the complete mark inside the centered safe circle of radius 40% of the image width. Hub and workspace pages SHALL provide an explicit Apple touch-icon link to the same padded artwork. Icon URLs in manifests and HTML metadata SHALL carry a revision query when the artwork changes so a fresh icon request does not reuse the previous HTTP cache entry.

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

#### Scenario: Home Screen compositing does not introduce a black background
- **WHEN** the platform displays a Uatu Home Screen icon
- **THEN** its source image has no transparent pixels and the space around and within the mark is opaque white
- **AND** applying a mask within the standard maskable safe-area guarantee does not clip the mark

#### Scenario: Apple installation metadata points to revised artwork
- **WHEN** a user opens a hub or workspace page to add it to the Home Screen
- **THEN** its Apple touch-icon link points to the versioned padded icon
- **AND** the applicable manifest advertises the same artwork revision

### Requirement: Server uses a stable default port
A session child SHALL bind to a stable default port (4711) when no `--port` flag is provided. If the default port is in use, the session child SHALL pick the next available port and log the rolled port to stderr. A session child's invocation MAY override the default with `--port <n>`, which is honored without rolling, including `--port 0` to opt into ephemeral port behavior. The hub starts every session child with `--port 0`, so hub-managed sessions bind kernel-assigned loopback ports that the hub reads from each child's printed URL and fronts at its own origin. The default port therefore applies to session children started without `--port`, such as a source run.

#### Scenario: Default port is used when free
- **WHEN** a session child is started with `.` and no `--port`, and port 4711 is free
- **THEN** the server binds to 4711
- **AND** the printed URL's origin is `http://127.0.0.1:4711`

#### Scenario: Default port rolls when occupied
- **WHEN** a session child is started with `.` and no `--port`, and port 4711 is already in use
- **THEN** the server binds to a free port above 4711
- **AND** writes a warning to stderr indicating the rolled port

#### Scenario: Explicit port is honored
- **WHEN** a session child is started with `. --port 9000`
- **THEN** the server binds to 9000

#### Scenario: Ephemeral port via --port 0
- **WHEN** a session child is started with `. --port 0`
- **THEN** the server binds to a kernel-assigned ephemeral port

#### Scenario: Hub-started children bind ephemeral ports
- **WHEN** the hub starts a workspace session
- **THEN** the session child is started with `--port 0` and binds a kernel-assigned loopback port
- **AND** the hub takes that port from the URL the child prints and proxies to it
