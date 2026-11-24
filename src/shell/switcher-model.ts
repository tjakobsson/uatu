// The pure half of the workspace switcher (shell/switcher.ts): what its
// button and chip say, what each pull request row says and in what order,
// how one search matches both lists, and how a typed number or pull request
// URL is read. The switcher answers two questions in the same words
// everywhere: the checkout you are *working in* (its files, terminal and
// agent), and what Files and Preview are *viewing* (a pull request that is
// not checked out, when there is one). See pr-mockups/switcher/design.md.
//
// No DOM and no imports beyond types and the contract's pure helpers, so
// both the Hub's part (hub-nav.ts) and the switcher can use it.

import { pullRequestLocalBranch, type GithubRepositoryRef, type PullRequestListItem, type PullRequestSummary } from "../shared/github-contract";
import { worktreeFolderName } from "../shared/worktree-branches";

// --- The button and the chip ------------------------------------------------

// A long name is cut in the middle, so both its start (the branch's kind,
// `feat/`, `fix/`) and its end (what it is about) stay readable.
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max || max < 5) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

// The spoken name of the touch button (and the chip): both facts, then the
// badge. `repository` is null outside a repository family, where the name is
// the workspace's display name.
export function switcherSpokenName(input: {
  repository: string | null;
  name: string;
  viewing: number | null;
  badge: string;
  stopped?: boolean;
}): string {
  const where = input.repository && input.repository !== input.name ? `${input.repository}, ${input.name}` : input.name;
  const parts = [`Switch. Working in ${where}${input.stopped ? ", stopped" : ""}.`];
  if (input.viewing !== null) parts.push(`Viewing pull request ${input.viewing}.`);
  if (input.badge) parts.push(`${input.badge}.`);
  return parts.join(" ");
}

// --- Pull request rows --------------------------------------------------------

export type PullRequestFilter = "open" | "review-requested" | "mine" | "drafts";

export const PULL_REQUEST_FILTERS: readonly { value: PullRequestFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "review-requested", label: "Review requested" },
  { value: "mine", label: "Mine" },
  { value: "drafts", label: "Drafts" },
];

// How many pull request rows show before "Show all n".
export const PULL_REQUESTS_FOLDED = 3;

export function filterPullRequests(items: readonly PullRequestListItem[], filter: PullRequestFilter, viewer: string | null): PullRequestListItem[] {
  return items.filter(item => filter === "open"
    || (filter === "review-requested" && item.viewerReviewRequested)
    || (filter === "mine" && item.author === viewer)
    || (filter === "drafts" && item.isDraft));
}

// Pull requests that wait on the viewer — a requested review, or their own
// review still pending — come first; otherwise the list's order (newest
// update first) stands.
export function sortPullRequests(items: readonly PullRequestListItem[], pending: (number: number) => number): PullRequestListItem[] {
  const waits = (item: PullRequestListItem) => item.viewerReviewRequested || pending(item.number) > 0 ? 0 : 1;
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => waits(a.item) - waits(b.item) || a.index - b.index)
    .map(entry => entry.item);
}

// One muted fact on line 2, with the tone that marks the one fact to act on.
export type LinePart = { text: string; tone?: "attention" | "danger" | "success" | "progress"; spoken?: string };

export function pullRequestChecksPart(checks: PullRequestListItem["checks"]): LinePart | null {
  if (checks.failed > 0) return { text: "✗ checks", spoken: "checks failing" };
  if (checks.pending > 0) return { text: "◷ checks running", spoken: "checks running" };
  if (checks.passed > 0) return { text: "✓ checks", spoken: "checks passed" };
  return null;
}

export function pullRequestReviewPart(item: PullRequestListItem, pending: number): LinePart | null {
  if (pending > 0) return { text: `✎ ${pending} pending`, tone: "attention", spoken: `your review pending, ${pending} ${pending === 1 ? "comment" : "comments"}` };
  if (item.viewerReviewRequested) return { text: "review requested", tone: "attention", spoken: "your review requested" };
  switch (item.reviewDecision) {
    case "APPROVED": return { text: "approved", tone: "success" };
    case "CHANGES_REQUESTED": return { text: "changes requested", tone: "danger" };
    case "REVIEW_REQUIRED": return { text: "review required" };
    default: return null;
  }
}

export type PullRequestRowFacts = {
  viewing: boolean;
  // Checked out: here (the branch's own) or in another checkout.
  checkedOut: boolean;
  pending: number;
};

// Line 2 of a pull request row: author · Fork or Draft · checks · review.
export function pullRequestLine2(item: PullRequestListItem, pending: number): LinePart[] {
  const parts: LinePart[] = [{ text: item.author }];
  if (item.isCrossRepository) parts.push({ text: "Fork" });
  else if (item.isDraft) parts.push({ text: "Draft" });
  const checks = pullRequestChecksPart(item.checks);
  if (checks) parts.push(checks);
  const review = pullRequestReviewPart(item, pending);
  if (review) parts.push(review);
  return parts;
}

