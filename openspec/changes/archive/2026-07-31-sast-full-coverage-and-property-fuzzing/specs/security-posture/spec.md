# security-posture Delta

## MODIFIED Requirements

### Requirement: Static analysis runs over the TypeScript codebase
The repository SHALL run CodeQL analysis for the `javascript-typescript` language on every pull request targeting `main`, on every push to `main`, and on a weekly schedule, uploading results to GitHub code scanning. The analysis workflow MUST NOT use path filters that exempt any commit or pull request from analysis. Analysis of the Swift desktop wrapper is explicitly out of scope for this capability's initial version.

#### Scenario: A pull request is analyzed
- **WHEN** a pull request targeting `main` is opened or updated, regardless of which paths it touches
- **THEN** CodeQL analyzes the change and reports findings to code scanning

#### Scenario: A docs-only change is analyzed
- **WHEN** a pull request or push to `main` touches only documentation, OpenSpec, or test-fixture paths
- **THEN** CodeQL still runs and produces an analysis for that commit

#### Scenario: Scheduled analysis covers the default branch
- **WHEN** the weekly CodeQL schedule fires
- **THEN** the `main` branch is analyzed even if no pull requests were opened that week

## ADDED Requirements

### Requirement: Input-handling code is property-based tested
The repository SHALL include property-based tests, using the `fast-check` library under the standard unit-test runner, for units that parse, transform, or emit untrusted input: HTML escaping, Markdown rendering, Mermaid sanitization, and the ignore engine. These tests MUST assert security invariants over generated arbitrary inputs — at minimum that rendering never throws, that escaped or sanitized output cannot carry script-capable markup (script elements, event-handler attributes, `javascript:` URLs), and that ignore decisions are deterministic. Property tests MUST run as part of the standard unit suite with bounded run counts so suite runtime stays practical.

#### Scenario: Arbitrary input cannot smuggle active markup through escaping
- **WHEN** the property suite feeds arbitrary strings through HTML escaping
- **THEN** no output contains an unescaped angle bracket or quote character

#### Scenario: Arbitrary Markdown renders safely
- **WHEN** the property suite renders arbitrary source text through the Markdown pipeline
- **THEN** rendering completes without throwing
- **AND** the emitted HTML contains no script element, inline event-handler attribute, or `javascript:` URL

#### Scenario: Property tests run in the unit suite
- **WHEN** `bun test` runs
- **THEN** the property-based tests execute with the rest of the unit suite and fail the run on any falsified property
