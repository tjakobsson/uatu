import { describe, expect, test } from "bun:test";
import { compareRecent, fileKey, matchesFileQuery, RecentModel, relativeWriteAge } from "./recent-model";
import type { DocumentMeta, RootGroup } from "../shared/types";
import type { DocumentPatch } from "../shared/document-updates";

const doc = (path: string, mtimeMs: number, rootId = "root"): DocumentMeta & { revision: number } => ({
  id: path, name: path.split("/").at(-1)!, relativePath: path, rootId, mtimeMs, kind: "text", revision: 1,
});
const root = (docs: DocumentMeta[], id = "root"): RootGroup => ({ id, label: id, path: id, hiddenCount: 0, docs });
const patch = (changes: Partial<DocumentPatch>): DocumentPatch => ({ kind: "patch", epoch: "test", previousRevision: 1,
  revision: 2, generatedAt: 100, scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: "test",
  upserts: [], removals: [], changedId: null, ...changes });

describe("Recent metadata projection", () => {
  test("discovery and opening never substitute for write time; ties use path then root", () => {
    const model = new RecentModel();
    model.reset([root([doc("z.md", 100), doc("a.md", 100), doc("future.md", 10000)]), root([doc("a.md", 100, "other")], "other")]);
    expect(model.entries().map(fileKey)).toEqual(["root\0future.md", "other\0a.md", "root\0a.md", "root\0z.md"]);
    model.applyPatch(patch({ upserts: [doc("ancient.md", 1)] }));
    expect(model.entries().at(-1)?.id).toBe("ancient.md");
    const revision = { ...doc("z.md", 100), revision: 2 };
    model.applyPatch(patch({ upserts: [revision] }));
    expect(model.entries()[3]).toEqual(revision);
    expect(compareRecent(doc("/a.md", 1), doc("a.md", 1, "z"))).toBeLessThan(0);
  });
  test("writes, removal, rename and root scope reconcile only current identities", () => {
    const model = new RecentModel();
    model.reset([root([doc("a.md", 1), doc("b.md", 2)])]);
    model.applyPatch(patch({ upserts: [doc("a.md", 3)] }));
    expect(model.entries().map(d => d.id)).toEqual(["a.md", "b.md"]);
    model.applyPatch(patch({ removals: [{ rootId: "root", id: "a.md" }], upserts: [doc("renamed.md", 3)] }));
    expect(model.entries().map(d => d.id)).toEqual(["renamed.md", "b.md"]);
    model.applyPatch(patch({ roots: [{ id: "new", label: "new", path: "new", hiddenCount: 0 }], upserts: [doc("only.md", 1, "new")] }));
    expect(model.entries().map(fileKey)).toEqual(["new\0only.md"]);
    expect(model.get("root\0b.md")).toBeUndefined();
  });
  test("large inventories remain ordered after a bounded affected-file patch", () => {
    const model = new RecentModel();
    model.reset([root(Array.from({ length: 20000 }, (_, i) => doc(`file-${i}.txt`, i)))]);
    model.applyPatch(patch({ upserts: [doc("file-10.txt", 30000)], removals: [{ rootId: "root", id: "file-11.txt" }] }));
    expect(model.entries()).toHaveLength(19999);
    expect(model.entries()[0]?.id).toBe("file-10.txt");
    expect(model.entries().filter(d => d.id === "file-10.txt")).toHaveLength(1);
  });
  test("path matching follows Pierre normalization, including roots and clear", () => {
    const model = new RecentModel();
    model.reset([root([doc("Renders/Bass.wav", 2)]), root([doc("other.md", 1, "two")], "two")]);
    expect(matchesFileQuery("root/Renders/Bass.wav", "  RENDERS\\BASS ")).toBe(true);
    expect(model.entries("root/renders")).toHaveLength(1);
    expect(model.entries("bass")[0]?.kind).toBe("text");
    expect(model.entries("not found")).toHaveLength(0);
    expect(model.entries(" ")).toHaveLength(2);
  });
  test("visible ages advance, cross the tree's 24-hour threshold, and clamp future writes", () => {
    expect(relativeWriteAge(10000, 1)).toBe("now");
    expect(relativeWriteAge(0, 59000)).toBe("now");
    expect(relativeWriteAge(0, 60000)).toBe("1m");
    expect(relativeWriteAge(0, 3600000)).toBe("1h");
    expect(relativeWriteAge(0, 86400000)).toBe("1d");
  });
});
