import { describe, expect, test } from "bun:test";

import { createDraftStore, draftAlreadySent, draftKey, sendThenClearDraft } from "./pr-drafts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const PR = { repositoryId: "repo", number: 642 };

describe("pull request drafts", () => {
  test("keeps text per pull request and location", () => {
    const storage = memoryStorage();
    const drafts = createDraftStore(() => storage);
    drafts.set(PR, { kind: "conversation" }, "hello");
    drafts.set(PR, { kind: "inline", path: "a.md", side: "RIGHT", line: 3 }, "nit");
    drafts.set({ ...PR, number: 7 }, { kind: "conversation" }, "other");
    expect(drafts.text(PR, { kind: "conversation" })).toBe("hello");
    expect(drafts.text(PR, { kind: "inline", path: "a.md", side: "RIGHT", line: 3 })).toBe("nit");
    expect(drafts.text(PR, { kind: "inline", path: "a.md", side: "LEFT", line: 3 })).toBe("");
    expect(drafts.text({ ...PR, number: 7 }, { kind: "conversation" })).toBe("other");
  });

  test("drops a draft emptied to whitespace", () => {
    const storage = memoryStorage();
    const drafts = createDraftStore(() => storage);
    drafts.set(PR, { kind: "reply", threadId: "t" }, "x");
    drafts.set(PR, { kind: "reply", threadId: "t" }, "  ");
    expect(storage.length).toBe(0);
    drafts.set(PR, { kind: "review" }, "Looks good");
    expect(drafts.get(PR, { kind: "review" })).toMatchObject({ text: "Looks good" });
    drafts.set(PR, { kind: "review" }, " \n ");
    expect(drafts.get(PR, { kind: "review" })).toBeNull();
  });

  test("lists one pull request's drafts of a kind, newest first", () => {
    const storage = memoryStorage();
    let clock = 0;
    const drafts = createDraftStore(() => storage, () => ++clock);
    drafts.set(PR, { kind: "inline", path: "a.md", side: "RIGHT", line: 3 }, "first");
    drafts.set(PR, { kind: "inline", path: "b.md", side: "LEFT", line: 9 }, "second");
    drafts.set({ ...PR, number: 6420 }, { kind: "inline", path: "c.md", side: "RIGHT", line: 1 }, "elsewhere");
    drafts.set(PR, { kind: "reply", threadId: "t" }, "reply");
    expect(drafts.list(PR, "inline").map(entry => entry.location)).toEqual([
      { kind: "inline", path: "b.md", side: "LEFT", line: 9 },
      { kind: "inline", path: "a.md", side: "RIGHT", line: 3 },
    ]);
    expect(drafts.list(PR, "reply").map(entry => entry.draft.text)).toEqual(["reply"]);
  });

  test("works without storage", () => {
    const drafts = createDraftStore(() => null);
    drafts.set(PR, { kind: "conversation" }, "lost");
    expect(drafts.text(PR, { kind: "conversation" })).toBe("");
    expect(draftKey(PR, { kind: "conversation" })).toBe('pr-draft:["repo",642,"conversation"]');
  });
});

describe("sending a draft", () => {
  const location = { kind: "inline" as const, path: "a.md", side: "RIGHT" as const, line: 3 };

  test("drops the draft once the send succeeds, before the page is updated", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.set(PR, location, "nit");
    const seen: string[] = [];
    await sendThenClearDraft(async () => {
      seen.push(`sent with draft "${store.text(PR, location)}"`);
      return () => seen.push(`applied with draft "${store.text(PR, location)}"`);
    }, () => store.clear(PR, location));
    expect(seen).toEqual(['sent with draft "nit"', 'applied with draft ""']);
    expect(store.list(PR, "inline")).toEqual([]);
  });

  test("keeps the draft when the send fails", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.set(PR, location, "nit");
    await expect(sendThenClearDraft(async () => { throw new Error("409"); }, () => store.clear(PR, location))).rejects.toThrow("409");
    expect(store.text(PR, location)).toBe("nit");
  });

  test("a page update that fails after the send still drops the draft", async () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.set(PR, location, "nit");
    const error = console.error;
    console.error = () => undefined;
    try {
      await sendThenClearDraft(async () => () => { throw new Error("render"); }, () => store.clear(PR, location));
    } finally {
      console.error = error;
    }
    expect(store.text(PR, location)).toBe("");
  });
});

describe("draftAlreadySent", () => {
  const comment = { id: "p1", body: "nit\n", bodyHtml: "", createdAt: "", path: "a.md", line: 3, side: "RIGHT" as const };
  const detail = {
    viewer: "me",
    pendingReview: { id: "r", commitOid: "c", comments: [comment, { ...comment, id: "p2", body: "thanks", threadId: "t1" }] },
    timeline: [{ kind: "comment" as const, comment: { id: "c1", author: "me", body: "posted", bodyHtml: "", createdAt: "" } }],
  };

  test("recognises an inline note, a reply and a conversation comment GitHub already holds", () => {
    expect(draftAlreadySent({ kind: "inline", path: "a.md", side: "RIGHT", line: 3 }, "nit", detail)).toBe(true);
    expect(draftAlreadySent({ kind: "reply", threadId: "t1" }, "thanks", detail)).toBe(true);
    expect(draftAlreadySent({ kind: "conversation" }, "posted", detail)).toBe(true);
  });

  test("keeps different text, another line, and a summary", () => {
    expect(draftAlreadySent({ kind: "inline", path: "a.md", side: "RIGHT", line: 3 }, "nit, longer", detail)).toBe(false);
    expect(draftAlreadySent({ kind: "inline", path: "a.md", side: "RIGHT", line: 4 }, "nit", detail)).toBe(false);
    expect(draftAlreadySent({ kind: "review" }, "nit", detail)).toBe(false);
    expect(draftAlreadySent({ kind: "conversation" }, "", detail)).toBe(false);
  });

  test("an edit is sent when the comment says it, or when the comment is gone", () => {
    expect(draftAlreadySent({ kind: "edit", commentId: "p1" }, "nit", detail)).toBe(true);
    expect(draftAlreadySent({ kind: "edit", commentId: "p1" }, "nit, reworded", detail)).toBe(false);
    expect(draftAlreadySent({ kind: "edit", commentId: "gone" }, "anything", detail)).toBe(true);
  });
});
