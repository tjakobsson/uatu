# Live-burst recovery evidence

## Scope and limits

The local reproduction uses the real hub broker, endpoint, SSE parser and an actively draining response reader. Its upstream is synthetic: 2,713 small ordered conversation upserts (~2 MiB total), delivered either in one chunk or queued 16 KiB chunks. It does not access a live session, credentials, settings or a running application.

This proves a burst-induced stream interruption, not that this path caused the reported screenshot. The lead's subsequent live desktop attempt observed a dismissal failure but no reconnect banner and an open stream. The exact live event trace and upstream chunk cadence remain unknown. This change does not fix provider latency, normalization volume or dismissal storage limits.

## Ranked hypotheses

1. Synchronous fan-out prevents the response reader from draining. Prediction: yielding between bounded batches fixes active-reader closure without relaxing the queue cap or allowing a truly stalled client to grow.
2. One oversized event exceeds the queue cap. Prediction: using many individually small events avoids closure. The initial reproduction refutes this: each text payload is only 512 bytes.
3. Cursor replay itself causes the interruption. Prediction: failure requires a replay/reconnect. The initial reproduction refutes this: the shared stream is already ready when the burst arrives.

## Red checks

Before pacing shared delivery:

```text
bun test src/hub/live-endpoint.test.ts -t 'a reading client drains a long-history'
0 pass, 1 fail
expect(stream.ended).toBe(false): expected false, received true
```

After pacing shared delivery only, private catch-up still failed:

```text
bun test src/hub/live-endpoint.test.ts -t 'a reading client drains a large private'
0 pass, 1 fail
expect(behind.ended).toBe(false): expected false, received true
```

Resetting the byte budget per upstream read was insufficient:

```text
bun test src/hub/live-endpoint.test.ts -t '16 KiB chunks'
0 pass, 1 fail
expect(stream.ended).toBe(false): expected false, received true
```

The final byte budget spans reads. Root cause: upstream delivery can repeatedly queue data faster than the response reader's microtasks run; the unchanged outbound cap then closes a reader that is not actually stalled.

## Green checks

```text
bun test src/hub/live-endpoint.test.ts -t 'a reading client drains|stalled client'
5 pass, 0 fail

bun test src/hub/live-broker.test.ts -t 'disposing during'
2 pass, 0 fail

bun test src/hub/live-broker.test.ts src/hub/live-endpoint.test.ts src/chat/client.test.ts src/chat/lifecycle.test.ts src/shell/live-channel.test.ts src/shell/live.test.ts src/shell/connection.test.ts
201 pass, 0 fail, 959 assertions

bun run typecheck
passed

openspec validate fix-live-burst-recovery --strict
valid

git diff --check
passed
```

The queue limit and intentional stalled-client behavior are unchanged. Tests check every delivered cursor in order, catch-up merging into later shared delivery, and disposal during both shared and private burst yields. The earlier lifecycle test was preserved unchanged; its slow-resync/invalidation/wake-up variant is a separate additional test.

## Handoff

- Production: `src/hub/live-broker.ts` only (bounded scheduling in shared and private delivery).
- Tests: `src/hub/live-broker.test.ts`, `src/hub/live-endpoint.test.ts`, and the earlier additive `src/chat/lifecycle.test.ts` scenario.
- Planning/documentation: this change directory.
- No adapter, UI, route, dismissal implementation, dependencies, live sessions, credentials, settings or services changed. No commits or publication.
- Independent affected-area review and broader release verification remain with the lead; this evidence is not a full-suite or live-browser fix claim.

## Independent affected-area review

A fresh reviewer found no actionable standards, correctness or security findings in the reconnect scope. The reviewer independently ran the seven-file suite: **201 passed**, 959 assertions, plus typecheck and scoped whitespace checks. With pacing disabled in memory, all three burst reproductions failed with unexpected stream closure (shared single-chunk, shared 16 KiB chunks and private catch-up); no repository files were modified for this check.

The review confirms the local defect and correction, not screenshot attribution. Parsing still materializes an upstream chunk before paced delivery, an existing limitation. Full-tree verification must be renewed after the separate live-source dismissal compatibility investigation is resolved.

## Stable release verification

An in-memory Bun module loader substituted the actual `v0.8.0:src/hub/live-broker.ts` from stable commit `f2876637e65d010c6eb94f138397ae35421c9e04` into the focused endpoint suite. All three `a reading client drains` cases failed with unexpected stream closure, including shared single-chunk, shared 16 KiB chunks and private catch-up. The identical three tests passed with the patched broker. No compatibility issue or repository edit was needed for this comparison.

This is a stable-release defect. The combined PR must retain a visible `fix` release note for burst-induced chat interruptions rather than using the dismissal-only poststable chore override. No generated changelog edit or publication was performed.

## Final combined verification

The lead's combined-tree `bun run test:ci` completed after the reviewed dismissal compatibility correction and broker pacing change: **9635 passed, 16 skipped, zero failed**, 103646 assertions across 327 files, 470.32 seconds. Typecheck, API validation, strict validation of both OpenSpec changes, build, compiled smoke and whitespace checks passed. No live deployment or publication was performed; original mobile reconnect attribution remains unverified.
