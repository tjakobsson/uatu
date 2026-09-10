import { expect, test } from "bun:test";
import type { DocumentMeta, RootGroup } from "../shared/types";
import { compareTreeEntries } from "../shared/file-order";
import { fileSiblings } from "./file-siblings";

function root(id: string, paths: string[]): RootGroup {
  return { id, path: id, label: "same label", hiddenCount: 0, docs: paths.map(relativePath => ({
    id: `${id}/${relativePath}`, rootId: id, relativePath, name: relativePath.split("/").at(-1)!, mtimeMs: 0,
    kind: (relativePath.endsWith(".png") || relativePath.endsWith(".bin") ? "binary" : relativePath.endsWith(".adoc") ? "asciidoc" : relativePath.endsWith(".md") ? "markdown" : "text") as DocumentMeta["kind"],
  })) };
}

test("exact root and directory, all mixed indexed kinds, explicit Files comparator and stable ties", () => {
  const a = root("a", ["images/z.png", "images/b.md", "images/.hidden", "images/A.adoc", "images/a.adoc", "images/archive/first.png", "image/z.png", "root.md", "images/10.bin", "images/2.ts"]);
  const b = root("b", ["images/b.md", "images/c.md"]);
  const result = fileSiblings([a, b], { kind: "folder" }, a.docs[1]!);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.files.map(doc => doc.name)).toEqual([".hidden", "10.bin", "2.ts", "A.adoc", "a.adoc", "b.md", "z.png"]);
  expect(result.index).toBe(5);
  const tree = result.files.toReversed().map(doc => ({ segments: doc.relativePath.split("/"), isDirectory: false }));
  expect(tree.sort(compareTreeEntries).map(entry => entry.segments.at(-1))).toEqual(result.files.map(doc => doc.name));
  expect(fileSiblings([a, b], { kind: "folder" }, { ...a.docs[1]!, rootId: "unknown" })).toEqual({ kind: "missing-target" });
});

test("file pins and CLI single-file corpora never widen", () => {
  const a = root("a", ["a.md", "b.md"]);
  expect(fileSiblings([a], { kind: "file", documentId: a.docs[0]!.id }, a.docs[0]!)).toEqual({ kind: "ready", files: [a.docs[0]!], index: 0 });
  expect(fileSiblings([a], { kind: "file", documentId: a.docs[0]!.id }, a.docs[1]!)).toEqual({ kind: "missing-target" });
  const single = root("file-root", ["a.md"]);
  expect(fileSiblings([single], { kind: "folder" }, single.docs[0]!)).toEqual({ kind: "ready", files: single.docs, index: 0 });
});

test("missing and ambiguous identities are not boundaries or guessed paths", () => {
  const a = root("a", ["a.md", "b.md"]);
  expect(fileSiblings([], { kind: "folder" }, a.docs[0]!)).toEqual({ kind: "missing-target" });
  expect(fileSiblings([a], { kind: "folder" }, { ...a.docs[0]!, relativePath: "renamed.md" })).toEqual({ kind: "missing-target" });
  expect(fileSiblings([a, a], { kind: "folder" }, a.docs[0]!)).toEqual({ kind: "ambiguous" });
  a.docs.push({ ...a.docs[1]!, id: "another-id" });
  expect(fileSiblings([a], { kind: "folder" }, a.docs[0]!)).toEqual({ kind: "ambiguous" });
});
