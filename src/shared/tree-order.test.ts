import { describe, expect, test } from "bun:test";

import { compareTreePaths, inTreeOrder } from "./tree-order";

describe("tree order", () => {
  test("folders before files at every level, then by name", () => {
    const paths = ["docs/pr-review.md", "docs/hub.md", "src/preview/pr-view.ts", "src/sidebar/pull-request.ts", "src/preview/diff-view.ts",
      "src/server/github.ts", "src/shared/github-contract.ts", "tests/e2e/pull-request.e2e.ts", "README.md"];
    expect(inTreeOrder(paths.map(path => ({ path }))).map(item => item.path)).toEqual([
      "docs/hub.md", "docs/pr-review.md",
      "src/preview/diff-view.ts", "src/preview/pr-view.ts", "src/server/github.ts", "src/shared/github-contract.ts", "src/sidebar/pull-request.ts",
      "tests/e2e/pull-request.e2e.ts",
      "README.md",
    ]);
  });

  test("dot-names first, case-insensitive names, a folder before its sibling file", () => {
    expect(["b.md", ".env", "A.md"].sort(compareTreePaths)).toEqual([".env", "A.md", "b.md"]);
    expect(["src.ts", "src/a.ts"].sort(compareTreePaths)).toEqual(["src/a.ts", "src.ts"]);
    expect(compareTreePaths("a/b.ts", "a/b.ts")).toBe(0);
  });
});
