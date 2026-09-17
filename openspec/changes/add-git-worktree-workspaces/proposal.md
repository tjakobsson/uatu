## Why

Users need parallel repository checkouts that they can create and navigate as ordinary Uatu workspaces, whether requested from the Hub or by an agent. Validate the creation, discovery, navigation, and safe-removal experience with a realistic mock-backed UI before committing to real Git and provider integration.

## What Changes

- First deliver a resettable, non-mutating prototype inside the actual Uatu workspace frontend, with test-only mocked backend operations and independent file, preview, terminal and chat data for each checkout. A separate Hub-style demo or placeholder session page does not satisfy this requirement. Explicit user UX approval is a hard gate before implementing Git/backend, CLI, or provider-skill integration; completing these planning artifacts is not that approval.
- Extend the existing in-workspace workspace picker to discover, create and switch worktrees. Switching opens the selected checkout's separate workspace context; conversations remain attached to their original checkout and are never migrated. Hub dashboard entry points remain secondary.
- Group children beneath an explicitly identified main workspace/repository in both the picker and the real Hub dashboard. Each main workspace has a fork action targeting that parent; children have no fork action. Child names are exact local branches, including slashes, not separately editable labels. Two mock parent repositories demonstrate correct targeting and same-branch disambiguation.
- New checkouts use the predetermined sibling `<main-folder>.worktrees/<safe-branch-folder>` destination, with deterministic collision handling and no destination/name form. External discoveries retain their existing paths and provenance. Already-checked-out branches offer opening their checkout; branch rename remains out of scope.
- Credentials and shared workspace configuration are managed only on the parent and inherited live, not copied at creation. Parent changes propagate to children. Files, terminal/chat runtimes, selected documents/conversations, and personal/per-device preferences remain independent; no child credential/settings form is provided.
- Preserve the original dashboard rows/actions/status/style, adding nesting, branch labels and parent forks. The switcher is focused on switching and parent forks: no Details action or global worktree button. Remove generic dashboard Details navigation. Retain Open/Start/Stop, parent Configure and Remove from Uatu (unregister); children have no Configure. Verified Uatu-created children offer guarded Delete worktree as a secondary action. Recovery and unavailable-path errors offer relevant inline actions, not generic navigation.
- Each parent fork opens only **New branch / worktree** and **Existing branch**. The first opens a compact single-name Create/Cancel popup using source HEAD. The second opens an editable accessible combobox: fuzzy typing filters local/remote refs; click/Enter commits the exact display ref into the input. Editing clears selection and disables Create until another choice is made. Reopening a committed value offers the full list. A small adjacent **Fetch remote branches** icon explicitly refreshes cached refs, with loading and inline auth/network errors; opening never fetches. Fetch preserves query and valid selection, clearing a disappeared selection. No dashboard fetch duplicate, base/destination/configuration/ownership readouts or stale hidden selection. Conflicts offer the existing checkout directly; no force/reset.
- Share authoritative operations between the Hub UI and a proposed agent-invoked Uatu CLI. Thin Claude/OpenCode skills guide persistent workspace creation without replacing native hooks, subagent isolation, or provider lifecycle APIs.
- Notify immediately after Uatu creation; reconcile Git inventory on open, after activity, periodically, and on manual refresh. External discovery neither transfers ownership nor silently changes the active workspace/conversation.
- Provide manual, guarded deletion only for durably identified Uatu-created linked trees, always preserving branches. No branch-deletion UI or operation is in scope. Keep forgetting separate; never automatically clean up external trees.
- Successful creation closes its popup on every entry path, refreshes source lists, and shows a small `Created <branch>` confirmation with explicit Open (start then open), never an automatic switch or Worktree ready/Details/inventory popup. Failures stay compact and actionable in the originating flow, with same-checkout registration retry.
- Deletion uses a compact `Delete worktree?` dialog with `<parent display name> / <branch>`, branch-preserving consequences and Cancel plus destructive Delete or Stop and delete. The button explicitly authorizes stopping only Uatu activity; no extra checkbox, metadata dump or in-dialog simulation banner. Safety blockers replace the normal message with a short actionable reason and prevent deletion; no force or promise to stop unknown external applications.
- Guard generic folder renames that would break linked/main/common-directory/ancestor Git dependencies, including unregistered trees. Disclose the inherited parent credential policy and retain partial checkouts for recovery.

## Capabilities

The user approved independent checkout lifecycle: main Stop affects only main,
children may start with main stopped, and parent owns configuration rather than
being a runtime prerequisite. The user selected **A · Active groups**: groups with
any running checkout appear under Active; stopped children and inactive groups
are expandable. The dashboard reuses its original rows/actions through reusable
capability-scoped presentation. The discarded alternative and layout toggle are
removed; scenario controls remain test-only. No-capability behavior is unchanged.
This layout decision does not approve real integration. Task 2.2 remains unapproved.

The approved mock-only provenance revision adds a muted `from <source-ref>` (or
`origin unknown`) label to nested child rows in both actual surfaces. New branch
creation snapshots the selected parent's actual simulated HEAD ref; remote-created
tracking branches snapshot the selected remote ref. Existing-local and external
origins are unknown absent explicitly recorded history. This is immutable creation
history, not live parent policy or upstream, and adds no creation fields/readouts.
It does not approve real integration or satisfy the final UX gate.

### New Capabilities
- `git-worktree-workspaces`: Provider-neutral worktree creation, provenance, discovery, lifecycle safety, shared operations, and mock-first UX acceptance.

### Modified Capabilities
- `hub-dashboard`: Worktree entry points and navigation, explicit create/open/recovery/delete states, and Git-aware limits on generic folder actions.
- `hub-service`: Server-enforced Git dependency guard on otherwise supported folder renames.
- `hub-live-stream`: A bounded worktree-inventory invalidation topic on the existing brokered channel, separate from content-free activity summaries.

## Impact

Product surfaces include the real workspace frontend (`src/index.html`, `src/app.ts`, `src/shell/hub-nav.ts` and associated styles), plus secondary Hub pages. Eventual integration includes Hub server/routes and public contracts, registry/onboarding/path reservations/session coordination, live broker/client, CLI dispatch, and provider skill distribution. Add a focused Hub worktree service rather than provider-owned creation or multiple checkouts inside one child. Existing credentials, stable workspace URLs, per-checkout conversation boundaries, native agent lifecycle behavior, and server-rendered Hub architecture remain intact.

Prototype harnesses, fake data/state, and demo controls belong in `tests/`, not `src/`; evidence follows `tests/e2e/evidence.ts`. The mock host serves the real frontend at separate `/s/<workspace-id>/` URLs without real Git, PTY/processes, providers or persistent Hub state. No new dependency or installed external tool is assumed. CLI syntax, skill packaging, refresh cadence, and compatibility floors remain proposed decisions to settle after UX review. The previous standalone demo does not establish acceptance of the corrected prototype. Research and architecture references are `docs/WORKTREE-RESEARCH.md` and `docs/WORKTREE-ARCHITECTURE.svg`; the agreed scope extends the research's smallest first slice to eventual discovery and guarded deletion.
