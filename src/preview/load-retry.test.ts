import { describe, expect, test } from "bun:test";

import { DOCUMENT_NOT_READABLE_ERROR } from "../shared/document-errors";
import { appState } from "../shell/state";
import { getSelectionActivation, getSelectionGeneration, setSelectedId } from "../shell/selection";
import {
  classifyDocumentResponse,
  createDocumentLoadRetry,
  documentFailureMessage,
  documentLoadRetryKey,
  isTransientDocumentFailure,
  type DocumentLoadFailure,
  type DocumentLoadRetryTimers,
} from "./load-retry";

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; delay: number }>();
  let next = 1;
  const timers: DocumentLoadRetryTimers = {
    setTimeout: (callback, delay) => {
      const id = next++;
      pending.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: timer => { pending.delete(timer as unknown as number); },
  };
  return {
    timers,
    delays: () => [...pending.values()].map(entry => entry.delay),
    fire: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.callback();
    },
  };
}

const status = (code: number, error?: string): DocumentLoadFailure =>
  error === undefined ? { kind: "status", status: code } : { kind: "status", status: code, error };

describe("isTransientDocumentFailure", () => {
  test("a server failure or no answer is transient", () => {
    expect(isTransientDocumentFailure({ kind: "no-answer" })).toBe(true);
    for (const code of [500, 502, 503]) {
      expect(isTransientDocumentFailure(status(code))).toBe(true);
    }
  });

  test("408 Request Timeout and 429 Too Many Requests are transient", () => {
    expect(isTransientDocumentFailure(status(408))).toBe(true);
    expect(isTransientDocumentFailure(status(429))).toBe(true);
  });

  test("what the server says about the document itself, or an unparseable OK answer, is final", () => {
    for (const code of [400, 401, 403, 404, 405, 409, 410, 413, 415, 418, 422, 428, 431, 451]) {
      expect(isTransientDocumentFailure(status(code))).toBe(false);
    }
    expect(isTransientDocumentFailure(status(403, DOCUMENT_NOT_READABLE_ERROR))).toBe(false);
    expect(isTransientDocumentFailure({ kind: "unreadable" })).toBe(false);
  });
});

const PERMISSION = "Uatu doesn't have permission to read this file. Change its permissions, then select it again.";
const NOT_FOUND = "File unavailable. It may have been removed or excluded from this workspace.";
const FINAL = "This file couldn't be loaded. Select it again to retry.";
const RETRYING = "This file couldn't be loaded. Retrying…";

describe("documentFailureMessage", () => {

  test("a 403 tagged as not readable names the permission problem", () => {
    expect(documentFailureMessage(status(403, DOCUMENT_NOT_READABLE_ERROR), false)).toBe(PERMISSION);
  });

  test("a 403 without the tag gets the generic final notice", () => {
    expect(documentFailureMessage(status(403), false)).toBe(FINAL);
    expect(documentFailureMessage(status(403, "forbidden"), false)).toBe(FINAL);
  });

  test("a 404 keeps the not-found notice", () => {
    expect(documentFailureMessage(status(404, "document not found"), false)).toBe(NOT_FOUND);
  });

  test("any other final failure gets the generic final notice", () => {
    expect(documentFailureMessage(status(415, "document is not viewable"), false)).toBe(FINAL);
    expect(documentFailureMessage(status(400), false)).toBe(FINAL);
    expect(documentFailureMessage(status(401), false)).toBe(FINAL);
    expect(documentFailureMessage({ kind: "unreadable" }, false)).toBe(FINAL);
  });

  test("a transient failure says it is retrying until the schedule is used up", () => {
    expect(documentFailureMessage({ kind: "no-answer" }, true)).toBe(RETRYING);
    expect(documentFailureMessage(status(500), true)).toBe(RETRYING);
    expect(documentFailureMessage({ kind: "no-answer" }, false)).toBe(FINAL);
    expect(documentFailureMessage(status(502), false)).toBe(FINAL);
  });

  test("a 408 or 429 retries like a server failure, then asks to select it again", () => {
    for (const code of [408, 429]) {
      expect(documentFailureMessage(status(code), true)).toBe(RETRYING);
      expect(documentFailureMessage(status(code), false)).toBe(FINAL);
    }
  });

  test("a 403 or 404 whose body is not JSON (a proxy's error page) gets the notice its status implies", () => {
    const html = "<html><body><h1>403 Forbidden</h1></body></html>";
    const forbidden = classifyDocumentResponse({ ok: false, status: 403 }, html);
    expect(forbidden).toEqual({ ok: false, failure: { kind: "status", status: 403 } });
    if (!forbidden.ok) {
      expect(isTransientDocumentFailure(forbidden.failure)).toBe(false);
      expect(documentFailureMessage(forbidden.failure, false)).toBe(FINAL);
    }

    const missing = classifyDocumentResponse({ ok: false, status: 404 }, "<html><body>Not Found</body></html>");
    expect(missing).toEqual({ ok: false, failure: { kind: "status", status: 404 } });
    if (!missing.ok) {
      expect(isTransientDocumentFailure(missing.failure)).toBe(false);
      expect(documentFailureMessage(missing.failure, false)).toBe(NOT_FOUND);
    }
  });
});

