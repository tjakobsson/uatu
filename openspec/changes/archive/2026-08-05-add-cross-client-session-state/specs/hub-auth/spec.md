## MODIFIED Requirements

### Requirement: Local mode bypasses authentication on loopback
When the Hub runs in local mode it SHALL treat every request as the implicit authenticated identity named `local`: no session cookie is issued or checked, login and logout routes SHALL remain absent, and login rate limiting is inert. The stable identity SHALL own local personal workspace state across Hub restarts. Local mode SHALL remain loopback-only and MUST NOT weaken authentication outside local mode.

#### Scenario: Local mode serves without credentials
- **WHEN** a request without a cookie reaches a local Hub route
- **THEN** it is served as the implicit `local` user

#### Scenario: Local personal state has stable ownership
- **WHEN** local mode saves personal workspace state, restarts, and serves that workspace again
- **THEN** the state is resolved for the same `local` identity

#### Scenario: Login routes remain absent
- **WHEN** a request targets `/login` or `/logout` in local mode
- **THEN** the Hub responds 404

#### Scenario: Configured Hub still gates every route
- **WHEN** the Hub starts outside local mode
- **THEN** configured-user authentication remains required
