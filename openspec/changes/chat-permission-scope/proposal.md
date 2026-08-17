## Why

When OpenCode asks for permission, uatu offers a button labelled **"Allow session"**. Choosing it sends OpenCode the `always` reply, which OpenCode persists as a saved rule: `PermissionSavedInfo { id, projectID, action, resource }`, listed by `projectID` and removable only through `DELETE /api/permission/saved/{id}`.

So the grant is **project-scoped and permanent**. It outlives the request, the conversation, the session, and the workspace process, and applies to every future conversation in that project. The label says the opposite. A user reaching for the least-privilege option they can see grants far more authority than they intended, and uatu gives them no way to discover or revoke it afterwards.

This is not an implementation slip. The main spec itself says the choices are "one-time approval, **session approval**, and rejection", so the code implemented the spec faithfully and the spec was wrong. Fixing only the button would leave the spec authorising the same mistake next time.

The problem is worse for a subagent's request, which today is only visible inside the subagent's own transcript — the place where a user has the least context for a decision that binds the whole project. That surfacing gap is a separate change; this one makes sure that wherever the choice appears, it states what it does.

## What Changes

- **Correct the spec's vocabulary.** The permission choices are one-time approval, **persistent project-scoped approval**, and rejection. The requirement additionally states that a choice which grants authority beyond the current request must say so where the user makes it.
- **Correct the control.** "Allow session" becomes "Allow always", with the scope stated in the surface itself so the consequence is legible before the click rather than discoverable afterwards.
- **Keep the wire value.** `approved-session` stays as the transported enum in `PermissionItem`, `PermissionResponseRequest`, and `PermissionResult`. Renaming it would be a breaking contract change for a misnaming that no client depends on the meaning of; the honest name belongs in the human-facing surface, and the internal name can be corrected whenever an API revision is being spent for other reasons.

Explicitly out of scope, and each worth its own change:

- Surfacing a subagent's pending request in the parent conversation.
- A confirmation step before granting a project-permanent rule.
- Listing and revoking saved rules in uatu (`GET /api/permission/saved`, `DELETE /api/permission/saved/{id}`). Worth doing — a user who grants one currently cannot see or undo it from uatu — but it is a new surface, not a correction.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: The requirement *Users can resolve agent interaction requests in context* describes the middle choice as "session approval". It must instead describe it as a persistent, project-scoped approval, and must require that the surface state that scope where the choice is offered.

## Impact

**Code**
- `src/chat/timeline-renderer.ts` — `renderPermission` builds the three buttons; "Allow session" is the text to correct, plus the scope statement.
- `src/styles.css` — presenting the scope without crowding the card.

**Not affected**
- No API contract change. The `approved-session` enum value is unchanged in `api/openapi.yaml`, so no revision increment and no changelog migration.
- No change to `permissionOutcome` in `src/chat/normalization.ts` or the outcome→reply mapping in `src/chat/adapter.ts`. The behaviour is already correct; only its description was wrong.

**Delivery**
- A bug fix against unreleased chat work, landing on `fix/chat-startup-diagnostics` (PR #260) under that PR's existing Release Please override.

**Relationship to other active changes**
- `chat-event-coverage` modifies the same requirement's neighbours but not its choice vocabulary; `chat-startup-diagnostics` modifies a different requirement. The three deltas do not conflict.
