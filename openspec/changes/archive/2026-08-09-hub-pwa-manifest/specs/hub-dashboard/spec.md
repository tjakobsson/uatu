# hub-dashboard — delta

## ADDED Requirements

### Requirement: Hub pages are installable as a web app
The hub SHALL serve a web-app manifest at its origin (`/manifest.webmanifest`) declaring `name`/`short_name` branding for the hub, `display: "standalone"`, `start_url: "/"`, `scope: "/"`, and 192x192 plus 512x512 PNG icons, and the login and dashboard pages SHALL link it from `<head>`. The manifest and its icons SHALL be served without authentication, since install-time fetches may be anonymous and the manifest carries only branding. An app installed from a hub page SHALL keep the entire hub origin — login, dashboard, and every `/s/<id>/` session — inside its scope so no in-app browser chrome appears while navigating between them.

#### Scenario: Hub manifest is reachable without a session
- **WHEN** an unauthenticated client requests `/manifest.webmanifest` on a non-local hub
- **THEN** the response is 200 with `Content-Type: application/manifest+json`
- **AND** the JSON declares `scope: "/"`, `start_url: "/"`, and `display: "standalone"`

#### Scenario: Login and dashboard pages link the manifest
- **WHEN** a client requests `/login` or `/`
- **THEN** the returned HTML contains a `<link rel="manifest">` referencing `/manifest.webmanifest` inside `<head>`

#### Scenario: Installed hub app stays standalone across sign-in
- **WHEN** a user installs the hub from the dashboard on iOS, later launches it signed out, signs in, and opens a workspace session
- **THEN** every page in that flow renders standalone, with no in-app browser bars
