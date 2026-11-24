// The real GithubService's Git side (add-github-pr-review D7, D8, D17; tasks
// 3.1–3.3, 5.2, 9.4, 9.5) over the in-memory transport fake
// (tests/fixtures/github-fake.ts) and real repositories: a local bare remote
// holding `refs/pull/<n>/head` stands in for GitHub's Git side, reached from
// a checkout whose `origin` reads as github.com/acme/widgets through
// `url.<bare>.insteadOf`. No network, no `gh`.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";

import { checkoutFingerprint, createPullRequestRemote, writeFileIn, type PullRequestRemote } from "../../tests/fixtures/pull-request-remote";
import { FakeGitHub } from "../../tests/fixtures/github-fake";
import { __resetDocumentDiffCachesForTests } from "../document/diff";
import { collectRepositorySnapshotsByTarget } from "../document/git-data";
import { clearPullRequestBases, onPullRequestBaseChange, pullRequestBaseFor } from "../document/pull-request-base";
import { listPullRequestRefs, privatePullRequestRef } from "../document/pull-request-refs";
import type { RootGroup } from "../shared/types";
import { checkoutReview, documentDiffReview } from "./anchoring";
import { GitHubApi } from "./api";
import { GhGithubService } from "./gh-service";
import { githubRouteHandlers } from "./http";

setDefaultTimeout(30_000);

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0x01]);

let remote: PullRequestRemote;
let fake: FakeGitHub;
let service: GhGithubService;
let main = "";

beforeEach(async () => {
  remote = await createPullRequestRemote();
  main = await remote.git(remote.checkout, "rev-parse", "HEAD");
  fake = new FakeGitHub();
  service = new GhGithubService({
    api: new GitHubApi(fake),
    mode: "full",
    repositoryRoot: id => (id === remote.checkout ? remote.checkout : null),
    gitEnv: remote.env,
    log: () => undefined,
  });
  clearPullRequestBases();
  __resetDocumentDiffCachesForTests();
});
afterEach(() => {
  clearPullRequestBases();
  remote.cleanup();
});

