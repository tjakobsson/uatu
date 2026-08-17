## Why

A user sat in Chat waiting for OpenCode to load a skill. OpenCode was waiting for permission; Chat never showed the request. Investigating it cost hours and still did not name the cause, because the workspace **discards every event it does not recognize without counting it** — `normalization.ts` ends in `default: return { conversationId, updates: [] }`, and `adapter.ts` then `continue`s past it. There is no counter, no log, and no way to ask a running workspace what it threw away.

That blind spot hides a family of real defects:

- OpenCode 1.18 emits two event families. `permission.v2.asked` is native and `permission.asked` is derived from it through an in-binary bridge (`action`→`permission`, `resources`→`patterns`, `save`→`always`). The workspace maps only the `v2` names, so the classic family is silently dropped — 31 of 87 event types are handled.
- The workspace's own code says OpenCode "never emits `question.v2.asked`", which forced a polling workaround. OpenCode does have live `question.asked` listeners, so the likely truth is that questions are emitted under the classic name the workspace ignores.
- A permission is knowable **only** from a live event. It has no case in `normalizeProviderMessage` and no pending-permission poll, so one missed while the supervised event pump was restarting is unrecoverable — the turn waits forever with nothing on screen.
- `normalizeProviderEvent` is called outside the loop's `try`, so a single unparseable payload throws out of the pump rather than dropping one event.

Beyond the hang class, unhandled compaction and revert events let the transcript quietly lie: content disappears with no explanation, and reverted work keeps rendering as though it still exists.

## What Changes

- **Count what is not understood.** Track unrecognized event types and the count of events dropped per type, and expose them on the existing debug metrics surface. This is the smallest change here and the one that makes the rest diagnosable from a running workspace instead of from a disassembled binary.
- **Handle both event families** for permissions and questions — `permission.asked`/`permission.replied` and `question.asked`/`question.replied`/`question.rejected` — mapping the classic payload shape onto the same normalized items the `v2` path already produces, and deduplicating so a permission delivered on both streams renders once.
- **Give a pending permission a recovery path.** Poll OpenCode's pending-permission list when a conversation's history loads, mirroring what `listQuestions` already does, so a request missed during a pump restart becomes answerable instead of stranding the turn.
- **Make an unparseable event survivable.** Normalize inside the loop's error boundary so one bad payload drops one event and increments a counter, rather than killing the pump and losing everything in the restart gap.
- **Reflect compaction and revert.** Map the `session.next.compaction.*` and `session.next.revert.*` families so a compacted or reverted conversation says so instead of appearing to lose content.

Explicitly out of scope: the remaining unhandled events that cannot mislead a user about conversation state — `pty.*`, `tui.*`, `lsp.*`, `mcp.*`, `workspace.*`, `worktree.*`, `plugin.added`, `catalog.updated`, and similar. The new counter is what will tell us whether any of them ever matter.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Two requirements change. *Conversation updates are structured and reconnectable* must state that normalization covers OpenCode's event families rather than one naming generation, that an unrecognized or unparseable event is counted and skipped rather than ending the stream, and that duplicate deliveries of one logical event resolve to a single timeline entry. *Users can resolve agent interaction requests in context* must state that a pending request stays resolvable even when its live announcement was missed.

## Impact

**Code**
- `src/chat/normalization.ts` — classic permission/question cases, compaction and revert families, and a typed "unrecognized" outcome instead of a silent empty update.
- `src/chat/adapter.ts` — normalization moves inside the error boundary (`adapter.ts:338` currently sits outside the inner `try`); pending-permission poll alongside the existing `pendingQuestions` call on history load; dedupe of cross-family duplicates.
- `src/chat/provider.ts`, `src/chat/sdk-v2-provider.ts` — a `listPermissions` seam beside `listQuestions`. Both list routes exist in the pinned SDK: `GET /permission` and `GET /api/permission/request`.
- `src/debug/metrics.ts` and the `/debug/metrics` route — the unhandled-event counters.

**Not affected**
- No dependency change; `@opencode-ai/sdk` stays pinned at `1.18.18`. No new HTTP route and no change to any response schema, so unlike `chat-startup-diagnostics` this needs no API revision increment — `/debug/metrics` is already excluded from the published contract (`workspace-debug` in `api/exclusions.yaml`).

**Delivery**
- These are bug fixes against unreleased chat work, so they land on `fix/chat-startup-diagnostics` (PR #260) rather than a separate branch, and are covered by that PR's existing Release Please override.

**Relationship to `chat-startup-diagnostics`**
- Same capability, disjoint requirements: that change modifies the installation/startup requirement and adds three; this one modifies the event-stream and interaction-request requirements. The two deltas do not overlap.
