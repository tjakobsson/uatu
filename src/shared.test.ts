import { describe, expect, test } from "bun:test";

import { buildTreeNodes, nextSelectedDocumentId, shouldRefreshPreview, type RootGroup } from "./shared";

const roots: RootGroup[] = [
  {
    id: "/tmp/docs",
    label: "docs",
    path: "/tmp/docs",
    docs: [
      { id: "/tmp/docs/README.md", name: "README.md", relativePath: "README.md", mtimeMs: 2, rootId: "/tmp/docs" },
      {
        id: "/tmp/docs/guides/setup.md",
        name: "setup.md",
        relativePath: "guides/setup.md",
        mtimeMs: 5,
        rootId: "/tmp/docs",
      },
    ],
  },
];

describe("buildTreeNodes", () => {
  test("creates nested sidebar nodes", () => {
    const nodes = buildTreeNodes(roots[0]!);
    expect(nodes[0]?.kind).toBe("dir");
    expect(nodes[0]?.name).toBe("guides");
    expect(nodes[1]?.kind).toBe("doc");
    expect(nodes[1]?.name).toBe("README.md");
  });
});

describe("shouldRefreshPreview", () => {
  test("refreshes when the selected document changes on disk", () => {
    expect(shouldRefreshPreview("/tmp/docs/README.md", "/tmp/docs/README.md")).toBe(true);
    expect(shouldRefreshPreview("/tmp/docs/README.md", "/tmp/docs/guides/setup.md")).toBe(false);
  });
});

describe("nextSelectedDocumentId", () => {
  test("follows the latest changed markdown document when follow is enabled", () => {
    expect(nextSelectedDocumentId(roots, "/tmp/docs/README.md", "/tmp/docs/guides/setup.md", true)).toBe(
      "/tmp/docs/guides/setup.md",
    );
  });

  test("keeps the current selection pinned when follow is disabled", () => {
    expect(nextSelectedDocumentId(roots, "/tmp/docs/README.md", "/tmp/docs/guides/setup.md", false)).toBe(
      "/tmp/docs/README.md",
    );
  });
});
