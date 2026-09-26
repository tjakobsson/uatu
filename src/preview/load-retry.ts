// Bounded retry for a document load that failed for a reason other than the
// document being gone: the server answered 5xx, or the request never got an
// answer at all. A 404 is the server saying the file is not there, and the
// live document topic reports when that changes; a transient failure has no
// such follow-up, so without a retry the preview would say "unavailable" for
// a file that exists until the user happened to click it again.
//
// Free of DOM and appState so the schedule can be tested directly; `mount.ts`
// decides what a failure is and whether a retry is still wanted when it fires.

export const DOCUMENT_LOAD_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000, 10_000];

// Whether a `/api/document` answer (or a failed request, `null`) is worth
// retrying. Anything the server stated about the document itself (404 gone,
// 415 not viewable, 400 malformed) is final.
export function isTransientDocumentFailure(status: number | null): boolean {
  return status === null || status >= 500;
}

export type DocumentLoadRetryTimers = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

export type DocumentLoadRetry = {
  // A transient failure loading `key` (one document within one selection).
  // Schedules `retry` after the next delay and returns true, or returns false
  // once the attempts for `key` are used up. A different key starts over.
  failed(key: string, retry: () => void): boolean;
  // The load settled another way (it succeeded, or failed for good): cancel
  // any pending retry and forget the attempt count.
  settle(): void;
};

export function createDocumentLoadRetry(options: {
  delays?: readonly number[];
  timers?: DocumentLoadRetryTimers;
} = {}): DocumentLoadRetry {
  const delays = options.delays ?? DOCUMENT_LOAD_RETRY_DELAYS_MS;
  const timers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => clearTimeout(timer),
  };
  let currentKey: string | null = null;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  return {
    failed(key, retry) {
      cancel();
      if (key !== currentKey) {
        currentKey = key;
        attempts = 0;
      }
      const delay = delays[attempts];
      if (delay === undefined) return false;
      attempts += 1;
      timer = timers.setTimeout(() => {
        timer = null;
        retry();
      }, delay);
      return true;
    },
    settle() {
      cancel();
      currentKey = null;
      attempts = 0;
    },
  };
}
