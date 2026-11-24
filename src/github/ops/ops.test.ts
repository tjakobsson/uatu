// The adapters' parsers over the hand-written fixture
// (tests/fixtures/github/acme-widgets.json): unknown enum values and union
// members are absorbed, file-level threads stay file-level, Markdown is
// sanitized with relative URLs resolved, and no query can merge.

import { describe, expect, test } from "bun:test";

import seed from "../../../tests/fixtures/github/acme-widgets.json";
import { renderGithubMarkdown } from "../markdown";
import { PULL_REQUEST_CONVERSATION, parseConversation } from "./conversation";
import { parseFilesPage, unifiedPatch } from "./files";
import { OPEN_PULL_REQUESTS, parseOpenPullRequests } from "./list";
import { ALL_MUTATIONS, WRITE_PRECONDITION } from "./mutations";
import { ParseNotes } from "./parse";
import { mergeReadinessFrom, type ReadinessInput } from "./readiness";
import { checksFrom, DETECT_PULL_REQUEST, pickDetected, PULL_REQUEST_SUMMARY } from "./summary";
import { lineTextFromHunk, parseThreads, PULL_REQUEST_THREADS } from "./threads";

const pr42 = structuredClone(seed.pullRequests.find(pr => pr.number === 42)!);
const answer = (pullRequest: unknown) => ({ viewer: { login: seed.viewer }, repository: { ...seed.repository, pullRequest } });

describe("conversation", () => {
  test("parses the summary, skips unknown timeline kinds and renders bodies safely", () => {
    const notes = new ParseNotes();
    const conversation = parseConversation(answer(pr42), notes)!;
    expect(conversation.viewer).toBe("octo-reviewer");
    const summary = conversation.parsed.summary;
    expect(summary).toMatchObject({ number: 42, state: "OPEN", author: "octo-author", headOwner: "acme", reviewDecision: "REVIEW_REQUIRED", changedFiles: 5, commits: 3 });
    // The title stays plain text: the client escapes it.
    expect(summary.title).toContain("<script>");
    // Team requests read as org/slug; an unknown reviewer kind is skipped.
    expect(summary.reviewers).toEqual([
      { login: "octo-colleague", state: "COMMENTED" },
      { login: "octo-reviewer", state: "REQUESTED" },
      { login: "acme/web", state: "REQUESTED" },
    ]);
    // Comments and reviews in order; DISMISSED reads as COMMENTED; the
    // unknown event is skipped and counted; a deleted author is "ghost".
    expect(conversation.timeline.map(item => item.kind)).toEqual(["comment", "review", "review", "comment"]);
    expect(conversation.timeline[2]).toMatchObject({ kind: "review", state: "COMMENTED", author: "octo-bot" });
    expect(conversation.timeline[3]).toMatchObject({ kind: "comment", comment: { author: "ghost" } });
    expect(conversation.omitted).toBe(2);
    expect(notes.skippedUnknown).toBeGreaterThanOrEqual(3);
    expect(conversation.bodyHtml).not.toContain("<script");
    expect(conversation.bodyHtml).not.toContain("onerror");
    expect(conversation.bodyHtml).not.toContain("javascript:");
    expect(conversation.bodyHtml).toContain('href="https://github.com/acme/widgets/pull/docs/login.md"');
    expect(conversation.bodyHtml).toContain('src="https://github.com/acme/widgets/pull/images/flow.png"');
    expect(conversation.bodyHtml).toContain('target="_blank"');
  });

  test("merge readiness from the pull request and repository settings", () => {
    const readiness = parseConversation(answer(pr42))!.readiness;
    expect(readiness.mergeable).toBe(false);
    expect(readiness.allowedMethods).toEqual(["MERGE", "SQUASH"]);
    expect(readiness.deleteBranchOnMerge).toBe(true);
    expect(readiness.blockers).toEqual([
      "main requires an approving review.",
      "Required check failing: lint.",
      "Waiting for required check: e2e.",
    ]);
  });

  test("a merged event says who merged and that the head branch went", () => {
    const merged = parseConversation(answer(structuredClone(seed.pullRequests.find(pr => pr.number === 57)!)))!;
    expect(merged.timeline).toEqual([{ kind: "merged", actor: "octo-reviewer", at: "2026-11-02T09:00:00Z", deletedBranch: true }]);
    expect(merged.readiness.blockers).toEqual(["Already merged."]);
  });

  test("an unknown pull request state reads as closed, an unknown decision as none", () => {
    const odd = { ...structuredClone(pr42), state: "QUEUED", reviewDecision: "SOMETHING_NEW" };
    const notes = new ParseNotes();
    const parsed = parseConversation(answer(odd), notes)!.parsed.summary;
    expect(parsed.state).toBe("CLOSED");
    expect(parsed.reviewDecision).toBeNull();
    expect(notes.notes.some(note => note.includes("QUEUED"))).toBe(true);
  });

  test("a missing pull request is null; a missing identity field is a classified failure", () => {
    expect(parseConversation({ viewer: { login: "x" }, repository: { pullRequest: null } })).toBeNull();
    expect(() => parseConversation(answer({ ...structuredClone(pr42), headRefOid: null }))).toThrow(/head commit/);
  });
});

