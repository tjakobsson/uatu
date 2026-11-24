// The GitHub service seam for the session child. Routes in
// src/server/routes.ts reach GitHub only through this interface
// (src/github/http.ts adapts HTTP to it), so the transport behind it can
// change without touching the routes or the browser.
//
// Today the only implementation is the in-memory fake (src/github/fake.ts),
// and it is enabled only when the process explicitly opts in with
// UATU_GITHUB_FAKE=1. Without that, `githubServiceFromEnvironment` answers
// null and every /api/github/* route answers 404: a production build exposes
// no fake data by default. The real `gh api` transport (design D2) is a
// later implementation of the same interface.
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
import { FakeGithubService } from "./fake";

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
}

export const GITHUB_FAKE_ENV = "UATU_GITHUB_FAKE";
export const GITHUB_FAKE_SCENARIO_ENV = "UATU_GITHUB_FAKE_SCENARIO";

export function githubServiceFromEnvironment(env: Record<string, string | undefined> = process.env): GithubService | null {
  if (env[GITHUB_FAKE_ENV] !== "1") return null;
  return new FakeGithubService({ scenario: env[GITHUB_FAKE_SCENARIO_ENV] });
}
