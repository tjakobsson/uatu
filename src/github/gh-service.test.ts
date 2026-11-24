// The real GithubService over the in-memory FakeGitHub transport
// (tests/fixtures/github-fake.ts) and real temporary Git repositories:
// detection, the event-driven refresh policy on a fake clock, statuses,
// detail sections, and every write with its server-side re-checks.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeGitHub } from "../../tests/fixtures/github-fake";
import { safeGit } from "../document/git-base-ref";
import { GitHubApi } from "./api";
import { FakeGithubService } from "./fake";
import { GhGithubService, SUMMARY_MIN_INTERVAL_MS, type GithubWriteMode } from "./gh-service";
import { githubServiceFromEnvironment, githubSetting } from "./service";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function repository(options: { remotes?: Record<string, string>; branch?: string; upstream?: { remote: string; merge: string } } = {}): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "uatu-gh-service-"));
  roots.push(root);
  const git = (...args: string[]) => safeGit(root, args);
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "t@example.test");
  await git("config", "user.name", "T");
  await git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init");
  for (const [name, url] of Object.entries(options.remotes ?? { origin: "git@github.com:acme/widgets.git" })) await git("remote", "add", name, url);
  if (options.branch) await git("checkout", "-b", options.branch);
  if (options.upstream && options.branch) {
    await git("config", `branch.${options.branch}.remote`, options.upstream.remote);
    await git("config", `branch.${options.branch}.merge`, options.upstream.merge);
  }
  return root;
}

function harness(root: string, options: { mode?: GithubWriteMode; ghHost?: string } = {}) {
  let now = Date.parse("2026-11-24T12:00:00Z");
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const fake = new FakeGitHub({ now: clock.now });
  const logs: string[] = [];
  const service = new GhGithubService({
    api: new GitHubApi(fake, clock.now),
    mode: options.mode ?? "full",
    repositoryRoot: id => (id === "repo" ? root : null),
    ghHost: options.ghHost,
    now: clock.now,
    log: line => logs.push(line),
  });
  return { fake, service, clock, logs };
}

