import { describe, expect, test } from "bun:test";

import {
  buildTreeNodes,
  defaultDocumentId,
  formatRelativeTime,
  nextSelectedDocumentId,
  shouldRefreshPreview,
  type RootGroup,
} from "./shared";

const roots: RootGroup[] = [
  {
    id: "/tmp/docs",
    label: "docs",
    path: "/tmp/docs",
    docs: [
      {
        id: "/tmp/docs/README.md",
        name: "README.md",
        relativePath: "README.md",
        mtimeMs: 2,
        rootId: "/tmp/docs",
        kind: "markdown",
      },
      {
        id: "/tmp/docs/guides/setup.md",
        name: "setup.md",
        relativePath: "guides/setup.md",
        mtimeMs: 5,
        rootId: "/tmp/docs",
        kind: "markdown",
      },
    ],
    hiddenCount: 0,
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

  test("bubbles up the newest descendant mtimeMs onto directory nodes", () => {
    const root: RootGroup = {
      id: "/tmp/repo",
      label: "repo",
      path: "/tmp/repo",
      docs: [
        {
          id: "/tmp/repo/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 1,
          rootId: "/tmp/repo",
          kind: "markdown",
        },
        {
          id: "/tmp/repo/guides/setup.md",
          name: "setup.md",
          relativePath: "guides/setup.md",
          mtimeMs: 100,
          rootId: "/tmp/repo",
          kind: "markdown",
        },
        {
          id: "/tmp/repo/guides/notes/jot.md",
          name: "jot.md",
          relativePath: "guides/notes/jot.md",
          mtimeMs: 500,
          rootId: "/tmp/repo",
          kind: "markdown",
        },
      ],
      hiddenCount: 0,
    };

    const nodes = buildTreeNodes(root);
    const guides = nodes.find(n => n.kind === "dir" && n.name === "guides");
    expect(guides?.mtimeMs).toBe(500);
    const notes = guides?.children?.find(n => n.kind === "dir" && n.name === "notes");
    expect(notes?.mtimeMs).toBe(500);
  });

  test("threads documentKind onto leaf nodes", () => {
    const mixed: RootGroup = {
      id: "/tmp/repo",
      label: "repo",
      path: "/tmp/repo",
      docs: [
        {
          id: "/tmp/repo/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 1,
          rootId: "/tmp/repo",
          kind: "markdown",
        },
        {
          id: "/tmp/repo/script.py",
          name: "script.py",
          relativePath: "script.py",
          mtimeMs: 2,
          rootId: "/tmp/repo",
          kind: "text",
        },
        {
          id: "/tmp/repo/logo.png",
          name: "logo.png",
          relativePath: "logo.png",
          mtimeMs: 3,
          rootId: "/tmp/repo",
          kind: "binary",
        },
      ],
      hiddenCount: 0,
    };

    const nodes = buildTreeNodes(mixed);
    const leaves = nodes.filter(node => node.kind === "doc");
    const byName = new Map(leaves.map(node => [node.name, node.documentKind]));
    expect(byName.get("README.md")).toBe("markdown");
    expect(byName.get("script.py")).toBe("text");
    expect(byName.get("logo.png")).toBe("binary");
  });
});

describe("formatRelativeTime", () => {
  const NOW = 1_700_000_000_000;

  test("renders just-modified files as `now`", () => {
    expect(formatRelativeTime(NOW - 0, NOW)).toBe("now");
    expect(formatRelativeTime(NOW - 4_000, NOW)).toBe("now");
  });

  test("renders seconds, minutes, hours, days, weeks, months", () => {
    expect(formatRelativeTime(NOW - 12_000, NOW)).toBe("12s");
    expect(formatRelativeTime(NOW - 3 * 60_000, NOW)).toBe("3m");
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatRelativeTime(NOW - 5 * 86_400_000, NOW)).toBe("5d");
    expect(formatRelativeTime(NOW - 2 * 604_800_000, NOW)).toBe("2w");
    expect(formatRelativeTime(NOW - 6 * 2_592_000_000, NOW)).toBe("6mo");
  });

  test("clamps future mtimes to `now`", () => {
    expect(formatRelativeTime(NOW + 10_000, NOW)).toBe("now");
  });
});

