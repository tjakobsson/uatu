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

import type {
  DiffSide,
  GithubFakeScenario,
  GithubSummary,
  PullRequestDetail,
  PullRequestList,
  ReviewEvent,
} from "../shared/github-contract";
import { FakeGithubService } from "./fake";

export { GithubError } from "./error";

export type NewThreadInput = { headOid: string; path: string; line: number; side: DiffSide; body: string };
export type SubmitReviewInput = { event: ReviewEvent; body: string };

export interface GithubService {
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