describe("detection (design D4)", () => {
  test("a branch with an open pull request, preferring it over a closed one with the same head", async () => {
    const { fake, service } = harness(await repository({ branch: "feature/login" }));
    const summary = await service.summary("repo");
    expect(summary).toMatchObject({ status: "ready", mock: false, repository: { host: "github.com", owner: "acme", name: "widgets" }, viewer: "octo-reviewer", stale: false });
    expect(summary.pullRequest).toMatchObject({ number: 42, state: "OPEN", headRefName: "feature/login" });
    expect(fake.operations()).toEqual(["UatuDetectPullRequest", "UatuPullRequestSummary"]);
  });

  test("an upstream of refs/pull/57/head names #57 without a branch search, merged included", async () => {
    const { fake, service } = harness(await repository({ branch: "pr/57", upstream: { remote: "origin", merge: "refs/pull/57/head" } }));
    const summary = await service.summary("repo");
    expect(summary.pullRequest).toMatchObject({ number: 57, state: "MERGED", isCrossRepository: true, headOwner: "octo-contributor" });
    expect(fake.operations()).toEqual(["UatuPullRequestSummary"]);
  });

  test("a fork layout: upstream is the base, the fork's owner the head owner", async () => {
    const root = await repository({ remotes: { origin: "git@github.com:me/widgets.git", upstream: "https://github.com/acme/widgets.git" }, branch: "feature/login", upstream: { remote: "origin", merge: "refs/heads/feature/login" } });
    const { fake, service } = harness(root);
    const summary = await service.summary("repo");
    expect(summary.repository).toEqual({ host: "github.com", owner: "acme", name: "widgets" });
    // #42's head is acme's, not me's.
    expect(summary.status).toBe("no-pull-request");
    expect(fake.calls[0]).toMatchObject({ operation: "UatuDetectPullRequest", variables: { owner: "acme", name: "widgets", head: "feature/login" } });
  });

  test("no pull request for the branch, and a detached HEAD, with no request for the latter", async () => {
    const root = await repository({ branch: "nothing-here" });
    const first = harness(root);
    expect((await first.service.summary("repo")).status).toBe("no-pull-request");
    await safeGit(root, ["checkout", "--detach"]);
    const second = harness(root);
    const detached = await second.service.summary("repo");
    expect(detached).toMatchObject({ status: "no-pull-request", message: "No branch is checked out (detached HEAD)." });
    expect(second.fake.calls).toEqual([]);
  });

  test("switching branches re-detects; the same branch doesn't", async () => {
    const root = await repository({ branch: "feature/login" });
    const { fake, service, clock } = harness(root);
    await service.summary("repo");
    clock.advance(SUMMARY_MIN_INTERVAL_MS + 1);
    await service.summary("repo");
    expect(fake.operations()).toEqual(["UatuDetectPullRequest", "UatuPullRequestSummary", "UatuPullRequestSummary"]);
    await safeGit(root, ["checkout", "main"]);
    expect((await service.summary("repo")).status).toBe("no-pull-request");
    expect(fake.operations().at(-1)).toBe("UatuDetectPullRequest");
  });

  test("a remote on an unknown host is not-github with no request; an Enterprise host counts once gh is signed in", async () => {
    const gitlab = harness(await repository({ remotes: { origin: "git@gitlab.com:acme/widgets.git" } }));
    expect(await gitlab.service.summary("repo")).toMatchObject({ status: "not-github", repository: null });
    expect(gitlab.fake.calls).toEqual([]);
    const root = await repository({ remotes: { origin: "https://ghe.example.com/acme/widgets.git" }, branch: "feature/login" });
    const enterprise = harness(root);
    expect((await enterprise.service.summary("repo")).status).toBe("not-github");
    enterprise.fake.authenticateHost("ghe.example.com");
    const signedIn = harness(root);
    signedIn.fake.authenticateHost("ghe.example.com");
    expect((await signedIn.service.summary("repo")).repository).toEqual({ host: "ghe.example.com", owner: "acme", name: "widgets" });
    // The Hub's projected host counts without asking gh.
    expect((await harness(root, { ghHost: "ghe.example.com" }).service.summary("repo")).status).toBe("ready");
  });

  test("an unknown repository id is a 404", async () => {
    const { service } = harness(await repository());
    await expect(service.summary("other")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("refresh policy (design D6)", () => {
  test("no request from time passing alone, and repeated asks share one answer", async () => {
    const { fake, service, clock } = harness(await repository({ branch: "feature/login" }));
    const [a, b] = await Promise.all([service.summary("repo"), service.summary("repo")]);
    expect(a).toBe(b);
    const count = fake.calls.length;
    clock.advance(24 * 3_600_000);
    await Bun.sleep(5);
    expect(fake.calls.length).toBe(count);
    // Within the interval a focus burst is answered from memory.
    clock.advance(0);
    await service.summary("repo");
    expect(fake.calls.length).toBe(count + 1);
    await service.summary("repo");
    expect(fake.calls.length).toBe(count + 1);
  });

  test("a rate limit stops every request until the reset, except a manual refresh, whose reads follow once", async () => {
    const { fake, service, clock } = harness(await repository({ branch: "feature/login" }));
    await service.summary("repo");
    await service.pullRequest("repo", 42);
    const resetAt = clock.now() + 14 * 60_000;
    fake.setRateLimit({ kind: "primary", resetAt });
    clock.advance(SUMMARY_MIN_INTERVAL_MS + 1);
    const limited = await service.summary("repo");
    expect(limited).toMatchObject({ status: "rate-limited", stale: true, retryAt: Math.ceil(resetAt / 1000) * 1000, pullRequest: { number: 42 } });
    const count = fake.calls.length;
    clock.advance(SUMMARY_MIN_INTERVAL_MS + 1);
    expect((await service.summary("repo")).status).toBe("rate-limited");
    // The last detail stays readable; an unread one is refused with 429.
    expect((await service.pullRequest("repo", 42)).summary.number).toBe(42);
    await expect(service.pullRequest("repo", 41)).rejects.toMatchObject({ httpStatus: 429 });
    await expect(service.addComment("repo", 42, "hi")).rejects.toMatchObject({ httpStatus: 429 });
    expect(fake.calls.length).toBe(count);
    // Retry asks GitHub, and the view's reads right after it go through.
    fake.setRateLimit(null);
    expect((await service.refresh("repo")).status).toBe("ready");
    await service.pullRequest("repo", 41);
    expect(fake.calls.length).toBeGreaterThan(count);
  });

  test("a secondary limit waits for retry-after", async () => {
    const { fake, service, clock } = harness(await repository({ branch: "feature/login" }));
    fake.setRateLimit({ kind: "secondary", resetAt: clock.now() + 90_000 });
    expect(await service.summary("repo")).toMatchObject({ status: "rate-limited", retryAt: clock.now() + 90_000 });
  });

  test("unavailable backs off and keeps the last data as stale", async () => {
    const { fake, service, clock } = harness(await repository({ branch: "feature/login" }));
    await service.summary("repo");
    fake.setFailure("unavailable");
    clock.advance(SUMMARY_MIN_INTERVAL_MS + 1);
    expect(await service.summary("repo")).toMatchObject({ status: "unavailable", stale: true, pullRequest: { number: 42 } });
    const count = fake.calls.length;
    clock.advance(10_000);
    await service.summary("repo");
    expect(fake.calls.length).toBe(count);
    clock.advance(10_000);
    await service.summary("repo");
    expect(fake.calls.length).toBe(count + 1);
    // The second failure waits twice as long.
    clock.advance(20_000);
    await service.summary("repo");
    expect(fake.calls.length).toBe(count + 1);
    fake.setFailure(null);
    expect((await service.refresh("repo")).status).toBe("ready");
  });

  test("each failure class has its status and no credential material", async () => {
    const cases = [
      ["no-credential", "no-credential"],
      ["not-found", "no-access"],
      ["sso", "no-access"],
      ["timeout", "unavailable"],
    ] as const;
    for (const [failure, status] of cases) {
      const { fake, service } = harness(await repository({ branch: "feature/login" }));
      fake.setFailure(failure);
      const summary = await service.summary("repo");
      expect(summary.status).toBe(status);
      expect(summary.pullRequest).toBeUndefined();
      expect(JSON.stringify(summary)).not.toMatch(/GH_TOKEN|ghp_|\.config\/gh|stderr/);
    }
  });
});

describe("detail", () => {
  test("joins threads to reviews, carries patches and says what it left out", async () => {
    const { service } = harness(await repository({ branch: "feature/login" }));
    const detail = await service.pullRequest("repo", 42);
    expect(detail.mock).toBe(false);
    expect(detail.timeline.find(item => item.kind === "review" && item.id === "PRR_1")).toMatchObject({ threadIds: ["PRRT_line", "PRRT_file", "PRRT_left"] });
    expect(detail.files.map(file => file.path)).toEqual(["src/login.ts", "docs/login.md", "src/session.ts", "src/auth/form.ts", "images/flow.png"]);
    expect(detail.files[0]!.patch).toContain("+++ b/src/login.ts");
    expect(detail.files[0]!.oldContents).toBeUndefined();
    expect(detail.omitted).toEqual({ timeline: 2, threads: false, files: false, unavailable: [] });
    expect(detail.mergeReadiness.blockers[0]).toBe("main requires an approving review.");
    expect(detail.bodyHtml).not.toContain("<script");
  });

  test("checks a token can't read cost the checks, not the pull request", async () => {
    const { fake, service } = harness(await repository());
    fake.setChecksForbidden(true);
    const detail = await service.pullRequest("repo", 42);
    expect(detail.omitted?.unavailable).toEqual(["checks"]);
    expect(detail.summary.checks.runs).toEqual([]);
    expect(detail.summary.number).toBe(42);
  });

  test("files are read once per head commit", async () => {
    const { fake, service } = harness(await repository());
    await service.pullRequest("repo", 42);
    await service.pullRequest("repo", 42);
    expect(fake.operations().filter(name => name === "UatuPullRequestFiles")).toHaveLength(1);
    fake.pushHead(42, "9".repeat(40));
    await service.pullRequest("repo", 42);
    expect(fake.operations().filter(name => name === "UatuPullRequestFiles")).toHaveLength(2);
  });

  test("an unknown pull request is a 404 naming it", async () => {
    const { service } = harness(await repository());
    await expect(service.pullRequest("repo", 9)).rejects.toMatchObject({ httpStatus: 404, message: "There's no pull request #9 in acme/widgets." });
  });

  test("the open list is cached for 30 s and counts what GitHub holds", async () => {
    const { fake, service, clock } = harness(await repository());
    const list = await service.pullRequests("repo");
    expect(list).toMatchObject({ mock: false, remote: "origin", viewer: "octo-reviewer", totalCount: 1, pullRequests: [{ number: 42, viewerReviewRequested: true }] });
    await service.pullRequests("repo");
    expect(fake.operations()).toEqual(["UatuOpenPullRequests"]);
    clock.advance(31_000);
    await service.pullRequests("repo");
    expect(fake.operations()).toEqual(["UatuOpenPullRequests", "UatuOpenPullRequests"]);
  });

  test("the open list names the base repository's local remote, which a check-out fetches from", async () => {
    // A fork layout: `origin` is the fork, `upstream` the base repository.
    const { fake, service } = harness(await repository({ remotes: { origin: "git@github.com:me/widgets.git", upstream: "https://github.com/acme/widgets.git" } }));
    const list = await service.pullRequests("repo");
    expect(list).toMatchObject({ remote: "upstream", repository: { owner: "acme", name: "widgets" } });
    expect(fake.calls[0]).toMatchObject({ operation: "UatuOpenPullRequests", variables: { owner: "acme", name: "widgets" } });
  });

  // Fetching and reading files from Git: pull-request-git.integration.test.ts,
  // against a local bare remote (this repository's origin is github.com).
  test("a head that isn't local reads as not fetched, without any Git network call", async () => {
    const { service, fake } = harness(await repository());
    expect(await service.pullRequestTree("repo", 42)).toEqual({ state: "not-fetched" });
    expect(await service.pullRequestBlob("repo", 42, { path: "src/login.ts", rev: "head" })).toEqual({ state: "not-fetched" });
    expect(await service.pullRequestCommits("repo", 42)).toEqual({ headOid: "4242424242424242424242424242424242424242", baseOid: "1111111111111111111111111111111111111111" });
    // One detail read, remembered for the next.
    expect(fake.operations().filter(operation => operation === "UatuPullRequestConversation")).toHaveLength(1);
  });
});

describe("writes (design D9)", () => {
  const head = "4242424242424242424242424242424242424242";

  test("a conversation comment posts and answers fresh detail", async () => {
    const { fake, service } = harness(await repository());
    const detail = await service.addComment("repo", 42, "@/etc/passwd is just text");
    expect(detail.timeline.at(-1)).toMatchObject({ kind: "comment", comment: { author: "octo-reviewer", body: "@/etc/passwd is just text" } });
    expect(fake.operations().slice(0, 2)).toEqual(["UatuPullRequestWriteCheck", "UatuAddComment"]);
  });

  test("the first inline comment starts the pending review at the head; the next reuses it", async () => {
    const { fake, service } = harness(await repository());
    const first = await service.addReviewThread("repo", 42, { headOid: head, path: "src/login.ts", line: 13, side: "RIGHT", body: "First" });
    expect(fake.record(42).pending).toMatchObject({ commitOid: head });
    expect(first.pendingReview!.comments).toEqual([expect.objectContaining({ body: "First", path: "src/login.ts", line: 13, side: "RIGHT" })]);
    const before = fake.operations().filter(name => name === "UatuAddReview").length;
    const second = await service.replyToThread("repo", 42, "PRRT_line", "Reply");
    expect(fake.operations().filter(name => name === "UatuAddReview").length).toBe(before);
    expect(second.pendingReview!.comments.at(-1)).toMatchObject({ body: "Reply", threadId: "PRRT_line" });
    expect(second.summary.viewerPendingComments).toBe(2);
  });

  test("a pending review started on github.com is reused", async () => {
    const { fake, service } = harness(await repository());
    fake.record(42).pending = { id: "PRR_web", commitOid: head, comments: [] };
    await service.addReviewThread("repo", 42, { headOid: head, path: "src/login.ts", line: 13, side: "RIGHT", body: "x" });
    expect(fake.operations()).not.toContain("UatuAddReview");
    expect(fake.record(42).pending!.id).toBe("PRR_web");
  });

  test("refusals: a moved head, a path outside the pull request, an older-commit pending review", async () => {
    const { fake, service } = harness(await repository());
    await expect(service.addReviewThread("repo", 42, { headOid: "stale", path: "src/login.ts", line: 1, side: "RIGHT", body: "x" })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(service.addReviewThread("repo", 42, { headOid: head, path: "nope.ts", line: 1, side: "RIGHT", body: "x" })).rejects.toMatchObject({ httpStatus: 422 });
    fake.record(42).pending = { id: "PRR_old", commitOid: "0".repeat(40), comments: [] };
    await expect(service.addReviewThread("repo", 42, { headOid: head, path: "src/login.ts", line: 1, side: "RIGHT", body: "x" })).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("older commit") });
    // A reply is still allowed.
    await expect(service.replyToThread("repo", 42, "PRRT_line", "ok")).resolves.toBeTruthy();
    expect(fake.operations()).not.toContain("UatuAddReviewThread");
  });

  test("submit publishes the pending comments; comment-only needs a body or comments", async () => {
    const { fake, service } = harness(await repository());
    await expect(service.submitReview("repo", 42, { event: "COMMENT", body: "" })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(service.submitReview("repo", 42, { event: "REQUEST_CHANGES", body: " " })).rejects.toMatchObject({ httpStatus: 422 });
    await service.addReviewThread("repo", 42, { headOid: head, path: "src/login.ts", line: 13, side: "RIGHT", body: "Inline" });
    const detail = await service.submitReview("repo", 42, { event: "COMMENT", body: "" });
    expect(detail.pendingReview).toBeNull();
    expect(detail.threads.some(thread => thread.comments.some(comment => comment.body === "Inline"))).toBe(true);
    expect(fake.operations()).toContain("UatuSubmitReview");
    // No pending review: approve creates and submits in one step.
    const approved = await service.submitReview("repo", 42, { event: "APPROVE", body: "" });
    expect(approved.summary.reviewDecision).toBe("APPROVED");
  });

  test("own pull request: approve and request changes are refused before GitHub is asked", async () => {
    const { fake, service } = harness(await repository());
    fake.record(42).author = { login: "octo-reviewer" };
    await expect(service.submitReview("repo", 42, { event: "APPROVE", body: "" })).rejects.toMatchObject({ httpStatus: 422 });
    expect(fake.operations()).not.toContain("UatuAddReview");
  });

  test("edit, delete and discard pending comments", async () => {
    const { service } = harness(await repository());
    const added = await service.addReviewThread("repo", 42, { headOid: head, path: "src/login.ts", line: 13, side: "RIGHT", body: "One" });
    const id = added.pendingReview!.comments[0]!.id;
    expect((await service.editPendingComment("repo", 42, id, "Edited")).pendingReview!.comments[0]!.body).toBe("Edited");
    await expect(service.editPendingComment("repo", 42, "missing", "x")).rejects.toMatchObject({ httpStatus: 404 });
    expect((await service.deletePendingComment("repo", 42, id)).pendingReview!.comments).toEqual([]);
    expect((await service.discardReview("repo", 42)).pendingReview).toBeNull();
  });

  test("resolve and unresolve a thread", async () => {
    const { service } = harness(await repository());
    expect((await service.setThreadResolved("repo", 42, "PRRT_line", true)).threads.find(thread => thread.id === "PRRT_line")!.isResolved).toBe(true);
    expect((await service.setThreadResolved("repo", 42, "PRRT_line", false)).threads.find(thread => thread.id === "PRRT_line")!.isResolved).toBe(false);
  });

  test("a closed pull request takes no new comment; its pending review can still be discarded", async () => {
    const { service } = harness(await repository());
    await expect(service.addComment("repo", 41, "x")).rejects.toMatchObject({ httpStatus: 422 });
    await expect(service.discardReview("repo", 41)).resolves.toBeTruthy();
  });

  test("one write at a time per pull request", async () => {
    const { service } = harness(await repository());
    const results = await Promise.allSettled([service.addComment("repo", 42, "a"), service.addComment("repo", 42, "b")]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ httpStatus: 409 });
  });

  test("the read setting refuses every write without asking GitHub, and says so in the summary", async () => {
    const { fake, service } = harness(await repository({ branch: "feature/login" }), { mode: "read" });
    expect((await service.summary("repo")).readOnly).toBe(true);
    const count = fake.calls.length;
    await expect(service.addComment("repo", 42, "x")).rejects.toMatchObject({ httpStatus: 403 });
    expect(fake.calls.length).toBe(count);
  });

  test("GitHub refusing a mutation answers its message, bounded", async () => {
    const { fake, service } = harness(await repository());
    fake.record(42).pending = { id: "PRR_x", commitOid: head, comments: [] };
    fake.record(42).files = [];
    // The cached files say the path is fine; GitHub refuses the line.
    const error = await service.addReviewThread("repo", 42, { headOid: head, path: "src/login.ts", line: 999, side: "RIGHT", body: "x" }).catch(caught => caught);
    expect(error).toMatchObject({ httpStatus: 422 });
  });
});

describe("the kill switch and selection", () => {
  test("UATU_GITHUB is off, read or full (default); anything else is off", () => {
    expect(githubSetting({})).toBe("full");
    expect(githubSetting({ UATU_GITHUB: "read" })).toBe("read");
    expect(githubSetting({ UATU_GITHUB: " FULL " })).toBe("full");
    expect(githubSetting({ UATU_GITHUB: "off" })).toBe("off");
    expect(githubSetting({ UATU_GITHUB: "yes" })).toBe("off");
  });

  test("off answers no service; the fake needs UATU_GITHUB_FAKE=1; otherwise the real one", () => {
    const deps = { repositoryRoot: () => null };
    expect(githubServiceFromEnvironment({ UATU_GITHUB: "off" }, deps)).toBeNull();
    expect(githubServiceFromEnvironment({ UATU_GITHUB: "off", UATU_GITHUB_FAKE: "1" }, deps)).toBeNull();
    expect(githubServiceFromEnvironment({ UATU_GITHUB_FAKE: "1" }, deps)).toBeInstanceOf(FakeGithubService);
    const real = githubServiceFromEnvironment({ UATU_GITHUB: "read", PATH: "/nonexistent" }, deps);
    expect(real).toBeInstanceOf(GhGithubService);
    expect(real!.mock).toBe(false);
    real!.dispose?.();
  });
});
