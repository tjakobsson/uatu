## 1. Remediate the advisories

- [x] 1.1 Add an `overrides` block to `package.json` pinning `dompurify` (`^3.4.11`) and `uuid` (`^14.0.1`)
- [x] 1.2 Run `bun update mermaid` (resolves 11.16.0 in-range) and review the `bun.lock` diff — confirm it is limited to mermaid's subtree (mermaid 11.16.0, dompurify 3.4.11, uuid 14.0.1) plus forced peers
- [x] 1.3 Run `bun audit` and confirm it reports 0 vulnerabilities
- [x] 1.4 Run `bun test` (unit + integration) and confirm it passes
- [x] 1.5 Run the Playwright mermaid e2e suite (`bun test:e2e`, or the mermaid spec specifically) and confirm diagrams still render
- [x] 1.6 Run `bun run build` + `bun run smoke` to confirm the bundled mermaid asset loads in the compiled binary

## 2. Harden Renovate

- [x] 2.1 Add `lockFileMaintenance: { enabled: true }` to `renovate.json` so the lockfile is refreshed and in-range/transitive fixes are pulled in
- [x] 2.2 Add `osvVulnerabilityAlerts: true` to `renovate.json` so advisories are scanned via OSV without depending on GitHub Dependabot alerts
- [x] 2.3 Leave `lockFileMaintenance` on the preset default cadence (no explicit `schedule`), per the resolved design decision
- [x] 2.4 Validate the config parses (no `renovate-config-validator` error / Renovate dependency-dashboard reflects the new settings on next run)

## 3. Add the CI vulnerability-audit gate

- [x] 3.1 Add a `bun audit --audit-level=moderate` step to the `validate` job in `.github/workflows/ci.yml`, after `bun install --frozen-lockfile` and alongside the license audit
- [x] 3.2 Confirm the step fails the workflow on a moderate+ advisory and passes when the tree is clean (`bun audit --audit-level=moderate` exits non-zero on moderate+, zero when clean)
- [x] 3.3 Add a scheduled, PR-independent `.github/workflows/dependency-audit.yml` (weekly cron + `workflow_dispatch`) running `bun audit --audit-level=moderate` against the full tree — covers transitive advisories that `osvVulnerabilityAlerts` (direct-only) misses between PRs (review follow-up)

## 4. Verify

- [x] 4.1 Run `bunx @fission-ai/openspec validate --all --strict` and confirm the change validates

## Finalize (post-archive, not tracked as checkboxes)

Finalization happens *after* `/openspec-archive-change`, in this order — the
commit deliberately captures the archive output too, so it cannot be a checkbox
inside the change being archived:

1. Archive the change — moves it into `openspec/changes/archive/` and syncs
   `openspec/specs/repository-workflows/`.
2. Commit the implementation + archive together (`fix(deps)`-style message),
   push the branch, and open the PR.
3. Confirm CI (including the new `bun audit` step) is green.
