import { describe, expect, test } from "bun:test";

import type { GithubSummary, PullRequestDetail, PullRequestSummary } from "../shared/github-contract";
import { PullRequestStore, pullRequestPreviewParams, pullRequestRepository, retryAfterSummary, scopedPullRequestNumber } from "./pull-request-store";

function withBranchPullRequest(store: PullRequestStore, number: number | null): void {
  const summary = {
    status: number === null ? "no-pull-request" : "ready",
    mock: true,
    repository: null,
    viewer: "octo-reviewer",
    checkedAt: 0,
    stale: false,
    ...(number === null ? {} : { pullRequest: { number } as PullRequestSummary }),
  } satisfies GithubSummary;
  store.state = { ...store.state, repositoryId: "repo", summary };
}

describe("scopedPullRequestNumber", () => {
  test("a pick other than the branch's own pull request scopes the workspace", () => {
    expect(scopedPullRequestNumber(639, 642)).toBe(639);
    expect(scopedPullRequestNumber(639, null)).toBe(639);
  });

  test("no pick, or the branch's own, is no scope", () => {
    expect(scopedPullRequestNumber(null, 642)).toBeNull();
    expect(scopedPullRequestNumber(642, 642)).toBeNull();
  });
});

describe("PullRequestStore selection", () => {
  test("the current pull request is the pick, else the branch's own", () => {
    const store = new PullRequestStore();
    withBranchPullRequest(store, 642);
    expect(store.currentNumber()).toBe(642);
    store.select(639);
    expect(store.scopedNumber()).toBe(639);
    expect(store.currentNumber()).toBe(639);
    store.select(null);
    expect(store.scopedNumber()).toBeNull();
    expect(store.currentNumber()).toBe(642);
  });

  test("picking the branch's own pull request returns to it", () => {
    const store = new PullRequestStore();
    withBranchPullRequest(store, 642);
    store.select(639);
    store.select(642);
    expect(store.scopedNumber()).toBeNull();
    expect(store.currentNumber()).toBe(642);
  });

  test("a branch without a pull request can still show a picked one", () => {
    const store = new PullRequestStore();
    withBranchPullRequest(store, null);
    expect(store.currentNumber()).toBeNull();
    store.select(627);
    expect(store.currentNumber()).toBe(627);
  });

  test("a pick waits for the summary to say which pull request is the branch's own", () => {
    const store = new PullRequestStore();
    store.select(642);
    expect(store.scopedNumber()).toBeNull();
    withBranchPullRequest(store, 642);
    expect(store.scopedNumber()).toBeNull();
    store.select(639);
    withBranchPullRequest(store, 642);
    expect(store.scopedNumber()).toBe(639);
  });

  test("the branch's own pull request, opened before the summary named it, is no pick after the branch loses it", () => {
    const store = new PullRequestStore();
    store.state = { ...store.state, repositoryId: "repo" };
    const summary = (number: number | null): GithubSummary => ({
      status: number === null ? "no-pull-request" : "ready", mock: true, repository: null, viewer: "octo-reviewer", checkedAt: 0, stale: false,
      ...(number === null ? {} : { pullRequest: { number } as PullRequestSummary }),
    });
    store.select(642);
    store.applySummary(summary(642));
    expect(store.scopedNumber()).toBeNull();
    store.applySummary(summary(null));
    expect(store.scopedNumber()).toBeNull();
    expect(store.currentNumber()).toBeNull();
    // A real pick still counts.
    store.select(627);
    expect(store.scopedNumber()).toBe(627);
  });

  test("a pull request whose head is the checked-out branch is never a pick", () => {
    const store = new PullRequestStore();
    withBranchPullRequest(store, null);
    store.state = { ...store.state, branch: "feat/view-pr" };
    store.select(642);
    expect(store.scopedNumber()).toBe(642);
    store.applyDetail({ summary: { number: 642, headRefName: "feat/view-pr", isCrossRepository: false } } as PullRequestDetail);
    expect(store.scopedNumber()).toBeNull();
    store.applyDetail({ summary: { number: 627, headRefName: "feat/view-pr", isCrossRepository: true } } as PullRequestDetail);
    store.select(627);
    expect(store.scopedNumber()).toBe(627);
  });

  test("no pick is in force while GitHub cannot say which pull request is the branch's", () => {
    const store = new PullRequestStore();
    store.state = { ...store.state, repositoryId: "repo", summary: { status: "no-credential", mock: true, repository: null, viewer: null, checkedAt: 0, stale: false } };
    store.select(642);
    expect(store.scopedNumber()).toBeNull();
    expect(store.currentNumber()).toBeNull();
  });

  test("selection changes notify subscribers once, and repeats do not", () => {
    const store = new PullRequestStore();
    withBranchPullRequest(store, 642);
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.select(639);
    store.select(639);
    store.select(null);
    expect(calls).toBe(2);
  });
});

