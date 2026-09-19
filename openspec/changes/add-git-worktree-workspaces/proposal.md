## Why

Users need parallel repository checkouts that they can create and navigate as ordinary Uatu workspaces, requested from the Hub. The creation, discovery, navigation and safe-removal experience was validated on a mock-backed prototype of the real frontend before the Git and provider integration was built; that approval is recorded, and the worktree surfaces now live on the Hub's published JSON API like every other Hub surface.

## What Changes

- The UX was first proven by a resettable, non-mutating prototype inside the actual Uatu workspace frontend, with test-only mocked backend operations and independent file, preview, terminal and chat data for each checkout. Explicit user UX approval was a hard gate before implementing Git/backend integration; that approval was given on 2026-09-17 and the prototype was retired afterwards. The UX obligations it established now bind the real surfaces.
- Extend the existing in-workspace workspace picker to discover, create and switch worktrees. Switching opens the selected checkout's separate workspace context; conversations remain attached to their original checkout and are never migrated. Hub dashboard entry points remain secondary.
- Group children beneath an explicitly identified main workspace/repository in both the picker and the real Hub dashboard. Each main workspace has a fork action targeting that parent; children have no fork action. Child names are exact local branches, including slashes, not separately editable labels. Two parent repositories in the acceptance suites demonstrate correct targeting and same-branch disambiguation.
- New checkouts use the predetermined sibling `<main-folder>.worktrees/<safe-branch-folder>` destination, with deterministic collision handling and no destination/name form. External discoveries retain their existing paths and provenance. Already-checked-out branches offer opening their checkout; branch rename remains out of scope.
- Credentials and shared workspace configuration are managed only on the parent and inherited live, not copied at creation. Parent changes propagate to children. Files, terminal/chat runtimes, selected documents/conversations, and personal/per-device preferences remain independent; no child credential/settings form is provided.
- Preserve the original dashboard rows/actions/status/style, adding nesting, branch labels and parent forks. The switcher is focused on switching and parent forks: no Details action or global worktree button. Remove generic dashboard Details navigation. Retain Open/Start/Stop, parent Configure and Remove from Uatu (unregister); children have no Configure. Verified Uatu-created children offer guarded Delete worktree as a secondary action. Recovery and unavailable-path errors offer relevant inline actions, not generic navigation.
- Each parent fork opens only **New branch / worktree** and **Existing branch**. New has Name plus **Create from**, using the same editable local/remote fuzzy combobox and adjacent explicit **Fetch remote branches** as Existing. Initial base prefers local `main`, else the sole remote branch named `main`; multiple remote mains or none require explicit selection, never a current-checkout fallback. Refetch never redefaults. Click/Enter commits an exact ref; editing clears selection, reopening offers all refs, and Create requires valid name/base and no pending operation. Fetch preserves name/query/valid selection, invalidates disappeared refs, and reports loading/errors inline. Titles retain target parent. No destination/settings/details or extra metadata; conflicts concern the new target branch, not a checked-out base.
- Serve every worktree operation from one session-authenticated JSON family under `/api/hub/worktrees`, published in the API contract like the rest of the Hub. The server-rendered `/worktrees` fragment/redirect flow and its contract exclusions are removed, along with the separate operation-progress poll. A single client module renders the inventory, create, delete, register, forget and retry-open views from that JSON inside the same dialog, embedded in both the in-workspace picker and the Hub dashboard, keeping today's roles, labels and copy.
- Notify immediately after Uatu creation; reconcile Git inventory on open, after activity, periodically, and on manual refresh. External discovery — including checkouts that agents or other Git tools create natively — neither transfers ownership nor silently changes the active workspace/conversation.
- Provide manual, guarded deletion only for durably identified Uatu-created linked trees, always preserving branches. No branch-deletion UI or operation is in scope. Keep forgetting separate; never automatically clean up external trees.
- Successful creation closes its popup on every entry path, refreshes source lists, and shows a small `Created <branch>` confirmation with explicit Open (start then open), never an automatic switch or Worktree ready/Details/inventory popup. Failures stay compact and actionable in the originating flow, with same-checkout registration retry.
- Deletion uses a compact `Delete worktree?` dialog with `<parent display name> / <branch>`, branch-preserving consequences and Cancel plus destructive Delete or Stop and delete. The button explicitly authorizes stopping only Uatu activity; no extra checkbox, metadata dump or in-dialog simulation banner. Safety blockers replace the normal message with a short actionable reason and prevent deletion; no force or promise to stop unknown external applications.
- Guard generic folder renames that would break linked/main/common-directory/ancestor Git dependencies, including unregistered trees. The server-side refusal on the dashboard's rename action is the disclosure; no separate worktree folder-policy dialog is offered. Disclose the inherited parent credential policy and retain partial checkouts for recovery.

