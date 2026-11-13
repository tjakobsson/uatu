import { expect, test } from "bun:test";
import type { DocumentMeta } from "./types";
import { isDocumentVisible, isFollowEligible } from "./file-visibility";

test("only confirmed ignored files without a Uatu exception are hidden", () => {
  const doc: DocumentMeta = { id: "out", rootId: "root", relativePath: "out", name: "out", kind: "text", mtimeMs: 1 };
  for (const gitIgnoreStatus of [undefined, "unknown", "ignored", "not-ignored"] as const) {
    const file = { ...doc, gitIgnoreStatus };
    expect(isDocumentVisible(file)).toBe(true);
    expect(isDocumentVisible(file, false)).toBe(gitIgnoreStatus !== "ignored");
    expect(isDocumentVisible({ ...file, ignoreVisibilityException: true }, false)).toBe(true);
  }
});

test("Follow eligibility excludes confirmed ignored files whatever their visibility", () => {
  for (const gitIgnoreStatus of [undefined, "unknown", "not-ignored"] as const) expect(isFollowEligible({ gitIgnoreStatus })).toBe(true);
  expect(isFollowEligible({ gitIgnoreStatus: "ignored" })).toBe(false);
  // A Uatu visibility exception shows the file but does not make it a target.
  expect(isFollowEligible({ gitIgnoreStatus: "ignored", ignoreVisibilityException: true } as never)).toBe(false);
});
