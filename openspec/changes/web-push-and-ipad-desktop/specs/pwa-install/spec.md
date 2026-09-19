## MODIFIED Requirements

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
