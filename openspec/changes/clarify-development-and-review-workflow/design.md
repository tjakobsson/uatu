## Context

See `proposal.md` for motivation and `specs/repository-workflows/spec.md` for acceptance criteria. The repo has `CLAUDE.md`, duplicate CLI-generated OpenSpec integrations for two clients, a canonical contributor guide, an existing Claude review action, and Renovate managing Bun/npm/actions. It has no project skills installation or skills updater. The process SVG is an existing discussion artifact, not an implemented contract.

The available global OpenSpec CLI is 1.12.0; the project lock records 1.14.0. There is no local `node_modules` installation. Planning can use the available CLI, but implementation must obtain approval before dependency installation or downloads and verify against the locked toolchain. No production runtime changes are needed.

## Goals / Non-Goals

**Goals:** one workflow with human and agent entry points; source-tracked skills available immediately after clone; Renovate-owned complete update PRs; simple, inspectable approval history; independently reviewed automation boundaries.

**Non-Goals:** a new workflow platform, service deployment, permanent baseline snapshots, automatically accepted AI verdicts, automatic instruction-update merges, broad architecture rewrites, or repairs to unrelated stale specifications. Installing tools, changing live repository settings or secrets, publishing, and merging remain separately authorized actions.

## Decisions

### 1. Give each policy one home

- `AGENTS.md` replaces the root `CLAUDE.md`. Keep repo-specific invariants and concise pointers with explicit task triggers. Preserve useful conventions and rationale, relocating detailed navigation to the existing architecture reference where needed.
- `CONTRIBUTING.md` owns the contribution lifecycle, lightweight mechanical path, validation choices, and PR expectations. Maintainer-only publication/recovery belongs in `docs/RELEASING.md`; shared release-note policy is linked rather than copied across entry points.
- Keep repo-specific skill integration in one small disclosed reference under `docs/agents/`, reached for PR writing and review. It supplies the GitHub tracker, current OpenSpec sources including archived changes, review range, and relevant standards. It is not another copy of the workflow.
- Update the SVG to a simpler delivery view; present occasional skill maintenance separately from the per-change flow. Label proposed or untested automation honestly until implemented and verified.

Current OpenCode V2 discovers `AGENTS.md` without a `CLAUDE.md` fallback. Current Claude Code supports native `AGENTS.md`; document its version and ancestor/local-instruction caveats and actual discovery checks. Reject maintaining parallel root instructions or adding a compatibility adapter, as agreed.

### 2. Use Git and the PR for acceptance history

For OpenSpec changes, record the commit identifying the approved planning artifacts in the PR or current handoff. Approval must identify the artifact version, not just an unrelated repository HEAD. Preserve that commit on the work branch until final acceptance; do not rewrite it out while it is needed. No commit is created merely by this proposal workflow.

Working artifacts evolve with implementation. The PR contains the short material-delta explanation and an explicit acceptance request before merge. A change-specific advance-approval list is recorded with the initial plan only when useful and may be empty. Existing permissions and safety rules remain controlling. After acceptance, final artifacts and the explanation are enough; ordinary squash merge avoids requiring a permanent snapshot directory.

Alternatives rejected: custom snapshot storage and cleanup, freezing every implementation detail, and automatically treating passing tests as acceptance. Spec reviewers deliberately do not compare with the approval baseline; humans own that judgment.

### 3. Import upstream skills; keep integration separate

Use an exact developer-tool version of the skills CLI and import only Matt Pocock's `pr` and `code-review` skills, including required companion files and attribution. Commit installed content, supported client links or copies, and the CLI's project lock. Prefer its shared canonical installation over manually maintaining duplicate skill text. Verify actual paths and tracked link behavior rather than assuming the current personal setup proves discovery.

Track one allowlisted Matt Pocock repository revision in a small Renovate-readable source declaration. It is the installation input; the project skills lock and installed files are generated outputs. The updater must consume the selected immutable revision, never run an unqualified bulk update that silently installs a newer revision. Test exact-ref support in the pinned CLI before choosing its invocation.

Keep upstream skill bodies unchanged so updates replace managed content safely. The repo reference supplies current OpenSpec intent, issue ownership relative to the actual target repository, and preserved release overrides. Use explicit immutable review base/head revisions. Committed review is the default; if reviewing local edits, capture a stable effective diff including the intended staged, unstaged, and untracked content rather than claiming `base...HEAD` includes them.

The updater's allowed output set excludes all CLI-generated OpenSpec skills and commands. Audit their actual prompts for conflicts with the agreed autonomy policy. Use supported project configuration and explicit integration where compatible; do not claim a prompt overrides controlling generated workflow rules. If the installed CLI cannot support a required behavior without hand-editing generated files, surface that integration blocker before claiming completion.

