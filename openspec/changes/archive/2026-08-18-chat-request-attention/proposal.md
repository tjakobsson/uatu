## Why

A user ran one task, got ten permission requests, and could not tell which still needed answering. Three separate defects produced that.

**Requests all look alike.** `.chat-request` gives the same border, background, and text colour to a request waiting on you, one queued behind it, and one resolved an hour ago. The only difference is body text you must read card by card while scrolling.

**The copy tells you to ignore work you still have to do.** Only the most recent pending request is answerable; every other pending one renders "Superseded by a newer request". They are not superseded — they become answerable as soon as the newer one is answered. The UI says *obsolete, ignore me* about requests that are merely queued.

**Nothing counts them.** There is no aggregate and no way to reach the next one. In a long transcript, colour alone would not fix this: a user would still scroll and count, and still doubt.

Separately, a request raised by a **subagent** never appears in the main conversation at all. It lands in the child session's transcript, which is deliberately excluded from the conversation picker and reachable only by clicking the parent's subagent row. The parent shows a task still running and no indication that anything is waiting. That is the worst case of the same problem: the signal is not merely hard to see, it is absent, and the decision it asks for reaches the user's other conversations — an "always" reply carries across every conversation the OpenCode instance serves.

## What Changes

- **Surface a subagent's pending request in its parent conversation**, answerable there. The child session stays the single owner: the parent renders a view carrying the owning conversation's id, and answering addresses that conversation through the existing route, so one `requirePending` guard and one receipt key still govern the reply.
- **Compute "answerable" per owning conversation.** Today the answerable request is the newest pending one in the timeline. With a subagent's request present, a parent's own request and a child's must both be answerable at once, so the rule becomes: a request is answerable when it is the active one *in the conversation that owns it*.
- **Give every request a visible state** — needs your answer, queued behind another, or resolved — carried on the element so styling can distinguish them, and expressed by more than colour so it survives colour-blindness and high-contrast mode.
- **Replace the misleading copy.** A queued request says it is waiting its turn, not that it has been superseded.
- **Count what is outstanding and offer a way to reach it**, reusing the pinned subagents row already beside the timeline rather than inventing a new surface.

Also corrected: a comment in `src/styles.css` still claims the persistent permission reply is "a project-scoped rule", which live measurement disproved — it lasts for the OpenCode instance's lifetime and never reaches the saved list.

Explicitly out of scope:

- Changing which request is answerable first. The newest-first ordering is preserved exactly; this change makes it legible, not different.
- Showing the `always` pattern a persistent approval would grant.
- Any confirmation step before answering.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: The requirement *Users can resolve agent interaction requests in context* says a request appears "in the conversation that raised it" and that "only the active unresolved request" may be answered. Both need widening: a request raised by a subagent must also reach the conversation that launched it, and "active" must be defined per owning conversation rather than per timeline. The requirement must also state that a request's status is distinguishable without reading it, and that a request awaiting its turn is not presented as obsolete.

## Impact

**Code**
- `src/chat/types.ts` — interaction items carry the conversation that owns them.
- `src/chat/adapter.ts` — publish a child's pending request into its parent's projection using `ProviderSession.parentId`; resolve it in both places when answered.
- `src/chat/timeline-renderer.ts` — per-owner active-request computation, request state on the element, corrected queued copy.
- `src/chat/ui.ts` — outstanding-request count and jump-to-next in the pinned row; route an answer to the owning conversation.
- `src/styles.css` — the three request states, and the stale comment.

**Published API contract**
- `PermissionItem` and `QuestionItem` are `additionalProperties: false`, so carrying an owning conversation id is a breaking change under the `contract-fast` closed-object rule. This increments `workspaceApiRevision` 2 → 3 with an `api/CHANGELOG.md` migration section naming the workspace domain. Recorded as an assumption: the alternative — encoding the owner inside the item id string — avoids the bump by making id parsing a protocol, which is worse to live with.

**Delivery**
- A bug fix against unreleased chat work, landing on `fix/chat-startup-diagnostics` (PR #260) under that PR's existing Release Please override.

**Relationship to other active changes**
- `chat-event-coverage` and `chat-permission-scope` both modify this same requirement. This delta is written on top of both, so the archive order is `chat-event-coverage`, then `chat-permission-scope`, then this one.
