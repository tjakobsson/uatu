# Design — harden-workflow-token-permissions

## Context

Scorecard's Token-Permissions check treats workflow-level write grants as the worst case because they are inherited by every job in the file — including jobs added later — while job-level grants are scoped warnings. uatu's `release.yml` already models the target shape: `permissions: {}` at top level, explicit scopes per job. `claude.yml` and `release-please.yml` predate that convention and grant writes at top level; `desktop-edge.yml` omits the top-level block entirely (its two jobs each declare their own).

## Goals / Non-Goals

**Goals:**
- No workflow-level write grants anywhere in `.github/workflows/`.
- Every workflow has an explicit top-level `permissions` block (`{}` or read-only) so nothing inherits the repository default.
- Zero behavior change for existing jobs.

**Non-Goals:**
- Reducing what any existing job can do (the grants themselves are already minimal for their tasks — this change relocates, not revokes).
- Chasing the remaining Token-Permissions warnings on `release.yml`'s job-level writes; those scopes are required for publishing releases.
- The DOMPurify lockfile bump (handled by Renovate PR #145).

## Decisions

### Mirror release.yml's shape: top-level `{}` plus per-job grants
One convention across all workflows beats a mix. Alternative considered: top-level `contents: read` instead of `{}` — rejected because the two AI workflows and release-please don't need ambient read on jobs that don't run; explicit is the house style.

### Keep the exact same scopes, just relocated
`claude.yml`'s `contents/pull-requests/issues/id-token: write` and `release-please.yml`'s `contents/issues/pull-requests: write` move verbatim onto their single jobs. Auditing whether any scope could be dropped is worthwhile but separate — mixing relocation with reduction would make the diff harder to trust.

### Encode the invariant in the security-posture spec
Without a spec-level statement, the next workflow added with top-level write silently regresses the score. The requirement makes the Scorecard workflow's published result the regression signal and the spec the stated rule.

## Risks / Trade-offs

- [A future job added to claude.yml/release-please.yml gets no permissions and fails] → That is the intended default; the failure is loud and the fix is an explicit job-level grant.
- [claude-code-action or release-please-action reads repo contents during checkout with `{}` at top level] → Their jobs retain `contents: write`, which includes read; nothing changes for the running jobs.
- [Scorecard still docks points for release.yml's job-level writes] → Accepted; that is the check's residual signal on a workflow that must write, not a defect.
