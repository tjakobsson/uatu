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
- **THEN** the generator and the unit suite fail naming that annotation

### Requirement: New vocabulary is visible per SDK version
When publication finds that the vocabulary differs from what the dashboard last published, it SHALL post a comment on the dashboard issue listing, per agent and per axis, the entries added and removed, together with the SDK versions before and after. The comment thread is the history of what each bump brought. A publication whose vocabulary is unchanged MUST NOT post a comment, even when versions changed. Several bumps that land before one publication SHALL be reported together, so no change is lost. When there is no previously published vocabulary to compare against, publication SHALL publish the dashboard as the new baseline and post no comment.

#### Scenario: A bump shows its additions
- **WHEN** publication runs after an SDK update that adds a message type and a tool
- **THEN** a comment on the dashboard names both under their axes, with the previous and current SDK versions
- **AND** each also appears in its axis on the dashboard with its observed state

#### Scenario: A version-only bump posts nothing
- **WHEN** publication runs after an SDK update that adds and removes nothing
- **THEN** the dashboard shows the new version
- **AND** no comment is posted

#### Scenario: Bumps between publications are reported together
- **WHEN** two SDK updates are merged and only the later one is followed by a completed publication
- **THEN** the single comment lists the vocabulary changes of both, against the last published versions

#### Scenario: No baseline posts no comment
- **WHEN** the dashboard has never been published, or its recorded vocabulary cannot be read
- **THEN** publication writes the dashboard as the new baseline
- **AND** no comment is posted

### Requirement: The report is published to a dashboard issue
The report SHALL be published as the body of one GitHub issue in the project's repository, the coverage dashboard, and not committed to the repository. After every change on the default branch that can change the report, and on manual request, the dashboard SHALL be regenerated against the SDK versions and code on that branch. For each agent it SHALL show the exact SDK versions it was generated against (and the agent CLI version the SDK bundles, where the SDK declares one), the number of unhandled or behavior-missing entries, and the full matrix of entries with their states and reasons. Output MUST be deterministic for a given set of SDKs and codebase. Publishing an unchanged report MUST leave the issue unedited. The README SHALL link to the dashboard. Publication MUST run only in the project's own repository, never in a fork. If the report outgrows what an issue body can hold, publication MUST fail, naming the size, and MUST NOT publish a truncated report.

#### Scenario: A merge that changes coverage updates the dashboard
- **WHEN** a change that alters how a normalizer treats a type is merged to the default branch
- **THEN** the dashboard shows that entry in its new state
- **AND** the gap count for that agent reflects it

#### Scenario: Republishing an unchanged report is a no-op
- **WHEN** publication runs twice against the same SDKs and codebase
- **THEN** it produces byte-identical dashboard content both times
- **AND** the second run does not edit the issue

#### Scenario: The repository carries no generated report
- **WHEN** a contributor bumps an agent SDK or changes a normalizer
- **THEN** no file in the repository has to be regenerated or committed for the report
- **AND** the README links to the dashboard issue

#### Scenario: A fork does not publish
- **WHEN** the publication workflow runs in a repository other than the project's own
- **THEN** it does nothing

#### Scenario: An oversized report fails instead of truncating
- **WHEN** the rendered dashboard exceeds the size an issue body accepts
- **THEN** publication fails, naming the rendered size and the limit
- **AND** the previous dashboard is left as it was

### Requirement: A dependency bump fails CI only when code must change
The unit suite SHALL, on every pull request, run vocabulary extraction, classification and annotation validation against the installed SDKs. It MUST fail when uatu's code or annotations have to change: an axis can no longer be extracted, an annotation names an entry the installed SDK does not declare, or a deliberately ignored type has no stated reason. It MUST NOT fail because an SDK version changed, because entries were added or removed without making an annotation stale, or because coverage is incomplete.

#### Scenario: A version-only bump passes
- **WHEN** a pull request changes only an agent SDK version and the SDK's vocabulary is unchanged
- **THEN** the unit suite passes

#### Scenario: A bump that adds vocabulary passes
- **WHEN** a pull request bumps an SDK that declares a new tool and a new message type
- **THEN** the unit suite passes
- **AND** after merge the dashboard lists both, in whatever state uatu's code puts them in

#### Scenario: A bump that strands an annotation fails
- **WHEN** a pull request bumps an SDK that no longer declares an entry an annotation names
- **THEN** the unit suite fails, naming that annotation

#### Scenario: A bump that breaks extraction fails
- **WHEN** a pull request bumps an SDK whose declaration files changed shape so that an axis yields no entries
- **THEN** the unit suite fails, naming the file it could not read
