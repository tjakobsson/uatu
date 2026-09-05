import { expect, test } from "bun:test";
import { nextSelectedDocumentId, shouldRefreshPreview, type DocumentKind, type RootGroup } from "./types";

function roots(kind: DocumentKind = "markdown"): RootGroup[] {
  return [{ id: "/docs", path: "/docs", label: "docs", hiddenCount: 0, docs: [
    { id: "/docs/a", rootId: "/docs", relativePath: "a", name: "a", kind, mtimeMs: 1 },
    { id: "/docs/b", rootId: "/docs", relativePath: "b", name: "b", kind: "text", mtimeMs: 2 },
  ] }];
}
for (const kind of ["text", "markdown", "binary"] as const) {
  test(`Follow off retains ${kind} through removal, return, and unrelated edits`, () => {
    const before = roots(kind);
    const missing = structuredClone(before);
    missing[0]!.docs.shift();
    let selected: string | null = "/docs/a";
    for (const snapshot of [before, missing, [], roots("binary"), before]) {
      selected = nextSelectedDocumentId(snapshot, selected, "/docs/b", false);
      expect(selected).toBe("/docs/a");
    }
    expect(nextSelectedDocumentId(before, "/docs/b", "/docs/a", false)).toBe("/docs/b");
    expect(nextSelectedDocumentId(before, selected, "/docs/b", true)).toBe("/docs/b");
  });
}
test("absence and return invalidate the preview even without changedId", () => {
  expect(shouldRefreshPreview("/docs/a", null, roots(), [])).toBe(true);
  expect(shouldRefreshPreview("/docs/a", null, [], roots())).toBe(true);
  expect(shouldRefreshPreview("/docs/a", null, [], [])).toBe(false);
});
