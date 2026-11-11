## Purpose

Define the Progressive Web App installation capability for UatuCode: a valid web app manifest, raster icons, a stable default port, and the installability criteria needed for Chromium-based browsers to surface their native install affordance — installability comes from the manifest and icons alone.

## Requirements

### Requirement: App is installable as a Progressive Web App

The UI SHALL meet Chromium installability criteria for Edge, Chrome, and Brave, using valid manifest/icons independently of notification permission, push enrollment, service workers, or offline capability. Hub apps SHALL support push-only workers for enrollment and subscription reconciliation. Boot SHALL remove only identified legacy Uatu workers and preserve current push and unrelated registrations. Cleanup/support detection SHALL be safe and SHALL NOT block or delay boot.

#### Scenario: Install in a Chromium browser without notification prerequisites
- **WHEN** the Uatu URL is visited in Edge, Chrome, or Brave
- **THEN** valid manifest and icons allow the native install affordance independently of permission, enrollment, worker registration, or offline support

#### Scenario: Keep Hub notification support push-only
- **WHEN** a Hub-served app enrolls for notifications or reconciles an existing subscription
- **THEN** its supported worker handles those push functions and SHALL NOT intercept document/API requests or provide an offline content cache

#### Scenario: Clean legacy registrations without making boot depend on workers
- **WHEN** the UI boots, including where service workers are unavailable
- **THEN** cleanup and notification support detection are safe and SHALL NOT block or delay boot
- **AND** only identified legacy Uatu registrations are removed; current push and unrelated registrations are preserved

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

The server SHALL serve and link a valid web-app manifest with the required branding, standalone display, colors, and icon entries. Scope SHALL follow serving ownership: origin-wide for Hub-served navigation, confined to the prefix for a generic base-path mount.

#### Scenario: Discover the complete typed manifest
- **WHEN** the HTML shell and `/manifest.webmanifest` are requested
- **THEN** `<head>` links the manifest, served with `Content-Type: application/manifest+json`
- **AND** it declares at least `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, and `icons` with 192x192 and 512x512 PNG entries using `purpose: "any"`

#### Scenario: Choose manifest scope from serving ownership
- **WHEN** a manifest is served through a Hub or a generic `--base-path` mount
- **THEN** Hub scope is the origin root `/` while `start_url` and icons stay beneath the session base path, keeping dashboard, login, and sibling navigation in-app
- **AND** generic-mount scope stays confined to its base path because the mount does not own the origin

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

The server SHALL serve appropriately typed and cached raster icons derived from the logo, with padded, aspect-preserving Home Screen artwork and safe maskable bounds. Hub and workspace pages SHALL link Apple touch icons, and changed artwork SHALL receive revisioned URLs.

#### Scenario: Serve padded raster installation artwork
- **WHEN** `/assets/icon-192.png` or `/assets/icon-512.png` is requested
- **THEN** the server returns raster artwork derived from `uatu-logo.svg`, with `Content-Type: image/png` and a long `Cache-Control` lifetime
- **AND** Home Screen artwork uses opaque white, preserves logo aspect ratio, and includes visible padding

#### Scenario: Advertise maskable and Apple artwork safely
- **WHEN** icons are advertised in manifests or Hub/workspace HTML
- **THEN** any maskable mark fits completely inside the centered safe circle of radius 40% of image width, and Hub and workspace pages explicitly link Apple touch icons to the same padded artwork
- **AND** changed artwork receives a revision query in manifest and HTML icon URLs so new requests do not reuse the previous cache entry

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

Without `--port`, a session child SHALL bind port 4711, or the next available port if occupied and log the rolled port to stderr. An invocation MAY override this with `--port <n>`, honored without rolling, including `--port 0` for an ephemeral port. Hub children already use port 0: the Hub reads their kernel-assigned loopback ports from printed URLs and fronts them at its own origin. The default applies only without an explicit port.

#### Scenario: An explicit port must not roll
- **WHEN** a session invocation overrides the default with `--port <n>`
- **THEN** that port is honored without trying a subsequent port; `--port 0` instead requests kernel-assigned ephemeral behavior

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
