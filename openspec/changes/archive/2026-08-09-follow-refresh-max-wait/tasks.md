# follow-refresh-max-wait — tasks

## 1. Implementation

- [x] 1.1 In `src/server/watch-session.ts` `scheduleRefresh`: record the batch start on the first event of a batch and clamp the re-armed trailing timer so it fires no later than `batchStartedAt + 2000` ms; reset the batch marker when the refresh fires.
- [x] 1.2 Unit test with a controlled clock: a stream of events every 100 ms for 5 s yields refreshes within the 2 s bound (and exactly one refresh for a short burst that ends before 150 ms of quiet elapses — the existing behavior).

## 2. Verification

- [x] 2.1 `bun test` green; spot-check `bun run dev` under a scripted write loop (e.g. a shell loop touching files every 100 ms) — sidebar and follow keep updating during the churn.
