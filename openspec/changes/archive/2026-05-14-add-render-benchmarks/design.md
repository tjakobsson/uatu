## Context

The current document rendering path is implemented in Bun/TypeScript and covers Markdown, AsciiDoc, and source-code views. Rendering performance is currently judged by feel, and the project does not have a benchmark harness or fixture corpus for isolating document render cost from server startup, file watching, browser rendering, or user interaction.

The first useful baseline should measure the render pipeline directly. That means benchmarking existing render entry points with representative fixture documents and reporting results in a format that can be compared locally over time.

## Goals / Non-Goals

**Goals:**
- Add a local benchmark harness for document rendering.
- Use large realistic fixture documents for Markdown, AsciiDoc, and source-code rendering.
- Exercise rendered and source views where those modes differ.
- Report enough context to interpret results, including scenario name, timing, and rendered output size.
- Keep benchmarks easy to run from the existing Bun project workflow.

**Non-Goals:**
- Optimize rendering performance in this change.
- Add hard CI performance gates.
- Benchmark browser layout, Mermaid client-side rendering, file watching, server startup, or SSE refresh behavior.
- Replace existing unit or end-to-end tests.

## Decisions

1. Use a function-level benchmark harness centered on `renderDocument()`.

   `renderDocument()` includes the real branch selection, file read, metadata/title behavior, and render output shape. Starting here keeps the baseline close to the behavior users experience while avoiding unrelated server and watcher noise.

   Alternative considered: benchmark only lower-level helpers such as `renderMarkdownToHtml()` or `renderAsciidocToHtml()`. Those are useful for later diagnosis, but they omit file read and entry-point behavior, so they are less suitable as the first baseline.

2. Use `mitata` for local render benchmarks.

   `mitata` is designed for JavaScript micro/function benchmarks and is recommended by the Bun documentation for this type of measurement. It fits direct calls into render functions better than process-level tools.

   Alternative considered: use `hyperfine`. `hyperfine` is stronger for whole-command benchmarking, but document render performance is better measured inside the process with stable prepared fixtures.

3. Keep fixture workloads deterministic and committed.

   The corpus should be representative enough to expose obvious differences between Markdown parsing, AsciiDoc conversion, syntax highlighting, large text handling, and many code blocks. It should avoid tiny fixtures and instead use one large committed fixture for each major render path: Markdown, AsciiDoc, and source code. Fixtures should be static files so local results are repeatable, reviewable, and any workload change is visible in diffs.

   Alternative considered: generate large fixtures during the benchmark. Dynamic generation keeps the repository smaller, but makes it harder to inspect exactly what is measured and can hide workload changes inside script logic.

4. Treat benchmark output as an informational baseline.

   The initial output should help compare local runs and identify slow scenarios. It should not fail CI on normal variance until the project has enough history to set meaningful thresholds.

   Alternative considered: add strict performance thresholds immediately. That risks noisy failures and optimization pressure before the baseline is trusted.

## Risks / Trade-offs

- Benchmark numbers vary by machine and load -> Document that local comparisons should be made on the same machine under similar conditions.
- Fixtures may drift away from real user documents -> Include small examples plus larger committed workloads modeled on real document shapes.
- `renderDocument()` includes file I/O -> Keep this intentionally for the first baseline, and use lower-level helper benchmarks later if diagnosis needs CPU-only measurements.
- Benchmark dependency adds project weight -> Keep the dependency dev-only and limited to the benchmark script.
- Output can be mistaken for a pass/fail contract -> Avoid hard thresholds in this change and describe results as baselines.

## Migration Plan

No migration is required. The change adds benchmark assets and scripts without changing runtime behavior. Rollback is removing the benchmark script, fixtures, package script, and benchmark dependency.

## Open Questions

- Should a later change add a lightweight CI smoke benchmark, or should benchmark execution remain local-only until stable baseline history exists?
- Should future diagnosis add lower-level benchmarks for individual render helpers once the first baseline identifies slow scenarios?
