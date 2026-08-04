# serve-cli-startup Delta Spec

## ADDED Requirements

### Requirement: Serve accepts a base path flag
`uatu serve` SHALL accept a `--base-path <prefix>` flag whose value is a normalized absolute path prefix (leading slash required; a trailing slash is accepted and normalized), defaulting to `/`. The session URL printed at startup — both the TTY banner and the single piped-stdout URL line consumed by supervisors — SHALL include the prefix so a supervisor can load the session without reconstructing it. An invalid value (no leading slash, embedded whitespace, or path traversal segments) SHALL fail startup with a usage error. The flag SHALL compose with existing flags (`--no-open`, `--exit-on-stdin-close`, port selection) without behavioral interaction beyond the URL shape.

#### Scenario: Prefixed URL is printed for supervisors
- **WHEN** `uatu serve <folder> --no-open --base-path /s/uatu/` starts with piped stdout
- **THEN** the single URL line printed includes the `/s/uatu/` prefix

#### Scenario: Invalid base path fails fast
- **WHEN** `uatu serve <folder> --base-path relative/path` is invoked
- **THEN** the process exits non-zero with a usage error before any server starts

#### Scenario: Omitted flag preserves today's output
- **WHEN** `uatu serve <folder>` runs without `--base-path`
- **THEN** startup output and the session URL are identical to behavior before this flag existed
