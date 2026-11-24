// Whether GitHub writes (comments, review comments, reviews and
// resolutions) can be sent right now, and the words every surface uses to say why
// not. One rule for the Pull request pane, the PR preview, the Files pane's
// PR scope and every composer, for the branch's pull request and a picked
// one alike: drafting always stays possible, only sending waits.

import type { GithubSummary, PullRequestSummary } from "../shared/github-contract";

type SummaryFacts = Pick<GithubSummary, "status" | "retryAt" | "message" | "readOnly"> | null;

export function minutesUntil(ms: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((ms - now) / 60_000));
}

// Why GitHub as a whole can't take writes now (null when it can, or when the
// session hasn't answered yet).
export function githubWritesPausedReason(summary: SummaryFacts, now = Date.now()): string | null {
  if (summary?.readOnly) return "This session reads GitHub only, so nothing can be sent. Start it with UATU_GITHUB=full to send.";
  switch (summary?.status) {
    case "no-credential":
      return "GitHub isn't connected for this workspace, so nothing can be sent.";
    case "rate-limited":
      return `GitHub's API rate limit is exhausted; sending is paused until it resets${summary.retryAt ? ` in ${minutesUntil(summary.retryAt, now)} min` : ""}.`;
    case "unavailable":
      return "GitHub isn't answering; sending is paused until it does.";
    default:
      return null;
  }
}

// Why this pull request can't take a new comment or review now.
export function sendBlockedReason(summary: SummaryFacts, pr: Pick<PullRequestSummary, "number" | "state"> | null, now = Date.now()): string | null {
  const paused = githubWritesPausedReason(summary, now);
  if (paused) return paused;
  if (pr && pr.state !== "OPEN") return `#${pr.number} is ${pr.state.toLowerCase()}; new comments are closed here.`;
  return null;
}

// The heading and explanation of the stale-data notice (rate-limited or
// unreachable), shared by the pane, the preview banner and the Files scope.
export function staleNotice(summary: SummaryFacts, now = Date.now()): { title: string; why: string } | null {
  if (summary?.status === "rate-limited") {
    // GitHub answered and refused: not an outage.
    return { title: "GitHub rate limit reached", why: `GitHub refused more API requests for now${summary.retryAt ? `; the limit resets in ${minutesUntil(summary.retryAt, now)} min` : ""}.` };
  }
  if (summary?.status === "unavailable") {
    return { title: "Couldn't reach GitHub", why: summary.message ?? "GitHub did not answer." };
  }
  return null;
}

// What a stale notice says about the last Retry: "Retrying…" while it runs,
// then when it ran and that GitHub still refused, so a repeated failure is
// visibly a new answer. Null when there is nothing to say (no retry yet, or
// GitHub answered: the notice itself goes away then).
export function retryNoticeText(
  retry: { status: "running" } | { status: "done"; at: number; recovered: boolean } | null,
  status: GithubSummary["status"] | undefined,
  clock: (ms: number) => string,
): string | null {
  if (!retry) return null;
  if (retry.status === "running") return "Retrying…";
  if (retry.recovered) return null;
  return status === "rate-limited"
    ? `Retried at ${clock(retry.at)}: the rate limit still holds.`
    : `Retried at ${clock(retry.at)}: GitHub still didn't answer.`;
}
