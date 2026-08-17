## 1. Make a request's state visible (no contract change — land first)

- [x] 1.1 Derive a request state — `needs-answer`, `queued`, `resolved` — in `src/chat/timeline-renderer.ts` and carry it on the card element so styling and counting read the same value
- [x] 1.2 Replace "Superseded by a newer request" with copy that says the request is awaiting its turn, and never implies it is obsolete or resolved
- [x] 1.3 Style the three states in `src/styles.css`: an accent border and raised surface for `needs-answer`, muted for `resolved`, plus a text badge on `needs-answer` so the signal survives colour-blindness, high-contrast mode, and greyscale
- [x] 1.4 Fix the stale `.chat-request-scope` comment in `src/styles.css` that still calls the persistent reply "a project-scoped rule" — live measurement showed it lasts for the OpenCode instance's lifetime and never reaches the saved list
- [x] 1.5 Tests in `src/chat/timeline-renderer.test.ts`: each state is distinguishable without reading the body; a queued card is not described as superseded/obsolete/resolved; the state is not conveyed by colour alone

## 2. Count what is outstanding and make it reachable

- [x] 2.1 Report the number of outstanding requests in the pinned row beside the subagents summary in `src/chat/ui.ts`, derived from the same per-item state as task 1.1
- [x] 2.2 Offer a jump-to-next control that scrolls to an outstanding request, reusing the existing `data-open-conversation` click-through conventions rather than inventing a new mechanism
- [x] 2.3 Clear the count to nothing once every request is answered
- [x] 2.4 Tests: the count matches the number of outstanding requests, jump reaches one, the row disappears at zero

## 3. Owning conversation on interaction items

- [x] 3.1 Add the owning conversation id to the permission and question items in `src/chat/types.ts`, equal to the conversation's own id in the ordinary case
- [x] 3.2 Accept and constrain it in `src/chat/validation.ts`
- [x] 3.3 Populate it in `src/chat/normalization.ts` for both event naming generations, and in the pending-permission and pending-question reconciliation paths in `src/chat/adapter.ts`
- [x] 3.4 Tests that every path producing an interaction item sets the owner

## 4. Answerable per owning conversation

- [x] 4.1 Replace the single newest-pending computation in `src/chat/timeline-renderer.ts` with one active request per owning conversation
- [x] 4.2 Route an answer to the owning conversation in `src/chat/ui.ts` rather than the displayed one
- [x] 4.3 Tests: a single-conversation timeline behaves exactly as before (existing tests must stay green untouched); with two owners present, both are answerable and answering one does not change the other

## 5. Surface a subagent's request in its parent

- [x] 5.1 Publish a child session's unresolved request into its parent's projection in `src/chat/adapter.ts`, using `ProviderSession.parentId` to find the parent
- [x] 5.2 Propagate resolution so answering in either place clears it in both, and stop hoisting once resolved
- [x] 5.3 Confirm the reply path still produces exactly one provider response — one `requirePending` guard and one receipt key, both the child's
- [x] 5.4 Tests: a subagent's request appears in the parent and is answerable there; answering from the parent replies once for the child; resolving in the child clears the parent's copy; a resolved child request is not hoisted

## 6. API contract

- [x] 6.1 Add the owning conversation id to `PermissionItem` and `QuestionItem` in `api/openapi.yaml`
- [x] 6.2 Increment `workspaceApiRevision` 2 → 3 in `src/shared/version.ts`, `api/contract.json`, and `api/openapi.yaml` (`info.version`, `x-uatu-revisions`, and the examples the revision tests check)
- [x] 6.3 Add an `api/CHANGELOG.md` migration section naming the workspace domain
- [x] 6.4 Run `bun run api:validate`, `bun run test:api`, and the `contract-fast` compatibility gate against `origin/main` — the gate, not my reading of the rules, decides whether the bump is right

## 7. Verification and delivery

- [x] 7.1 Run `bun test`, `bun run typecheck`, `bun run check:licenses`
- [x] 7.2 Run the real-OpenCode integration test (`UATU_REAL_OPENCODE=1`)
- [x] 7.3 Run `bun test:e2e`; the pre-existing `find.e2e.ts` "⌘G steps matches without focus" failure is unrelated and stays out of scope
- [x] 7.4 Screenshot a stack of mixed-state requests and a hoisted subagent request before trusting the suite — whether a user spots what needs them is the entire point, and no assertion establishes it
- [x] 7.5 Drive a real subagent permission against live OpenCode and confirm it appears in the parent, since that is the case the user could not verify
- [x] 7.6 Commit onto `fix/chat-startup-diagnostics`, push so it lands in PR #260, and describe it in that PR's body

> **Archive ordering (not a task).** `chat-event-coverage`, `chat-permission-scope`,
> and this change all modify the same requirement. This delta is written on top
> of both, so archive in that order: `chat-event-coverage`, then
> `chat-permission-scope`, then `chat-request-attention`.
