## Context

See `proposal.md` — Why. The constraints that shape the approach:

- `normalizeProviderEvent` (`src/chat/normalization.ts`) is a `switch` over event type ending in `default: return { conversationId, updates: [] }`. An unrecognized event and a recognized-but-empty one are indistinguishable to the caller.
- `adapter.ts:338` calls it *outside* the loop's inner `try` (which covers only `requireSession`), so a throw from a strict accessor escapes the `for await` and ends the pump. The pump is supervised and restarts with backoff, but the gap is unrecoverable for permissions.
- Permissions exist in uatu only as live events: no case in `normalizeProviderMessage`, no pending-permission poll. Questions already have the poll (`adapter.ts:157`, `pendingQuestions`).
- `MetricsRegistry` (`src/debug/metrics.ts`) is a flat `Record<string, number>` with `increment(name, delta)`. Its snapshot is written to `snapshot-<pid>.json` **unconditionally** — `--debug` gates only `/debug/metrics` and the 1 Hz NDJSON history.
- The pinned SDK has both `GET /permission` (global, `directory` query) and `GET /api/permission/request`.

Verified against a live OpenCode 1.18.18 during exploration and treated as fixed ground: `skill` is a real permission type (`GET /config` returned `{"bash":"ask","skill":"ask"}`); the binary contains a bridge translating `permission.v2.asked` → `permission.asked` (`action`→`permission`, `resources`→`patterns`, `save`→`always`); and `/event` and `/api/event` carry identical modern type names for everything observed. Not established: which family announces a *skill* approval, because the isolated probe could never authenticate a provider to reach the permission gate. The approach below is deliberately chosen to not depend on that answer.

## Goals / Non-Goals

**Goals:**

- Make "what did the workspace throw away?" answerable from a running workspace, without a rebuild and without `--debug`.
- Close the hang class regardless of which event family OpenCode uses.
- Keep a bad payload's blast radius to one event.

**Non-Goals:**

- Mapping every unhandled event. 56 are unhandled; this maps the ones that can hang a turn or make the transcript lie, and adds the counter that will show whether any of the rest matter.
- Changing how interactions are rendered or answered. The item types, routes, and receipt behavior are unchanged.
- Any published-contract change. `/debug/metrics` is already excluded (`workspace-debug` in `api/exclusions.yaml`).

## Decisions

### 1. Handle both families by mapping onto the same item id — dedupe falls out

Both families carry the same request identity: `permission.v2.asked` has `data.id`, and the bridged `permission.asked` has `properties.id` holding that same value. Mapping both to the existing `permission:${requestId}` item id means the projection's upsert **is** the dedupe. No cross-family bookkeeping, no "which one won" state.

Field mapping follows the bridge exactly, in reverse:

```
classic permission.asked → normalized PermissionRequest
  properties.id        → requestId          (and item id `permission:<id>`)
  properties.permission → action            (v2 calls this `action`)
  properties.patterns   → resources         (v2 calls this `resources`)
  properties.sessionID  → conversationId
```

Same for `question.asked` / `question.replied` / `question.rejected` onto `question:${requestId}`.

Where the two families disagree on a field, last-write-wins through the existing merge in `adapter.ts:607`, which already reconciles overlapping permission upserts and prefers a non-empty `resources` over an empty one.

Alternatives considered:
- **Pick one family and ignore the other.** Requires knowing which one OpenCode uses for every interaction type — exactly the thing exploration could not establish. Handling both costs one extra `case` per event and removes the question.
- **Explicit cross-family dedupe table.** Redundant once both map to one id, and it would need eviction.

### 2. Normalization returns an outcome instead of throwing or silently emptying

`normalizeProviderEvent` gains a discriminated result: recognized-with-updates, recognized-but-nothing-to-do, or unrecognized. Parse failures are caught at the boundary and reported as a fourth: unparseable-with-type. The caller then counts and continues in every non-fatal case.

This is what makes the counter honest. Today an unrecognized event and a deliberately ignored one return the identical empty value, so counting at the call site would either miss real drops or inflate the count with events we intentionally skip.

The call moves inside the loop's error boundary so a throw from a strict accessor drops one event rather than the pump.

### 3. Counters live in the existing registry, keyed by type, with bounded cardinality

