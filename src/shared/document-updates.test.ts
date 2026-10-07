import { describe, expect, test } from "bun:test";
import {
  DocumentStateIndex, normalizeDocumentContext, projectDocumentPatch, projectDocumentSnapshot, unseenSnapshotChange,
  type DocumentPatch, type DocumentSnapshot, type RevisionedDocument,
} from "./document-updates";
import { DEFAULT_WATCH_CONTEXT } from "./watch-context";
import { BUILD_SUMMARY } from "../server/watch-session";
import { WORKSPACE_API_REVISION } from "./version";

function doc(id: string, revision = 0, rootId = "/docs"): RevisionedDocument {
  return { id, rootId, revision, name: id.split("/").at(-1)!, relativePath: id.slice(rootId.length + 1), mtimeMs: 1, kind: "markdown" };
}
function snapshot(): DocumentSnapshot {
  return {
    kind: "snapshot", epoch: "session-a", revision: 0, workspaceApiRevision: WORKSPACE_API_REVISION,
    ...DEFAULT_WATCH_CONTEXT, roots: [{ id: "/docs", path: "/docs", label: "docs", hiddenCount: 0, docs: [doc("/docs/a.md")] }],
    repositories: [], initialFollow: true, defaultDocumentId: "/docs/a.md", changedId: null,
    generatedAt: 1, build: BUILD_SUMMARY, unscopedFingerprint: "0",
    discovery: { status: "ready", discovered: 1 }, repositoryState: { status: "pending", generation: 0 },
  };
}
function patch(revision: number, values: Partial<DocumentPatch> = {}): DocumentPatch {
  return {
    kind: "patch", epoch: "session-a", previousRevision: revision - 1, revision,
    ...DEFAULT_WATCH_CONTEXT, generatedAt: revision + 1, unscopedFingerprint: `${revision}`,
    upserts: [], removals: [], changedId: null, ...values,
  };
}

describe("document update protocol", () => {
  test("JSON round trips preserve revisions and a multi-file update", () => {
    const index = new DocumentStateIndex();
    expect(index.apply(JSON.parse(JSON.stringify(snapshot())))).toBe("applied");
    const update = patch(1, { upserts: [doc("/docs/a.md", 1), doc("/docs/b.md", 1)], changedId: "/docs/b.md" });
    expect(index.apply(JSON.parse(JSON.stringify(update)))).toBe("applied");
    expect(index.find("/docs/a.md")?.revision).toBe(1);
    expect(index.find("/docs/b.md")?.revision).toBe(1);
    expect(index.snapshot()?.changedId).toBe("/docs/b.md");
  });

  test("missing predecessors and different epochs require resync without mutation", () => {
    const index = new DocumentStateIndex();
    expect(index.apply(patch(1))).toBe("resync");
    index.apply(snapshot());
    for (const update of [patch(2), patch(1, { epoch: "other" }), patch(1, { previousRevision: -1 }), patch(1, { revision: Infinity })]) {
      expect(index.apply(update)).toBe("resync");
      expect(index.snapshot()).toEqual(snapshot());
    }
  });

  test("duplicate and older messages cannot restore removed entries", () => {
    const index = new DocumentStateIndex();
    index.apply(snapshot());
    const removal = patch(1, { removals: [{ rootId: "/docs", id: "/docs/a.md" }] });
    index.apply(removal);
    expect(index.apply(removal)).toBe("ignored");
    expect(index.apply(snapshot())).toBe("ignored");
    expect(index.find("/docs/a.md")).toBeUndefined();
    expect(index.snapshot()?.roots[0]?.docs).toEqual([]);
  });

  test("malformed batch tails never partially apply", () => {
    const index = new DocumentStateIndex();
    index.apply(snapshot());
    expect(index.apply(patch(1, { upserts: [doc("/docs/b.md", 1), doc("/outside/c.md", 1, "/missing")] }))).toBe("resync");
    expect(index.snapshot()).toEqual(snapshot());
    expect(index.apply(patch(1, { upserts: [doc("/docs/b.md", 1), doc("/docs/b.md", 1)] }))).toBe("resync");
    expect(index.snapshot()).toEqual(snapshot());
  });

  test("repository and discovery completion preserve newer files and clear edit intent", () => {
    const index = new DocumentStateIndex();
    index.apply(snapshot());
    index.apply(patch(1, { upserts: [doc("/docs/b.md", 1)], changedId: "/docs/b.md" }));
    index.apply(patch(2, { repositoryState: { status: "ready", generation: 1 }, repositories: [] }));
    index.apply(patch(3, { discovery: { status: "ready", discovered: 2 } }));
    expect(index.find("/docs/b.md")?.revision).toBe(1);
    expect(index.snapshot()?.changedId).toBeNull();
    expect(index.snapshot()?.repositoryState).toEqual({ status: "ready", generation: 1 });
    expect(index.snapshot()?.latestChange).toEqual({ id: "/docs/b.md", revision: 1 });
  });

  test("snapshot catch-up remembers an unseen edit without replaying it on repository refresh", () => {
    const index = new DocumentStateIndex();
    index.apply(snapshot());
    const next: DocumentSnapshot = { ...snapshot(), revision: 2, latestChange: { id: "/docs/a.md", revision: 1 } };
    expect(unseenSnapshotChange(index, next)).toBe("/docs/a.md");
    index.apply(next);
    expect(unseenSnapshotChange(index, { ...next, revision: 3 })).toBeNull();
    expect(unseenSnapshotChange(index, { ...next, epoch: "new-child" })).toBe("/docs/a.md");
  });

  test("joining snapshot and continued patches produce identical inventories", () => {
    const original = new DocumentStateIndex();
    original.apply(snapshot());
    original.apply(patch(1, { upserts: [doc("/docs/z.md", 1), doc("/docs/b.md", 1)] }));
    const joiner = new DocumentStateIndex();
    joiner.apply(JSON.parse(JSON.stringify(original.snapshot())));
    const update = patch(2, { upserts: [doc("/docs/b.md", 2)], removals: [{ rootId: "/docs", id: "/docs/a.md" }] });
    original.apply(update);
    joiner.apply(update);
    expect(joiner.snapshot()).toEqual(original.snapshot());
    expect(joiner.snapshot()?.roots[0]?.docs.map(doc => doc.id)).toEqual(["/docs/b.md", "/docs/z.md"]);
  });

  test("root-qualified removal preserves another root's overlapping entry", () => {
    const initial = snapshot();
    initial.roots.push({ id: "/", label: "outer", path: "/", hiddenCount: 0, docs: [doc("/docs/a.md", 0, "/")] });
    const index = new DocumentStateIndex();
    index.apply(initial);
    index.apply(patch(1, { removals: [{ rootId: "/docs", id: "/docs/a.md" }] }));
    expect(index.find("/docs/a.md")?.rootId).toBe("/");
  });

  test("new epoch replaces the old inventory and permits revision restart", () => {
    const index = new DocumentStateIndex();
    index.apply(snapshot());
    index.apply(patch(1, { upserts: [doc("/docs/b.md", 1)] }));
    const next = { ...snapshot(), epoch: "session-b" };
    expect(index.apply(next)).toBe("applied");
    expect(index.find("/docs/b.md")).toBeUndefined();
    expect(index.revision).toBe(0);
  });
});

