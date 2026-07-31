# SAST full coverage and property-based fuzzing

## Why

OpenSSF Scorecard rates the repository 7.0. The two cheapest remaining
material wins are SAST (7/10 — CodeQL's `paths-ignore` leaves docs-only
commits unanalyzed, and the check wants every commit covered) and Fuzzing
(0/10 — no fuzzing signal at all; Scorecard recognizes property-based
testing via `fast-check` for TypeScript projects). Both also carry real
value: full CodeQL coverage removes a blind spot, and property tests
harden the input-handling code a docs previewer is built around.

## What Changes

- Remove the `paths-ignore` filters from the CodeQL workflow so every
  push to `main` and every pull request is analyzed, regardless of which
  paths changed.
- Add `fast-check` as a devDependency and introduce property-based tests
  for security-relevant, input-facing units in the existing colocated
  unit suite:
  - HTML escaping (`src/shared/html.ts`) — escaped output never contains
    active markup for arbitrary input.
  - Markdown rendering (`src/render/`) — the pipeline never throws and
    never emits script-capable markup for arbitrary source text.
  - Mermaid sanitization (`src/render/`) — sanitized output strips
    script vectors for arbitrary input.
  - Ignore engine (`src/ignore/`) — decisions are deterministic and
    consistent for arbitrary path/pattern inputs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `security-posture`: the static-analysis requirement changes from
  "analyzes TypeScript changes" to "analyzes every commit and pull
  request" (no path filters), and a new requirement mandates
  property-based testing of input-handling code.

## Impact

- `.github/workflows/codeql.yml` — drop `paths-ignore` (adds ~2 min of
  CI to docs-only PRs; acceptable).
- `package.json` / `bun.lock` — new devDependency `fast-check` (MIT
  licensed; `bun run check:licenses` must stay green).
- New colocated `*.property.test.ts` (or additions to existing
  `*.test.ts`) files under `src/shared/`, `src/render/`, `src/ignore/`.
- Expected Scorecard movement: SAST 7→10, Fuzzing 0→10, overall ≈7.0→7.5+.
