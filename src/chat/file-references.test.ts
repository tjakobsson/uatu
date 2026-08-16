import { describe, expect, test } from "bun:test";
import type { RootGroup } from "../shared/types";
import { resolveWorkspaceFileReference } from "./file-references";

const roots: RootGroup[] = [
  { id: "one", label: "one", path: "/work/one", hiddenCount: 0, docs: [{ id: "one:app", rootId: "one", name: "app.ts", relativePath: "src/app.ts", mtimeMs: 1, kind: "text" }] },
  { id: "two", label: "two", path: "/work/two", hiddenCount: 0, docs: [{ id: "two:app", rootId: "two", name: "app.ts", relativePath: "src/app.ts", mtimeMs: 1, kind: "text" }] },
];

describe("workspace file references", () => {
  test("resolves watched absolute paths and line suffixes", () => {
    expect(resolveWorkspaceFileReference("/work/one/src/app.ts:42", roots)).toMatchObject({ document: { id: "one:app" }, line: 42 });
  });

  test("resolves Windows drive-qualified absolute paths against Windows roots", () => {
    const windowsRoots: RootGroup[] = [
      { id: "win", label: "win", path: "C:\\work\\one", hiddenCount: 0, docs: [{ id: "win:app", rootId: "win", name: "app.ts", relativePath: "src/app.ts", mtimeMs: 1, kind: "text" }] },
    ];
    expect(resolveWorkspaceFileReference("C:\\work\\one\\src\\app.ts:7", windowsRoots)).toMatchObject({ document: { id: "win:app" }, line: 7 });
    expect(resolveWorkspaceFileReference("C:/work/one/src/app.ts", windowsRoots)).toMatchObject({ document: { id: "win:app" } });
    // A drive path outside every root stays inert instead of falling into the
    // relative lookup.
    expect(resolveWorkspaceFileReference("D:/other/src/app.ts", windowsRoots)).toBeNull();
  });

  test("keeps ambiguous, traversing, outside, and unresolved references inert", () => {
    expect(resolveWorkspaceFileReference("src/app.ts:2", roots)).toBeNull();
    expect(resolveWorkspaceFileReference("../one/src/app.ts", roots)).toBeNull();
    expect(resolveWorkspaceFileReference("/etc/passwd:1", roots)).toBeNull();
    expect(resolveWorkspaceFileReference("missing.ts", roots)).toBeNull();
  });
});