describe("checks", () => {
  test("counts runs and statuses, treats unknown conclusions as pending, and keeps requiredness", () => {
    const notes = new ParseNotes();
    const facts = checksFrom(pr42 as never, notes);
    expect(facts.rollup).toMatchObject({ state: "FAILURE", passed: 2, failed: 2, pending: 1 });
    expect(facts.rollup.runs.map(run => run.name)).toEqual(["build", "lint", "e2e", "flaky-optional", "ci/legacy"]);
    expect(facts.requiredFailing).toEqual(["lint"]);
    expect(facts.requiredPending).toEqual(["e2e"]);
    const unknown = structuredClone(pr42);
    unknown.lastCommit.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [{ __typename: "CheckRun", name: "new", status: "COMPLETED", conclusion: "WARP_SPEED", isRequired: true }];
    unknown.lastCommit.nodes[0]!.commit.statusCheckRollup!.contexts.totalCount = 1;
    expect(checksFrom(unknown as never, new ParseNotes()).rollup.runs[0]).toEqual({ name: "new", state: "PENDING", detail: "GitHub reported WARP_SPEED" });
  });

  test("no rollup (no checks configured) is an empty success", () => {
    const pr41 = seed.pullRequests.find(pr => pr.number === 41)!;
    expect(checksFrom(pr41 as never, new ParseNotes()).rollup).toEqual({ state: "SUCCESS", passed: 0, failed: 0, pending: 0, runs: [] });
  });
});

describe("threads", () => {
  test("line, outdated, file-level and left-side threads", () => {
    const parsed = parseThreads({ repository: { pullRequest: { ...pr42, pendingReviews: { nodes: [] } } } }, new ParseNotes(), pr42.url)!;
    const byId = new Map(parsed.threads.map(thread => [thread.id, thread]));
    expect(byId.get("PRRT_line")).toMatchObject({ line: 12, side: "RIGHT", isOutdated: false, lineText: "  if (!user.name) return;" });
    expect(byId.get("PRRT_outdated")).toMatchObject({ line: null, isOutdated: true });
    expect(byId.get("PRRT_file")).toMatchObject({ line: null, isOutdated: false, subjectType: "FILE", lineText: "" });
    expect(byId.get("PRRT_left")).toMatchObject({ line: 3, side: "LEFT", isResolved: true, lineText: "const legacy = true;" });
    expect(parsed.threadsByReview.get("PRR_1")).toEqual(["PRRT_line", "PRRT_file", "PRRT_left"]);
    expect(parsed.pendingReview).toBeNull();
    expect(parsed.truncated).toBe(false);
  });

  test("the viewer's pending comments leave the threads for the pending review", () => {
    type Loose = { reviewThreads: { nodes: { comments: { nodes: unknown[] } }[] }; headRefOid: string; url: string; pendingReviews?: unknown };
    const pr = structuredClone(pr42) as unknown as Loose;
    pr.reviewThreads.nodes[0]!.comments.nodes.push({ id: "PRRC_reply", author: { login: "octo-reviewer" }, body: "Reply", createdAt: "2026-11-23T00:00:00Z", diffHunk: "", state: "PENDING", pullRequestReview: { id: "PRR_pending" } });
    (pr.reviewThreads.nodes as unknown[]).push({ id: "PRRT_new", path: "src/login.ts", line: 11, startLine: null, originalLine: 11, diffSide: "LEFT", isResolved: false, isOutdated: false, subjectType: "LINE",
      comments: { totalCount: 1, nodes: [{ id: "PRRC_new", author: { login: "octo-reviewer" }, body: "New", createdAt: "2026-11-23T00:00:00Z", diffHunk: "", state: "PENDING", pullRequestReview: { id: "PRR_pending" } }] } });
    pr.pendingReviews = { nodes: [{ id: "PRR_pending", commit: { oid: pr.headRefOid }, comments: { nodes: [
      { id: "PRRC_reply", body: "Reply", createdAt: "2026-11-23T00:00:00Z", path: "src/login.ts", line: 12, replyTo: { id: "PRRC_1" } },
      { id: "PRRC_new", body: "New", createdAt: "2026-11-23T00:00:00Z", path: "src/login.ts", line: 11, replyTo: null },
    ] } }] };
    const parsed = parseThreads({ repository: { pullRequest: pr } }, new ParseNotes(), pr.url)!;
    expect(parsed.threads.some(thread => thread.id === "PRRT_new")).toBe(false);
    expect(parsed.threads.find(thread => thread.id === "PRRT_line")!.comments.map(comment => comment.id)).toEqual(["PRRC_1"]);
    expect(parsed.pendingReview).toMatchObject({ id: "PRR_pending", commitOid: pr.headRefOid });
    expect(parsed.pendingReview!.comments).toEqual([
      expect.objectContaining({ id: "PRRC_reply", path: "src/login.ts", line: 12, side: "RIGHT", threadId: "PRRT_line" }),
      expect.objectContaining({ id: "PRRC_new", path: "src/login.ts", line: 11, side: "LEFT" }),
    ]);
    expect(parsed.pendingReview!.comments[1]!.threadId).toBeUndefined();
  });

  test("lineTextFromHunk takes the hunk's last line without its marker", () => {
    expect(lineTextFromHunk("@@ -1 +1 @@\n-old\n+new")).toBe("new");
    expect(lineTextFromHunk("")).toBe("");
  });
});

