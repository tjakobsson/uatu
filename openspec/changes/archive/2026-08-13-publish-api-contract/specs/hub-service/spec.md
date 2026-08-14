## ADDED Requirements

### Requirement: Hub reports its public API compatibility identity
The Hub SHALL expose an authenticated machine-readable compatibility identity containing its public Hub API revision and the public workspace API revision expected behind its proxied workspace routes. These revisions SHALL identify wire-contract compatibility independently from the product version and source-build identity, and SHALL correspond to published contract metadata. Clients MUST NOT need to infer API compatibility from a display-formatted version string.

#### Scenario: Native client probes Hub compatibility
- **WHEN** an authenticated native client requests Hub state
- **THEN** the response identifies the Hub API revision and proxied workspace API revision as machine-readable values
- **AND** the values can be matched to published contract revisions

#### Scenario: Product release does not imply a contract break
- **WHEN** the product version changes without an incompatible Hub or workspace wire-contract change
- **THEN** the corresponding public API revision remains unchanged
