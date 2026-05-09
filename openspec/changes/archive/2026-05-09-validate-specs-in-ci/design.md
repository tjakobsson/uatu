## Context

The CI workflow today (`.github/workflows/ci.yml`) is a single `validate` job that installs Bun, installs Playwright, runs unit tests, runs the license audit, builds the standalone executable, and runs the Playwright e2e suite. It takes minutes. None of those steps depend on OpenSpec spec health, and none of them detect spec breakage — a malformed `### Requirement:` header or an empty capability would land silently.

Locally, `openspec validate --all --strict` runs in seconds and catches every structural issue OpenSpec knows about (missing scenarios, empty specs, header format violations, delta application errors). Yesterday's `split-document-watch-browser` change made this concrete: the validator caught an attempted empty-capability spec at archive time, and the only reason we noticed early was that I happened to run it. CI should be that watchdog by default.

The `repository-workflows` capability already governs CI shape and explicitly requires pinned action references and a pinned Bun runtime. Adding a new check needs to fit that posture.

## Goals / Non-Goals

**Goals:**
- Run `openspec validate --all --strict` on every PR and every push to `main`, with failure blocking the merge.
- Do it without slowing down the existing `validate` job — spec validation has no dependency on tests, build artifacts, or Playwright.
- Keep version drift under control: pin the OpenSpec CLI the same way the rest of the toolchain is pinned, and put it on Renovate so it doesn't go stale.
- Keep the spec contract honest: the `repository-workflows` requirement that lists minimum automated checks should mention spec validation if we treat it as required.

**Non-Goals:**
- Path-filtered triggers (e.g. only-when-`openspec/**`-changes). Required-checks + path-filtered triggers interact poorly with GitHub's "skipped" status; the simpler always-on approach costs ~15 seconds per PR.
- A pre-commit hook for spec validation. Local hooks are out of scope here; this change is about making CI the load-bearing check.
- Validating archived changes. `openspec validate --all` covers active specs and in-flight changes; archives are intentionally frozen and not validated.
- Publishing or consuming a third-party "openspec-action" composite Action. None exists upstream, and a `bunx` one-liner is simpler than introducing a Marketplace dependency.
- Adding `--json` output / artifact upload. The default human output is already readable; we can revisit if a reporting need emerges.

## Decisions

### Decision 1: New parallel job, not an inline step

**Choice:** Add a new top-level job `validate-specs` to `ci.yml`. It runs in parallel with the existing `validate` job.

**Alternatives considered:**
- *Inline step in `validate`.* Rejected — spec validation depends on nothing the `validate` job does (no build, no install, no Playwright). Inlining serializes it behind work it doesn't need, and a spec-only PR would still wait for the full e2e suite to finish before getting feedback.
- *Pre-commit hook.* Useful but separate concern. CI is the contract that blocks merges; a hook is contributor convenience.

**Rationale:** Spec PRs get fast feedback (~30s vs minutes). Failure messages are localized. Required-status is per-job, so the new check is a clean signal in the PR UI.

### Decision 2: `bunx`, not `npx`

**Choice:** Run the validator via `bunx @fission-ai/openspec@<version> validate --all --strict`. No `actions/setup-node` step.

**Alternatives considered:**
- *`npx` with `actions/setup-node`.* Adds a setup step and a second runtime to install. Pure overhead since Bun is already installed.
- *Run from a project script (e.g. `bun run openspec:validate`).* Equivalent, slightly more indirection. Worth doing if we end up wrapping the command in a script for local use too — leave that as a follow-up.

**Rationale:** Probed locally — `bunx @fission-ai/openspec@1.2.0 validate --all --strict` works end-to-end against this repo. Bun's npm-package execution covers OpenSpec's needs. Avoiding `setup-node` keeps the new job lean.

### Decision 3: Pin via devDependency, not a floating tag

**Choice:** Add `@fission-ai/openspec` to `devDependencies` in `package.json`. CI invokes `bunx @fission-ai/openspec validate --all --strict` (resolved through the lockfile, not from npm at runtime).

**Alternatives considered:**
- *`bunx @fission-ai/openspec@latest`.* Floats — silent breakage on a major release.
- *`bunx @fission-ai/openspec@1.2.0` (literal pin in YAML).* Pins, but invisible to Renovate; updates require manual edits to `ci.yml`.

**Rationale:** A devDependency lives in `bun.lock`, gets the same Renovate treatment as everything else, and avoids drift between CI and local. The marginal cost is 284 transitive packages added to `node_modules` — small, and only at install time.

### Decision 4: Modify `repository-workflows` rather than add a new capability

**Choice:** Extend the existing "GitHub Actions validate the repository on GitHub" requirement to include OpenSpec validation in the minimum-checks list, plus one scenario.

**Alternatives considered:**
- *New capability `openspec-ci`.* Massive overkill for one CI step.
- *No spec change.* Defensible (the existing requirement says "at minimum"), but then the new check exists outside the spec contract — future contributors might remove it without realizing it's intentional.

**Rationale:** This is exactly what `repository-workflows` is for. One small REPLACE-style modification keeps the spec honest about what CI guarantees.

## Risks / Trade-offs

- **[Risk] `bunx` pulls 284 packages each fresh CI run.** → **Mitigation:** Bun's install is fast and cached at the action level via `bun install --frozen-lockfile` in the existing job. The new job will install dependencies the same way before running `bunx`, so the `@fission-ai/openspec` package resolves through the lockfile, not the registry. Cold-start cost: ~15s on a fresh runner.
- **[Risk] OpenSpec releases break our specs on Renovate auto-update.** → **Mitigation:** Renovate raises a PR for the upgrade; CI runs `validate --all --strict` against the new version on that PR. Breakage surfaces before merge, not after.
- **[Risk] Adding a required check could slow merges if the validator has flaky network behavior.** → **Mitigation:** `bunx` resolves locally from the lockfile after `bun install`, so the validator itself is offline. Network risk is the same as any other npm-installed dev tool, which we already accept.
- **[Trade-off] Two CI jobs vs one.** Slightly more YAML, slightly more visible noise in the Actions tab. Worth it for parallel feedback and clearer failure attribution.

## Migration Plan

1. Land this change.
2. Renovate picks up `@fission-ai/openspec` updates from this point forward.
3. If a future change adds another openspec subcommand worth running in CI (e.g. `openspec list --json` for drift detection), extend this job rather than creating a third job.

**Rollback:** Revert the PR. The change is additive — removing the job and the devDependency restores prior CI behavior exactly.

## Open Questions

- Should the spec also require `bunx` specifically, or just "OpenSpec validation" abstractly? Default: abstract, so a future move to `npx` or a wrapper script doesn't require a spec change. The spec captures *what* is checked; the workflow file captures *how*.
- Should we add a job-level concurrency cancel-in-progress? The existing `validate` job doesn't, so for consistency this one shouldn't either. Re-evaluate if CI minutes become a concern.
