# Tasks — harden-workflow-token-permissions

Work lands via a single PR from `chore/harden-workflow-token-permissions`.
Independently, merging Renovate PR
[#145](https://github.com/tjakobsson/uatu/pull/145) (lock file maintenance)
clears the open DOMPurify advisory and the Vulnerabilities point — that
merge is a maintainer action, not a task of this change.

## 1. Relocate write grants to job level

- [x] 1.1 `release-please.yml`: set top-level `permissions: {}`, move `contents/issues/pull-requests: write` onto the `release-please` job
- [x] 1.2 `claude.yml`: set top-level `permissions: {}`, move `contents/pull-requests/issues/id-token: write` onto the `claude` job
- [x] 1.3 `desktop-edge.yml`: add top-level `permissions: {}` (jobs already declare their own scopes)
- [x] 1.4 `claude-review.yml`: set top-level `permissions: {}`, move `contents: read` + `pull-requests/id-token: write` onto the `review` job (found by the task 2.1 grep; Scorecard's alert list was truncated)

## 2. Validate

- [x] 2.1 Run `actionlint` over all workflows and confirm no workflow-level block in `.github/workflows/` contains a write scope (grep check)
- [x] 2.2 Run `openspec validate harden-workflow-token-permissions --strict`

## Post-merge verification (not tasks — happens after this change's PR)

- The next Scorecard run (push to `main` triggers one) should score
  Token-Permissions ~10, with only `release.yml`'s intentional job-level
  writes remaining as warnings.
- Confirm the `claude` and `release-please` workflows still function on
  their next natural triggers (an @claude mention / issue event, and the
  next push to `main` updating the release PR).
