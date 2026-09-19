## Context

See proposal.md — Why. Two mechanisms are involved:

- **Hub enrollment settle.** `HubNotifications.enroll()` calls `settle()` for every selected running workspace, which opens (or joins) that workspace's feed observer and races `observer.connected` against a 3 s timer. The `enrolling` refcount keeps `refresh()` from tearing the observer down before a device record exists. After the race, `enroll()` stamps `since[ws][category] = now()` and writes the device. The client (`src/pwa/notification-client.js`) throws on any non-OK response, shows `error.message` in the dialog's status line, and leaves its enabled state untouched — so a refusal already renders correctly.
- **Adapter interaction identity.** `observeNotifications` emits `interaction` events keyed by `sourceId = [ownerConversationId, requestId]`. For an upsert the owner comes from the item (`item.conversationId`, the subagent for a request discovered through a parent's sweep); for a remove there is no item, and the code falls back to the session that reported the removal. Two reporters can be the parent: `refreshQuestions`/the reconciliation in the load path (removals computed from `publishedQuestions` / projection items), and `respondQuestion`/`respondPermission` invoked with the parent conversation id. The live answered event from the child's own pump usually also arrives and publishes the correct id, which is why the mismatch is only visible when that event is missed.

## Goals / Non-Goals

**Goals:**
- A device is enabled only if the hub's cutoff can be honored for every selected running workspace.
- Every interaction removal the adapter publishes carries the identity the matching upsert carried.

**Non-Goals:**
- Changing the feed protocol, the cursorless-open handoff, or the settle bound itself (#404 is closed separately).
- Client UI changes; the refusal message is server-authored and the existing status line shows it.
- Making a spurious `resolved` for an unknown id an error — the tracker's "resolution after lost pending frame" path stays.

## Decisions

**D1 — `settle()` returns the workspaces that did not connect; `enroll()` refuses before mutating.**
`settle()` keeps its race but resolves to the subset of `workspaceIds` whose `connected` promise is still pending when the timer wins (track each with a settled flag rather than inspecting promise state). `enroll()` throws `NotificationRequestError(503, "notification feed for <name, name> did not answer; try again")` using `options.workspaceName` so the message matches the dashboard. The throw happens before `store.mutate`, so an existing device keeps its previous record and cutoffs; a fresh device is never written. The `enrolling` refcount is released in `finally` as today, and the observer stays alive only if `refresh()` still wants it (an existing enrolled device selecting the workspace) — so a refused first-time enrollment does not pin an upstream connection.
*Alternative:* keep stamping and instead bump the cutoff forward to the cursor once it arrives — rejected: the device would be "enabled" with an unknown start point and the window Codex flagged remains.

**D2 — Refusal covers re-enrollment too.**
The same path serves preference updates of an existing device (same endpoint). Refusing there means a user toggling a workspace on while its feed stalls sees the error and their old preferences stay; this is the truthful outcome and needs no special case.

**D3 — Adapter remembers each published request's owner.**
Add `interactionOwner: Map<itemId, conversationId>` beside `questionCreatedAt`/`permissionCreatedAt`, populated wherever a question or permission item is built with a known owner (`pendingQuestions`, `pendingPermissions`, and the live upsert path in `observeNotifications` itself — the upsert already has `item.conversationId ?? session.id`). The remove branch reads `interactionOwner.get(update.itemId) ?? session.id`, then deletes the entry. Populating from the upsert path means the map is right even when the request was first seen live through the child's pump and later removed through the parent.
*Alternative:* read the owner from the projection item before it is removed — rejected: the projection may be LRU-evicted or never populated for a child answered from the parent (the very case `seedPendingQuestions` exists for).

**D4 — Also fix the `respond*` reporters.**
`respondQuestion`/`respondPermission` call `observeNotifications({ conversationId })` with the conversation the user answered from. With D3 the remove resolves to the owner regardless, so no signature change is needed; the test covers the parent-answer path as well as the reconciliation-only path.

**D5 — Spec scenarios rather than new requirements.**
Both fixes make existing normative sentences hold; the delta adds one sentence and one scenario to each requirement instead of inventing a new capability.

## Risks / Trade-offs

- [A slow but healthy feed now blocks enrollment for 3 s and then fails] → the message says "try again"; the observer keeps connecting in the background when something else wants it, and the second attempt usually joins an already-connected observer. Existing test "enrolling on a running workspace stamps the cutoff after the feed position is known" guards the success path.
- [`interactionOwner` grows with abandoned requests] → entries are deleted on remove; `forgetInteractions(conversationId)` clears the conversation's entries alongside its other per-request maps. Bounded by the same lifetimes as `questionCreatedAt`.
- [A removal for a request never seen as an upsert] → falls back to `session.id` exactly as today; no regression.
- [The 503 text leaks a workspace name] → the name is the enrolling user's own selected workspace, already authorized by `preferences()`.

## Migration Plan

None. Unreleased feature; no stored-state shape changes. PR body carries `BEGIN_COMMIT_OVERRIDE chore(notifications): stabilize enrollment and resolution before release END_COMMIT_OVERRIDE`.