`chat.event.unhandled.<type>` and `chat.event.unparseable.<type>`, through `MetricsRegistry.increment`. Two properties matter:

- They ride the **unconditional** `snapshot-<pid>.json`, so an operator reads them from the cache directory without restarting under `--debug`. That is the difference between "diagnosable on the box where it broke" and "reproduce it again, this time with a flag."
- They also appear at `/debug/metrics` when `--debug` is on, and in watchdog dump bundles, for free.

Event type strings come from a local trusted process, but the key space must still be bounded: cap distinct unhandled types (64) and fold the rest into `chat.event.unhandled.other`, so a future OpenCode that emits per-request type names cannot grow the registry without limit. Payloads are never recorded — the spec forbids it and a payload can carry file contents.

Alternatives considered:
- **A dedicated log line per drop.** Unbounded output for a high-frequency type, and it needs a logging facility uatu does not have (deliberately out of scope in `chat-startup-diagnostics`).
- **Only expose at `/debug/metrics`.** Requires a restart with `--debug` to learn what a live workspace is discarding, which defeats the purpose.

### 4. Pending permissions reconcile on history load, mirroring questions

Add `listPermissions?(sessionId)` to `OpenCodeProvider` and call it beside `pendingQuestions` in the history path. Use the global `GET /permission` filtered by directory — the same route shape `listQuestions` already uses, and for the reason recorded there: on 1.18 the session-scoped route answers empty for a session the global route reports a live request for. `GET /api/permission/request` exists as an alternative and is not used, so there is one polling pattern rather than two.

Reuse `pendingQuestions`' failure discipline verbatim: a failed list degrades the snapshot and must not rewrite the published set, because erasing live requests is worse than missing new ones. The optional-method shape means a provider without it simply never recovers permissions, exactly as with questions.

Deliberately **not** polling on a timer: history load is the moment a user is looking at the conversation, which is the moment recovery matters. A timer would add steady request load to every workspace for a rare failure.

### 5. Compaction and revert become notices, not new item types

Map `session.next.compaction.started/ended` and `session.next.revert.staged/committed/cleared` onto the existing `notice` item. The user-visible requirement is that the transcript stop lying; it does not require bespoke rendering, and a new item type would touch the renderer, the validator, and the published `ConversationItem` schema — which would drag an API revision into a change that otherwise needs none.

`session.next.compaction.delta` is intentionally skipped: it is streaming progress for an operation whose start and end are enough, and the new counter will show if that judgment is wrong.

## Risks / Trade-offs

- **The classic payload lacks a field the v2 path assumes** → Map with optional accessors and fall back to the merge in `adapter.ts:607`; a test drives the exact bridged shape observed in the binary.
- **Both families deliver and the merge picks the worse value** → The existing merge already prefers non-empty `resources` and a real `action`; a test asserts a v2-then-classic and classic-then-v2 pair both settle on one complete entry.
- **Counter cardinality growth** → Capped at 64 distinct types with an `other` bucket.
- **A permission poll on every history load adds latency** → It is one request, already the pattern for questions, and it runs concurrently with the existing question list rather than after it.
- **Recovered permission is already resolved** → Answering a stale request is refused by the existing `requirePending` guard, and the reconciliation only adds entries absent from the timeline.
- **This still may not be the reported bug** → Accepted, and the reason item 1 is sequenced first: if the counter shows a different type being dropped, the fix follows the evidence instead of this analysis.

## Migration Plan

No data, config, or contract migration. No new HTTP route, no response-schema change, so no API revision increment — unlike `chat-startup-diagnostics`, which needed one because it added a property to a closed response object.

These are bug fixes against unreleased chat work and land on `fix/chat-startup-diagnostics` (PR #260), covered by that PR's existing Release Please override. Item 1 (counters) is independently useful and should be committed first so it is available even if the rest is still in review.

Rollback: every piece is additive and independent. Reverting the classic-family cases restores today's behavior; reverting the poll leaves the live path intact; the counters affect nothing but the registry.

## Open Questions

- Whether a *skill* approval is announced as a permission or as a structured question. Deferrable: both families of both kinds are handled here, so the fix does not depend on the answer, and the new counter will settle it on the reporter's machine.
