# hub-dashboard — delta

## ADDED Requirements

### Requirement: Dashboard lists and revokes device sessions
The dashboard SHALL show the signed-in user's active sessions — device label, issue time, and which one is the current session — and SHALL offer a revoke action per session. Revoking SHALL take effect server-side immediately for every transport; revoking the current session behaves as sign-out. Revocation SHALL be a POST guarded like other state-changing endpoints.

#### Scenario: Another device's session is revoked
- **WHEN** a user revokes a listed session belonging to another device
- **THEN** that device's next request is treated as unauthenticated
- **AND** the current browser session remains signed in

#### Scenario: The current session is marked
- **WHEN** the sessions list renders
- **THEN** the session serving the request is visibly identified as the current one

#### Scenario: Revoking the current session signs out
- **WHEN** a user revokes the session marked as current
- **THEN** the response clears the cookie and lands on the login page
