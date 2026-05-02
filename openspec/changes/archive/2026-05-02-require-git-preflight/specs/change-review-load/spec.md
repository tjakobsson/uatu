## MODIFIED Requirements

### Requirement: Apply project review scoring configuration
The system SHALL read an optional `.uatu.json` file from the detected repository root and apply its `review` configuration to review-load scoring. The `review` configuration MAY define `baseRef`, score thresholds, risk areas, support areas, and ignore areas. Risk areas SHALL add score when changed files match their configured path patterns. Support areas SHALL subtract score when changed files match their configured path patterns. Ignore areas SHALL exclude matching files from score calculations while still reporting that they were excluded. The system SHALL expose loaded configured risk, support, and ignore areas to the browser UI even when they do not match the current change, so users can distinguish "configuration loaded but not matched" from "no configuration loaded". Configured areas that do not match the current change MUST be shown as zero-impact or unmatched and MUST NOT alter the review-burden score. Invalid or missing configuration MUST NOT prevent the watch session from starting.

#### Scenario: Risk area matches changed files
- **WHEN** `.uatu.json` defines a risk area with paths matching changed files
- **THEN** the review burden includes that risk area's configured score contribution
- **AND** the explanation identifies the risk area label and matched files

#### Scenario: Support area matches changed files
- **WHEN** `.uatu.json` defines a support area with paths matching changed files such as tests or documentation
- **THEN** the review burden includes that support area's configured score reduction
- **AND** the explanation identifies the support area label and matched files

#### Scenario: Ignore area matches generated files
- **WHEN** `.uatu.json` defines an ignore area matching generated or vendor files
- **THEN** matching files are excluded from score calculations
- **AND** the explanation identifies the ignored area label and excluded files

#### Scenario: Configured areas do not match the current change
- **WHEN** `.uatu.json` defines risk, support, or ignore areas
- **AND** the current changed files do not match those configured area patterns
- **THEN** the browser UI shows that the configured areas were loaded
- **AND** each unmatched configured area is shown as not matching the current change
- **AND** those unmatched configured areas do not change the review-burden score

#### Scenario: Configuration is absent
- **WHEN** no `.uatu.json` file exists at the repository root
- **THEN** the system uses built-in score thresholds and mechanical scoring defaults
- **AND** no path-based risk or support modifier is applied except built-in heuristic categories
- **AND** the browser UI does not imply that project-specific review areas were loaded

#### Scenario: Configuration is invalid
- **WHEN** `.uatu.json` cannot be parsed or contains invalid review scoring fields
- **THEN** the watch session remains usable
- **AND** invalid configuration is ignored or partially ignored in favor of defaults
- **AND** the browser UI can display a configuration warning
