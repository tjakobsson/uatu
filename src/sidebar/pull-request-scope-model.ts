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

// Why Change Overview's comparison isn't the pull request's diff, or null
// when it is: a picked pull request (Change Overview still describes the
// checked-out branch), uncommitted changes, a local HEAD other than the pull
// request's head, or Since last commit. Shown as the pane's "Local branch"
// label, with this as its tooltip.
export function changeOverviewDifference(input: {
  branch: string | null;
  picked: number | null;
  pullRequest: { number: number; headRefOid: string } | null;
  dirty: boolean;
  commitShort: string | null;
  compareTarget: "base" | "last-commit";
}): string | null {
  const branch = input.branch ? ` ${input.branch}` : "";
  if (input.picked !== null) return `Change Overview describes the checked-out branch${branch}, not the picked pull request #${input.picked}.`;
  const pr = input.pullRequest;
  if (!pr) return null;
  const reasons: string[] = [];
  if (input.compareTarget === "last-commit") reasons.push("it compares against the last commit, not the pull request's base");
  if (input.commitShort && !pr.headRefOid.startsWith(input.commitShort)) reasons.push(`the checked-out commit ${input.commitShort} isn't the pull request's head ${pr.headRefOid.slice(0, 7)}`);
  if (input.dirty) reasons.push("it includes uncommitted changes");
  if (reasons.length === 0) return null;
  return `Change Overview describes the local branch${branch}, which differs from #${pr.number}'s diff: ${reasons.join("; ")}.`;
}