describe("files", () => {
  test("statuses fold into the contract's three, patches gain headers, a patchless file stays", () => {
    const page = parseFilesPage(pr42.files, 1_000_000);
    expect(page.full).toBe(false);
    expect(page.files.map(file => [file.path, file.status, file.previousPath ?? null])).toEqual([
      ["src/login.ts", "modified", null],
      ["docs/login.md", "added", null],
      ["src/session.ts", "modified", null],
      ["src/auth/form.ts", "modified", "src/form.ts"],
      ["images/flow.png", "added", null],
    ]);
    expect(page.files[1]!.patch).toStartWith("diff --git a/docs/login.md b/docs/login.md\n--- /dev/null\n+++ b/docs/login.md\n@@ -0,0 +1,2 @@");
    expect(page.files[3]!.patch).toContain("--- a/src/form.ts\n+++ b/src/auth/form.ts");
    expect(page.files[4]!.patch).toBeUndefined();
  });

  test("patches past the byte budget are dropped and said so", () => {
    const page = parseFilesPage(pr42.files, 150);
    expect(page.patchesDropped).toBe(true);
    expect(page.files.filter(file => file.patch).length).toBeLessThan(4);
  });

  test("unifiedPatch for a removed file", () => {
    expect(unifiedPatch({ path: "a.txt", status: "removed" }, "@@ -1 +0,0 @@\n-x")).toBe("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n");
  });
});

describe("open pull requests and detection", () => {
  test("the list keeps open ones with the viewer's review requests", () => {
    const open = seed.pullRequests.filter(pr => pr.state === "OPEN");
    const parsed = parseOpenPullRequests({ viewer: { login: "octo-reviewer" }, repository: { pullRequests: { totalCount: 140, nodes: open } } })!;
    expect(parsed.totalCount).toBe(140);
    expect(parsed.items).toEqual([expect.objectContaining({ number: 42, viewerReviewRequested: true, checks: { state: "FAILURE", passed: 2, failed: 2, pending: 1 } })]);
  });

  test("detection keeps the head owner's pull requests, open first", () => {
    const nodes = [
      { number: 41, state: "CLOSED", updatedAt: "2026-11-25T00:00:00Z", headRepositoryOwner: { login: "acme" } },
      { number: 43, state: "OPEN", updatedAt: "2026-11-24T00:00:00Z", headRepositoryOwner: { login: "someone-else" } },
      { number: 42, state: "OPEN", updatedAt: "2026-11-23T00:00:00Z", headRepositoryOwner: { login: "ACME" } },
    ];
    expect(pickDetected({ viewer: { login: "v" }, repository: { pullRequests: { nodes } } }, "acme")).toEqual({ viewer: "v", number: 42, repositoryFound: true });
    expect(pickDetected({ viewer: { login: "v" }, repository: { pullRequests: { nodes: nodes.slice(0, 1) } } }, "acme").number).toBe(41);
    expect(pickDetected({ viewer: { login: "v" }, repository: null }, "acme").repositoryFound).toBe(false);
  });
});

