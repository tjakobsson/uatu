// The GitHub service seam for the session child. Routes in
// src/server/routes.ts reach GitHub only through this interface
// (src/github/http.ts adapts HTTP to it), so the transport behind it can
// change without touching the routes or the browser.
//
// Two implementations, chosen once per session by
// `githubServiceFromEnvironment`:
// - the real one (src/github/gh-service.ts), GitHub through `gh api`
//   (design D2), with the session's own `gh` and credential;
// - the in-memory fake (src/github/fake.ts), for the demo and tests, only
//   when the process opts in with UATU_GITHUB_FAKE=1.
//
// The kill switch is one setting, UATU_GITHUB = off | read | full (default
// full): `off` answers null, so every /api/github/* route answers 404 and the
// browser shows no pull request surface; `read` serves pull requests and
// refuses every write (the summary says `readOnly`); `full` also sends
// comments and reviews. It applies to the fake too, except that the fake has
// no read-only mode.
//
// A pull request's file contents (the file view, design D5) come through the
// same seam as bytes: `pullRequestBlob` answers a path at the head or base
// commit, `pullRequestTree` every path at the head, and `fetchPullRequestHead`
// is the explicit, narrow fetch that makes a head local (D7). The real
// service reads them from Git (`git cat-file` / `ls-tree` on
// `refs/uatu/pull/<n>/head`, design phase 2); classifying and rendering stay
// in the route layer (src/github/http.ts), so the fake supplies bytes and
// still exercises the real renderers.

import type {
  DiffSide,
  GithubFakeScenario,
  GithubSummary,
  PullRequestDetail,
  PullRequestList,
  PullRequestRevision,
  ReviewEvent,
} from "../shared/github-contract";
import { GitHubApi } from "./api";
import { FakeGithubService } from "./fake";
import { GhTransport } from "./gh";
import { GhGithubService } from "./gh-service";

export { GithubError } from "./error";

export type NewThreadInput = { headOid: string; path: string; line: number; side: DiffSide; body: string };
export type SubmitReviewInput = { event: ReviewEvent; body: string };
// A file's bytes at the pull request's head or base commit (`oid`), or word
// that the head isn't local yet. A path the commit doesn't hold is a 404
// GithubError.
export type PullRequestBlob = { oid: string; bytes: Uint8Array } | { state: "not-fetched" };
export type PullRequestTreeAnswer = { headOid: string; paths: string[]; truncated: boolean } | { state: "not-fetched" };

export interface GithubService {
  // True for the in-memory fake: every answer, the file view's included,
  // says so (`mock: true`).
  readonly mock: boolean;
  summary(repositoryId: string): Promise<GithubSummary>;
  // Manual refresh: bypasses any cached answer once.
  refresh(repositoryId: string): Promise<GithubSummary>;
  pullRequest(repositoryId: string, number: number): Promise<PullRequestDetail>;
  pullRequests(repositoryId: string): Promise<PullRequestList>;
  addComment(repositoryId: string, number: number, body: string): Promise<PullRequestDetail>;
  addReviewThread(repositoryId: string, number: number, input: NewThreadInput): Promise<PullRequestDetail>;
  replyToThread(repositoryId: string, number: number, threadId: string, body: string): Promise<PullRequestDetail>;
  setThreadResolved(repositoryId: string, number: number, threadId: string, resolved: boolean): Promise<PullRequestDetail>;
  editPendingComment(repositoryId: string, number: number, commentId: string, body: string): Promise<PullRequestDetail>;
  deletePendingComment(repositoryId: string, number: number, commentId: string): Promise<PullRequestDetail>;
  submitReview(repositoryId: string, number: number, input: SubmitReviewInput): Promise<PullRequestDetail>;
  discardReview(repositoryId: string, number: number): Promise<PullRequestDetail>;
  // The file view's contents. Reading never touches the network; only the
  // fetch does, and only when the reviewer asks for it.
  fetchPullRequestHead(repositoryId: string, number: number): Promise<{ headOid: string }>;
  pullRequestBlob(repositoryId: string, number: number, input: { path: string; rev: PullRequestRevision }): Promise<PullRequestBlob>;
  pullRequestTree(repositoryId: string, number: number): Promise<PullRequestTreeAnswer>;
  // Dev-only controls; present only on the fake.
  setScenario?(scenario: GithubFakeScenario): void;
  reset?(): void;
  // Stops what is still running (the session is stopping).
  dispose?(): void;
}

export const GITHUB_SETTING_ENV = "UATU_GITHUB";
export const GITHUB_FAKE_ENV = "UATU_GITHUB_FAKE";
export const GITHUB_FAKE_SCENARIO_ENV = "UATU_GITHUB_FAKE_SCENARIO";

export type GithubSetting = "off" | "read" | "full";

// Unset means full. A value uatu doesn't know turns GitHub off rather than
// guessing at what was meant.
export function githubSetting(env: Record<string, string | undefined> = process.env): GithubSetting {
  const value = env[GITHUB_SETTING_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") return "full";
  return value === "read" || value === "full" ? value : "off";
}

export type GithubServiceDeps = {
  // The session's repository id → its root on disk.
  repositoryRoot: (repositoryId: string) => string | null;
};

export function githubServiceFromEnvironment(env: Record<string, string | undefined> = process.env, deps?: GithubServiceDeps): GithubService | null {
  const setting = githubSetting(env);
  if (setting === "off") return null;
  if (env[GITHUB_FAKE_ENV] === "1") return new FakeGithubService({ scenario: env[GITHUB_FAKE_SCENARIO_ENV] });
  if (!deps) return null;
  return new GhGithubService({
    api: new GitHubApi(new GhTransport({ env })),
    mode: setting,
    repositoryRoot: deps.repositoryRoot,
    ghHost: env.GH_HOST,
  });
}