describe("classifyDocumentResponse", () => {
  test("a non-OK answer carries the body's error tag only when it is a JSON string", () => {
    expect(classifyDocumentResponse({ ok: false, status: 403 }, JSON.stringify({ error: DOCUMENT_NOT_READABLE_ERROR })))
      .toEqual({ ok: false, failure: { kind: "status", status: 403, error: DOCUMENT_NOT_READABLE_ERROR } });
    expect(classifyDocumentResponse({ ok: false, status: 403 }, "<html>Forbidden</html>"))
      .toEqual({ ok: false, failure: { kind: "status", status: 403 } });
    expect(classifyDocumentResponse({ ok: false, status: 403 }, JSON.stringify({ error: 403 })))
      .toEqual({ ok: false, failure: { kind: "status", status: 403 } });
    expect(classifyDocumentResponse({ ok: false, status: 502 }, ""))
      .toEqual({ ok: false, failure: { kind: "status", status: 502 } });
    expect(classifyDocumentResponse({ ok: false, status: 429 }, "null"))
      .toEqual({ ok: false, failure: { kind: "status", status: 429 } });
  });

  test("a non-OK answer whose body read fails is classified by its status alone, with no tag", () => {
    for (const code of [403, 404, 415]) {
      const result = classifyDocumentResponse({ ok: false, status: code }, null);
      expect(result).toEqual({ ok: false, failure: { kind: "status", status: code } });
      if (!result.ok) expect(isTransientDocumentFailure(result.failure)).toBe(false);
    }
    const forbidden = classifyDocumentResponse({ ok: false, status: 403 }, null);
    if (!forbidden.ok) expect(documentFailureMessage(forbidden.failure, false)).toBe(FINAL);
    const missing = classifyDocumentResponse({ ok: false, status: 404 }, null);
    if (!missing.ok) expect(documentFailureMessage(missing.failure, false)).toBe(NOT_FOUND);
  });

  test("a 503 whose body read fails stays transient through its status", () => {
    const result = classifyDocumentResponse({ ok: false, status: 503 }, null);
    expect(result).toEqual({ ok: false, failure: { kind: "status", status: 503 } });
    if (!result.ok) expect(isTransientDocumentFailure(result.failure)).toBe(true);
  });

  test("an OK answer whose body read fails got no complete answer", () => {
    const result = classifyDocumentResponse({ ok: true, status: 200 }, null);
    expect(result).toEqual({ ok: false, failure: { kind: "no-answer" } });
    if (!result.ok) expect(isTransientDocumentFailure(result.failure)).toBe(true);
  });

  test("an OK answer is a payload only when it parses and has a string html", () => {
    expect(classifyDocumentResponse({ ok: true, status: 200 }, JSON.stringify({ id: "a", html: "<p>x</p>" })))
      .toEqual({ ok: true, payload: { id: "a", html: "<p>x</p>" } as { html: string } });
    expect(classifyDocumentResponse({ ok: true, status: 200 }, "not json"))
      .toEqual({ ok: false, failure: { kind: "unreadable" } });
    expect(classifyDocumentResponse({ ok: true, status: 200 }, JSON.stringify({ id: "a" })))
      .toEqual({ ok: false, failure: { kind: "unreadable" } });
    expect(classifyDocumentResponse({ ok: true, status: 200 }, "null"))
      .toEqual({ ok: false, failure: { kind: "unreadable" } });
  });
});