### 4. Reuse the existing GitHub review workflow

Keep the current action and authentication route. Add ready-for-review handling, and a trusted-maintainer trigger for external PRs. Resolve the current actor permission and head SHA when authorizing; a stale authorization must not silently cover a replacement head. Review identifies exact base/head and spec inputs, reports Standards and Spec separately, and stays advisory.

Load automation policy and the imported reviewer skill from the trusted base revision. Candidate instructions and revised OpenSpec artifacts are data being reviewed, not permissions or executable policy. Use separate read-only review contexts for the two axes and do not import the local verdict. Explicitly report when there is no applicable spec.

Review tooling permits reading the pinned diff and sources and posting review comments, not executing PR tests/scripts/hooks or writing repository contents. Verify the action can actually run isolated review tasks under those restrictions; test the documented invocation and delegation controls rather than relying on prompt wording as enforcement. If unsupported, report the blocker instead of silently replacing independent review with a single prompt.

### 5. Renovate owns the update; one trusted helper materializes it

Add a custom Renovate manager for the allowlisted source declaration, using a documented Git-ref/digest datasource and explicit manager enablement. Pin the skills CLI through normal dependency management. Do not assume Mend-hosted Renovate allows arbitrary `postUpgradeTasks`.

Choose a same-PR regeneration workflow, not a second scheduler or bot. It runs trusted base-revision updater code for an allowlisted, same-repository Renovate PR. Fetch and validate candidate metadata as data: repository/source identity, selected immutable revision, expected branch, actor authorization, current head, and eligible changed paths. The initial implementation handles source-revision update PRs; unsupported mixed changes fail with an actionable explanation instead of expanding the allowlist.

Run the pinned installer in isolation without write credentials or PR-provided hooks/scripts. Generate only the selected skill directories, approved client links, and project lock. Reject paths escaping the managed roots and unexpected outputs. Apply the generated result atop the exact candidate head while preserving its other changes, and push only if that head is unchanged. A no-op is idempotent; stale heads abort and can be retried. Credential-bearing push/dispatch steps are separate from installation.

A push with `GITHUB_TOKEN` does not implicitly rerun CI. Explicitly dispatch the existing CI workflow for the regenerated branch with narrowly scoped Actions permission, verify the run's head, and document that dispatch status is not automatically equivalent to the required PR check. The validation topology must prove the required checks run on the regenerated SHA; if dispatch cannot supply the required check context, obtain approval for a supported trigger/credential arrangement rather than ship stale green checks. Never adopt a new credential or change a live service as an implicit fallback.

Local consistency tests and security fixtures are feasible without live writes. Actual Renovate extraction, helper push/dispatch, required-check association, and external-review authorization also require an authorized GitHub dry run. Missing upstream access is an explicit unexecuted acceptance check, not evidence that automation works.

## Risks / Trade-offs

- **More automation than two copied skills** → keep one source declaration, one narrowly scoped updater, and the existing Renovate/CI/review services; no second update lifecycle.
- **Managed skills replace local edits** → keep adaptations separate and validate upstream content plus companion files and lock consistency.
- **Candidate content changes automation behavior** → use trusted base code/policy, inspect candidate data only, constrain outputs and credentials, and test hostile-input cases.
- **Token pushes do not produce usable required checks** → verify the exact regenerated SHA and check association; retain a deployment blocker until proved, not a claim based on workflow YAML alone.
- **Native client or generated OpenSpec behavior differs from expectations** → verify supported versions and actual discovery/invocation before documenting success; preserve CLI ownership.
- **Changing requirements can hide non-delivery from reviewers** → preserve the approved Git revision through explicit human acceptance and summarize material departures in the PR.
- **Global planning CLI differs from the lock** → report which version validated artifacts and repeat validation with approved project dependencies during implementation.

## Migration Plan

1. Obtain scoped approval for the needed dependency restore, pinned skills CLI, and two skill-source downloads; keep personal configuration unchanged.
2. Implement the source-tracked skills installation and focused consistency/security tests, then the Renovate manager and same-PR helper.
3. Simplify instruction/doc ownership and integrate the existing local/GitHub review handoffs. Preserve useful existing rules and release behavior.
4. Run focused local verification, fresh independent review, and the authorized hosted checks. Record remaining upstream setup without claiming it was performed.
5. Before merge, request explicit acceptance of material plan changes, sync the capability spec, archive this change, and renew affected checks.

Rollback is an ordinary revert of the development-tooling change, with any separately approved live configuration changes listed for maintainer recovery. No application data migration is involved.
