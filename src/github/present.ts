// Small HTML builders shared by every pull request surface: state and review
// badges, avatars, check glyphs and ages. Plain strings from GitHub (logins,
// titles, branch names, check names) are always escaped here; Markdown
// bodies arrive already sanitized by the server's renderer.

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { formatCommitAge } from "../shared/relative-time";
import type {
  CheckState,
  GithubSummary,
  PullRequestSummary,
  ReviewDecision,
  ReviewerState,
} from "../shared/github-contract";

// "just now" under a minute (and for a clock a little ahead), then Git's
// long form ("5 minutes ago").
export function age(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  return now - then < 60_000 ? "just now" : formatCommitAge(then, now);
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

const AVATAR_COLORS = ["#8250df", "#1a7f37", "#0969da", "#bf3989", "#1ca8a7", "#9a6700", "#cf222e"];

// A coloured initial instead of a GitHub avatar: avatars are not loaded.
export function avatar(login: string, size: "sm" | "md" = "md"): string {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
  const initial = (login.replace(/^octo-/, "")[0] ?? "?").toUpperCase();
  return `<span class="gh-avatar gh-avatar-${size}" style="background:${color}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

export function stateBadge(pr: Pick<PullRequestSummary, "state" | "isDraft">): string {
  if (pr.state === "MERGED") return `<span class="gh-state gh-state-merged">Merged</span>`;
  if (pr.state === "CLOSED") return `<span class="gh-state gh-state-closed">Closed</span>`;
  if (pr.isDraft) return `<span class="gh-state gh-state-draft">Draft</span>`;
  return `<span class="gh-state gh-state-open">Open</span>`;
}

export function reviewDecisionBadge(decision: ReviewDecision): string {
  if (decision === "APPROVED") return `<span class="gh-pill gh-pill-success">✓ Approved</span>`;
  if (decision === "CHANGES_REQUESTED") return `<span class="gh-pill gh-pill-danger">Changes requested</span>`;
  if (decision === "REVIEW_REQUIRED") return `<span class="gh-pill gh-pill-attention">Review required</span>`;
  return `<span class="gh-pill">No reviews</span>`;
}

export function reviewerBadge(state: ReviewerState, pending: number): string {
  if (pending > 0) return `<span class="gh-pill gh-pill-attention">✎ ${pending} pending</span>`;
  if (state === "APPROVED") return `<span class="gh-pill gh-pill-success">✓ Approved</span>`;
  if (state === "CHANGES_REQUESTED") return `<span class="gh-pill gh-pill-danger">Changes requested</span>`;
  if (state === "COMMENTED") return `<span class="gh-pill">Commented</span>`;
  return `<span class="gh-pill">Requested</span>`;
}

// A check's state as a glyph. It names the state for screen readers, unless
// `decorative`: beside words that already say it ("2 failing"), a named
// glyph would read twice ("running running").
export function checkGlyph(state: CheckState, decorative = false): string {
  const [kind, glyph, label] = state === "SUCCESS" ? ["success", "✓", "passed"] : state === "FAILURE" ? ["failure", "✕", "failed"] : ["pending", "●", "running"];
  return `<span class="gh-check gh-check-${kind}" ${decorative ? `aria-hidden="true"` : `aria-label="${label}"`}>${glyph}</span>`;
}

export function checksSummaryHtml(checks: { passed: number; failed: number; pending: number }): string {
  const parts: string[] = [];
  const total = checks.passed + checks.failed + checks.pending;
  if (checks.failed === 0 && checks.pending === 0) return `${checkGlyph("SUCCESS", true)} ${checks.passed} of ${total} passed`;
  if (checks.passed > 0) parts.push(`${checkGlyph("SUCCESS", true)} ${checks.passed}<span class="sr-only"> passed,</span>`);
  if (checks.failed > 0) parts.push(`${checkGlyph("FAILURE", true)} ${checks.failed} failing`);
  if (checks.pending > 0) parts.push(`${checkGlyph("PENDING", true)} ${checks.pending} running`);
  return parts.join(" ");
}

export function branchesHtml(pr: Pick<PullRequestSummary, "headRefName" | "baseRefName" | "isCrossRepository" | "headOwner">): string {
  const head = pr.isCrossRepository ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName;
  return `<code class="gh-ref">${escapeHtml(head)}</code> → <code class="gh-ref">${escapeHtml(pr.baseRefName)}</code>`;
}

// A link that opens in a new tab says so: the arrow for the eye, words for a
// screen reader.
export function externalLink(href: string, label: string, className = "gh-external", title?: string): string {
  return `<a class="${className}" href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtmlAttribute(title)}"` : ""}>${escapeHtml(label)} <span aria-hidden="true">↗</span>${NEW_TAB_NOTE}</a>`;
}

// The pull request's link to GitHub where merging would be: "Merge on
// GitHub ↗" as the primary (merge-green) action only while GitHub says it
// can merge; otherwise a secondary "View on GitHub ↗", since merging is
// blocked (or not known) and the link is for reading. uatu never merges.
export function mergeLinkLabel(ready: boolean): string {
  return ready ? "Merge on GitHub" : "View on GitHub";
}
export function mergeLinkHtml(href: string, ready: boolean, extraClass = ""): string {
  return externalLink(href, mergeLinkLabel(ready), `gh-button${ready ? " gh-button-merge" : ""}${extraClass ? ` ${extraClass}` : ""}`,
    ready ? "Merging happens on GitHub, which handles merge queues, rulesets and stacked pull requests" : "Merging is blocked; GitHub shows why");
}

export const NEW_TAB_NOTE = `<span class="sr-only"> (opens in a new tab)</span>`;

// The "this is fake" label every surface shows while the fake answers.
export function mockNotice(mock: boolean): string {
  return mock ? `<span class="gh-mock-label" title="Served by the in-memory fake (src/github/fake.ts). Nothing reaches GitHub.">Mocked GitHub data</span>` : "";
}

export function repositoryName(summary: Pick<GithubSummary, "repository">): string {
  return summary.repository ? `${summary.repository.owner}/${summary.repository.name}` : "";
}

// "as of 09:41": the stale-data wording of mockup 6 ("resets in 14 min" is
// in ./availability.ts).
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// "09:41:07": a retry's time, to the second, so a repeated answer reads as
// new.
export function clockTimeWithSeconds(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
