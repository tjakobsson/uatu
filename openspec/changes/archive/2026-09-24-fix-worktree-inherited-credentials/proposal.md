## Why

A linked worktree's Hub dashboard row read `No credentials assigned` while the checkout was in fact working with its parent's Git credentials (#418). The row summarised the child's own `credentialAssignments`, which the state API deliberately leaves empty: policy lives on the parent and is inherited live, so a child never holds assignment rows of its own. `git-worktree-workspaces` already requires that credentials be "managed only on the parent and inherited live" and that "Parent policy SHALL be disclosed" — reporting the child's empty record as an absence of credentials disclosed the opposite of the truth.

The same seam was unenforced on the write side. Nothing stopped a caller from recording an assignment against a child id, and such a row would never be resolved: the credential context resolver reads the parent's assignments. The spec's rule held only by convention in the Settings form, which already omits children from its workspace selector.

## What Changes

- **Dashboard rows disclose inherited policy.** A row summarises its *policy owner's* assignments and appends ` · inherited from <parent>` when the owner is not the row itself. Parent and unrelated rows are unchanged, and the state API is untouched — the client reads the parent already present in the fetched list, named by the row's `parentId`.
- **One owner lookup for the whole dashboard.** The row summary, the fork dialog's source and the credential card's `Restart required` notice all resolve policy through `workspacePolicyOwner`, which falls back to the row itself if the list is ever inconsistent rather than fabricating a parent. That fixes the notice as well: the server flags `credentialRestartRequired` on the running row, which for a linked worktree is the child while the assignment names the parent, so the comparison never matched and the notice never fired.
- **The credential API refuses assignments that name a linked worktree.** `POST /api/hub/credentials/{id}/assign`, `POST /api/hub/workspaces/{id}/credential-assignments` and `POST /api/hub/credentials/{id}/unassign` answer 409 with `credentials are managed on the parent workspace <parentId>; linked worktrees inherit them`. The parent remains assignable on every route. For `unassign` with `stop: true` the refusal is checked before the workspace is stopped, so a refused request cannot cost a running child its session.
- **One `policyWorkspaceId` seam**, shared by the stored credential context resolver and the credential API, so both answer "whose policy governs this workspace?" the same way. `CredentialApiError` carries its own HTTP status instead of relying on message matching, and `credentialApiError` now classifies `unknown workspace` / `unknown credential` as 404 before the 409 message shapes, which a workspace id containing a 409 word could otherwise capture.
- Out of scope, recorded as known follow-ups: unassigning a parent's credential while a running child inherits it neither refuses nor stops the child (the unassign route's running-workspace check and its `stop: true` stop both consider the named workspace only); and assignment rows recorded against a child id by a pre-fix hub are not pruned on read — only unreleased builds could have written one.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `git-worktree-workspaces`: "Workspace boundaries and credentials remain explicit" gains the disclosure obligation on the surfaces that report a child's credential policy — report the parent's effective assignments and name the parent, never the child's empty record as an absence — and the write-side counterpart, that an assignment or unassignment naming a linked worktree is refused with a conflict naming the parent, before any workspace is stopped on its behalf.

`hub-credentials` and `hub-dashboard` are unchanged. The rule being enforced is the worktree capability's own ("managed only on the parent and inherited live"); restating it as a second requirement over the assignment endpoints would duplicate it. `hub-dashboard`'s neutral row summary (`assigned authentication and signing credential names … or No credentials assigned`) still describes what a row shows for its policy owner; the delta specialises it for a row that owns no policy.

## Impact

- `src/hub/pages.ts` — `workspaceCredentialSummary` for running and stopped rows; the credential card's restart notice and the fork dialog source resolve through `workspacePolicyOwner`.
- `src/hub/credential-api.ts` — `assignmentTarget` / `assertAssignmentTarget`, the `policyWorkspaceId` service, `CredentialApiError`, and the 404-before-409 ordering in `credentialApiError`.
- `src/hub/main.ts` — one `policyWorkspaceId` function passed to both the credential context resolver and the credential API. `src/hub/server.ts` — the unassign route asserts the target inside the lifecycle queue, before the stop.
- `src/hub/pages.test.ts`, `src/hub/credential-api.integration.test.ts` — new coverage; `src/hub/worktree-api.integration.test.ts` and `src/hub/worktree-lifecycle.integration.test.ts` supply the new service in their fixtures.
- No stored-state, protocol or published-contract change: the refusals are existing endpoints answering an existing error shape, asserted against the published contract in the integration test.
- Release notes: linked worktrees arrived in #395, after the latest stable tag `v0.7.0`, so no stable release shows this defect. The PR keeps its truthful `fix(hub)` title and its body MUST carry the Release Please override `chore(hub): stabilize the unreleased feature before release` before squash merge (see CLAUDE.md, "Release-note discipline").
