## MODIFIED Requirements

### Requirement: Hub manages dedicated credential runtimes
The Hub SHALL use dedicated owner-only runtime locations for every SSH or OpenPGP agent it manages and MUST give Hub clone jobs and workspace sessions explicit paths to those runtimes. It MUST NOT load keys into, lock, stop, reconfigure, or delete sockets belonging to an inherited system agent. Hub shutdown SHALL stop only agents whose ownership and lifecycle the Hub can prove; stale runtime state SHALL be validated and recovered without signaling unrelated processes. On Linux, the Hub SHALL retain enough boot identity in newly created SSH guardian ownership state to distinguish exact managed artifacts left by an earlier system boot.

#### Scenario: Ambient agents remain untouched
- **WHEN** the Hub starts with system `SSH_AUTH_SOCK` and GnuPG sockets already present
- **THEN** Hub-managed credentials use separate Hub-owned locations
- **AND** stopping or reconfiguring the Hub leaves the system agents and their identities unchanged

#### Scenario: Stale Hub socket is not trusted blindly
- **WHEN** startup finds a socket or process record in the Hub credential runtime location that it cannot prove belongs to its managed agent
- **THEN** the Hub refuses to signal that process
- **AND** it reports the affected credential runtime unavailable with recovery guidance

#### Scenario: Linux restart leaves managed SSH sockets behind
- **WHEN** startup finds an owner-only SSH guardian record from an earlier Linux boot and every remaining guardian socket exactly matches the identity recorded for it
- **THEN** the Hub removes the remaining previous-boot guardian artifacts without signaling any recorded PID
- **AND** it can start a fresh managed SSH agent without manual cleanup

#### Scenario: Previous-boot socket identity does not match
- **WHEN** startup finds a previous-boot ownership record but a remaining guardian socket does not exactly match its recorded identity
- **THEN** the Hub preserves the unprovable artifacts
- **AND** it reports the credential runtime unavailable with recovery guidance
