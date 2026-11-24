// Pure half of the Files pane's pull request scope: the rows a picked pull
// request's changed files become, and the text each row's decoration shows.

import type { GitStatus } from "@pierre/trees";

import type { PullRequestDetail, PullRequestFile } from "../shared/github-contract";

export type PullRequestFileRow = {
  path: string;
  status: GitStatus;
  additions: number;
  deletions: number;
  // Open review threads and the viewer's pending comments on the file.
  threads: number;
  pending: number;
};

const STATUS: Record<PullRequestFile["status"], GitStatus> = { added: "added", modified: "modified", removed: "deleted" };

export function pullRequestFileRows(detail: PullRequestDetail): PullRequestFileRow[] {
  return detail.files.map(file => ({
    path: file.path,
    status: STATUS[file.status],
    additions: file.additions,
    deletions: file.deletions,
    threads: detail.threads.filter(thread => thread.path === file.path && !thread.isResolved).length,
    pending: detail.pendingReview?.comments.filter(comment => comment.path === file.path).length ?? 0,
  }));
}

// "💬1 ✎2 · +12 −3". U+00A0 separators: the row's flex layout trims ordinary
// spaces at part boundaries (as in the workspace tree's decorations).
export function pullRequestFileDecoration(row: PullRequestFileRow): { text: string; title: string; parts: { text: string; color?: string }[] } {
  const review = `${row.threads ? `💬${row.threads} ` : ""}${row.pending ? `✎${row.pending} ` : ""}${row.threads || row.pending ? "· " : ""}`;
  const parts = [
    { text: review, color: "var(--uatu-tree-review-color, var(--trees-accent))" },
    { text: `+${row.additions} `, color: "var(--success-strong)" },
    { text: `−${row.deletions}`, color: "var(--danger)" },
  ];
  const title = [
    `${row.additions} added, ${row.deletions} deleted ${row.additions + row.deletions === 1 ? "line" : "lines"}`,
    row.threads ? `${row.threads} open ${row.threads === 1 ? "thread" : "threads"}` : "",
    row.pending ? `${row.pending} pending ${row.pending === 1 ? "comment" : "comments"}` : "",
  ].filter(Boolean).join(", ");
  return { text: parts.map(part => part.text).join(""), title, parts: parts.filter(part => part.text) };
}
