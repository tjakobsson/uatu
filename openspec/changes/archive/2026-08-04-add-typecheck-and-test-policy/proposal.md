# add-typecheck-and-test-policy

## Why

Two gaps stand between uatu and honestly claiming every MUST of the OpenSSF
Best Practices passing badge (https://www.bestpractices.dev/en/criteria/0):
the `warnings` criterion requires an enforced linter or safe language mode,
and `test_policy`/`tests_documented_added` require an explicit written policy
that new functionality comes with tests. The repo has a strict `tsconfig.json`
with `noEmit` — type checking was clearly intended — but nothing ever runs
`tsc`: Bun executes and bundles TypeScript without checking it, and CI has no
lint or typecheck step. Running `tsc --noEmit` today surfaces 54 errors across
13 files, several of which look like genuine latent bugs, so this is real
hygiene, not badge theater.

## What Changes

- Fix all existing type errors so `tsc --noEmit` passes. Suspicious errors
  (union-member property accesses in `src/shell/boot.ts` / `src/shell/events.ts`,
  file-handle method calls in `src/sidebar/tree-view.ts`) are investigated as
  potential behavior bugs, not silenced.
- Add `typescript` as a pinned devDependency and a `bun run typecheck`
  (`tsc --noEmit`) package script.
- Add a typecheck step to the CI validation workflow so type errors fail PRs.
- Document the test policy in `CONTRIBUTING.md` — changes that add or change
  functionality must include tests — and add `bun run typecheck` to the
  documented validation command list.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-workflows`: two requirements change — the GitHub Actions
  validation requirement gains a mandatory TypeScript type check, and the
  contributor-documentation requirement gains the explicit test policy.

## Impact

- `src/` — type-level fixes in ~13 files (largest: `src/render/asciidoc.ts`
  with 23 errors from untyped Asciidoctor interop; `src/cli.ts` with 10).
  Behavior changes only where an error reveals an actual bug.
- `package.json` / `bun.lock` — new `typescript` devDependency, new script.
- `.github/workflows/ci.yml` — one added step.
- `CONTRIBUTING.md` — test policy sentence + validation list addition.
- Enables the OpenSSF Best Practices form answers for `warnings`,
  `warnings_fixed`, `warnings_strict`, `test_policy`, and
  `tests_documented_added`.