describe("createDocumentLoadRetry", () => {
  test("retries on the schedule, then gives up", () => {
    const clock = fakeTimers();
    const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
    let runs = 0;
    const run = () => { runs += 1; };

    expect(retry.failed("a", run, "request")).toBe(true);
    expect(clock.delays()).toEqual([10]);
    clock.fire();
    expect(runs).toBe(1);

    expect(retry.failed("a", run, "retry")).toBe(true);
    expect(clock.delays()).toEqual([20]);
    clock.fire();
    expect(runs).toBe(2);

    expect(retry.failed("a", run, "retry")).toBe(false);
    expect(clock.delays()).toEqual([]);
  });

  test("a different document or selection starts over", () => {
    const clock = fakeTimers();
    const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
    retry.failed("a", () => {}, "request");
    retry.failed("a", () => {}, "retry");
    expect(clock.delays()).toEqual([20]);

    expect(retry.failed("b", () => {}, "retry")).toBe(true);
    // The pending retry for "a" is replaced, not stacked.
    expect(clock.delays()).toEqual([10]);
  });

  test("settling cancels the pending retry and resets the count", () => {
    const clock = fakeTimers();
    const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
    let runs = 0;
    retry.failed("a", () => { runs += 1; }, "request");
    retry.settle();
    expect(clock.delays()).toEqual([]);
    clock.fire();
    expect(runs).toBe(0);

    retry.failed("a", () => {}, "request");
    expect(clock.delays()).toEqual([10]);
  });
});

describe("re-arming the schedule", () => {
  // The key mount.ts builds for the load in flight right now.
  const currentKey = (documentId: string) => documentLoadRetryKey({
    selectionGeneration: getSelectionGeneration(),
    activation: getSelectionActivation(),
    documentId,
  });

  test("the user activating the same document again starts a fresh schedule; a watcher reconcile does not", () => {
    const initialSelectedId = appState.selectedId;
    const initialSelectionCleared = appState.selectionCleared;
    try {
      const documentId = "/watch/docs/retry-rearm.md";
      const clock = fakeTimers();
      const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });

      setSelectedId(documentId, "navigation");
      expect(retry.failed(currentKey(documentId), () => {}, "request")).toBe(true);
      clock.fire();
      expect(retry.failed(currentKey(documentId), () => {}, "retry")).toBe(true);
      clock.fire();
      expect(retry.failed(currentKey(documentId), () => {}, "retry")).toBe(false);

      // A watcher frame re-confirms the same selection: the key is unchanged,
      // so the schedule's own retries stay exhausted.
      const generation = getSelectionGeneration();
      setSelectedId(documentId, "reconcile");
      expect(getSelectionGeneration()).toBe(generation);
      expect(retry.failed(currentKey(documentId), () => {}, "retry")).toBe(false);
      expect(clock.delays()).toEqual([]);

      // Selecting the same row again leaves the selection generation alone
      // but is a new user activation, so the schedule starts over.
      setSelectedId(documentId, "navigation");
      expect(getSelectionGeneration()).toBe(generation);
      expect(retry.failed(currentKey(documentId), () => {}, "retry")).toBe(true);
      expect(clock.delays()).toEqual([10]);
    } finally {
      appState.selectedId = initialSelectedId;
      appState.selectionCleared = initialSelectionCleared;
    }
  });

  test("a live frame's reload that fails starts the schedule over; a failed retry never re-arms it", () => {
    const initialSelectedId = appState.selectedId;
    const initialSelectionCleared = appState.selectionCleared;
    try {
      const documentId = "/watch/docs/retry-live-frame.md";
      const clock = fakeTimers();
      const retry = createDocumentLoadRetry({ delays: [10, 20], timers: clock.timers });
      let runs = 0;
      const run = () => { runs += 1; };

      setSelectedId(documentId, "navigation");
      expect(retry.failed(currentKey(documentId), run, "request")).toBe(true);
      clock.fire();
      expect(retry.failed(currentKey(documentId), run, "retry")).toBe(true);
      clock.fire();
      expect(retry.failed(currentKey(documentId), run, "retry")).toBe(false);
      expect(runs).toBe(2);

      // A watcher frame for the same selection reloads it (same key, no new
      // activation) and that reload fails: the frame is new evidence the file
      // changed, so a fresh schedule starts at the first delay.
      setSelectedId(documentId, "reconcile");
      expect(retry.failed(currentKey(documentId), run, "request")).toBe(true);
      expect(clock.delays()).toEqual([10]);

      // The schedule's own retries continue it and give up again, without
      // re-arming themselves.
      clock.fire();
      expect(retry.failed(currentKey(documentId), run, "retry")).toBe(true);
      expect(clock.delays()).toEqual([20]);
      clock.fire();
      expect(retry.failed(currentKey(documentId), run, "retry")).toBe(false);
      expect(retry.failed(currentKey(documentId), run, "retry")).toBe(false);
      expect(clock.delays()).toEqual([]);
      expect(runs).toBe(4);
    } finally {
      appState.selectedId = initialSelectedId;
      appState.selectionCleared = initialSelectionCleared;
    }
  });
});