describe("PullRequestStore pending reviews elsewhere", () => {
  const detail = (number: number, pending: number) => ({
    summary: { number } as PullRequestSummary,
    pendingReview: pending ? { id: "r", commitOid: "c", comments: Array.from({ length: pending }, (_, index) => ({ id: `p${index}` })) } : null,
  }) as unknown as PullRequestDetail;

  test("lists the viewer's pending reviews on other pull requests, from details and the open list", () => {
    const store = new PullRequestStore();
    withBranchPullRequest(store, 642);
    store.applyDetail(detail(639, 1));
    store.applyDetail(detail(627, 0));
    store.applyList({ mock: true, repository: { host: "github.com", owner: "o", name: "r" }, viewer: "me", pullRequests: [
      { number: 618, viewerPendingComments: 2 }, { number: 639, viewerPendingComments: 0 },
    ] } as never);
    // A detail this page read wins over the list's older count.
    expect(store.pendingElsewhere([642])).toEqual([{ number: 618, count: 2 }, { number: 639, count: 1 }]);
    expect(store.pendingElsewhere([639, 642])).toEqual([{ number: 618, count: 2 }]);
    expect(store.pendingCount(639)).toBe(1);
    expect(store.pendingCount(618)).toBe(2);
    expect(store.pendingCount(1)).toBe(0);
  });

  test("keeps the branch's last known pending count once a summary no longer names its pull request", () => {
    const store = new PullRequestStore();
    const summary = (status: GithubSummary["status"], pullRequest?: Partial<PullRequestSummary>) => ({
      status, mock: true, repository: null, viewer: "v", checkedAt: 0, stale: false,
      ...(pullRequest ? { pullRequest: pullRequest as PullRequestSummary } : {}),
    }) satisfies GithubSummary;
    store.applySummary(summary("ready", { number: 642, viewerPendingComments: 2 }));
    expect(store.pendingElsewhere([])).toEqual([{ number: 642, count: 2 }]);
    // No pull request for the branch any more, then no credential: still known.
    store.applySummary(summary("no-pull-request"));
    expect(store.pendingElsewhere([])).toEqual([{ number: 642, count: 2 }]);
    store.applySummary(summary("no-credential"));
    expect(store.pendingElsewhere([])).toEqual([{ number: 642, count: 2 }]);
    // A finished review is known too.
    store.applySummary(summary("ready", { number: 642, viewerPendingComments: 0 }));
    expect(store.pendingElsewhere([])).toEqual([]);
  });
});

