// The explicit, narrow fetch of a pull request's head (add-github-pr-review
// D7, task 9.4) against a local bare remote holding `refs/pull/<n>/head`, as
// GitHub publishes them. No network: `origin` reads as github.com, and
// `url.<bare>.insteadOf` sends the fetch to the bare remote; the failure
// cases use a loopback HTTP server and a refused loopback port.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { checkoutFingerprint, createPullRequestRemote, GITHUB_ORIGIN, type PullRequestRemote } from "../../tests/fixtures/pull-request-remote";
import { commitPresent } from "./git-objects";
import {
  fetchPullRequestRefs,
  listPullRequestRefs,
  privatePullRequestRef,
  prunePullRequestRefs,
  pullRequestFetchEnvironment,
} from "./pull-request-refs";

// Real Git processes; the parallel CI runner shares cores.
setDefaultTimeout(30_000);

let remote: PullRequestRemote;
beforeEach(async () => { remote = await createPullRequestRemote(); });
afterEach(() => remote.cleanup());

async function publishedPullRequest(number: number, files: Record<string, string>): Promise<string> {
  await remote.git(remote.contributor, "checkout", "--quiet", "-B", `topic-${number}`, "main");
  const oid = await remote.commit(files, `pull request ${number}`);
  await remote.publishPullRequest(number, oid);
  return oid;
}

