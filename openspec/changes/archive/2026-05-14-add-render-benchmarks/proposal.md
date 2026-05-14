## Why

Document rendering feels slow today, but there is no repeatable local baseline for comparing render performance before optimization work begins. We need stable numbers for representative Markdown, AsciiDoc, and source-code render paths so future tuning can target measured bottlenecks instead of perception.

## What Changes

- Add a local document-render benchmarking capability focused on the existing render pipeline.
- Introduce a representative fixture corpus covering small, large, and syntax-heavy documents.
- Add repeatable benchmark execution that reports render timings and useful context such as output size.
- Document how to run the benchmarks locally and how to interpret results.
- Do not change rendering behavior or optimize render internals as part of this change.

## Capabilities

### New Capabilities
- `document-render-benchmarks`: Defines the local benchmark baseline for document rendering scenarios.

### Modified Capabilities
- `document-rendering`: Adds requirements for preserving existing rendering behavior while introducing render benchmarks.

## Impact

- Affected areas: benchmark scripts, package scripts, fixture files, and documentation.
- Existing render code may be imported by the benchmark harness but should not receive behavioral changes.
- Likely dependency impact: add a benchmark runner suitable for Bun function-level measurements, such as `mitata`.
- CI impact should be minimal; any automated benchmark use should be informational or smoke-level unless thresholds are explicitly introduced later.
