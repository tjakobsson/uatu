## Why

Users need parallel repository checkouts that they can create and navigate as ordinary Uatu workspaces, whether requested from the Hub or by an agent. Validate the creation, discovery, navigation, and safe-removal experience with a realistic mock-backed UI before committing to real Git and provider integration.

## What Changes

- First deliver a resettable, non-mutating UI prototype using the actual server-rendered Hub presentation and test-only simulated operations. Explicit user UX approval is a hard gate before implementing Git/backend, CLI, or provider-skill integration; completing these planning artifacts is not that approval.
- Create ordinary Git worktrees as separate Hub workspaces: new branch with explicit base, existing local branch, or a local tracking branch from a remote ref. A branch already checked out offers opening its existing checkout, never force/reset.
- Share authoritative operations between the Hub UI and a proposed agent-invoked Uatu CLI. Thin Claude/OpenCode skills guide persistent workspace creation without replacing native hooks, subagent isolation, or provider lifecycle APIs.
- Notify immediately after Uatu creation; reconcile Git inventory on open, after activity, periodically, and on manual refresh. External discovery neither transfers ownership nor silently changes the active workspace/conversation.
- Provide manual, guarded deletion only for durably identified Uatu-created linked trees, preserving branches by default. Keep forgetting separate; never automatically clean up external trees.
- Guard generic folder renames that would break linked/main/common-directory/ancestor Git dependencies, including unregistered trees. Make credential assignments explicit and retain partial checkouts for recovery.

## Capabilities

### New Capabilities
- `git-worktree-workspaces`: Provider-neutral worktree creation, provenance, discovery, lifecycle safety, shared operations, and mock-first UX acceptance.

### Modified Capabilities
- `hub-dashboard`: Worktree entry points and navigation, explicit create/open/recovery/delete states, and Git-aware limits on generic folder actions.
- `hub-service`: Server-enforced Git dependency guard on otherwise supported folder renames.
- `hub-live-stream`: A bounded worktree-inventory invalidation topic on the existing brokered channel, separate from content-free activity summaries.

## Impact

Eventual product surfaces include `src/hub/pages.ts`, Hub server/routes and public contracts, registry/onboarding/path reservations/session coordination, live broker/client, workspace switcher, CLI dispatch, and provider skill distribution. Add a focused Hub worktree service rather than provider-owned creation or multiple checkouts inside one child. Existing credentials, stable workspace URLs, per-checkout conversation boundaries, native agent lifecycle behavior, and server-rendered Hub architecture remain intact.

Prototype harnesses, fake data/state, and demo controls belong in `tests/`, not `src/`; evidence follows `tests/e2e/evidence.ts`. No new dependency or installed external tool is assumed. CLI syntax, skill packaging, refresh cadence, and compatibility floors remain proposed decisions to settle after UX review. This change contains planning artifacts only. Research and architecture references are `docs/WORKTREE-RESEARCH.md` and `docs/WORKTREE-ARCHITECTURE.svg`; the agreed scope extends the research's smallest first slice to eventual discovery and guarded deletion.