## Capabilities

The paragraphs below record decisions taken during the prototype review. The
prototype is retired; the same obligations now hold for the migrated real
surfaces.

The user approved independent checkout lifecycle: main Stop affects only main,
children may start with main stopped, and parent owns configuration rather than
being a runtime prerequisite. The user selected **A · Active groups**: groups with
any running checkout appear under Active; stopped children and inactive groups
are expandable. The dashboard reuses its original rows/actions through reusable
capability-scoped presentation. The discarded alternative and layout toggle are
removed. No-capability behavior is unchanged.

The approved provenance revision adds a muted `from <source-ref>` (or
`origin unknown`) label to nested child rows in both actual surfaces. New branch
creation snapshots its explicitly selected starting ref; remote-created
tracking branches snapshot the selected remote ref. Existing-local and external
origins are unknown absent explicitly recorded history. This is immutable creation
history, not live parent policy or upstream. Main checkout rows in dashboard and
selector show the actual mutable branch, distinct from repository identity and
child provenance; detached/unknown states never guess `main`.

### New Capabilities
- `git-worktree-workspaces`: Provider-neutral worktree creation, provenance, discovery, lifecycle safety, and one published operation family behind the approved UX.

### Modified Capabilities
- `hub-dashboard`: Worktree entry points and navigation, explicit create/open/recovery/delete states rendered from the published JSON family, and Git-aware limits on generic folder actions.
- `hub-service`: Server-enforced Git dependency guard on otherwise supported folder renames.
- `hub-live-stream`: A bounded worktree-inventory invalidation topic on the existing brokered channel, separate from content-free activity summaries.

## Impact

Product surfaces include the real workspace frontend (`src/index.html`, `src/app.ts`, `src/shell/hub-nav.ts`, the new `src/shell/worktree-dialog.ts` and associated styles), plus secondary Hub pages. Integration covers Hub server/routes and public contracts, registry/onboarding/path reservations/session coordination, and the live broker/client. A focused Hub worktree service owns creation rather than provider-owned creation or multiple checkouts inside one child. Existing credentials, stable workspace URLs, per-checkout conversation boundaries, native agent lifecycle behavior, and server-rendered Hub architecture remain intact.

The repository keeps only what the released product executes, what clients read as contract, what users read as documentation, and tests that exercise product code through its real entry points. The mock host, its scenario controls, the review gallery and the demo suites are removed with the prototype, leaving no stray configuration, snapshot, screenshot or reference behind. Evidence follows `tests/e2e/evidence.ts`; a change's `screenshots/` folder is assembled at PR time. No new dependency or installed external tool is assumed. Refresh cadence and Git compatibility floors are settled by targeted tests. Research and architecture references travel with this change as `openspec/changes/add-git-worktree-workspaces/WORKTREE-RESEARCH.md` and `openspec/changes/add-git-worktree-workspaces/WORKTREE-ARCHITECTURE.svg`; the agreed scope extends the research's smallest first slice to eventual discovery and guarded deletion.
