## ADDED Requirements

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
