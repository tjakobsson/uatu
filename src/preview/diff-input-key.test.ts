import { expect, test } from "bun:test";
import type { ChangedFileSummary, RepositorySnapshot } from "../shared/types";
import { diffInputKey } from "./diff-input-key";

const file = (path: string, additions = 1): ChangedFileSummary => ({ path, oldPath: null, status: "M", additions, deletions: 0, hunks: 1 });

function repository(overrides: { head?: string; mergeBase?: string; changedFiles?: ChangedFileSummary[]; rootPath?: string; watchedRootIds?: string[] } = {}): RepositorySnapshot {
  return {
    id: "repo", rootPath: overrides.rootPath ?? "/work/repo", label: "repo", watchedRootIds: overrides.watchedRootIds ?? [overrides.rootPath ?? "/work/repo"], status: "available",
    metadata: { id: "repo", rootPath: "/work/repo", label: "repo", watchedRootIds: [], status: "git", branch: "main", detached: false, commitShort: overrides.head ?? "aaaaaaa", dirty: true, message: null },
    base: { mode: "remote-default", ref: "origin/main", mergeBase: overrides.mergeBase ?? "bbbbbbb", compareTarget: "base", comparedAgainstRef: "origin/main", targetsCollapsed: false },
    changedFiles: overrides.changedFiles ?? [file("docs/a.md"), file("docs/b.md")],
    gitIgnoredFiles: [], configWarnings: [], message: null, commitLog: [],
  };
}

const A = "/work/repo/docs/a.md";
const key = (snapshot: RepositorySnapshot) => diffInputKey(A, [snapshot], "base");

test("a change to another file leaves the key alone", () => {
  expect(key(repository({ changedFiles: [file("docs/a.md"), file("docs/b.md", 7)] }))).toBe(key(repository()));
  expect(key(repository({ changedFiles: [file("docs/a.md")] }))).toBe(key(repository()));
});

test("HEAD moving changes the key", () => {
  expect(key(repository({ head: "ccccccc" }))).not.toBe(key(repository()));
});

test("the compare base moving changes the key", () => {
  expect(key(repository({ mergeBase: "ddddddd" }))).not.toBe(key(repository()));
});

test("the file's own change entry changing changes the key", () => {
  expect(key(repository({ changedFiles: [file("docs/b.md")] }))).not.toBe(key(repository()));
  expect(key(repository({ changedFiles: [{ ...file("docs/a.md"), status: "A" }, file("docs/b.md")] }))).not.toBe(key(repository()));
  expect(key(repository({ changedFiles: [{ ...file("docs/a.md"), status: "R", oldPath: "docs/old.md" }, file("docs/b.md")] }))).not.toBe(key(repository()));
});

test("line counts alone leave the key alone, since content changes re-fetch through the file revision", () => {
  expect(key(repository({ changedFiles: [file("docs/a.md", 9), file("docs/b.md")] }))).toBe(key(repository()));
});

test("the compare target is part of the key", () => {
  expect(diffInputKey(A, [repository()], "last-commit")).not.toBe(key(repository()));
});

test("the innermost repository owns a nested document", () => {
  const outer = repository({ rootPath: "/work" , head: "1111111" });
  const inner = repository();
  expect(diffInputKey(A, [outer, inner], "base")).toBe(diffInputKey(A, [inner], "base"));
  expect(diffInputKey(A, [repository({ rootPath: "/work", head: "2222222" }), inner], "base")).toBe(diffInputKey(A, [inner], "base"));
});

test("a document outside every repository has a stable key", () => {
  expect(diffInputKey("/elsewhere/a.md", [repository()], "base")).toBe(diffInputKey("/elsewhere/a.md", [repository({ head: "ccccccc" })], "base"));
});

test("a watched root spelled differently from Git's top level still owns its documents", () => {
  // macOS: the session watches /tmp/..., Git reports /private/tmp/....
  const spelled = (head = "aaaaaaa", files = [file("docs/a.md"), file("docs/b.md")]) =>
    repository({ rootPath: "/private/tmp/repo", watchedRootIds: ["/tmp/repo/docs"], head, changedFiles: files });
  const id = "/tmp/repo/docs/a.md";
  const keyOf = (snapshot: RepositorySnapshot) => diffInputKey(id, [snapshot], "base");
  expect(keyOf(spelled())).not.toBe(JSON.stringify(["base", null]));
  expect(keyOf(spelled("ccccccc"))).not.toBe(keyOf(spelled()));
  expect(keyOf(spelled("aaaaaaa", [file("docs/b.md")]))).not.toBe(keyOf(spelled()));
  expect(keyOf(spelled("aaaaaaa", [file("docs/a.md"), file("docs/b.md", 5)]))).toBe(keyOf(spelled()));
});
