## Why

Contributors and agents need a shared path from agreed intent to an evidence-backed PR without repeated personal instructions. Today the repository mixes agent reference material with workflow policy, lacks repo-local PR and code-review skills, and does not track upstream skill updates through Renovate.

## What Changes

- Establish concise `AGENTS.md` guidance for current Claude Code and OpenCode, replacing `CLAUDE.md` without a compatibility adapter. Keep shared workflow policy in `CONTRIBUTING.md` and detailed architecture behind task-specific pointers.
- Clarify the existing OpenSpec lifecycle: approve intent once, record the approved Git revision, let implementation and working artifacts evolve within the original outcome, and explicitly accept material departures before merge. Use the PR for the short change explanation, not a separate approval system.
- Require OpenSpec for behavior and workflow changes, while allowing strictly mechanical edits without invented requirements. Run focused local checks and successful applicable CI rather than routinely duplicating the entire suite locally.
- Commit Matt Pocock's `pr` and `code-review` skills using a pinned skills CLI, tracked source revisions, and repo-local discovery. Keep imported files unchanged and describe essential repository integration separately. Leave generated OpenSpec instructions under OpenSpec CLI ownership.
- Use independent Standards and Spec review locally and on GitHub for every PR. Spec review checks revised requirements only; missing specs are reported. GitHub review stays advisory, with maintainer-authorized inspection for external PRs and autonomous fixing or reasoned rejection of findings.
- Include Renovate-owned skill update PRs in this change. A narrowly scoped helper may refresh installed files and lock metadata in the same PR; validation must reject inconsistent generated content. Human review is required before merging instruction updates.
- Fix browser setup and workflow ordering, align affected documentation and the existing process SVG, and preserve release-note conventions.

## Capabilities

### New Capabilities

None. These changes extend the existing repository workflow capability.

### Modified Capabilities

- `repository-workflows`: Shared instruction discovery, bounded implementation autonomy, review and acceptance handoffs, committed skills, and Renovate-owned skill maintenance.

## Impact

- Contributor and maintainer documentation, `CLAUDE.md`/`AGENTS.md`, the process SVG, repo-local third-party skill files, dependency metadata, focused workflow tests, Renovate configuration, and review/update GitHub workflows.
- Developer tooling only; no application API, runtime dependency, release-version, account, or provider changes.
- Renovate helper permissions, CI retriggering, exact skill pinning, and automated review tool capabilities require implementation-time verification. Do not assume hosted Renovate permits post-upgrade shell commands or that GitHub token pushes rerun CI.
- No new bot service, auto-merge policy, dashboard, permanent approved-plan snapshots, or custom approval platform. Live upstream service changes, secrets, installations, publication, and merges retain their normal separate approvals.