describe("merge readiness table", () => {
  const base: ReadinessInput = {
    state: "OPEN", isDraft: false, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    requiredFailing: [], requiredPending: [], viewerPermission: "WRITE",
    repository: { mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: true, deleteBranchOnMerge: false },
  };
  test.each<[string, Partial<ReadinessInput>, string[]]>([
    ["clean", {}, []],
    ["unstable (optional checks failing) still merges", { mergeStateStatus: "UNSTABLE" }, []],
    ["has hooks", { mergeStateStatus: "HAS_HOOKS" }, []],
    ["merged", { state: "MERGED" }, ["Already merged."]],
    ["closed", { state: "CLOSED" }, ["Closed."]],
    ["draft", { isDraft: true, mergeStateStatus: "DRAFT" }, ["Draft: mark it ready for review on GitHub first."]],
    ["conflicts", { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, ["Conflicts with main must be resolved."]],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }, ["Changes were requested; that reviewer must approve."]],
    ["behind", { mergeStateStatus: "BEHIND" }, ["Behind main: update the branch on GitHub first."]],
    ["computing", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, ["GitHub is still checking whether it can merge."]],
    ["blocked by an unseen rule", { mergeStateStatus: "BLOCKED" }, ["A rule on main blocks merging; see the pull request on GitHub."]],
    ["unknown merge state", { mergeStateStatus: "other", mergeStateStatusRaw: "QUEUED" }, ["GitHub reports merge state QUEUED; see the pull request on GitHub."]],
    ["unknown mergeability", { mergeable: "other" }, ["GitHub reports a mergeability uatu doesn't know; see the pull request on GitHub."]],
    ["read permission", { viewerPermission: "READ" }, ["Your access to this repository (read) can't merge."]],
    ["no merge method", { repository: { mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false, deleteBranchOnMerge: false } }, ["The repository allows no merge method."]],
  ])("%s", (_name, change, blockers) => {
    const readiness = mergeReadinessFrom({ ...base, ...change });
    expect(readiness.blockers).toEqual(blockers);
    expect(readiness.mergeable).toBe(blockers.length === 0);
  });

  test("required checks list their names, failing before waiting", () => {
    expect(mergeReadinessFrom({ ...base, requiredFailing: ["a", "b"], requiredPending: ["c"], mergeStateStatus: "BLOCKED" }).blockers)
      .toEqual(["Required checks failing: a, b.", "Waiting for required check: c."]);
  });
});

describe("pinned operations", () => {
  const all = [DETECT_PULL_REQUEST, PULL_REQUEST_SUMMARY, PULL_REQUEST_CONVERSATION, PULL_REQUEST_THREADS, OPEN_PULL_REQUESTS, WRITE_PRECONDITION, ...ALL_MUTATIONS];

  test("every document names its operation, and every union asks for __typename", () => {
    for (const operation of all) {
      expect(operation.query).toContain(` ${operation.name}(`);
      if (operation.query.includes("... on ")) expect(operation.query).toContain("__typename");
    }
  });

  test("nothing can merge, delete a branch or enable auto-merge", () => {
    for (const operation of all) {
      expect(operation.query).not.toMatch(/mergePullRequest|enablePullRequestAutoMerge|mergeBranch|deleteRef|updatePullRequestBranch/);
    }
  });

  test("only mutations write, and they take one $input", () => {
    for (const operation of ALL_MUTATIONS) {
      expect(operation.write).toBe(true);
      expect(operation.query).toMatch(/^mutation \w+\(\$input: \w+!\)/);
    }
  });
});

describe("renderGithubMarkdown", () => {
  test.each([
    ["<script>alert(1)</script>", "<script"],
    ["<img src=x onerror=alert(1)>", "onerror"],
    ["[x](javascript:alert(1))", "javascript:"],
    ["<a href=\"vbscript:x\">x</a>", "vbscript:"],
    ["<iframe src=\"https://evil.example\"></iframe>", "<iframe"],
    ["<style>body{display:none}</style>", "<style"],
  ])("strips %s", (body, forbidden) => {
    expect(renderGithubMarkdown(body, "https://github.com/acme/widgets/pull/42")).not.toContain(forbidden);
  });

  test("relative links and images resolve against the pull request; fragments and absolute URLs stay", () => {
    const html = renderGithubMarkdown("[a](../blob/main/a.md) [b](#heading) [c](https://example.com/c) ![d](d.png)", "https://github.com/acme/widgets/pull/42");
    expect(html).toContain('href="https://github.com/acme/widgets/blob/main/a.md"');
    expect(html).toContain('href="#heading"');
    expect(html).toContain('href="https://example.com/c"');
    expect(html).toContain('src="https://github.com/acme/widgets/pull/d.png"');
  });

  test("an empty body renders nothing", () => {
    expect(renderGithubMarkdown("  ", "https://github.com/a/b/pull/1")).toBe("");
  });
});
