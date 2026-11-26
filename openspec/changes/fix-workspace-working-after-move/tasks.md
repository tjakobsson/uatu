## 1. Provider Seam & OpenCode v2 Normalization

- [x] 1.1 Extend `NormalizedSessionLifecycle` with `kind: "moved"` and add optional `listActiveSessions()` to `ChatProvider` in `src/chat/provider.ts`.
- [x] 1.2 Normalize `session.moved` before foreign-event filtering in `src/chat/opencode/v2/normalization.ts` and implement `listActiveSessions()` via `client.session.active()` in `src/chat/opencode/v2/provider.ts`.

## 2. Adapter Activity & Inventory Handling

- [x] 2.1 Handle `kind: "moved"` in `ChatAdapter.applySessionLifecycle()` (source activity/coalescer/projection cleanup, `listedSessions` invalidation, known active child re-verification, and destination inventory/background/active-session seeding) in `src/chat/adapter.ts`.
- [x] 2.2 Reconcile stale tracked activity on `requireSession()` null misses, `listConversations()`, and `server.connected` recovery, guarding active-session probes with per-session status sequences in `src/chat/adapter.ts`.

## 3. Verification & Spec Sync

- [x] 3.1 Add unit tests covering `session.moved` normalization (`src/chat/opencode/v2/normalization.test.ts`), `listActiveSessions()` (`src/chat/opencode/v2/provider.test.ts`), and source/destination move-out, move-in, coalescer race, child re-verification, and missed-move reconciliation (`src/chat/adapter.test.ts`).
- [x] 3.2 Sync delta requirements into `openspec/specs/opencode-chat/spec.md` and validate with `openspec validate --all --strict`, `tests/openspec-discipline.test.ts`, `bun run typecheck`, and targeted `bun test`.
