# agent-coverage-report Specification

## Purpose
Keeps a truthful, generated record of which parts of each supported agent's SDK vocabulary — message types, content parts, and tools — uatu renders on purpose, renders through a fallback, ignores deliberately, or has not decided about, so coverage gaps are visible and can be prioritized instead of discovered by accident.
## Requirements
### Requirement: Coverage is derived from the installed SDK and observed behavior

The coverage generator SHALL classify each supported agent's installed SDK vocabulary by exercising product normalization and rendering, and SHALL distinguish SDK-declared vocabulary from axes the SDK does not enumerate.

#### Scenario: Extract each supported agent's declared axes
- **WHEN** coverage is generated for any supported agent
- **THEN** extraction reads message types and subtypes, content-block or part types, and tool names where enumerated by that installed SDK
- **AND** classification MUST exercise product normalization and rendering rather than consult a maintained handling list

#### Scenario: An SDK does not enumerate an axis
- **WHEN** the installed SDK supplies no enumeration for a vocabulary axis
- **THEN** the report states that limitation instead of attributing a product-maintained list to the SDK

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

Every coverage entry SHALL have exactly one state: dedicated, generic, ignored, unhandled, or behavior-missing. The first four are observed; behavior-missing is declared by a per-agent annotation for a rendered but undelivered effect. Ignored entries SHALL have reasons. Annotations MUST name only installed-SDK entries; other names are errors. The report carries no tracking-artifact links.

#### Scenario: Explain an undelivered effect without unstable links
- **WHEN** a per-agent annotation declares behavior-missing
- **THEN** its reason MUST state what does not work and name any existing change or issue intended to fix it
- **AND** the report identifies that work without links to tracking artifacts that may move or disappear on archival

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

Publication SHALL comment on the dashboard issue when vocabulary changes, listing additions, removals, and SDK versions by agent and axis. Unchanged vocabulary MUST NOT produce a comment, even for version-only changes. With no prior vocabulary to compare, publication SHALL write a new baseline without a comment.

#### Scenario: Publish vocabulary removals as well as additions
- **WHEN** extracted vocabulary differs from the last dashboard publication
- **THEN** one dashboard comment lists added and removed entries by agent and axis, with before-and-after SDK versions
- **AND** it compares against the last published baseline across all intervening bumps, keeping their combined changes in the comment history

#### Scenario: Establish the first vocabulary baseline
- **WHEN** no previously published vocabulary is available for comparison
- **THEN** publication writes the dashboard as the new baseline without a change comment

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

The report SHALL live in one GitHub dashboard issue body in the project's repository, not a committed report. Every report-affecting default-branch change and manual request SHALL regenerate it from that branch's SDKs and code. Output MUST be deterministic; unchanged output MUST leave the issue unedited. Publication MUST run only in the project's own repository, never a fork. The README SHALL link to the dashboard. Oversized output MUST fail, naming its size, without truncation.

#### Scenario: Inspect an agent's published coverage
- **WHEN** the dashboard is regenerated
- **THEN** each agent shows its exact SDK versions and bundled CLI version where the SDK declares one
- **AND** its full entry matrix includes states and reasons alongside the count of unhandled or behavior-missing entries

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

Every pull request's unit suite SHALL validate SDK vocabulary extraction, classification, and annotations. It MUST fail for required code or annotation changes, not merely version changes, incomplete coverage, or vocabulary changes that leave annotations valid.

#### Scenario: Coverage validation requires a code or annotation correction
- **WHEN** any pull request runs the unit suite against installed SDKs
- **THEN** it MUST fail if an axis cannot be extracted, an annotation names an undeclared entry, or a deliberately ignored type has no reason
- **AND** it MUST NOT fail merely for SDK version changes, additions or removals that leave annotations valid, or incomplete coverage

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
