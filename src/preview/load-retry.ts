// Bounded retry for a document load that failed for a reason that may clear
// on its own: the server answered 5xx, 408 or 429, or the request never got a
// complete answer. Any other 4xx is the server stating something about the
// document (gone, not readable, not viewable), and the live document topic
// reports when the file changes; a transient failure has no such follow-up, so without a
// retry the preview would say "couldn't be loaded" for a file that is fine
// until the user happened to click it again.
//
// Free of DOM and appState so the schedule, the classification, and the
// notice text can be tested directly; `mount.ts` builds the failure from the
// response and decides whether a retry is still wanted when it fires.

import { DOCUMENT_NOT_READABLE_ERROR } from "../shared/document-errors";

export const DOCUMENT_LOAD_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000, 10_000];

// What went wrong loading a document from `/api/document`:
// - "no-answer": the request got no complete answer (`fetch()` threw, or the
//   body of an OK answer broke before it finished). A network failure.
// - "status": the server answered with a non-OK status; `error` is the
//   body's machine tag when it could be read. The status line alone decides
//   whether it is final, so a non-OK body that breaks mid-read is still a
//   `status` failure, just without a tag.
// - "unreadable": the server answered OK but the body is not a document
//   payload. Asking again will not make it parse.
export type DocumentLoadFailure =
  | { kind: "no-answer" }
  | { kind: "status"; status: number; error?: string }
  | { kind: "unreadable" };

// The 4xx statuses that say "not now" rather than anything about the
// document: 408 Request Timeout and 429 Too Many Requests (typically from a
// proxy in front of the session). Retry-After is not read; the schedule's own
// delays apply.
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

// Whether a failed load is worth retrying: no answer, a 5xx, a 408 or a 429.
// Anything the server stated about the document itself (404 gone, 403 not
// readable, 415 not viewable, 400 malformed) and an OK answer that does not
// parse are final.
export function isTransientDocumentFailure(failure: DocumentLoadFailure): boolean {
  if (failure.kind === "no-answer") return true;
  if (failure.kind === "status") return failure.status >= 500 || TRANSIENT_CLIENT_STATUSES.has(failure.status);
  return false;
}

// Classifies one `/api/document` answer: its status plus the body read as
// text, or `null` when reading the body threw. A non-OK answer is a `status`
// failure, with the body's `error` tag when the body is JSON carrying a
// string one; a body from something else in the path (a proxy's HTML error
// page, say) or a body that could not be read yields no tag, and the status
// alone decides (a 404 stays final, a 503 stays transient). An OK answer whose
// body could not be read got no complete answer: `no-answer`. An OK answer
// whose body does not parse, or has no string `html`, is `unreadable`.
// `fetch()` itself throwing is the caller's "no-answer".
export function classifyDocumentResponse(
  response: { ok: boolean; status: number },
  text: string | null,
): { ok: true; payload: { html: string } } | { ok: false; failure: DocumentLoadFailure } {
  if (text === null && response.ok) return { ok: false, failure: { kind: "no-answer" } };
  let parsed: unknown;
  try {
    parsed = text === null ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const error = (parsed as { error?: unknown } | null | undefined)?.error;
    return {
      ok: false,
      failure: typeof error === "string"
        ? { kind: "status", status: response.status, error }
        : { kind: "status", status: response.status },
    };
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { html?: unknown }).html !== "string") {
    return { ok: false, failure: { kind: "unreadable" } };
  }
  return { ok: true, payload: parsed as { html: string } };
}

// The notice the preview shows for a failed load. `retrying` says whether the
// schedule has another attempt pending (only ever true for a transient
// failure). The permission notice needs the server's tag as well as the
// status, so a 403 from anywhere else (a hub refusal, say) is never
// mislabeled as a file-permission problem.
export function documentFailureMessage(failure: DocumentLoadFailure, retrying: boolean): string {
  if (isTransientDocumentFailure(failure)) {
    return retrying
      ? "This file couldn't be loaded. Retrying…"
      : "This file couldn't be loaded. Select it again to retry.";
  }
  if (failure.kind === "status" && failure.status === 403 && failure.error === DOCUMENT_NOT_READABLE_ERROR) {
    return "Uatu doesn't have permission to read this file. Change its permissions, then select it again.";
  }
  if (failure.kind === "status" && failure.status === 404) {
    return "File unavailable. It may have been removed or excluded from this workspace.";
  }
  return "This file couldn't be loaded. Select it again to retry.";
}

// The retry schedule's key: one document within one selection *and* one user
// activation. Folding the activation in means "select it again" — even the
// row already selected, which leaves the selection generation unchanged —
// starts a fresh schedule, while a watcher reconcile of the same selection
// does not.
export function documentLoadRetryKey(parts: {
  selectionGeneration: number;
  activation: number;
  documentId: string;
}): string {
  return `${parts.selectionGeneration}\u0000${parts.activation}\u0000${parts.documentId}`;
}

// What started the load that failed. Only the schedule's own timer is a
// "retry"; every other load is a "request" and counts as new evidence: a user
// activation, a view change, or a live frame saying the file changed on disk.
// A request that fails transiently starts the schedule over, even for a key
// whose attempts are used up, so a watcher reload after the schedule gave up
// is not one last try. A failed retry only continues the schedule, so the
// timer can never re-arm itself.
export type DocumentLoadTrigger = "request" | "retry";

export type DocumentLoadRetryTimers = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

export type DocumentLoadRetry = {
  // A transient failure loading `key` (one document within one selection).
  // Schedules `retry` after the next delay and returns true, or returns false
  // once the attempts for `key` are used up. A different key, or a failed
  // load the schedule did not start itself (`trigger` "request"), starts over.
  failed(key: string, retry: () => void, trigger: DocumentLoadTrigger): boolean;
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
    failed(key, retry, trigger) {
      cancel();
      if (key !== currentKey || trigger === "request") {
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
