## Why

The repository now has 15 OpenSpec capabilities (up from 8 before yesterday's split) and the working agreement is that specs are the source of truth for what each capability does. There is no automated check that those specs are well-formed — a malformed scenario header, an empty capability, or a contributor accidentally breaking a delta during a refactor would all merge silently. `openspec validate --all --strict` already catches each of these in under 30 seconds locally, but it isn't run in CI, so the safety net only exists for contributors who remember to run it. Adding it to the GitHub Actions workflow makes spec health a required check on every PR, the same way unit tests and the e2e suite already are.

## What Changes

- Add a new `validate-specs` job to `.github/workflows/ci.yml` that runs `bunx @fission-ai/openspec@<pinned-version> validate --all --strict` on every PR and push to `main`. The job runs in parallel with the existing `validate` job (no shared dependencies — spec validation needs neither the build nor Playwright).
- Add `@fission-ai/openspec` to `devDependencies` in `package.json` so the version is pinned in `bun.lock` and Renovate can keep it current alongside the other tooling.
- Update the `repository-workflows` capability's "GitHub Actions validate the repository on GitHub" requirement to include OpenSpec spec validation in the minimum set of automated checks. This makes the new CI step contractual rather than incidental.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-workflows`: Extend the "GitHub Actions validate the repository on GitHub" requirement so the minimum automated checks include OpenSpec validation (`openspec validate --all --strict` or equivalent). Add a scenario covering it. No other requirements change.

## Impact

- `.github/workflows/ci.yml` gains one new job (~12 lines of YAML), unchanged otherwise.
- `package.json` and `bun.lock` gain one devDependency entry.
- `openspec/specs/repository-workflows/spec.md` gets a small modification to one requirement and one new scenario.
- No production code, no runtime dependencies, no shipped-binary impact.
- Renovate will start tracking `@fission-ai/openspec` updates alongside other npm devDependencies.
