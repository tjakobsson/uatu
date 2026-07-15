# serve-cli-startup Specification (delta)

## ADDED Requirements

### Requirement: Serve exits when supervised standard input closes
The `serve` command SHALL accept an `--exit-on-stdin-close` flag. When the flag
is set, the process MUST monitor its standard input and, upon end-of-file, run
the same clean shutdown path used for SIGTERM and exit with status 0. When the
flag is not set, standard input reaching end-of-file MUST NOT affect the server's
lifetime. The flag SHALL appear in the usage text, described as intended for
supervising wrapper processes so a crashed supervisor cannot orphan the server.

#### Scenario: Supervisor crash ends the server
- **WHEN** `uatu serve --exit-on-stdin-close` runs as a child of a supervisor holding its stdin pipe
- **AND** the supervisor process dies without signalling the child
- **THEN** the server detects stdin end-of-file and shuts down cleanly

#### Scenario: Default behavior is unchanged
- **WHEN** `uatu serve` runs without the flag and its standard input closes
- **THEN** the server keeps running

#### Scenario: Flag is documented
- **WHEN** a user runs `uatu --help`
- **THEN** the usage text lists `--exit-on-stdin-close` with its supervising-wrapper purpose
