import { describe, expect, test } from "bun:test";

import type { PullRequestDetail } from "../shared/github-contract";
import { pullRequestFileDecoration, pullRequestFileRows } from "./pull-request-scope-model";

function detail(): PullRequestDetail {
  const file = (path: string, status: "added" | "modified" | "removed", additions: number, deletions: number) =>
    ({ path, status, additions, deletions, oldContents: "", newContents: "" });
  const thread = (id: string, path: string, isResolved: boolean) =>
    ({ id, path, line: 1, side: "RIGHT" as const, isResolved, isOutdated: false, lineText: "", comments: [] });
  return {
    files: [file("src/a.ts", "modified", 3, 1), file("docs/new.md", "added", 5, 0), file("old.txt", "removed", 0, 2)],
    threads: [thread("t1", "src/a.ts", false), thread("t2", "src/a.ts", true)],
    pendingReview: { id: "r", commitOid: "x", comments: [{ id: "c", body: "", bodyHtml: "", createdAt: "", path: "docs/new.md", line: 2, side: "RIGHT" }] },
  } as unknown as PullRequestDetail;
}

describe("pullRequestFileRows", () => {
  test("maps file status to the tree's Git status and counts open threads and pending comments", () => {
    const rows = pullRequestFileRows(detail());
    expect(rows.map(row => [row.path, row.status, row.threads, row.pending])).toEqual([
      ["src/a.ts", "modified", 1, 0],
      ["docs/new.md", "added", 0, 1],
      ["old.txt", "deleted", 0, 0],
    ]);
  });
});

describe("pullRequestFileDecoration", () => {
  test("shows review marks before the line counts", () => {
    const [a, added] = pullRequestFileRows(detail());
    expect(pullRequestFileDecoration(a!).text).toBe("💬1 · +3 −1");
    expect(pullRequestFileDecoration(added!).text).toBe("✎1 · +5 −0");
    expect(pullRequestFileDecoration(a!).title).toBe("3 added, 1 deleted lines, 1 open thread");
  });
});