describe("PullRequestStore retry", () => {
  test("says Retrying while it runs, then whether GitHub answered", async () => {
    const { githubApi } = await import("./client");
    const original = githubApi.refresh;
    const stale = { status: "unavailable", mock: true, repository: null, viewer: "v", checkedAt: 1, stale: true } satisfies GithubSummary;
    let answer: GithubSummary = stale;
    githubApi.refresh = async () => answer;
    try {
      const store = new PullRequestStore();
      withBranchPullRequest(store, null);
      const seen: string[] = [];
      store.subscribe(() => seen.push(store.state.retry?.status ?? "none"));
      await store.retry();
      expect(seen[0]).toBe("running");
      expect(store.state.retry).toMatchObject({ status: "done", recovered: false });
      answer = { ...stale, status: "ready", stale: false, checkedAt: 2 };
      await store.retry();
      expect(store.state.retry).toMatchObject({ status: "done", recovered: true });
    } finally {
      githubApi.refresh = original;
    }
  });
});

describe("retryAfterSummary", () => {
  const done = { status: "done", at: 5, recovered: false } as const;
  test("a finished Retry's outcome goes once GitHub's status changes", () => {
    expect(retryAfterSummary(done, "rate-limited", "unavailable")).toBeNull();
    expect(retryAfterSummary(done, "rate-limited", "ready")).toBeNull();
    expect(retryAfterSummary(done, "rate-limited", "rate-limited")).toBe(done);
    expect(retryAfterSummary(null, "ready", "rate-limited")).toBeNull();
  });
  test("a running Retry keeps going", () => {
    expect(retryAfterSummary({ status: "running" }, "rate-limited", "ready")).toEqual({ status: "running" });
  });
  test("the store drops it when a refresh brings another status", () => {
    const store = new PullRequestStore();
    const base = { status: "rate-limited", mock: true, repository: null, viewer: "v", checkedAt: 1, stale: true } satisfies GithubSummary;
    store.applySummary(base);
    store.state = { ...store.state, retry: done };
    store.applySummary({ ...base, checkedAt: 2 });
    expect(store.state.retry).toBe(done);
    store.applySummary({ ...base, status: "unavailable", checkedAt: 3 });
    expect(store.state.retry).toBeNull();
  });
});

describe("pull request URLs", () => {
  const repo = "/work/uatu";
  test("?pr=<n> alone names the workspace's pull request repository", () => {
    expect(pullRequestPreviewParams(new URLSearchParams("pr=642"), repo)).toEqual({ repositoryId: repo, number: 642, tab: "conversation" });
    expect(pullRequestPreviewParams(new URLSearchParams("pr=642&tab=files&file=a.md"), repo)).toEqual({ repositoryId: repo, number: 642, tab: "files", file: "a.md" });
    expect(pullRequestPreviewParams(new URLSearchParams("pr=642&tab=files&thread=T1"), repo)).toEqual({ repositoryId: repo, number: 642, tab: "files", thread: "T1" });
    // A thread belongs to Files changed.
    expect(pullRequestPreviewParams(new URLSearchParams("pr=642&thread=T1"), repo)).toEqual({ repositoryId: repo, number: 642, tab: "conversation" });
  });
  test("older URLs that name the repository keep working", () => {
    expect(pullRequestPreviewParams(new URLSearchParams(`repository=${encodeURIComponent("/other")}&pr=7`), repo)?.repositoryId).toBe("/other");
    expect(pullRequestPreviewParams(new URLSearchParams("repository=&pr=7"), repo)?.repositoryId).toBe(repo);
  });
  test("no number, a bad number, or no repository names nothing", () => {
    expect(pullRequestPreviewParams(new URLSearchParams("pr=abc"), repo)).toBeNull();
    expect(pullRequestPreviewParams(new URLSearchParams("pr=0"), repo)).toBeNull();
    expect(pullRequestPreviewParams(new URLSearchParams(""), repo)).toBeNull();
    expect(pullRequestPreviewParams(new URLSearchParams("pr=642"), null)).toBeNull();
  });
  test("the pull request repository is the first Git one", () => {
    const repositories = [{ id: "a", metadata: { status: "non-git" } }, { id: "b", metadata: { status: "git" } }, { id: "c", metadata: { status: "git" } }];
    expect(pullRequestRepository(repositories)?.id).toBe("b");
    expect(pullRequestRepository([])).toBeNull();
  });
});
