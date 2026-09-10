import { describe, expect, test } from "bun:test";

import { createDocumentLoadGuard, type DocumentLoadToken } from "./load-generation";

type Deferred = {
  promise: Promise<string>;
  resolve(value: string): void;
};

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  return {
    promise: new Promise<string>(next => { resolve = next; }),
    resolve,
  };
}

describe("createDocumentLoadGuard", () => {
  test("reports pending, timeout, exact retry, and supersession through one generation", () => {
    const guard = createDocumentLoadGuard();
    const statuses: string[] = [];
    const unsubscribe = guard.subscribe(() => statuses.push(guard.state().status));
    const first = guard.begin("image#1.png", "rendered", "single");
    guard.settle(first, "timeout");
    expect(guard.state()).toEqual({ documentId: "image#1.png", status: "timeout" });
    const retry = guard.begin("image#1.png", "rendered", "single");
    guard.settle(first, "ready");
    expect(guard.state().status).toBe("pending-selection");
    guard.settle(retry, "missing-target");
    const next = guard.begin("next.md", "source", "single");
    guard.settle(retry, "load-error");
    guard.settle(next, "ready");
    unsubscribe();
    guard.begin("ignored", "source", "single");
    expect(statuses).toEqual(["pending-selection", "timeout", "pending-selection", "missing-target", "pending-selection", "ready"]);
  });
  test("rejects an older selection response that finishes last", async () => {
    const guard = createDocumentLoadGuard();
    let selectedId = "README.md";
    const mounted: string[] = [];
    const first = deferred();
    const second = deferred();

    const finish = async (token: DocumentLoadToken, response: Promise<string>) => {
      const value = await response;
      if (guard.isCurrent(token, selectedId, "rendered", "single")) mounted.push(value);
    };

    const firstToken = guard.begin("README.md", "rendered", "single");
    const firstFinished = finish(firstToken, first.promise);
    selectedId = "guide.md";
    const secondToken = guard.begin("guide.md", "rendered", "single");
    const secondFinished = finish(secondToken, second.promise);

    second.resolve("guide");
    await secondFinished;
    first.resolve("readme");
    await firstFinished;
    expect(mounted).toEqual(["guide"]);
  });

  test("rejects an older refresh of the same document", async () => {
    const guard = createDocumentLoadGuard();
    const mounted: string[] = [];
    const first = deferred();
    const second = deferred();

    const finish = async (token: DocumentLoadToken, response: Promise<string>) => {
      const value = await response;
      if (guard.isCurrent(token, "README.md", "rendered", "single")) mounted.push(value);
    };

    const firstFinished = finish(guard.begin("README.md", "rendered", "single"), first.promise);
    const secondFinished = finish(guard.begin("README.md", "rendered", "single"), second.promise);
    second.resolve("new");
    await secondFinished;
    first.resolve("old");
    await firstFinished;
    expect(mounted).toEqual(["new"]);
  });

  test("rejects a response after the active view changes", () => {
    const guard = createDocumentLoadGuard();
    const token = guard.begin("README.md", "rendered", "single");
    expect(guard.isCurrent(token, "README.md", "source", "single")).toBe(false);
  });

  test("rejects a response after the active layout changes", () => {
    const guard = createDocumentLoadGuard();
    const token = guard.begin("README.md", "rendered", "split-h");
    expect(guard.isCurrent(token, "README.md", "rendered", "single")).toBe(false);
  });
});
