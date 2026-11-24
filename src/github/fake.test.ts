import { describe, expect, test } from "bun:test";

import { countLineChanges, FakeGithubService } from "./fake";
import { GithubError } from "./error";
import { githubServiceFromEnvironment } from "./service";

const REPO = "/repo";

function fake(start = 1_000_000_000_000) {
  let now = start;
  const service = new FakeGithubService({ now: () => now });
  return { service, advance: (ms: number) => { now += ms; } };
}

async function refusal(run: () => Promise<unknown>): Promise<GithubError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GithubError) return error;
    throw error;
  }
  throw new Error("expected a GithubError");
}

describe("githubServiceFromEnvironment", () => {
  test("serves nothing unless the process opts in", () => {
    expect(githubServiceFromEnvironment({})).toBeNull();
    expect(githubServiceFromEnvironment({ UATU_GITHUB_FAKE: "true" })).toBeNull();
    expect(githubServiceFromEnvironment({ UATU_GITHUB_FAKE: "1" })).toBeInstanceOf(FakeGithubService);
  });
});

describe("FakeGithubService", () => {
  test("reports the checked-out branch's pull request, labelled as mocked", async () => {
    const { service } = fake();
    const summary = await service.summary(REPO);
    expect(summary.status).toBe("ready");
    expect(summary.mock).toBe(true);
    expect(summary.viewer).toBe("octo-reviewer");
    expect(summary.pullRequest?.number).toBe(642);
    expect(summary.pullRequest?.reviewDecision).toBe("REVIEW_REQUIRED");
    expect(summary.pullRequest?.checks).toMatchObject({ state: "PENDING", passed: 4, pending: 1 });
    expect(summary.pullRequest?.changedFiles).toBe(9);
  });

  test("lists open pull requests with draft, fork and review-requested facts", async () => {
    const { service } = fake();
    const list = await service.pullRequests(REPO);
    expect(list.pullRequests.map(item => item.number).sort()).toEqual([618, 627, 631, 636, 639, 642]);
    expect(list.pullRequests.find(item => item.number === 631)?.isDraft).toBe(true);
    expect(list.pullRequests.find(item => item.number === 639)?.isCrossRepository).toBe(true);
    expect(list.pullRequests.filter(item => item.viewerReviewRequested).map(item => item.number).sort()).toEqual([639, 642]);
  });

  test("a conversation comment posts immediately and renders sanitized Markdown", async () => {
    const { service } = fake();
    const detail = await service.addComment(REPO, 642, "**hi** <script>alert(1)</script>");
    const last = detail.timeline.at(-1);
    expect(last?.kind).toBe("comment");
    if (last?.kind !== "comment") return;
    expect(last.comment.author).toBe("octo-reviewer");
    expect(last.comment.bodyHtml).toContain("<strong>hi</strong>");
    expect(last.comment.bodyHtml).not.toContain("<script");
  });

  test("inline comments and replies accumulate in one pending review until submitted", async () => {
    const { service } = fake();
    const head = (await service.pullRequest(REPO, 642)).summary.headRefOid;
    await service.addReviewThread(REPO, 642, { headOid: head, path: "docs/pr-review.md", line: 9, side: "RIGHT", body: "Nit" });
    let detail = await service.replyToThread(REPO, 642, "thread-checks-source", "Thanks");
    expect(detail.pendingReview?.comments.map(comment => comment.threadId ?? comment.path)).toEqual(["docs/pr-review.md", "thread-checks-source"]);
    expect(detail.summary.viewerPendingComments).toBe(2);
    expect((await service.summary(REPO)).pullRequest?.viewerPendingComments).toBe(2);

    detail = await service.submitReview(REPO, 642, { event: "APPROVE", body: "" });
    expect(detail.pendingReview).toBeNull();
    expect(detail.summary.reviewDecision).toBe("APPROVED");
    expect(detail.threads.find(thread => thread.id === "thread-checks-source")?.comments.at(-1)?.body).toBe("Thanks");
    const created = detail.threads.find(thread => thread.path === "docs/pr-review.md" && thread.line === 9);
    expect(created?.lineText).toContain("Click `+`");
    const review = detail.timeline.at(-1);
    expect(review?.kind === "review" && review.threadIds).toEqual([created!.id]);
  });

  test("pending comments can be edited and discarded, and the review discarded", async () => {
    const { service } = fake();
    const head = (await service.pullRequest(REPO, 642)).summary.headRefOid;
    let detail = await service.addReviewThread(REPO, 642, { headOid: head, path: "README.md", line: 10, side: "RIGHT", body: "one" });
    const id = detail.pendingReview!.comments[0]!.id;
    detail = await service.editPendingComment(REPO, 642, id, "two");
    expect(detail.pendingReview!.comments[0]!.body).toBe("two");
    detail = await service.deletePendingComment(REPO, 642, id);
    expect(detail.pendingReview!.comments).toEqual([]);
    detail = await service.discardReview(REPO, 642);
    expect(detail.pendingReview).toBeNull();
  });

  test("refuses inline comments on a stale head, an unknown file or a line outside it", async () => {
    const { service } = fake();
    const head = (await service.pullRequest(REPO, 642)).summary.headRefOid;
    expect((await refusal(() => service.addReviewThread(REPO, 642, { headOid: "0000000", path: "README.md", line: 1, side: "RIGHT", body: "x" }))).httpStatus).toBe(409);
    expect((await refusal(() => service.addReviewThread(REPO, 642, { headOid: head, path: "nope.md", line: 1, side: "RIGHT", body: "x" }))).httpStatus).toBe(422);
    expect((await refusal(() => service.addReviewThread(REPO, 642, { headOid: head, path: "README.md", line: 999, side: "RIGHT", body: "x" }))).httpStatus).toBe(422);
  });

  test("a review needs a type and, except Approve, a summary or comments; own PRs only take comments", async () => {
    const { service } = fake();
    expect((await refusal(() => service.submitReview(REPO, 642, { event: "COMMENT", body: " " }))).httpStatus).toBe(422);
    expect((await refusal(() => service.submitReview(REPO, 627, { event: "APPROVE", body: "" }))).message).toContain("your own pull request");
  });

  test("resolving a thread flips it both ways", async () => {
    const { service } = fake();
    expect((await service.setThreadResolved(REPO, 642, "thread-checks-source", true)).threads[0]!.isResolved).toBe(true);
    expect((await service.setThreadResolved(REPO, 642, "thread-checks-source", false)).threads[0]!.isResolved).toBe(false);
  });

  test("merge readiness lists every blocker until approved and checks pass, and is read-only", async () => {
    const { service, advance } = fake();
    let detail = await service.pullRequest(REPO, 642);
    expect(detail.mergeReadiness.allowedMethods).toEqual(["SQUASH", "REBASE"]);
    expect(detail.mergeReadiness.deleteBranchOnMerge).toBe(true);
    expect(detail.mergeReadiness.mergeable).toBe(false);
    expect(detail.mergeReadiness.blockers).toEqual(["main requires 2 approving reviews.", "Waiting for required check: e2e (leg 2)."]);
    await service.submitReview(REPO, 642, { event: "APPROVE", body: "" });
    detail = await service.pullRequest(REPO, 642);
    expect(detail.mergeReadiness.blockers).toEqual(["Waiting for required check: e2e (leg 2)."]);
    advance(2 * 60_000);
    detail = await service.pullRequest(REPO, 642);
    expect(detail.mergeReadiness).toMatchObject({ mergeable: true, blockers: [] });
    expect(detail.summary.state).toBe("OPEN");
    expect("merge" in service).toBe(false);
  });

  test("drafts and conflicting PRs say why they cannot merge", async () => {
    const { service } = fake();
    expect((await service.pullRequest(REPO, 631)).mergeReadiness.blockers[0]).toContain("Draft");
    expect((await service.pullRequest(REPO, 618)).mergeReadiness.blockers.join(" ")).toContain("Conflicts");
  });

  test("the open list carries the viewer's pending comment count", async () => {
    const { service } = fake();
    const head = (await service.pullRequest(REPO, 639)).summary.headRefOid;
    const detail = await service.pullRequest(REPO, 639);
    const file = detail.files[0]!;
    await service.addReviewThread(REPO, 639, { headOid: head, path: file.path, line: 1, side: file.status === "removed" ? "LEFT" : "RIGHT", body: "pending" });
    const list = await service.pullRequests(REPO);
    expect(list.pullRequests.find(item => item.number === 639)?.viewerPendingComments).toBe(1);
    expect(list.pullRequests.find(item => item.number === 642)?.viewerPendingComments).toBe(0);
  });

  test("scenarios reproduce the empty and error states, and reset re-seeds", async () => {
    const { service, advance } = fake();
    await service.addComment(REPO, 642, "before");
    service.setScenario("no-credential");
    expect((await service.summary(REPO)).status).toBe("no-credential");
    expect((await refusal(() => service.pullRequest(REPO, 642))).httpStatus).toBe(401);
    service.setScenario("no-pull-request");
    const none = await service.summary(REPO);
    expect(none.status).toBe("no-pull-request");
    expect(none.pullRequest).toBeUndefined();
    advance(60_000);
    service.setScenario("rate-limited");
    const limited = await service.summary(REPO);
    expect(limited).toMatchObject({ status: "rate-limited", stale: true });
    expect(limited.pullRequest?.number).toBe(642);
    expect(limited.retryAt! - limited.checkedAt).toBe(14 * 60_000);
    expect((await refusal(() => service.addComment(REPO, 642, "x"))).httpStatus).toBe(429);
    service.setScenario("unavailable");
    expect((await refusal(() => service.addComment(REPO, 642, "x"))).httpStatus).toBe(503);
    service.setScenario("ready");
    service.reset();
    const timeline = (await service.pullRequest(REPO, 642)).timeline;
    expect(timeline.some(item => item.kind === "comment" && item.comment.body === "before")).toBe(false);
  });
});

describe("countLineChanges", () => {
  test("counts added and deleted lines", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nx\nc\nd\n")).toEqual({ additions: 2, deletions: 1 });
    expect(countLineChanges("", "a\nb\n")).toEqual({ additions: 2, deletions: 0 });
  });
});
