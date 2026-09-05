// A scan and its repository collection publish as one operation. Requests
// received during it coalesce into a subsequent scan, including null-id
// reconciliations. The debounce remains with the caller.
export function createRefreshQueue(refresh: (changedId: string | null) => Promise<void>) {
  type Batch = { changedId: string | null; completion: ReturnType<typeof Promise.withResolvers<void>> };
  let pending: Batch | null = null;
  let running = false;
  let stopped = false;

  async function drain() {
    running = true;
    while (pending && !stopped) {
      const batch = pending;
      pending = null;
      try {
        await refresh(batch.changedId);
        batch.completion.resolve();
      } catch (error) {
        // Settle this batch, then drain any events received during failure.
        batch.completion.reject(error);
      }
    }
    running = false;
  }

  return {
    request(changedId: string | null): Promise<void> {
      if (stopped) return Promise.resolve();
      pending ??= { changedId: null, completion: Promise.withResolvers<void>() };
      if (changedId) pending.changedId = changedId;
      // Startup waits for its own complete snapshot, not for all future
      // activity to stop. A busy workspace must still be able to start.
      const completion = pending.completion.promise;
      if (!running) void drain();
      return completion;
    },
    stop() {
      stopped = true;
      pending?.completion.resolve();
      pending = null;
    },
  };
}
