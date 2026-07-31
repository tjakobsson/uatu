# Adopt OpenSSF baseline

## Why

uatu already practices most of what OpenSSF Scorecard measures (SHA-pinned actions, least-privilege workflow tokens, Renovate, dependency audits, build provenance), but the remaining gaps are the visible ones: `main` has no branch protection, there is no security policy, no static analysis runs, and none of the existing discipline is continuously measured or published. Closing these gaps earns a credible Scorecard result, satisfies the corresponding OpenSSF Best Practices and OSPS Security Baseline criteria, and turns "no direct pushes to main" from a habit into an enforced rule.

## What Changes

- Add a **branch ruleset on `main`**: require pull requests, require the fast CI validation check, block force pushes and deletions. Required approvals stay at 0 so the solo-maintainer PR flow keeps working (Scorecard scores branch protection tier-wise, so this still earns most points).
- Add **`SECURITY.md`** describing supported versions, how to report a vulnerability privately (GitHub private vulnerability reporting), response expectations, and what is in scope for a local-first tool (terminal auth token, render/sanitization pipeline, file-serving path handling) versus out of scope.
- Add an **OpenSSF Scorecard workflow** (`ossf/scorecard-action`) running on a schedule and on pushes to `main`, publishing results to the OpenSSF API so the score is continuously measured and badgeable.
- Add a **CodeQL workflow** for the TypeScript codebase, running on PRs and a weekly schedule, filling the Scorecard SAST check. (Swift/desktop analysis is deliberately out of scope for this change; it needs macOS runners and can follow later.)
- **Verify and, if needed, fix Signed-Releases visibility**: the release workflow already generates provenance attestations, but Scorecard inspects release *assets*. Extend the release to also publish the provenance material as a release asset so verification does not require GitHub-specific tooling.
- Enable **GitHub private vulnerability reporting** on the repository (settings task, referenced by `SECURITY.md`).

## Capabilities

### New Capabilities

- `security-posture`: the repository's OpenSSF-aligned security floor — the published security policy, the enforced branch ruleset on `main`, the scheduled Scorecard measurement workflow, and static analysis (CodeQL) over the TypeScript codebase.

### Modified Capabilities

- `release-distribution`: the "verifiable integrity artifacts" requirement is extended — provenance material must additionally be discoverable as a release asset (not only via the GitHub attestation store), so third-party scanners and non-`gh` users can verify releases.

## Impact

- **New files**: `SECURITY.md`, `.github/workflows/scorecard.yml`, `.github/workflows/codeql.yml`.
- **Changed files**: `.github/workflows/release.yml` (publish provenance bundle as an asset), `README.md` (Scorecard badge, optional), `CONTRIBUTING.md`/`docs/RELEASING.md` if they reference merge or release mechanics affected by the ruleset.
- **Repository settings** (not code, tracked as tasks): branch ruleset on `main`, private vulnerability reporting enabled.
- **CI cost**: CodeQL adds a PR-time job (TypeScript-only keeps it a few minutes); Scorecard runs weekly plus on `main` pushes.
- **Workflow behavior change**: once the ruleset is active, direct pushes to `main` are rejected — including by the maintainer and any automation not going through PRs (Release Please already merges via PR, so it is unaffected; release tags are pushed by the workflow and rulesets on `main` do not block tag pushes).
