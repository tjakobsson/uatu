## MODIFIED Requirements

### Requirement: Clients verify the server's build identity
The workspace server SHALL report its build identity, including version and commit, and a bundled-web contract revision to authenticated clients via the state payload. The bundled web client SHALL embed its own build identity at bundle time and SHALL compare on boot and on SSE reconnect. The web client SHALL re-establish a permanently-closed event stream itself (browsers close an EventSource for good when its automatic retry fails mid-restart), so a server restart is always eventually observed and the comparison actually runs. On mismatch the web client SHALL reload itself at most once per observed server identity; if the mismatch persists after that reload, the client SHALL display a persistent, visible stale-client notice instead of reloading again. The bundled-web contract revision SHALL govern compatibility between the server and the web assets shipped from the same product build; independently released native clients SHALL use the separately published Hub and workspace public API revisions and MUST NOT treat a product build mismatch alone as an API incompatibility.

#### Scenario: Server restart with a new build reloads the web client once
- **WHEN** the server restarts with a new build while a web client is open and the client's SSE connection re-establishes
- **THEN** the client detects the identity mismatch and reloads once
- **AND** the reloaded client matches the server and shows no notice

#### Scenario: Persistent mismatch is surfaced, not looped
- **WHEN** a reloaded web client still observes a build identity different from its own
- **THEN** the client shows a persistent stale-client notice
- **AND** does not trigger further automatic reloads for that server identity

#### Scenario: Contract break is explicit
- **WHEN** the bundled web client's embedded contract revision differs from the workspace server's bundled-web contract revision
- **THEN** the web client surfaces the mismatch visibly rather than silently continuing

#### Scenario: Native compatibility uses public API revisions
- **WHEN** a native client's product build identity differs from the server but its pinned public API revision is compatible
- **THEN** the client does not classify the build difference alone as an API incompatibility
- **AND** it determines compatibility from the published Hub or workspace API revision instead