describe("fetchPullRequestRefs", () => {
  test("writes only the private ref: the working tree, index, branches, remote-tracking refs and FETCH_HEAD stay as they were", async () => {
    const head = await publishedPullRequest(639, { "docs/terminal.md": "# Terminal\n" });
    await remote.git(remote.checkout, "checkout", "--quiet", "-b", "feat/local");
    const before = await checkoutFingerprint(remote);
    expect(await commitPresent(remote.checkout, head)).toBe(false);
    const outcome = await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 639, head: true, env: remote.env });
    expect(outcome).toEqual({ ok: true, headOid: head, fetchedHead: true, fetchedBase: false });
    expect(await commitPresent(remote.checkout, head)).toBe(true);
    expect(await remote.git(remote.checkout, "rev-parse", privatePullRequestRef(639))).toBe(head);
    expect(await checkoutFingerprint(remote)).toBe(before);
    // The remote still reads as GitHub; only the fetch went to the bare one.
    expect(await remote.git(remote.checkout, "config", "--get", "remote.origin.url")).toBe(GITHUB_ORIGIN);
  });

  test("the base, when asked for, goes into its remote-tracking ref and nowhere else", async () => {
    await remote.git(remote.contributor, "checkout", "--quiet", "-b", "release/2.0");
    const base = await remote.commit({ "CHANGELOG.md": "2.0\n" }, "release");
    await remote.git(remote.contributor, "push", "--quiet", "origin", "release/2.0");
    const head = await publishedPullRequest(42, { "src/a.ts": "a\n" });
    const outcome = await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 42, head: true, baseRefName: "release/2.0", env: remote.env });
    expect(outcome).toEqual({ ok: true, headOid: head, fetchedHead: true, fetchedBase: true });
    expect(await remote.git(remote.checkout, "rev-parse", "refs/remotes/origin/release/2.0")).toBe(base);
    expect(await remote.git(remote.checkout, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  test("a pull request the remote doesn't publish is missing-ref, and nothing is written", async () => {
    const before = await checkoutFingerprint(remote);
    const outcome = await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 9999, head: true, env: remote.env });
    expect(outcome).toMatchObject({ ok: false, failure: "missing-ref" });
    expect(outcome.ok ? "" : outcome.message).toContain("refs/pull/9999/head");
    expect(await listPullRequestRefs(remote.checkout)).toEqual([]);
    expect(await checkoutFingerprint(remote)).toBe(before);
  });

  test("a shallow repository fetches with --depth=1 and stays shallow", async () => {
    await publishedPullRequest(7, { "one.md": "1\n" });
    const head = await remote.commit({ "two.md": "2\n" }, "second");
    await remote.publishPullRequest(7, head);
    const shallow = `${remote.checkout}-shallow`;
    await remote.git(remote.contributor, "clone", "--quiet", "--depth=1", `file://${remote.bare}`, shallow);
    await remote.git(shallow, "remote", "set-url", "origin", GITHUB_ORIGIN);
    await remote.git(shallow, "config", `url.file://${remote.bare}.insteadOf`, GITHUB_ORIGIN);
    const outcome = await fetchPullRequestRefs({ repoRoot: shallow, remote: "origin", number: 7, head: true, env: remote.env });
    expect(outcome).toMatchObject({ ok: true, headOid: head });
    expect(await remote.git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(await remote.git(shallow, "rev-list", "--count", privatePullRequestRef(7))).toBe("1");
  });

  test("a remote that wants a credential the session doesn't have is no-credential, without prompting", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="GitHub"' } }),
    });
    try {
      await remote.git(remote.checkout, "config", "--unset-all", `url.${remote.bare}.insteadOf`);
      await remote.git(remote.checkout, "config", `url.http://127.0.0.1:${server.port}/acme/widgets.git.insteadOf`, GITHUB_ORIGIN);
      const outcome = await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 1, head: true, env: remote.env });
      expect(outcome).toMatchObject({ ok: false, failure: "no-credential" });
      expect(outcome.ok ? "" : outcome.message).toContain("no Git credential");
    } finally {
      server.stop(true);
    }
  });

  test("an unreachable remote is a network failure", async () => {
    await remote.git(remote.checkout, "config", "--unset-all", `url.${remote.bare}.insteadOf`);
    await remote.git(remote.checkout, "config", "url.http://127.0.0.1:1/acme/widgets.git.insteadOf", GITHUB_ORIGIN);
    const outcome = await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 1, head: true, env: remote.env });
    expect(outcome).toMatchObject({ ok: false, failure: "network" });
  });

  test("odd input is refused before Git runs", async () => {
    expect(await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "--upload-pack=x", number: 1, head: true, env: remote.env })).toMatchObject({ ok: false, failure: "invalid" });
    expect(await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 0, head: true, env: remote.env })).toMatchObject({ ok: false, failure: "invalid" });
    expect(await fetchPullRequestRefs({ repoRoot: remote.checkout, remote: "origin", number: 1, head: false, baseRefName: "a:b", env: remote.env })).toMatchObject({ ok: false, failure: "invalid" });
  });

  test("the fetch environment never prompts and keeps a projected SSH command", () => {
    expect(pullRequestFetchEnvironment({ PATH: "/bin" })).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    expect(pullRequestFetchEnvironment({ GIT_SSH_COMMAND: "/hub/ssh-wrapper" }).GIT_SSH_COMMAND).toBe("/hub/ssh-wrapper");
  });
});

describe("prunePullRequestRefs", () => {
  test("keeps at most 20, dropping closed pull requests first, then the oldest, never the protected one", async () => {
    // 22 commits a day apart (committer dates order them), oldest first,
    // each a private ref.
    for (let day = 1; day <= 22; day++) {
      const date = `2026-01-${String(day).padStart(2, "0")}T12:00:00Z`;
      const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", `day ${day}`], {
        cwd: remote.checkout, env: { ...remote.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, stdout: "ignore", stderr: "ignore",
      });
      expect(await child.exited).toBe(0);
      await remote.git(remote.checkout, "update-ref", privatePullRequestRef(day), "HEAD");
    }
    expect(await listPullRequestRefs(remote.checkout)).toHaveLength(22);
    // #5 is closed; #1 (the oldest) is the one just fetched.
    const deleted = await prunePullRequestRefs(remote.checkout, { protect: [1], closed: [5] });
    const left = (await listPullRequestRefs(remote.checkout)).map(ref => ref.number).sort((a, b) => a - b);
    expect(left).toHaveLength(20);
    expect(left).toContain(1);
    expect(left).not.toContain(5);
    expect(deleted).toHaveLength(2);
    expect(deleted).toContain(5);
  });
});

