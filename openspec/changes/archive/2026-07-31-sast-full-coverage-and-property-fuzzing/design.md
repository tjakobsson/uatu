# Design — sast-full-coverage-and-property-fuzzing

## Context

CodeQL currently runs on push/PR/schedule but with `paths-ignore` for
`**/*.md`, `docs/**`, `openspec/**`, `testdata/**` — so commits touching
only those paths produce no analysis run, which Scorecard's SAST check
penalizes ("SAST tool detected but not run on all commits"). Scorecard's
Fuzzing check detects `fast-check` usage in TypeScript projects as
property-based testing and scores it 10. The unit suite is Bun test with
colocated `foo.test.ts` siblings.

## Goals / Non-Goals

**Goals:**

- CodeQL analyzes every commit on `main` and every PR.
- Genuine property-based tests over the code that parses or emits
  untrusted input, using `fast-check` under `bun test`.
- Keep the unit suite fast (property tests bounded to default run counts;
  suite stays well under a minute of added time).

**Non-Goals:**

- No OSS-Fuzz / ClusterFuzzLite integration — heavyweight for a local
  docs previewer.
- No Signed-Releases or CII-badge work (separate changes).
- No AsciiDoc property fuzzing — asciidoctor.js is a large Ruby
  transpile; throwing arbitrary bytes at it is slow and its failure
  modes are upstream's. Markdown, escaping, sanitization, and ignore
  logic are ours and fast.

## Decisions

- **Drop `paths-ignore` entirely rather than curating it.** Any
  path-based carve-out reintroduces unanalyzed commits; the cost of a
  full CodeQL pass (~2 min on this repo) on docs-only changes is
  acceptable, and the weekly-backstop comment in the workflow becomes
  moot but the schedule stays as defense in depth.
- **`fast-check` as the property-testing library.** It is the ecosystem
  standard, MIT-licensed, works under Bun's Jest-compatible `test`/`expect`,
  and is what Scorecard's Fuzzing check recognizes for JavaScript/TypeScript.
- **Property tests live next to the units they test** (repo convention:
  colocated tests). Added to the existing `*.test.ts` siblings rather
  than a parallel suite, using `fc.assert(fc.property(...))` inside
  ordinary `test()` blocks so `bun test` runs them with everything else.
- **Properties assert security invariants, not exact output.**
  - `escapeHtml`: for arbitrary strings, output contains no `<`, `>`,
    or unescaped quotes; escaping is idempotent-safe on round-trip
    through a text node.
  - Markdown render: for arbitrary source, rendering resolves without
    throwing and the emitted HTML contains no `<script`, no
    `javascript:` URLs, and no inline event-handler attributes
    (the sanitizer's contract).
  - Mermaid sanitization: for arbitrary input embedded in a mermaid
    block, script vectors do not survive sanitization.
  - Ignore engine: same path + same rules ⇒ same decision across calls;
    a path ignored by a rule set stays ignored when unrelated rules are
    appended (monotonicity where the engine guarantees it).
- **Bounded run counts.** Default `fc.assert` runs (100) per property;
  no `numRuns` inflation in CI. Determinism via fast-check's seed
  reporting on failure (seed logged so failures are reproducible).

## Risks / Trade-offs

- [Property tests surface a real pre-existing bug and fail CI] → that is
  the point; fix or narrow the property with a documented issue link,
  never delete the invariant silently.
- [CodeQL on docs-only PRs wastes runner minutes] → bounded (~2 min),
  and required-check status comes from `validate`/`validate-specs`, not
  CodeQL, so merge latency is unaffected.
- [fast-check generators slow the suite] → bounded run counts; the four
  target units are pure functions or near-pure, each property runs in
  milliseconds.

## Migration Plan

Single PR; revert the commit to roll back. Scorecard re-scores on the
next push to `main` (or manual `workflow_dispatch` of the Scorecard
workflow).
