## Context

See `proposal.md` — Why. What constrains the approach:

- `timeline-renderer.ts:37` picks the answerable request as the *last* pending interaction in the timeline; everything else pending renders "Superseded by a newer request". `ConversationProjection.requirePending` enforces the same newest-first rule server-side.
- `.chat-request` in `styles.css` styles all three states identically.
- Subagent children are excluded from the conversation picker (`adapter.ts:113`) and reached through the parent's subagent rows, which already carry `conversationId` and a click-through (`ui.ts`, `data-open-conversation`).
- `ProviderSession.parentId` is populated from OpenCode's `parentID` (`sdk-v2-provider.ts:402`), so the server can map a child session to the conversation that launched it.
- `PermissionItem` and `QuestionItem` are `additionalProperties: false` in `api/openapi.yaml`.
- The pinned subagents row (`#chat-subagents`) is the established pattern for "state that must not scroll away".

## Goals / Non-Goals

**Goals:**

- A user who has requests outstanding knows it without scrolling, and can reach one.
- A subagent's request is answerable where the user already is.
- Exactly one reply reaches OpenCode per request, unchanged from today.

**Non-Goals:**

- Changing the order in which requests become answerable. Newest-first is preserved; this change makes it legible.
- Rendering the `always` pattern a persistent approval grants.
- Auto-answering, confirmations, or timeouts.

## Decisions

### 1. The parent gets a view; the child stays the owner

Interaction items gain the id of the conversation that owns them. A subagent's pending request is published into the parent's projection carrying the child's conversation id, and any answer — from either place — is addressed to that conversation through the existing per-conversation route.

This is what keeps the single-reply guarantee intact. There is one `requirePending` guard (the child's), one receipt key (`permission:<childId>:<requestId>:<clientRequestId>`), and one resolution. The parent's copy is never independently answerable; it is a rendering of the child's item that happens to sit in the parent's timeline.

Alternatives considered:
- **Badge the subagent row only, answer in the child.** Smaller, and it was my first recommendation. Rejected because the persistent-approval choice reaches every conversation the OpenCode instance serves, so it should be made where the user has context, not inside a transcript they had to go hunting for.
- **Duplicate the item into the parent as an independently answerable copy.** Two projections would each believe they own one request, with per-conversation receipts unable to see each other — a genuine double-reply hazard against a guarantee the spec makes.

### 2. "Active" becomes per owning conversation

Today's rule — the newest pending item in the timeline — breaks as soon as the timeline holds items from two conversations: a parent's own request and a subagent's would fight over one active slot.

The rule becomes: a request is answerable when it is the newest pending request *among items owned by the same conversation*. With a single-conversation timeline this is exactly today's behaviour, so nothing changes for the common case.

This is deliberately a generalisation rather than a redesign. Whether newest-first is the right order at all is a separate question, and changing it would alter which request a user is asked for first — out of scope here.

### 3. Request state is data on the element, not a CSS guess

Each request carries a state — `needs-answer`, `queued`, `resolved` — derived from its status and whether it is active for its owner. Styling keys off that attribute rather than re-deriving it, and the same value drives the count.

The distinction is not colour alone: `needs-answer` gets a text badge as well as an accent border. Colour-only state fails colour-blind users, high-contrast mode, and greyscale screenshots — and this is precisely the signal a user must not miss.

### 4. The count and jump reuse the pinned row

The outstanding count and its jump-to-next live in the pinned area that already holds subagents, which is the established "must not scroll away" surface. A user with three outstanding requests sees the count without scrolling, and clicking moves to one.

Deliberately not a toast or a modal: requests can arrive in bursts, and a modal would serialise a user who may want to read the transcript before deciding.

### 5. Copy states the queue, not obsolescence

"Superseded by a newer request" becomes wording that says the request is waiting its turn. The word "superseded" is not softened, it is removed: it asserts the opposite of the truth, and a user acting on it skips work they must return to.

## Risks / Trade-offs

- **A hoisted request outlives its usefulness in the parent** (child finishes, request resolved elsewhere) → Resolution propagates to every place the request appears; a test drives resolve-in-child-then-check-parent.
- **The parent's timeline becomes noisy with child items** → Only *unresolved* child requests are hoisted, and they leave when answered. A resolved child request stays in the child's transcript only.
- **Per-owner active computation regresses single-conversation behaviour** → It reduces to the current rule when every item shares one owner; existing tests cover that path and must stay green untouched.
- **Two clients answer the same hoisted request at once** → Unchanged from today: the child's `requirePending` and receipts arbitrate, and the loser gets the existing conflict error.
- **The count disagrees with the timeline** → Both derive from the same per-item state rather than being computed separately.
- **The revision bump** → Assumed acceptable and recorded in the proposal. If it is refused, the fallback is encoding the owner in the item id string, which makes id parsing a protocol; I would rather spend the bump.

## Migration Plan

`workspaceApiRevision` 2 → 3 across `src/shared/version.ts`, `api/contract.json`, and `api/openapi.yaml`, with an `api/CHANGELOG.md` migration section naming the workspace domain — the same shape as the increment `chat-startup-diagnostics` made, and for the same closed-object reason.

Clients that ignore unknown properties need no change. The owning-conversation id is present on every interaction item, equal to the conversation's own id for the ordinary case.

Rollback: the visual state, copy, and count are independent of the hoisting and of each other. Reverting the hoisting leaves a conversation showing only its own requests, which is today's behaviour.

## Open Questions

- Whether newest-first is the right order for answering a burst of requests, or an artifact of the original implementation. Deferrable: this change preserves the order exactly and only makes it legible, so the answer changes nothing here — but if it is an artifact, oldest-first would remove the need for a queued state at all.