describe("document context projection", () => {
  const pinned = { scope: { kind: "file" as const, documentId: "/docs/a.md" }, compareTarget: "last-commit" as const };

  test("pins receive only their file but every revision and unscoped corpus version", () => {
    const index = new DocumentStateIndex();
    index.apply(projectDocumentSnapshot(snapshot(), pinned, []));
    const unrelated = projectDocumentPatch(patch(1, { upserts: [doc("/docs/b.md", 1)], changedId: "/docs/b.md", defaultDocumentId: "/docs/b.md" }), pinned);
    expect(unrelated.upserts).toEqual([]);
    expect(unrelated.changedId).toBeNull();
    expect(index.apply(unrelated)).toBe("applied");
    expect(index.snapshot()?.unscopedFingerprint).toBe("1");
    expect(index.snapshot()?.defaultDocumentId).toBe("/docs/a.md");
    const own = projectDocumentPatch(patch(2, { upserts: [doc("/docs/a.md", 2)], changedId: "/docs/a.md" }), pinned);
    expect(index.apply(own)).toBe("applied");
    expect(index.find("/docs/a.md")?.revision).toBe(2);
    expect(index.find("/docs/b.md")).toBeUndefined();
  });

  test("wrong comparison data is omitted unless the caller provides its matching result", () => {
    const update = patch(1, { repositories: [] });
    expect(projectDocumentPatch(update, pinned).repositories).toBeUndefined();
    expect(projectDocumentPatch(update, pinned, undefined, []).repositories).toEqual([]);
    const index = new DocumentStateIndex();
    index.apply(projectDocumentSnapshot(snapshot(), pinned));
    expect(index.apply(update)).toBe("resync");
  });

  test("discovery preserves unknown pins; complete inventory normalizes missing or binary pins", () => {
    expect(normalizeDocumentContext(pinned, { status: "indexing", discovered: 0 }, () => undefined)).toBe(pinned);
    expect(normalizeDocumentContext(pinned, { status: "error", discovered: 0 }, () => undefined)).toBe(pinned);
    expect(normalizeDocumentContext(pinned, { status: "ready", discovered: 0 }, () => undefined).scope).toEqual({ kind: "folder" });
    expect(normalizeDocumentContext(pinned, { status: "ready", discovered: 1 }, () => ({ ...doc("/docs/a.md"), kind: "binary" })).scope).toEqual({ kind: "folder" });
    expect(normalizeDocumentContext(pinned, { status: "ready", discovered: 1 }, () => doc("/docs/a.md"))).toBe(pinned);
  });

  test("a pin can acquire its first discovered root without leaking unrelated roots", () => {
    const initial = snapshot();
    initial.roots = [];
    initial.discovery = { status: "indexing", discovered: 0 };
    const index = new DocumentStateIndex();
    index.apply(projectDocumentSnapshot(initial, pinned));
    const root = { id: "/docs", path: "/docs", label: "docs", hiddenCount: 0 };
    expect(index.apply(projectDocumentPatch(patch(1, { upserts: [doc("/docs/a.md", 1), doc("/docs/b.md", 1)] }), pinned, [root]))).toBe("applied");
    expect(index.snapshot()?.roots[0]?.docs.map(doc => doc.id)).toEqual(["/docs/a.md"]);
  });
});
