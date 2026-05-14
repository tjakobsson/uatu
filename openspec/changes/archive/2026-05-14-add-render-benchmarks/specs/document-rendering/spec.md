## ADDED Requirements

### Requirement: Preserve document rendering behavior while benchmarking
Document render benchmarks SHALL measure existing rendering behavior without changing the rendered HTML, metadata extraction, source-view behavior, or safety guarantees defined by document rendering requirements.

#### Scenario: Benchmarking does not alter Markdown rendering
- **WHEN** Markdown render benchmarks are added
- **THEN** existing Markdown rendering behavior and tests remain valid

#### Scenario: Benchmarking does not alter AsciiDoc rendering
- **WHEN** AsciiDoc render benchmarks are added
- **THEN** existing AsciiDoc rendering behavior and tests remain valid

#### Scenario: Benchmarking does not alter source rendering
- **WHEN** source-code render benchmarks are added
- **THEN** existing source-view rendering behavior and tests remain valid
