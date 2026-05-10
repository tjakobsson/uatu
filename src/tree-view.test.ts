import { describe, expect, it } from "bun:test";

import type { RootGroup } from "./shared";
import { ancestorPaths, buildPathInputs } from "./tree-view";

function makeRoot(overrides: Partial<RootGroup> & { id: string; label: string; docs: RootGroup["docs"] }): RootGroup {
  return {
    path: `/tmp/${overrides.id}`,
    hiddenCount: 0,
    ...overrides,
  };
}

describe("buildPathInputs", () => {
  it("does not prefix paths with the root label when there is a single root", () => {
    const root = makeRoot({
      id: "r1",
      label: "myproject",
      docs: [
        {
          id: "/abs/myproject/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
        {
          id: "/abs/myproject/src/index.ts",
          name: "index.ts",
          relativePath: "src/index.ts",
          mtimeMs: 0,
          rootId: "r1",
          kind: "text",
        },
      ],
    });

    const { paths, mapping, rootPrefix } = buildPathInputs([root]);
    // Single-root: paths are taken verbatim, so top-level files show at the
    // top of the tree (matches VS Code's single-folder workspace UX).
    expect(paths).toEqual(["README.md", "src/index.ts"]);
    expect(mapping.get("README.md")).toBe("/abs/myproject/README.md");
    expect(mapping.get("src/index.ts")).toBe("/abs/myproject/src/index.ts");
    expect(rootPrefix.get("r1")).toBe("");
  });

  it("prefixes every file with the root label when there are multiple roots", () => {
    const left = makeRoot({
      id: "r1",
      label: "docs",
      docs: [
        {
          id: "/a/docs/a.md",
          name: "a.md",
          relativePath: "a.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "site",
      docs: [
        {
          id: "/b/site/b.md",
          name: "b.md",
          relativePath: "b.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });

    const { paths, rootPrefix } = buildPathInputs([left, right]);
    expect(paths).toEqual(["docs/a.md", "site/b.md"]);
    expect(rootPrefix.get("r1")).toBe("docs/");
    expect(rootPrefix.get("r2")).toBe("site/");
  });

  it("disambiguates duplicate labels with a numeric suffix in multi-root mode", () => {
    const left = makeRoot({
      id: "r1",
      label: "docs",
      docs: [
        {
          id: "/a/docs/a.md",
          name: "a.md",
          relativePath: "a.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "docs",
      docs: [
        {
          id: "/b/docs/b.md",
          name: "b.md",
          relativePath: "b.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });

    const { paths, rootPrefix } = buildPathInputs([left, right]);
    expect(paths).toEqual(["docs/a.md", "docs (2)/b.md"]);
    expect(rootPrefix.get("r1")).toBe("docs/");
    expect(rootPrefix.get("r2")).toBe("docs (2)/");
  });

  it("falls back to 'root' when a multi-root label is blank", () => {
    const left = makeRoot({
      id: "r1",
      label: "   ",
      docs: [
        {
          id: "/nameless/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "other",
      docs: [
        {
          id: "/other/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });
    const { paths } = buildPathInputs([left, right]);
    expect(paths).toEqual(["root/README.md", "other/README.md"]);
  });

  it("strips a leading slash from relativePath if present (defensive)", () => {
    const root = makeRoot({
      id: "r1",
      label: "proj",
      docs: [
        {
          id: "/abs/proj/README.md",
          name: "README.md",
          relativePath: "/README.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const { paths } = buildPathInputs([root]);
    expect(paths).toEqual(["README.md"]);
  });

  it("returns empty paths and an empty mapping when there are no roots", () => {
    const { paths, mapping, rootPrefix } = buildPathInputs([]);
    expect(paths).toEqual([]);
    expect(mapping.size).toBe(0);
    expect(rootPrefix.size).toBe(0);
  });
});

describe("ancestorPaths", () => {
  it("returns each ancestor directory from outermost to innermost, trailing slash", () => {
    expect(ancestorPaths("a/b/c/leaf.md")).toEqual(["a/", "a/b/", "a/b/c/"]);
  });

  it("returns an empty array for a top-level file (no ancestors)", () => {
    expect(ancestorPaths("README.md")).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(ancestorPaths("")).toEqual([]);
  });

  it("handles a single nested directory", () => {
    expect(ancestorPaths("src/index.ts")).toEqual(["src/"]);
  });

  it("handles multi-root-prefixed paths consistently", () => {
    expect(ancestorPaths("myproject/src/index.ts")).toEqual(["myproject/", "myproject/src/"]);
  });
});