// Pull request #42 (the fixture's, head branch `feature/login`) at a real
// commit the contributor made on top of main, published as GitHub does.
async function publishFortyTwo(files: Record<string, string | Uint8Array | null> = {
  "docs/guide.md": "# Guide\n\nFirst.\nSecond.\n",
  "images/logo.png": PNG,
  "assets/big.bin": LFS_POINTER,
}): Promise<string> {
  await remote.git(remote.contributor, "checkout", "--quiet", "-B", "feature/login", "main");
  const head = await remote.commit(files, "the pull request");
  await remote.publishPullRequest(42, head);
  fake.pushHead(42, head);
  fake.setBase(42, "main", main);
  fake.setFiles(42, Object.keys(files).map(filename => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1 +1 @@\n-a\n+b" })));
  return head;
}

// The reviewer's checkout on the pull request's own branch, at its head.
async function checkOutFortyTwo(head: string): Promise<void> {
  await remote.git(remote.checkout, "fetch", "--quiet", "origin", `${head}`);
  await remote.git(remote.checkout, "checkout", "--quiet", "-b", "feature/login", head);
}

const text = (blob: Awaited<ReturnType<GhGithubService["pullRequestBlob"]>>) => ("bytes" in blob ? new TextDecoder().decode(blob.bytes) : blob);

describe("reading a pull request's files from Git (task 9.4)", () => {
  test("a head that isn't local reads as not fetched until the narrow fetch, which writes only the private ref", async () => {
    const head = await publishFortyTwo();
    expect(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" })).toEqual({ state: "not-fetched" });
    expect(await service.pullRequestTree(remote.checkout, 42)).toEqual({ state: "not-fetched" });
    const before = await checkoutFingerprint(remote);
    expect(await service.fetchPullRequestHead(remote.checkout, 42)).toEqual({ headOid: head });
    expect(await checkoutFingerprint(remote)).toBe(before);
    expect(await remote.git(remote.checkout, "rev-parse", privatePullRequestRef(42))).toBe(head);

    expect(text(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" }))).toBe("# Guide\n\nFirst.\nSecond.\n");
    expect(text(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "base" }))).toBe("# Guide\n\nFirst.\n");
    const png = await service.pullRequestBlob(remote.checkout, 42, { path: "images/logo.png", rev: "head" });
    expect("bytes" in png && [...png.bytes]).toEqual([...PNG]);
    await expect(service.pullRequestBlob(remote.checkout, 42, { path: "nope.md", rev: "head" })).rejects.toMatchObject({ httpStatus: 404 });
    const tree = await service.pullRequestTree(remote.checkout, 42);
    expect(tree).toEqual({ headOid: head, truncated: false, paths: ["README.md", "assets/big.bin", "docs/guide.md", "images/logo.png"] });
  });

  test("the routes show an LFS pointer as its text and serve only the pull request's commits", async () => {
    const head = await publishFortyTwo();
    await service.fetchPullRequestHead(remote.checkout, 42);
    const routes = githubRouteHandlers(() => service, () => null, { repositoryIds: () => [remote.checkout] });
    const query = (file: string) => `http://uatu.test/api/github/pull-request/file?repository=${encodeURIComponent(remote.checkout)}&number=42&path=${encodeURIComponent(file)}&view=source`;
    const lfs = await routes.pullRequestFile(new Request(query("assets/big.bin")));
    expect(lfs.status).toBe(200);
    expect(await lfs.json()).toMatchObject({ lfsPointer: true, mock: false, revision: { oid: head, rev: "head" } });
    const binary = await routes.pullRequestFile(new Request(query("images/logo.png")));
    expect(binary.status).toBe(415);
    const blobBase = ((await binary.json()) as { revision: { blobBase: string } }).revision.blobBase;
    const image = await routes.pullRequestBlob(new Request(`http://uatu.test/${blobBase}images/logo.png`));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...PNG]);
    const other = await routes.pullRequestBlob(new Request(`http://uatu.test/${blobBase.replace(head, main)}images/logo.png`.replace(`/${main}/`, `/${"0".repeat(40)}/`)));
    expect(other.status).toBe(404);
  });

  test("the branch's own pull request needs no fetch: its head is the checkout's", async () => {
    const head = await publishFortyTwo();
    await checkOutFortyTwo(head);
    const summary = await service.summary(remote.checkout);
    expect(summary.pullRequest).toMatchObject({ number: 42, headRefOid: head });
    expect(text(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" }))).toBe("# Guide\n\nFirst.\nSecond.\n");
    expect(await service.fetchPullRequestHead(remote.checkout, 42)).toEqual({ headOid: head });
    expect(await listPullRequestRefs(remote.checkout)).toEqual([]);
  });

  test("a checkout ahead of the head reads the pull request's file, not its own; one behind needs the fetch", async () => {
    const head = await publishFortyTwo();
    await checkOutFortyTwo(head);
    await writeFileIn(remote.checkout, "docs/guide.md", "# Guide\n\nMine.\n");
    await remote.git(remote.checkout, "commit", "--quiet", "-am", "ahead");
    expect(text(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" }))).toBe("# Guide\n\nFirst.\nSecond.\n");
    // Behind: the pull request moves on past what the checkout has.
    await remote.git(remote.contributor, "checkout", "--quiet", "feature/login");
    const next = await remote.commit({ "docs/guide.md": "# Guide\n\nThird.\n" }, "more");
    await remote.publishPullRequest(42, next);
    fake.pushHead(42, next);
    await service.refresh(remote.checkout);
    expect(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" })).toEqual({ state: "not-fetched" });
  });

  test("a pull request the remote doesn't publish, and a remote that wants a credential, can't be fetched, and say why", async () => {
    await publishFortyTwo();
    fake.pushHead(42, "a".repeat(40));
    await remote.git(remote.bare, "update-ref", "-d", "refs/pull/42/head");
    await expect(service.fetchPullRequestHead(remote.checkout, 42)).rejects.toMatchObject({ httpStatus: 404, message: expect.stringContaining("refs/pull/42/head") });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="GitHub"' } }) });
    try {
      await remote.git(remote.checkout, "config", "--unset-all", `url.${remote.bare}.insteadOf`);
      await remote.git(remote.checkout, "config", `url.http://127.0.0.1:${server.port}/acme/widgets.git.insteadOf`, "git@github.com:acme/widgets.git");
      await expect(service.fetchPullRequestHead(remote.checkout, 42)).rejects.toMatchObject({ httpStatus: 403, message: expect.stringContaining("no Git credential") });
    } finally {
      server.stop(true);
    }
  });

  test("fetching prunes: a merged pull request's ref goes first, then the oldest beyond 20", async () => {
    await publishFortyTwo();
    // 21 refs from earlier fetches; #57 (merged, per the fixture) among them.
    for (const number of [57, ...Array.from({ length: 20 }, (_, index) => 100 + index)]) {
      await remote.git(remote.checkout, "update-ref", privatePullRequestRef(number), main);
    }
    await service.pullRequest(remote.checkout, 57);
    await service.fetchPullRequestHead(remote.checkout, 42);
    const numbers = (await listPullRequestRefs(remote.checkout)).map(ref => ref.number);
    expect(numbers).toHaveLength(20);
    expect(numbers).toContain(42);
    expect(numbers).not.toContain(57);
  });

  test("a new head (9.5): the next read names it, its file isn't local until fetched, then reads the new text", async () => {
    const head = await publishFortyTwo();
    await service.fetchPullRequestHead(remote.checkout, 42);
    expect((await service.pullRequest(remote.checkout, 42)).summary.headRefOid).toBe(head);
    await remote.git(remote.contributor, "checkout", "--quiet", "feature/login");
    const next = await remote.commit({ "docs/guide.md": "# Guide\n\nRewritten.\n" }, "push");
    await remote.publishPullRequest(42, next);
    fake.pushHead(42, next);
    await service.refresh(remote.checkout);
    expect((await service.pullRequest(remote.checkout, 42)).summary.headRefOid).toBe(next);
    expect(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" })).toEqual({ state: "not-fetched" });
    expect(await service.fetchPullRequestHead(remote.checkout, 42)).toEqual({ headOid: next });
    expect(text(await service.pullRequestBlob(remote.checkout, 42, { path: "docs/guide.md", rev: "head" }))).toBe("# Guide\n\nRewritten.\n");
  });
});

describe("the pull request base from the summary (tasks 3.1, 3.2)", () => {
  test("the summary sets the base; a retargeted base collects again and changes the changed files, with no file event", async () => {
    // release/2.0 branches off main; #42 is based on it.
    await remote.git(remote.contributor, "checkout", "--quiet", "-B", "release/2.0", "main");
    const release = await remote.commit({ "release.md": "2.0\n" }, "release");
    await remote.git(remote.contributor, "push", "--quiet", "origin", "release/2.0");
    const head = await remote.commit({ "docs/guide.md": "# Guide\n\nOn release.\n" }, "the pull request");
    await remote.publishPullRequest(42, head);
    fake.pushHead(42, head);
    fake.setBase(42, "main", main);
    await checkOutFortyTwo(head);
    const heard: string[] = [];
    const stop = onPullRequestBaseChange(root => heard.push(root));
    try {
      await service.summary(remote.checkout);
      expect(pullRequestBaseFor(remote.checkout)).toMatchObject({ number: 42, remote: "origin", baseRefName: "main", baseRefOid: main, branch: "feature/login" });
      const entries = [{ kind: "dir", absolutePath: remote.checkout } as never];
      const first = await collectRepositorySnapshotsByTarget(entries, []);
      expect(first.base[0]?.base).toMatchObject({ mode: "pull-request", pullRequest: { number: 42, state: "exact" } });
      expect(first.base[0]?.changedFiles.map(file => file.path).sort()).toEqual(["docs/guide.md", "release.md"]);
      // GitHub retargets #42 onto release/2.0 (its commit fetched already).
      await remote.git(remote.checkout, "fetch", "--quiet", "origin", "release/2.0");
      fake.setBase(42, "release/2.0", release);
      await service.refresh(remote.checkout);
      expect(heard).toEqual([remote.checkout, remote.checkout]);
      const second = await collectRepositorySnapshotsByTarget(entries, []);
      expect(second.base[0]?.base).toMatchObject({ ref: "origin/release/2.0", pullRequest: { state: "exact" } });
      expect(second.base[0]?.changedFiles.map(file => file.path)).toEqual(["docs/guide.md"]);
    } finally {
      stop();
    }
  });

  test("a branch without a pull request clears it", async () => {
    const head = await publishFortyTwo();
    await checkOutFortyTwo(head);
    await service.summary(remote.checkout);
    expect(pullRequestBaseFor(remote.checkout)).not.toBeNull();
    await remote.git(remote.checkout, "checkout", "--quiet", "-b", "nothing-here");
    await service.refresh(remote.checkout);
    expect(pullRequestBaseFor(remote.checkout)).toBeNull();
  });

  test("the fetch brings a missing base commit into its remote-tracking ref", async () => {
    await remote.git(remote.contributor, "checkout", "--quiet", "-B", "release/3.0", "main");
    const release = await remote.commit({ "release.md": "3.0\n" }, "release");
    await remote.git(remote.contributor, "push", "--quiet", "origin", "release/3.0");
    const head = await remote.commit({ "docs/guide.md": "x\n" }, "pr");
    await remote.publishPullRequest(42, head);
    fake.pushHead(42, head);
    fake.setBase(42, "release/3.0", release);
    await service.fetchPullRequestHead(remote.checkout, 42);
    expect(await remote.git(remote.checkout, "rev-parse", "refs/remotes/origin/release/3.0")).toBe(release);
    expect(text(await service.pullRequestBlob(remote.checkout, 42, { path: "release.md", rev: "base" }))).toBe("3.0\n");
  });
});

describe("anchoring in the document Diff view (D8, task 5.2)", () => {
  async function ownPullRequest(): Promise<{ head: string; roots: RootGroup[] }> {
    const head = await publishFortyTwo({ "docs/guide.md": "# Guide\n\nFirst.\nSecond.\n", "notes.md": "notes\n" });
    await checkOutFortyTwo(head);
    await writeFileIn(remote.checkout, "README.md", (await Bun.file(path.join(remote.checkout, "README.md")).text()));
    await service.summary(remote.checkout);
    // The pane reads the branch's pull request: its files are known now.
    await service.pullRequest(remote.checkout, 42);
    const docs = ["docs/guide.md", "notes.md", "README.md"].map(relativePath => ({
      id: path.join(remote.checkout, relativePath), name: path.basename(relativePath), relativePath, mtimeMs: 0, rootId: remote.checkout, kind: "markdown" as const,
    }));
    return { head, roots: [{ id: remote.checkout, label: "checkout", path: remote.checkout, hiddenCount: 0, docs }] };
  }
  const review = (roots: RootGroup[], file: string, target: "base" | "last-commit" = "base") =>
    documentDiffReview(service, roots, path.join(remote.checkout, file), target);

  test("exact when HEAD is the head, the file is clean, the base exact and the path in the pull request", async () => {
    const { head, roots } = await ownPullRequest();
    expect(await review(roots, "docs/guide.md")).toEqual({ number: 42, headOid: head, path: "docs/guide.md", exact: true });
  });

  test("each reason, in order", async () => {
    const { roots } = await ownPullRequest();
    expect(await review(roots, "README.md")).toMatchObject({ exact: false, reason: "not-in-pr" });
    expect(await review(roots, "docs/guide.md", "last-commit")).toMatchObject({ exact: false, reason: "last-commit" });
    await writeFileIn(remote.checkout, "docs/guide.md", "# Guide\n\nEdited.\n");
    expect(await review(roots, "docs/guide.md")).toMatchObject({ exact: false, reason: "local-changes" });
    await remote.git(remote.checkout, "checkout", "--quiet", "--", "docs/guide.md");
    expect(await review(roots, "docs/guide.md")).toMatchObject({ exact: true });
    await remote.git(remote.checkout, "commit", "--quiet", "--allow-empty", "-m", "ahead");
    __resetDocumentDiffCachesForTests();
    expect(await review(roots, "docs/guide.md")).toMatchObject({ exact: false, reason: "head-mismatch" });
    await remote.git(remote.checkout, "reset", "--quiet", "--hard", "HEAD~1");
    // GitHub's base commit isn't local: only origin/main, possibly stale.
    fake.setBase(42, "main", "c".repeat(40));
    await service.refresh(remote.checkout);
    expect(await review(roots, "docs/guide.md")).toMatchObject({ exact: false, reason: "base-inexact", baseState: "stale" });
  });

  test("files not read yet are files-unknown, not a guess", async () => {
    const head = await publishFortyTwo();
    await checkOutFortyTwo(head);
    await service.summary(remote.checkout);
    const roots: RootGroup[] = [{ id: remote.checkout, label: "c", path: remote.checkout, hiddenCount: 0, docs: [{ id: path.join(remote.checkout, "docs/guide.md"), name: "guide.md", relativePath: "docs/guide.md", mtimeMs: 0, rootId: remote.checkout, kind: "markdown" }] }];
    expect(await review(roots, "docs/guide.md")).toMatchObject({ exact: false, reason: "files-unknown" });
  });

  test("a comment from the Diff view is re-checked against the checkout on write; Files changed's is not", async () => {
    const { head } = await ownPullRequest();
    await writeFileIn(remote.checkout, "docs/guide.md", "# Guide\n\nEdited.\n");
    const input = { headOid: head, path: "docs/guide.md", line: 3, side: "RIGHT" as const, body: "Looks good" };
    await expect(service.addReviewThread(remote.checkout, 42, { ...input, fromCheckout: true })).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("local-changes") });
    expect(fake.operations()).not.toContain("UatuAddReviewThread");
    // The pull request view's Files changed shows GitHub's diff: allowed.
    const detail = await service.addReviewThread(remote.checkout, 42, input);
    expect(detail.pendingReview?.comments).toHaveLength(1);
    await remote.git(remote.checkout, "checkout", "--quiet", "--", "docs/guide.md");
    expect(await checkoutReview(remote.checkout, "docs/guide.md", { number: 42, headOid: head, paths: new Set(["docs/guide.md"]) })).toMatchObject({ exact: true });
  });
});
