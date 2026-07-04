## MODIFIED Requirements

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open (`--no-open`) and to disable follow mode (`--no-follow`) before the watch session starts. The local browser URL MUST be printed whether or not the browser is opened successfully. When the SPA boots with `location.pathname` resolving to a known non-binary document (anything other than `/`), the SPA MUST disable follow mode for the session regardless of the CLI default — see the `follow-mode` capability's "Follow defaults to ON; URL direct links force OFF on boot" requirement for the full rule.

The legacy `--mode` flag's deprecation window is over: `--mode` SHALL be treated as an unknown CLI argument, and the usage text MUST NOT list it. The usage text MUST list only flags the parser actually honors.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu watch docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the watch session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu watch docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the watch session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

#### Scenario: --mode flag is rejected after the deprecation window
- **WHEN** a user runs `uatu watch docs --mode=review`
- **THEN** the CLI exits with a non-zero status
- **AND** stderr names `--mode` as an unknown flag

#### Scenario: Usage text no longer advertises --mode
- **WHEN** a user runs `uatu --help`
- **THEN** the printed usage text does not mention `--mode`
- **AND** every flag listed in the usage text is accepted by the parser
