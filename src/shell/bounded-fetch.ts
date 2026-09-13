// A fetch that cannot hang. A phone changing networks routinely leaves a
// request unanswered with no error — the socket is gone but nothing says so
// — and a recovery task built on such a request never settles. Every read the
// lifecycle recovery depends on goes through here, so it fails within a
// bound the coalescer can rely on. Mirrors the chat client's read budget.

export type BoundedFetchTimers = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const defaultTimers: BoundedFetchTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function fetchWithinBudget(
  fetcher: Fetcher,
  input: string,
  timeoutMs: number,
  timers: BoundedFetchTimers = defaultTimers,
): Promise<Response> {
  const controller = new AbortController();
  const timer = timers.setTimeout(() => {
    controller.abort(new Error(`request unanswered after ${timeoutMs} ms: ${input}`));
  }, timeoutMs);
  // Raced rather than relying on the fetcher honouring the signal: an
  // implementation that ignores `signal` (or a fake) would otherwise still
  // hang the caller.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  return Promise.race([fetcher(input, { signal: controller.signal }), aborted])
    .finally(() => timers.clearTimeout(timer));
}
