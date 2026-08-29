## 1. Chat Contracts

- [x] 1.1 Add the reversible-history capability, local command kind, normalized revert state/result, restored-draft types, and conversation-rewritten resync reason; extend runtime validation and verify `bun test src/chat/validation.test.ts src/chat/slash-commands.test.ts` passes.
- [x] 1.2 Add idempotent Undo and Redo workspace API operations, response schemas, and the required workspace API revision update; verify `bun run api:validate` and the API contract tests pass.
- [x] 1.3 Extend provider, adapter, service, client, route dependency, and E2E fake interfaces with reversible-history operations; verify TypeScript checking reports no incomplete implementers.

## 2. OpenCode Provider Compatibility

- [x] 2.1 Implement normalized reversible-history state and previous/next user-turn selection from authoritative OpenCode sessions and messages, excluding synthetic turns and recovering available attachment references; verify focused provider tests cover staged, clear, oldest, newest, and missing-attachment cases.
- [x] 2.2 Dispatch compatibility sessions through classic `session.revert` / `session.unrevert` and native-v2 sessions through stage / clear, including Redo advancing to the next hidden turn; verify `bun test src/chat/sdk-v2-provider.test.ts` covers both stores and exact SDK request shapes.
- [x] 2.3 Declare reversible-history support only when the provider operations are available and expose Undo and Redo as local commands rather than provider commands; verify command-list tests prove neither command reaches `provider.command()`.

## 3. Shell Output Fidelity

- [x] 3.1 Preserve live tool metadata and direct output fields, read rolling `metadata.output` after final output fields, and accept OpenCode's `metadata.exit` plus the compatibility `exitCode`; verify normalization tests cover running updates, completion replacement, and zero/non-zero exits.
- [x] 3.2 Treat a legacy shell-ended event with no exit code as ended rather than failed and retain its output; verify exact legacy event fixtures in `src/chat/normalization.test.ts` pass.
- [x] 3.3 Verify running and fast-completed command rows update in place, retain inspectable output, and keep existing output bounds with focused `src/chat/timeline-renderer.test.ts` coverage.

## 4. Subagent Request Context

- [x] 4.1 Derive child labels by conversation ID once per timeline render, include resolved origin data in renderer cache variants, and render a truthful fallback for foreign requests; verify renderer tests cover attribution arriving after the request.
- [x] 4.2 Add the escaped `data-open-conversation` control to foreign permission and question cards while leaving own-conversation and capability-disabled cards unchanged; verify pending, resolved, hostile-ID, and no-subagent-capability unit cases.
- [x] 4.3 Add browser coverage that opens a surfaced request's child transcript and returns to the unchanged parent selection; verify the focused Chat request/drill-down E2E test passes in desktop and touch presentation.

## 5. Revert Coordination And Replay

- [x] 5.1 Add authoritative projection replacement that resets timeline and text reconciliation before reseeding, then emits a conversation-rewritten resync; verify projection and replay tests cover suffix removal and fresh snapshot recovery.
- [x] 5.2 Implement idempotent Undo and Redo adapter mutations in the per-conversation admission lane, pausing delivery before interruption and preserving removable queued messages while staged; verify adapter tests cover lost-response retries and the interrupt-idle queue race.
- [x] 5.3 Reconcile provider history and reversible state after local mutations and externally observed revert lifecycle events; verify duplicate local/event triggers converge without duplicate notices or resync loops.
- [x] 5.4 Commit a staged revert before admitting a replacement prompt, deliver that replacement before older queued messages, and resume the queue when Redo clears the boundary; verify adapter ordering tests cover both resume paths.
- [x] 5.5 Return only the invoking client's restored draft while broadcasting transcript resync to all subscribers; verify adapter tests preserve unrelated client drafts and retain placeholders for unavailable attachments.

## 6. Service, Routes, And Composer

- [x] 6.1 Thread Undo and Redo through the lazy service, route table, request validation, idempotency error mapping, and E2E fake server; verify focused service and route tests cover supported, unsupported, no-op, and provider-failure responses.
- [x] 6.2 Add Chat client methods and local slash-command dispatch so `/undo` and `/redo` call their dedicated endpoints and never enter prompt submission; verify client and composer tests cover command recognition and failure recovery.
- [x] 6.3 Restore returned text and available attachments into only the invoking composer, preserve other local drafts during resync, and announce no-op or failure outcomes accessibly; verify focused UI tests cover Undo, repeated Undo, Redo, replacement editing, and unavailable attachments.
- [x] 6.4 Add multi-client E2E coverage for synchronized hidden/restored history, file restoration, private drafts, queued-message pausing, and replacement-branch commit; verify the focused Chat E2E files pass serially.

## 7. Validation

- [x] 7.1 Run `bun run typecheck`, `bun run api:validate`, `bunx @fission-ai/openspec validate --all --strict`, and the focused Chat unit suites; resolve every failure.
- [x] 7.2 Run `bun run check:licenses` and `bun run build`; verify the existing pinned OpenCode SDK needs no dependency change and the production binary builds.
- [x] 7.3 Run the complete `bun test` suite and the affected Chat Playwright files with `workers: 1`; verify request handling, shell output, queueing, attachments, drill-down, and conversation inventory retain their existing behavior.

## 8. Selected-Message Revert And Restore

- [x] 8.1 Extend reversible-history state with the hidden user-message suffix, add strict selected Revert and Restore request contracts, and publish workspace API revision 10; verify runtime, route, and API contract validation.
- [x] 8.2 Implement canonical selected-boundary Revert and per-message Restore in classic and native-v2 providers while retaining one-step Undo and Redo; verify focused provider tests cover direct older boundaries, middle restore, newest restore, and stale targets.
- [x] 8.3 Thread selected mutations through adapter idempotency, admission serialization, interruption, queue pause, authoritative reconciliation, service, routes, and client; verify only the caller receives restored composer state while all clients receive the shared hidden-message list.
- [x] 8.4 Add inline Revert message actions and a synchronized reverted-message restore dock without exposing main-conversation controls in drill-downs; verify renderer, UI, and multi-client browser coverage matches OpenCode's boundary behavior.

## 9. Command Discovery And Header Layout

- [x] 9.1 Rank slash-command suggestions by exact, prefix, segment, substring, and subsequence match quality with deterministic ties; verify `/archive` discovers and inserts `/openspec-archive-change` in unit and browser tests.
- [x] 9.2 Give workspace/agent identity and conversation controls separate rows in the shared desktop/touch Chat header; verify markup and desktop/touch geometry coverage.

## 10. Follow-Up Validation

- [x] 10.1 Run typecheck, strict API/OpenSpec validation, focused Chat unit suites, and affected Chat Playwright files with one worker; resolve every failure.
- [x] 10.2 Run the complete unit suite, license audit, production build, final diff review, and refresh the light-mode PR screenshots without adding image files to the feature commit.
