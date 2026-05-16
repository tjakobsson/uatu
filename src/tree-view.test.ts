import { describe, expect, it } from "bun:test";

import type { ChangedFileSummary, RepositoryReviewSnapshot, ReviewLoadResult, RootGroup } from "./shared";
import {
  ancestorPaths,
  buildPathInputs,
  computeFilesPaneFilterMembership,
  computeFilteredPaths,
  reconcileFilterExpansion,
  type FilesPaneFilterMembership,
} from "./tree-view";

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

describe("computeFilteredPaths", () => {
  const root = makeRoot({
    id: "r1",
    label: "proj",
    docs: [
      {
        id: "/abs/proj/README.md",
        name: "README.md",
        relativePath: "README.md",
        mtimeMs: 0,
        rootId: "r1",
        kind: "markdown",
      },
      {
        id: "/abs/proj/src/auth/login.ts",
        name: "login.ts",
        relativePath: "src/auth/login.ts",
        mtimeMs: 0,
        rootId: "r1",
        kind: "text",
      },
      {
        id: "/abs/proj/src/auth/oauth.ts",
        name: "oauth.ts",
        relativePath: "src/auth/oauth.ts",
        mtimeMs: 0,
        rootId: "r1",
        kind: "text",
      },
      {
        id: "/abs/proj/docs/glossary.md",
        name: "glossary.md",
        relativePath: "docs/glossary.md",
        mtimeMs: 0,
        rootId: "r1",
        kind: "markdown",
      },
    ],
  });

  it("keeps only docs in the allow-list plus their ancestor directories", () => {
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r1", new Set(["src/auth/login.ts", "docs/glossary.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths, ancestors } = computeFilteredPaths([root], rootPrefix, filter);
    expect(new Set(paths)).toEqual(new Set(["src/auth/login.ts", "docs/glossary.md"]));
    expect(new Set(ancestors)).toEqual(new Set(["src/", "src/auth/", "docs/"]));
  });

  it("returns empty arrays when no doc matches the allow-list", () => {
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r1", new Set(["nonexistent.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths, ancestors } = computeFilteredPaths([root], rootPrefix, filter);
    expect(paths).toEqual([]);
    expect(ancestors).toEqual([]);
  });

  it("filters every root out when the per-root allow-list is missing", () => {
    const filter: FilesPaneFilterMembership = { allowedByRoot: new Map() };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths } = computeFilteredPaths([root], rootPrefix, filter);
    expect(paths).toEqual([]);
  });

  it("respects multi-root prefixes when the chip's allow-list is per repo-root path", () => {
    const left = makeRoot({
      id: "r1",
      label: "docs",
      docs: [
        {
          id: "/a/docs/intro.md",
          name: "intro.md",
          relativePath: "intro.md",
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
          id: "/b/site/index.md",
          name: "index.md",
          relativePath: "index.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r2", new Set(["index.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([left, right]);
    const { paths } = computeFilteredPaths([left, right], rootPrefix, filter);
    expect(paths).toEqual(["site/index.md"]);
  });

  it("ignores any allow-list path not present in the doc list (defensive)", () => {
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r1", new Set(["README.md", "ghost.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths, ancestors } = computeFilteredPaths([root], rootPrefix, filter);
    expect(paths).toEqual(["README.md"]);
    expect(ancestors).toEqual([]);
  });
});

describe("computeFilesPaneFilterMembership", () => {
  function makeChange(path: string, status = "M"): ChangedFileSummary {
    return { path, oldPath: null, status, additions: 0, deletions: 0, hunks: 0 };
  }

  function makeRepo(overrides: {
    id: string;
    watchedRootIds: string[];
    reviewLoad: Partial<ReviewLoadResult>;
  }): RepositoryReviewSnapshot {
    return {
      id: overrides.id,
      rootPath: `/tmp/${overrides.id}`,
      label: overrides.id,
      watchedRootIds: overrides.watchedRootIds,
      metadata: {
        id: overrides.id,
        rootPath: `/tmp/${overrides.id}`,
        label: overrides.id,
        watchedRootIds: overrides.watchedRootIds,
        status: "git",
        branch: "main",
        detached: false,
        commitShort: null,
        dirty: false,
        message: null,
      },
      reviewLoad: {
        status: "available",
        score: 0,
        level: "low",
        thresholds: { medium: 10, high: 25 },
        base: { mode: "configured", ref: "main", mergeBase: null },
        changedFiles: [],
        ignoredFiles: [],
        gitIgnoredFiles: [],
        drivers: [],
        configuredAreas: [],
        settingsWarnings: [],
        message: null,
        ...overrides.reviewLoad,
      },
      commitLog: [],
    };
  }

  it("unions changedFiles and ignoredFiles per repo, keyed by watched-root id", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      reviewLoad: {
        changedFiles: [makeChange("src/app.ts", "M"), makeChange("README.md", "?")],
        ignoredFiles: [makeChange("dist/bundle.js", "M")],
      },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    const set = membership.allowedByRoot.get("root-1");
    expect(set).toBeDefined();
    expect(set).toEqual(new Set(["src/app.ts", "README.md", "dist/bundle.js"]));
  });

  it("excludes gitIgnoredFiles from the change set", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      reviewLoad: {
        changedFiles: [makeChange("src/app.ts", "M")],
        ignoredFiles: [],
        gitIgnoredFiles: [".claude/settings.local.json"],
      },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    const set = membership.allowedByRoot.get("root-1") ?? new Set();
    expect(set.has("src/app.ts")).toBe(true);
    expect(set.has(".claude/settings.local.json")).toBe(false);
  });

  it("skips repositories whose review-load is not available", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      reviewLoad: { status: "non-git", changedFiles: [makeChange("README.md", "M")] },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    expect(membership.allowedByRoot.size).toBe(0);
  });

  it("strips a leading slash on incoming paths so the allow-set matches normalised doc paths", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      reviewLoad: {
        changedFiles: [makeChange("/src/app.ts", "M")],
        ignoredFiles: [makeChange("/dist/bundle.js", "M")],
      },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    const set = membership.allowedByRoot.get("root-1") ?? new Set();
    expect(set.has("src/app.ts")).toBe(true);
    expect(set.has("/src/app.ts")).toBe(false);
    expect(set.has("dist/bundle.js")).toBe(true);
  });

  it("fans out one repository's change set to every watched-root id it owns", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-a", "root-b"],
      reviewLoad: { changedFiles: [makeChange("shared.ts", "M")] },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    expect(membership.allowedByRoot.get("root-a")).toEqual(new Set(["shared.ts"]));
    expect(membership.allowedByRoot.get("root-b")).toEqual(new Set(["shared.ts"]));
  });
});

