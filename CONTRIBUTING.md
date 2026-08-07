# Contributing to uatu

Thanks for helping improve uatu. This guide is the canonical workflow for
developing, validating, and merging changes. Maintainers should also read
[the release runbook](./docs/RELEASING.md).

## Development setup

uatu requires Bun 1.3.5 or newer. CI currently pins the exact project runtime
shown in `.github/workflows/ci.yml`.

```bash
bun install
bunx playwright install chromium
bun run dev
```

The development server watches `testdata/watch-docs` by default.
[ARCHITECTURE.md](./ARCHITECTURE.md) describes the runtime, state, request,
terminal, and extension points.

## Changes and branches

1. Start from an up-to-date `main` and create a focused branch.
2. For behavior or workflow changes, create an OpenSpec change under
   `openspec/changes/<name>/` before implementation.
3. Keep implementation, tests, documentation, and the OpenSpec task list in
   sync as work progresses.
4. Open a pull request and address required CI and review findings.
5. Squash-merge with a Conventional Commit title. A ruleset on `main`
   enforces this flow: direct pushes are rejected, and merging requires
   the CI `validate` check to pass.
6. Sync changed capability specs and archive completed OpenSpec artifacts as
   part of the change before its final merge.

OpenSpec's normal lifecycle is:

```bash
openspec new change <name>
openspec status --change <name>
openspec validate <name> --strict
```

The proposal, design, delta specs, and tasks describe intent and acceptance
criteria. Current behavior belongs in `openspec/specs/`; completed planning
artifacts belong in `openspec/changes/archive/`.

## Pull requests and commits

Pull requests are squash-merged, so the PR title becomes the commit seen by
Release Please. Titles must follow Conventional Commits:

```text
<type>[optional scope][!]: <description>
```

Examples:

```text
feat(terminal): add searchable session history
fix(review): wrap long base refs in the burden meter
perf(diff): avoid repeated base resolution
chore(deps): refresh the lockfile
ci: pin the release action digest
```

Release behavior:

| Type | Public changelog | Version effect |
| --- | --- | --- |
| `feat` | Features | Minor |
| `fix` | Bug Fixes | Patch |
| `perf` | Performance | Patch |
| Any type with `!` or `BREAKING CHANGE:` | Breaking change | Major |
| `chore`, `ci`, `test`, `build`, `refactor`, `docs` | Hidden by default | None by itself |

Use a user-facing type only when users of the latest stable release need the
change. Public notes describe the stable-to-stable user-visible delta; Git
history can retain the intermediate work that produced it. Routine dependency
updates, including runtime dependency updates, are `chore(deps)`. Only an
update that remediates a known vulnerability is `fix(deps)`, and its summary
should state the security reason rather than only the version bump.

When a separate PR fixes functionality introduced after the latest stable tag,
keep the truthful `fix(...)` PR title and squash commit in Git, but add a
Release Please override to the PR body before merging so the correction does
not appear as a bug stable users experienced:

```text
BEGIN_COMMIT_OVERRIDE
chore(scope): stabilize the unreleased feature before release
END_COMMIT_OVERRIDE
```

This override workflow depends on squash merging. A fix for behavior that does
exist in the latest stable release remains a normal visible `fix(...)` with no
override.

## Validation

Changes that add or change functionality must include tests — unit tests in
the colocated `*.test.ts` files, plus an e2e test when the behavior is only
observable through the UI.

Run the checks relevant to your change. Before requesting final review, the
same core checks as CI should pass:

```bash
bun run typecheck
bun audit --audit-level=moderate
bun test
bun run check:licenses
bun run build
bun run smoke
bun run test:e2e
bunx @fission-ai/openspec validate --all --strict
```

The full Playwright suite takes longer than unit tests. Focused Playwright
files are appropriate while iterating, but CI remains the final full-suite
gate. Playwright is development-only and is not included in the compiled uatu
binary.

## Releases

Do not manually bump `package.json`, edit generated future changelog sections,
or push version tags. Release Please keeps a release PR current from the
Conventional Commits on `main`. Maintainers merge that PR when ready; see
[docs/RELEASING.md](./docs/RELEASING.md) for publication and recovery steps.