// A row's name for assistive technology: both lines and the marks in words,
// then what Enter does.
export function pullRequestRowName(item: PullRequestListItem, facts: PullRequestRowFacts, action: string): string {
  const line2 = pullRequestLine2(item, facts.pending).map(part => part.spoken ?? part.text).join(", ");
  const marks = [facts.viewing ? "Viewing" : "", facts.checkedOut ? "Checked out" : ""].filter(Boolean).join(", ");
  return `Pull request ${item.number}, ${item.title}. ${line2}.${marks ? ` ${marks}.` : ""} ${action}`;
}

// The worktree folder and branch a pull request would be checked out as.
export function pullRequestCheckout(item: Pick<PullRequestListItem, "number" | "headRefName" | "isCrossRepository">, repositoryName: string): { branch: string; folder: string; folderName: string } {
  const branch = pullRequestLocalBranch(item);
  // The Hub's own folder rule, so the preview names the folder the Hub
  // creates (unless that one is taken and it disambiguates).
  const folderName = worktreeFolderName(branch);
  return { branch, folderName, folder: `${repositoryName}.worktrees/${folderName}` };
}

// --- One search over both lists -------------------------------------------

export function searchNeedle(query: string): string {
  return query.trim().toLowerCase().replace(/^#/, "");
}

export function matchesSearch(fields: readonly (string | null | undefined)[], query: string): boolean {
  const needle = searchNeedle(query);
  if (!needle) return true;
  return fields.some(field => typeof field === "string" && field.toLowerCase().includes(needle));
}

export function pullRequestMatches(item: PullRequestListItem, query: string): boolean {
  return matchesSearch([String(item.number), item.title, item.author, item.headRefName, item.headOwner], query);
}

// --- A typed number or pull request URL (moved from the retired picker) ----

// The pull request a search names outright: `642`, `#642`, or a pull request
// URL (`https://github.com/<owner>/<repo>/pull/642`, with or without a
// trailing path), with the repository a URL names. Null for anything else.
export type PullRequestQuery = { number: number; repository: GithubRepositoryRef | null };
export function pullRequestQueryTarget(query: string): PullRequestQuery | null {
  const text = query.trim();
  const plain = /^#?(\d{1,9})$/.exec(text);
  const url = plain ? null : /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/i.exec(text);
  const number = Number(plain?.[1] ?? url?.[4] ?? NaN);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, repository: url ? { host: url[1]!, owner: url[2]!, name: url[3]! } : null };
}

const hostKey = (host: string) => host.toLowerCase().replace(/^www\./, "");

// A URL for another repository than this workspace's: what it names
// ("other/repo", with its host when that differs), else null. Hosts, owners
// and names compare case-insensitively, as GitHub does.
export function otherRepositoryName(target: PullRequestQuery, repository: GithubRepositoryRef): string | null {
  const other = target.repository;
  if (!other) return null;
  const sameHost = hostKey(other.host) === hostKey(repository.host);
  if (sameHost && other.owner.toLowerCase() === repository.owner.toLowerCase() && other.name.toLowerCase() === repository.name.toLowerCase()) return null;
  return sameHost ? `${other.owner}/${other.name}` : `${hostKey(other.host)}/${other.owner}/${other.name}`;
}

// What the switcher says about a number the open list doesn't hold, in one
// sentence: looking, not found, or why GitHub couldn't say.
export type Lookup = { status: "loading" } | { status: "found"; pr: PullRequestSummary } | { status: "error"; message: string; missing: boolean };
export function lookupText(number: number, lookup: Lookup, repositoryName: string): string {
  if (lookup.status === "loading") return `#${number} isn't in the open list. Looking it up on GitHub…`;
  if (lookup.status === "error") return lookup.missing ? `There's no pull request #${number} in ${repositoryName}.` : `Couldn't look up #${number} on GitHub: ${lookup.message}`;
  const pr = lookup.pr;
  return pr.state === "OPEN" ? `#${number} isn't in the list yet; ↻ re-reads it.` : `#${number} is ${pr.state.toLowerCase()}, so it isn't in the open list.`;
}

export const LOOKUP_DELAY_MS = 400;

// Whether a typed number (or URL) is looked up on GitHub now: it names this
// repository's pull request, none of the open list matches the query, and
// typing has paused on this query (or Enter was pressed).
export function shouldLookUp(input: { named: boolean; otherRepository: boolean; exactOpen: boolean; visibleMatches: number; settled: boolean }): boolean {
  return input.named && !input.otherRepository && !input.exactOpen && input.visibleMatches === 0 && input.settled;
}

// ArrowDown / ArrowUp over the rows of both lists, wrapping: with nothing
// active (or the active row filtered away) Down starts at the first row and
// Up at the last.
export function nextListSelection<T>(keys: readonly T[], selected: T | null, key: "ArrowDown" | "ArrowUp"): T | null {
  if (keys.length === 0) return null;
  const index = selected === null ? -1 : keys.indexOf(selected);
  if (index === -1) return key === "ArrowDown" ? keys[0]! : keys.at(-1)!;
  return keys[(index + (key === "ArrowDown" ? 1 : keys.length - 1)) % keys.length]!;
}