describe("reconcileFilterExpansion", () => {
  it("snapshots the user's currently-expanded set when transitioning All → Changed", () => {
    const result = reconcileFilterExpansion({
      previousFilterKind: "all",
      nextFilterKind: "changed",
      autoExpanded: ["src/", "src/auth/"],
      currentlyExpanded: ["src/", "tests/", "docs/guides/"],
      storedSnapshot: null,
    });
    expect(result.initialExpandedPaths).toEqual(["src/", "src/auth/"]);
    expect(result.nextSnapshot).toEqual(["src/", "tests/", "docs/guides/"]);
  });

  it("restores the snapshot as initial expansion when transitioning Changed → All", () => {
    const result = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "all",
      autoExpanded: ["src/"],
      currentlyExpanded: null,
      storedSnapshot: ["src/", "tests/", "docs/guides/"],
    });
    // Snapshot directories restored alongside the new auto-expand reveal,
    // deduplicated and in first-seen order.
    expect(result.initialExpandedPaths).toEqual(["src/", "tests/", "docs/guides/"]);
    // Snapshot is consumed on restore so a subsequent All → Changed → All
    // cycle without further user expansion does not double-feed stale dirs.
    expect(result.nextSnapshot).toBeNull();
  });

  it("does not lose user-opened directories across All → Changed → All", () => {
    const after_all_to_changed = reconcileFilterExpansion({
      previousFilterKind: "all",
      nextFilterKind: "changed",
      autoExpanded: ["src/", "src/auth/"],
      currentlyExpanded: ["src/", "src/auth/oauth/", "tests/"],
      storedSnapshot: null,
    });
    const after_changed_to_all = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "all",
      autoExpanded: [],
      currentlyExpanded: null,
      storedSnapshot: after_all_to_changed.nextSnapshot,
    });
    expect(after_changed_to_all.initialExpandedPaths).toEqual([
      "src/",
      "src/auth/oauth/",
      "tests/",
    ]);
  });

  it("passes the auto-expand reveal through unchanged on same-kind transitions", () => {
    const stayAll = reconcileFilterExpansion({
      previousFilterKind: "all",
      nextFilterKind: "all",
      autoExpanded: ["docs/"],
      currentlyExpanded: null,
      storedSnapshot: null,
    });
    expect(stayAll.initialExpandedPaths).toEqual(["docs/"]);
    expect(stayAll.nextSnapshot).toBeNull();

    const stayChanged = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "changed",
      autoExpanded: ["src/auth/"],
      currentlyExpanded: null,
      storedSnapshot: ["src/", "docs/guides/"],
    });
    expect(stayChanged.initialExpandedPaths).toEqual(["src/auth/"]);
    // Snapshot is preserved across same-kind transitions so the next
    // Changed → All edge can still restore it.
    expect(stayChanged.nextSnapshot).toEqual(["src/", "docs/guides/"]);
  });

  it("falls back to bare auto-expand when no snapshot exists on Changed → All", () => {
    const result = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "all",
      autoExpanded: ["src/"],
      currentlyExpanded: null,
      storedSnapshot: null,
    });
    expect(result.initialExpandedPaths).toEqual(["src/"]);
    expect(result.nextSnapshot).toBeNull();
  });
});
