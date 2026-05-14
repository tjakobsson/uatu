## 1. Benchmark Setup

- [x] 1.1 Add the benchmark runner as a development dependency.
- [x] 1.2 Add a package script for running document render benchmarks locally.
- [x] 1.3 Choose and document the benchmark output format produced by the script.

## 2. Fixture Corpus

- [x] 2.1 Add a large committed Markdown benchmark fixture.
- [x] 2.2 Add a large committed AsciiDoc architecture-style benchmark fixture.
- [x] 2.3 Add a large committed source-code benchmark fixture.
- [x] 2.4 Keep fixture names stable and descriptive so benchmark scenario names remain comparable.

## 3. Render Benchmark Harness

- [x] 3.1 Implement a benchmark script that builds `RootGroup` input from the fixture corpus.
- [x] 3.2 Measure `renderDocument()` for each Markdown, AsciiDoc, and source-code scenario.
- [x] 3.3 Include rendered and source views where the document type supports both modes.
- [x] 3.4 Report stable scenario names, timing data, and rendered output size or equivalent context.
- [x] 3.5 Ensure benchmark execution does not mutate fixtures or application runtime state.

## 4. Documentation

- [x] 4.1 Document how to run the document render benchmarks locally.
- [x] 4.2 Document that the initial results are informational baselines, not hard pass/fail thresholds.
- [x] 4.3 Note that local comparisons should use the same machine under similar load.

## 5. Verification

- [x] 5.1 Run the document render benchmark command and confirm all scenarios complete.
- [x] 5.2 Run the existing render-related tests to confirm behavior is unchanged.
- [x] 5.3 Run the standard test suite or explain any skipped verification.
