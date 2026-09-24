# agent-coverage-report Specification

## Purpose
Keeps a truthful, generated record of which parts of each supported agent's SDK vocabulary — message types, content parts, and tools — uatu renders on purpose, renders through a fallback, ignores deliberately, or has not decided about, so coverage gaps are visible and can be prioritized instead of discovered by accident.
## Requirements
### Requirement: Coverage is derived from the installed SDK and observed behavior
The repository SHALL provide a generator that, for every supported agent, reads the vocabulary its installed SDK declares — message types and subtypes, content-block or part types, and tool names where the SDK enumerates them — and classifies each entry by what the product's own normalization and rendering code does with it. Classification MUST be observed by exercising the product code, not read from a maintained list, so the report cannot disagree with the behavior it describes. Where an SDK does not enumerate a vocabulary axis, the report SHALL say so rather than presenting the product's own list as the SDK's.

#### Scenario: A vocabulary entry is classified by what the code does
- **WHEN** the generator meets a message type the normalizer produces timeline updates for
- **THEN** the entry is reported as dedicated
- **AND** a type the normalizer deliberately drops is reported as ignored
- **AND** a type the normalizer neither handles nor lists is reported as unhandled

#### Scenario: A tool without purpose-built rendering is generic, not missing
- **WHEN** the generator meets a tool name the timeline renders through its generic tool row
- **THEN** the entry is reported as generic
- **AND** it is distinguished from tools with dedicated rendering and from tools that are dropped

#### Scenario: Extraction failure is loud
- **WHEN** an SDK's declaration files change shape so that a vocabulary axis yields no entries
- **THEN** the generator fails naming the file it could not read
- **AND** no report claiming an empty vocabulary is produced

### Requirement: Coverage states are exactly five and annotations are constrained
Every entry SHALL carry exactly one of five states: dedicated, generic, ignored, unhandled, or behavior-missing. The first four are observed; behavior-missing is declared by a per-agent annotation for an entry that renders but whose effect the workspace does not deliver, and MUST carry a reason stating what does not work and, where a change or issue exists to fix it, naming that work. The report carries no links to tracking artifacts, which move or disappear as work is archived. An ignored entry SHALL carry a stated reason. An annotation MUST name only entries the installed SDK declares; an annotation naming anything else is an error.

#### Scenario: A rendered-but-inert tool is reported truthfully
- **WHEN** an annotation marks a tool as behavior-missing with a reason
- **THEN** the report shows the tool with that state and reason
- **AND** it is not counted as dedicated or generic

#### Scenario: An unexplained ignore fails
- **WHEN** the product drops a type deliberately and no annotation states why
- **THEN** the generator fails naming that entry
- **AND** the entry can be resolved only by stating a reason or by no longer ignoring the type, which reports it as unhandled

#### Scenario: A stale annotation fails
- **WHEN** an annotation names an entry that the installed SDK no longer declares
- **THEN** the generator and the freshness check fail naming that annotation

### Requirement: The committed report matches the installed SDKs
The repository SHALL commit, per agent, the generated coverage matrix and badge, and a marked README block linking each badge to its matrix. A test SHALL verify that the committed outputs equal what the generator produces for the SDK versions currently installed. That test MUST fail when a report, badge, or README block is stale, and MUST NOT fail because coverage is incomplete. The matrix and badge SHALL name the exact SDK version — and the agent CLI version the SDK bundles, where it declares one — they were generated against, and the output MUST be deterministic for a given SDK and codebase.

#### Scenario: An SDK bump without regeneration is caught
- **WHEN** an agent SDK version changes and the committed report is not regenerated
- **THEN** the freshness test fails and names the stale output

#### Scenario: Incomplete coverage does not fail
- **WHEN** the report lists unhandled or behavior-missing entries and the committed outputs are current
- **THEN** the freshness test passes

#### Scenario: Regeneration is repeatable
- **WHEN** the generator runs twice against the same SDK and codebase
- **THEN** it produces byte-identical outputs

### Requirement: New vocabulary is visible per SDK version
Each matrix SHALL list the entries that are new or removed relative to the previously committed matrix and the SDK version that matrix named, so a dependency bump shows what arrived with it.

#### Scenario: A bump shows its additions
- **WHEN** the generator runs after an SDK update that adds a message type and a tool
- **THEN** the regenerated matrix lists both under what changed since the previous version
- **AND** each also appears in its axis with its observed state

### Requirement: The badge and its link stay inside the repository
The per-agent badge SHALL be an image file committed in the repository and referenced by a repository-relative path, linking to the matrix by a repository-relative path. The README block MUST NOT reference an external image or badge service, so rendering the README anywhere — on the forge, in a local previewer, or in uatu itself — sends no reader request outside the machine. The badge SHALL state the agent, the version, and the count of entries that are unhandled or behavior-missing.

#### Scenario: The README renders offline
- **WHEN** the README is rendered from a checkout with no network access
- **THEN** every agent badge renders from a file in the checkout
- **AND** activating a badge opens that agent's matrix from the checkout

#### Scenario: The badge summarizes gaps, not a percentage
- **WHEN** a reader looks at an agent's badge
- **THEN** it shows the agent name, the SDK or CLI version, and how many entries are unhandled or behavior-missing
