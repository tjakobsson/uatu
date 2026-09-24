## Context

Credential policy for a linked worktree lives on its parent and is resolved live: `createStoredCredentialContextResolver` maps a workspace to `registry.byId(id)?.worktree?.parentWorkspaceId ?? id` before reading assignments. The published state therefore reports an empty `credentialAssignments` for a child, by design — it never claims a child holds assignments. Two consumers of that state had not been told: the dashboard row summary, which rendered the empty record as `No credentials assigned`, and the assignment endpoints, which accepted a child id and would have written a row nothing ever reads.

## Decisions

- **The client discloses inheritance; the server does not substitute assignments.** The dashboard resolves a row's policy owner from the `parentId` the row already carries, finds that parent in the same fetched list, and renders its summary with ` · inherited from <parent>`. The state API keeps saying what is true of the child — it holds no assignments — and the disclosure stays where the inheritance is a presentation concern.
- **One owner lookup, falling back to the row itself.** `workspacePolicyOwner(w)` returns the listed `w.parentId || w.id`, else `w`. Every consumer (row summary, restart notice, fork dialog source) uses it, so they cannot disagree, and an inconsistent list degrades to the row's own policy rather than to a fabricated parent. It also repairs the `Restart required` notice, which had compared the assignment's workspace id against the running row: for a linked worktree the running row is the child and the assignment names the parent.
- **The API enforces "rows name policy owners only" at write time, through the same seam.** `policyWorkspaceId` is defined once in `runHub` and given to both the context resolver and the credential API, so the question "whose policy governs this workspace?" has a single answer. An assignment target that is not its own policy owner is refused with 409 and the parent's id, which is actionable: it tells the caller where to make the change.
- **A typed status error.** `credentialApiError` classified failures by matching message text. The refusal's message matches none of those shapes and would have fallen through to the 500 default, so `CredentialApiError` carries its status explicitly rather than inviting a new phrase into the pattern list. While there, `unknown workspace` / `unknown credential` moved ahead of the 409 patterns: a workspace id containing a word like `locked` had turned a 404 into a 409.
- **Refusal precedes the stop.** `unassign` with `stop: true` stops the workspace inside the lifecycle queue before the operation runs, so a check inside `unassign` would arrive too late. The route calls `assertAssignmentTarget` first: a request the Hub will not honour must not cost a running child its shells.

## Alternatives considered

- **Publish an effective `credentialPolicy` object on each workspace in the state API.** Rejected: it duplicates parent state onto every child in every poll, invites a client to read a stale copy as the child's own, and blurs the distinction the state API deliberately maintains — a child holds no assignments. The parent is already in the same payload; naming it is enough, and it costs no contract change.
- **Prune assignment rows recorded against a child id on read.** Rejected: only an unreleased build could have written one, and a silent prune on read would delete a user's record without saying so. The write-side refusal stops new ones; an existing stray row is inert because nothing resolves it.
- **Restate the rule as a new requirement over the credential endpoints in `hub-credentials`.** Rejected as duplication: the constraint is defined by `git-worktree-workspaces`, and the endpoints are its enforcement point, not a second rule.

## Risks / Trade-offs

- A caller that had come to rely on assigning a child id now gets a 409. Only unreleased builds accepted it, the Settings assignment form has always omitted children from its selector, and the message names the workspace to use instead.
- The row disclosure depends on the parent being present in the same list. The Hub never lists a child without its parent; if it ever did, the row falls back to its own (empty) policy — the pre-fix reading — rather than inventing an owner.

## Open Questions

- Should unassigning a parent's credential stop the running children that inherit it, as it stops the assigned workspace itself? Left as a recorded follow-up rather than widened here.
