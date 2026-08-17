## 1. Tell the truth about what the choice grants

- [x] 1.1 In `renderPermission` (`src/chat/timeline-renderer.ts`), relabel the `approved-session` button from "Allow session" to "Allow always", keeping the `data-permission-outcome="approved-session"` value so the wire contract and every handler are untouched
- [x] 1.2 State the reach in the card where the choice is made — that persistent approval covers later conversations and similar requests, and lasts until OpenCode restarts — rather than relying on the button text alone. (Corrected after measurement: an earlier wording claimed project-wide persistence, which a live 1.18.18 disproved.)
- [x] 1.3 Style the scope note in `src/styles.css` so it reads as a consequence of the choice without crowding the request card

## 2. Prove it

- [x] 2.1 Test in `src/chat/timeline-renderer.test.ts` that a pending permission card offers the three choices, that the persistent one still carries `approved-session`, and that the rendered card states project scope and does not describe the choice as session- or conversation-limited
- [x] 2.2 Test that choosing it still produces exactly one `always` reply — already covered by `adapter.test.ts` "supports permission outcomes exactly once and refuses stale duplicates", which drives `approved-session`, refuses a duplicate without a second reply, and asserts the exact sequence `["once","always","reject"]`; it fails if the mapping drifts, so no new test was added
- [x] 2.3 Extend the chat e2e coverage in `tests/e2e/` so the visible label and scope statement are asserted against the real surface, not only the renderer

## 3. Verification and delivery

- [x] 3.1 Run `bun test`, `bun run typecheck`, `bun run check:licenses`
- [x] 3.2 Run `bun run test:api` and confirm no contract artifact changed — the `approved-session` enum stays, so this must need no revision increment
- [x] 3.3 Run `bun test:e2e`; the pre-existing `find.e2e.ts` "⌘G steps matches without focus" failure is unrelated and stays out of scope
- [x] 3.4 Look at the rendered permission card before trusting the suite — the entire point is whether a user reads the scope correctly, which a passing assertion does not establish
- [ ] 3.5 Commit onto `fix/chat-startup-diagnostics` and push so the fix lands in PR #260, and describe it in that PR's body

> **Archive ordering (not a task).** `chat-event-coverage` modifies the same
> requirement. This delta was written on top of that one's updated text, so
> archive `chat-event-coverage` first and this second; archiving in the other
> order would drop that change's recovery paragraph and scenarios from the
> main spec.

> **Deliberately skipped: `design.md`.** The schema makes it conditional and
> none of its triggers apply — one label string and a scope line, no
> cross-cutting work, no dependency or data-model change, no migration. The
> single decision worth recording (keep the `approved-session` wire value and
> correct only the human-facing text) is stated in `proposal.md`.
