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
