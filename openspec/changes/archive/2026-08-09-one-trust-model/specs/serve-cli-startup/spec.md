# serve-cli-startup — delta

## ADDED Requirements

### Requirement: Bare serve invocation warns of deprecation
A user-invoked `uatu serve` (or the `watch` alias) SHALL print a single stderr line stating that serve is deprecated as a public command, that `uatu hub` is the way to run uatu, and that direct serve will be removed in a future release. The warning MUST NOT change exit codes or any serve behavior, and it MUST NOT appear for hub-spawned session children or for the repository's dev/e2e harness invocations (the hub controls the child argv and suppresses it).

#### Scenario: Bare invocation warns once
- **WHEN** a user runs `uatu serve docs/` from a terminal
- **THEN** stderr contains one deprecation line naming `uatu hub`
- **AND** the session starts and behaves exactly as before

#### Scenario: Hub-spawned children stay quiet
- **WHEN** the hub starts a workspace session through its backend
- **THEN** the child's output contains no deprecation warning
