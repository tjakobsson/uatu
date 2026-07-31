# Harden workflow token permissions

## Why

The first published OpenSSF Scorecard run (overall 6.1) scored **Token-Permissions at 0** despite every workflow declaring permissions: Scorecard zeroes the check when any workflow grants *write* at the *workflow (top) level*, and two do — `claude.yml` and `release-please.yml` — while `desktop-edge.yml` declares no top-level block at all. Moving the same grants to job level is behavior-identical (each workflow has a single job needing them) but restores the least-privilege default for any job later added to those files, and is expected to take the check from 0 to ~10.

## What Changes

- `release-please.yml`: replace the top-level `contents/issues/pull-requests: write` block with `permissions: {}` at top level and the same grants on the `release-please` job.
- `claude.yml`: same treatment for its `contents/pull-requests/issues/id-token: write` block, moved onto the `claude` job.
- `desktop-edge.yml`: add `permissions: {}` at top level; its `build` and `update-tap` jobs already declare their own scopes.
- `claude-review.yml`: same treatment — its top-level `pull-requests/id-token: write` (plus `contents: read`) moves onto the `review` job. (Found during implementation; the Scorecard alert listing surfaced only the first few offenders.)
- No change to `release.yml`: Scorecard also warns on its job-level `contents: write`, but the release/publish jobs genuinely need it — job-level writes are the accepted least-privilege shape and cost far less than top-level ones.

**Related, out of scope**: the Vulnerabilities check (9/10, DOMPurify advisory [GHSA-c2j3-45gr-mqc4](https://osv.dev/GHSA-c2j3-45gr-mqc4)) is already fixed by open Renovate PR [#145](https://github.com/tjakobsson/uatu/pull/145) (lock file maintenance bumps dompurify 3.4.11 → 3.4.12); merging that PR is independent of this change.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `security-posture`: add a requirement that workflow token permissions are declared at job level with no workflow-level write grants, so the least-privilege posture Scorecard measures is a stated invariant rather than a convention.

## Impact

- **Changed files**: `.github/workflows/release-please.yml`, `.github/workflows/claude.yml`, `.github/workflows/desktop-edge.yml`, `.github/workflows/claude-review.yml` — permissions blocks only; no trigger, step, or secret changes.
- **Behavior**: identical token capabilities for every existing job; only the default for hypothetical future jobs in these files tightens to none.
- **Scorecard**: Token-Permissions 0 → ~10 on the next run after merge; overall score rises accordingly.
