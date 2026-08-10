## MODIFIED Requirements

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