describe("shouldRefreshPreview", () => {
  test("refreshes when the selected document changes on disk", () => {
    expect(shouldRefreshPreview("/tmp/docs/README.md", "/tmp/docs/README.md")).toBe(true);
    expect(shouldRefreshPreview("/tmp/docs/README.md", "/tmp/docs/guides/setup.md")).toBe(false);
  });
});

describe("defaultDocumentId", () => {
  test("returns the most recently modified non-binary document", () => {
    const mixed: RootGroup[] = [
      {
        id: "/tmp/repo",
        label: "repo",
        path: "/tmp/repo",
        docs: [
          {
            id: "/tmp/repo/README.md",
            name: "README.md",
            relativePath: "README.md",
            mtimeMs: 5,
            rootId: "/tmp/repo",
            kind: "markdown",
          },
          {
            id: "/tmp/repo/logo.png",
            name: "logo.png",
            relativePath: "logo.png",
            mtimeMs: 10,
            rootId: "/tmp/repo",
            kind: "binary",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(defaultDocumentId(mixed)).toBe("/tmp/repo/README.md");
  });

  test("returns null when only binary documents are indexed", () => {
    const onlyBinary: RootGroup[] = [
      {
        id: "/tmp/assets",
        label: "assets",
        path: "/tmp/assets",
        docs: [
          {
            id: "/tmp/assets/logo.png",
            name: "logo.png",
            relativePath: "logo.png",
            mtimeMs: 1,
            rootId: "/tmp/assets",
            kind: "binary",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(defaultDocumentId(onlyBinary)).toBeNull();
  });
});

describe("nextSelectedDocumentId", () => {
  test("follows the latest changed markdown document when follow is enabled", () => {
    expect(nextSelectedDocumentId(roots, "/tmp/docs/README.md", "/tmp/docs/guides/setup.md", true)).toBe(
      "/tmp/docs/guides/setup.md",
    );
  });

  test("follows the latest changed non-markdown text document when follow is enabled", () => {
    const mixed: RootGroup[] = [
      {
        id: "/tmp/repo",
        label: "repo",
        path: "/tmp/repo",
        docs: [
          {
            id: "/tmp/repo/README.md",
            name: "README.md",
            relativePath: "README.md",
            mtimeMs: 1,
            rootId: "/tmp/repo",
            kind: "markdown",
          },
          {
            id: "/tmp/repo/script.py",
            name: "script.py",
            relativePath: "script.py",
            mtimeMs: 2,
            rootId: "/tmp/repo",
            kind: "text",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(nextSelectedDocumentId(mixed, "/tmp/repo/README.md", "/tmp/repo/script.py", true)).toBe(
      "/tmp/repo/script.py",
    );
  });

  test("ignores a binary changedId under follow mode", () => {
    const mixed: RootGroup[] = [
      {
        id: "/tmp/repo",
        label: "repo",
        path: "/tmp/repo",
        docs: [
          {
            id: "/tmp/repo/README.md",
            name: "README.md",
            relativePath: "README.md",
            mtimeMs: 1,
            rootId: "/tmp/repo",
            kind: "markdown",
          },
          {
            id: "/tmp/repo/logo.png",
            name: "logo.png",
            relativePath: "logo.png",
            mtimeMs: 99,
            rootId: "/tmp/repo",
            kind: "binary",
          },
        ],
        hiddenCount: 0,
      },
    ];

    expect(nextSelectedDocumentId(mixed, "/tmp/repo/README.md", "/tmp/repo/logo.png", true)).toBe(
      "/tmp/repo/README.md",
    );
  });

  test("keeps the current selection pinned when follow is disabled", () => {
    expect(nextSelectedDocumentId(roots, "/tmp/docs/README.md", "/tmp/docs/guides/setup.md", false)).toBe(
      "/tmp/docs/README.md",
    );
  });
});
