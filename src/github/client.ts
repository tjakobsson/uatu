// Browser-side wrapper for the session's `/api/github/*` routes. Every URL
// goes through appUrl() so the session stays relocatable under the Hub's
// base path. Writes answer the refreshed pull request detail.

import { appUrl } from "../shared/app-url";
import type {
  DiffSide,
  GithubFakeScenario,
  GithubSummary,
  PullRequestDetail,
  PullRequestList,
  ReviewEvent,
} from "../shared/github-contract";

export class GithubRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

// `path` is already relocated by appUrl() at each call site.
async function request<T>(method: string, path: string, query: Record<string, string | number> | null, body?: unknown): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    });
  } catch {
    throw new GithubRequestError(0, "This workspace did not answer. Check the connection and try again.");
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || payload === null) {
    throw new GithubRequestError(response.status, payload?.error ?? `Request failed (${response.status}).`);
  }
  return payload;
}

type Target = { repository: string; number: number };

export const githubApi = {
  summary: (repository: string) => request<GithubSummary>("GET", appUrl("/api/github/summary"), { repository }),
  refresh: (repository: string) => request<GithubSummary>("POST", appUrl("/api/github/refresh"), null, { repository }),
  pullRequest: (target: Target) => request<PullRequestDetail>("GET", appUrl("/api/github/pull-request"), target),
  pullRequests: (repository: string) => request<PullRequestList>("GET", appUrl("/api/github/pull-requests"), { repository }),
  markdown: (body: string) => request<{ html: string }>("POST", appUrl("/api/github/markdown"), null, { body }),
  comment: (target: Target, body: string) => request<PullRequestDetail>("POST", appUrl("/api/github/comments"), null, { ...target, body }),
  createThread: (target: Target, input: { headOid: string; path: string; line: number; side: DiffSide; body: string }) =>
    request<PullRequestDetail>("POST", appUrl("/api/github/review/threads"), null, { ...target, ...input }),
  reply: (target: Target, threadId: string, body: string) =>
    request<PullRequestDetail>("POST", appUrl(`/api/github/review/threads/${encodeURIComponent(threadId)}/replies`), null, { ...target, body }),
  resolve: (target: Target, threadId: string, resolved: boolean) =>
    request<PullRequestDetail>("POST", appUrl(`/api/github/review/threads/${encodeURIComponent(threadId)}/resolution`), null, { ...target, resolved }),
  editPendingComment: (target: Target, commentId: string, body: string) =>
    request<PullRequestDetail>("PATCH", appUrl(`/api/github/review/comments/${encodeURIComponent(commentId)}`), null, { ...target, body }),
  deletePendingComment: (target: Target, commentId: string) =>
    request<PullRequestDetail>("DELETE", appUrl(`/api/github/review/comments/${encodeURIComponent(commentId)}`), null, target),
  submitReview: (target: Target, event: ReviewEvent, body: string) =>
    request<PullRequestDetail>("POST", appUrl("/api/github/review/submit"), null, { ...target, event, body }),
  discardReview: (target: Target) => request<PullRequestDetail>("DELETE", appUrl("/api/github/review"), null, target),
  setScenario: (input: { scenario?: GithubFakeScenario; reset?: boolean }) =>
    request<{ ok: true }>("POST", appUrl("/api/github/dev/scenario"), null, input),
};
