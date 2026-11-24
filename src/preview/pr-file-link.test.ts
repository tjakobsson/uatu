import { describe, expect, test } from "bun:test";

import { pullRequestFileFor, repositoryRelativePath } from "./pr-file-link";

describe("repositoryRelativePath", () => {
  test("joins the watched root and the document's path, relative to the repository", () => {
    expect(repositoryRelativePath("/w/uatu", "/w/uatu", "docs/a.md")).toBe("docs/a.md");
    expect(repositoryRelativePath("/w/uatu/", "/w/uatu/docs", "a.md")).toBe("docs/a.md");
    expect(repositoryRelativePath("/w/uatu", "/w/other", "a.md")).toBeNull();
    // A sibling whose name starts with the repository's is not inside it.
    expect(repositoryRelativePath("/w/uatu", "/w/uatu-two", "a.md")).toBeNull();
  });
});

describe("pullRequestFileFor", () => {
  const roots = [{ id: "r1", path: "/w/uatu/docs" }];
  const repositories = [{ id: "repo", rootPath: "/w/uatu", watchedRootIds: ["r1"] }];
  const current = { repositoryId: "repo", number: 642, files: [{ path: "docs/pr-review.md" }] };

  test("names the pull request and path for a file it changes", () => {
    expect(pullRequestFileFor({ rootId: "r1", relativePath: "pr-review.md" }, roots, repositories, current))
      .toEqual({ repositoryId: "repo", number: 642, path: "docs/pr-review.md" });
  });

  test("offers nothing for other files, other repositories, or an unread pull request", () => {
    expect(pullRequestFileFor({ rootId: "r1", relativePath: "hub.md" }, roots, repositories, current)).toBeNull();
    expect(pullRequestFileFor({ rootId: "r2", relativePath: "pr-review.md" }, roots, repositories, current)).toBeNull();
    expect(pullRequestFileFor({ rootId: "r1", relativePath: "pr-review.md" }, roots, repositories, { ...current, files: null })).toBeNull();
    expect(pullRequestFileFor({ rootId: "r1", relativePath: "pr-review.md" }, roots, repositories, { ...current, number: null })).toBeNull();
  });
});
