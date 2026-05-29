# document-render-benchmarks Specification

## Purpose
Define the local baseline benchmark coverage for document rendering performance.

## Requirements
### Requirement: Provide repeatable document render benchmarks
The system SHALL provide a local benchmark harness for measuring document rendering performance against a deterministic fixture corpus. The harness MUST exercise the existing document render entry point for large representative Markdown, AsciiDoc, and source-code documents, and MUST report timing results for each named scenario.

#### Scenario: Benchmark renders Markdown fixtures
- **WHEN** the document render benchmark command is run locally
- **THEN** it measures a large committed Markdown fixture through the document render path

#### Scenario: Benchmark renders AsciiDoc fixtures
- **WHEN** the document render benchmark command is run locally
- **THEN** it measures a large committed AsciiDoc architecture-style fixture through the document render path

#### Scenario: Benchmark renders source-code fixtures
- **WHEN** the document render benchmark command is run locally
- **THEN** it measures a large committed source-code fixture through the document render path

### Requirement: Report interpretable benchmark context
The benchmark output SHALL identify each render scenario by name and SHALL include enough context to compare local runs. At minimum, each scenario MUST expose timing results and the rendered output size or equivalent output-size signal.

#### Scenario: Output includes scenario names
- **WHEN** the benchmark command completes
- **THEN** the output identifies every measured scenario with a stable human-readable name

#### Scenario: Output includes render result context
- **WHEN** a scenario is measured
- **THEN** the benchmark output includes timing data and a rendered output size or equivalent context for that scenario

### Requirement: Document local benchmark usage
The project SHALL document how to run the document render benchmarks locally and SHALL state that the initial benchmark is an informational baseline rather than a strict pass/fail performance gate.

#### Scenario: User can find benchmark command
- **WHEN** a developer wants to measure document render performance locally
- **THEN** project documentation or package scripts identify the benchmark command to run

#### Scenario: Documentation explains baseline interpretation
- **WHEN** a developer reads the benchmark documentation
- **THEN** it explains that results should be compared on the same machine under similar conditions and are not hard performance thresholds

### Requirement: Comparative source-render benchmark gates the source-view wrap implementation

The project SHALL provide a repeatable, throwaway benchmark harness (under
`tests/`, not `src/`) that renders identical source fixtures two ways — the
current highlight.js source renderer and the `@pierre/diffs` virtualized
code viewer — **both without word-wrap** — and reports comparable metrics
so the team can choose the source-view wrap implementation on evidence.
The harness SHALL exercise a file-size curve (at least: small ~100 lines,
medium ~2k lines, large ~20k lines, and near the source highlight size
cap) across at least one light grammar and one heavy grammar. It SHALL
report, per case, time-to-first-paint, a cold-vs-warm distinction, rendered
DOM node count, and a scroll-smoothness signal on the large fixture. The
benchmark's pass criteria SHALL be recorded before the measurement is run,
and the outcome SHALL determine whether source-view wrap is implemented via
a homegrown per-line gutter or by adopting the Pierre code viewer.

#### Scenario: Harness compares both renderers on the same fixtures
- **WHEN** the benchmark is run
- **THEN** it renders each fixture with both the highlight.js renderer and the Pierre code viewer
- **AND** it reports time-to-first-paint, cold-vs-warm, DOM node count, and a scroll-smoothness signal for each

#### Scenario: Outcome is judged against pre-committed criteria
- **WHEN** the benchmark results are available
- **THEN** they are compared against the pass criteria recorded beforehand
- **AND** the comparison selects either the homegrown per-line gutter path or the Pierre code-viewer path for source-view wrap

#### Scenario: Wrap-mode stress is measured before adopting Pierre
- **WHEN** the Pierre code viewer passes the unwrapped baseline
- **THEN** a follow-up measurement renders the large fixtures with the library's wrap mode enabled
- **AND** the wrap-mode result is included in the adoption decision
