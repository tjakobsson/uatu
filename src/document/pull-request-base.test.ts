// The pull request base override (add-github-pr-review D7, task 3.1) over a
// real repository: a pull request into `release/2.0` measured from GitHub's
// exact base commit, from a stale local `origin/release/2.0`, or, with
// neither local, from the default resolution, flagged; `last-commit`
// ignoring it; the diff's base cache following a new base; and the default
// again once the branch is switched away.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { createPullRequestRemote, type PullRequestRemote } from "../../tests/fixtures/pull-request-remote";
import type { DocumentMeta, RootGroup } from "../shared/types";
import { __resetDocumentDiffCachesForTests, getDocumentDiff } from "./diff";
import { resolveCompareBase } from "./git-base-ref";
import { collectRepositorySnapshotsByTarget } from "./git-data";
import { clearPullRequestBases, onPullRequestBaseChange, setPullRequestBase } from "./pull-request-base";

let remote: PullRequestRemote;
let root = "";
// main:        I ── M            (M: main-only.md, not in release/2.0)
// release/2.0: I ── R1 ── R2     (R2 is GitHub's base; local origin/release/2.0 is R1)
// feature:     R1 ── F           (F: feature.md; HEAD)
let release1 = "";
let release2 = "";
let git: (...args: string[]) => Promise<string>;

beforeEach(async () => {
  remote = await createPullRequestRemote();
  root = remote.checkout;
  git = (...args) => remote.git(root, ...args);
  const initial = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "-b", "release/2.0");
  await Bun.write(path.join(root, "release.md"), "release 1\n");
  await git("add", "release.md");
  await git("commit", "--quiet", "-m", "R1");
  release1 = await git("rev-parse", "HEAD");
  await Bun.write(path.join(root, "release.md"), "release 2\n");
  await git("commit", "--quiet", "-am", "R2");
  release2 = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "main");
  await Bun.write(path.join(root, "main-only.md"), "main\n");
  await git("add", "main-only.md");
  await git("commit", "--quiet", "-m", "M");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("checkout", "--quiet", "-b", "feature", release1);
  await Bun.write(path.join(root, "feature.md"), "feature\n");
  await git("add", "feature.md");
  await git("commit", "--quiet", "-m", "F");
  await git("update-ref", "refs/remotes/origin/release/2.0", release1);
  expect(initial).not.toBe(release1);
  __resetDocumentDiffCachesForTests();
  clearPullRequestBases();
});

afterEach(() => {
  clearPullRequestBases();
  remote.cleanup();
});

function pullRequestInto(baseRefOid: string, branch = "feature") {
  setPullRequestBase(root, { number: 42, remote: "origin", baseRefName: "release/2.0", baseRefOid, branch });
}

async function changedPaths(): Promise<{ base: string[]; last: string[] }> {
  const results = await collectRepositorySnapshotsByTarget([{ kind: "dir", absolutePath: root } as never], []);
  return {
    base: (results.base[0]?.changedFiles ?? []).map(file => file.path).sort(),
    last: (results["last-commit"][0]?.changedFiles ?? []).map(file => file.path).sort(),
  };
}

function rootsFor(relativePath: string, kind: DocumentMeta["kind"] = "markdown"): RootGroup[] {
  return [{ id: root, label: "checkout", path: root, hiddenCount: 0, docs: [{ id: path.join(root, relativePath), name: path.basename(relativePath), relativePath, mtimeMs: 0, rootId: root, kind }] }];
}

describe("the pull request base (D7)", () => {
  test("without a pull request the default resolution applies: origin/HEAD (origin/main)'s merge base shows the release commits", async () => {
    const base = await resolveCompareBase(root);
    expect(base).toMatchObject({ mode: "remote-default", ref: "origin/main" });
    expect(base.pullRequest).toBeUndefined();
    expect((await changedPaths()).base).toEqual(["feature.md", "release.md"]);
  });

  test("case 1: GitHub's base commit is local, so base measures from its exact merge base", async () => {
    pullRequestInto(release2);
    const base = await resolveCompareBase(root);
    expect(base).toMatchObject({ mode: "pull-request", ref: "origin/release/2.0", comparedAgainstRef: "origin/release/2.0", mergeBase: release1 });
    expect(base.pullRequest).toEqual({ number: 42, ref: "origin/release/2.0", state: "exact" });
    // Only the branch's own commit: release.md is the base's, and main's
    // commits never show.
    expect((await changedPaths()).base).toEqual(["feature.md"]);
  });

  test("case 2: only the local remote-tracking base is there, marked stale", async () => {
    pullRequestInto("f".repeat(40));
    const base = await resolveCompareBase(root);
    expect(base).toMatchObject({ mode: "pull-request", ref: "origin/release/2.0", mergeBase: release1 });
    expect(base.pullRequest).toEqual({ number: 42, ref: "origin/release/2.0", state: "stale" });
  });

  test("case 3: neither is local, so the default resolution applies, flagged missing", async () => {
    await git("update-ref", "-d", "refs/remotes/origin/release/2.0");
    pullRequestInto("f".repeat(40));
    const base = await resolveCompareBase(root);
    expect(base).toMatchObject({ mode: "remote-default", ref: "origin/main" });
    expect(base.pullRequest).toEqual({ number: 42, ref: "origin/release/2.0", state: "missing" });
  });

  test("last-commit ignores the pull request", async () => {
    pullRequestInto(release2);
    await Bun.write(path.join(root, "feature.md"), "feature, edited\n");
    expect((await changedPaths()).last).toEqual(["feature.md"]);
    const diff = await getDocumentDiff(rootsFor("feature.md"), path.join(root, "feature.md"), "last-commit");
    expect(diff).toMatchObject({ kind: "text", baseRef: "HEAD" });
  });

  test("switching away from the pull request's branch falls back at once", async () => {
    pullRequestInto(release2);
    expect((await resolveCompareBase(root)).mode).toBe("pull-request");
    await git("checkout", "--quiet", "-b", "elsewhere");
    const base = await resolveCompareBase(root);
    expect(base).toMatchObject({ mode: "remote-default", ref: "origin/main" });
    expect(base.pullRequest).toBeUndefined();
  });

  test("the document diff's cached base follows a new pull request base without HEAD moving", async () => {
    const roots = rootsFor("release.md");
    const file = path.join(root, "release.md");
    // Default base: release.md is new since origin/main's merge base.
    expect(await getDocumentDiff(roots, file)).toMatchObject({ kind: "text", baseRef: "origin/main" });
    pullRequestInto(release2);
    // Same HEAD, new base: release.md is the base's own file now.
    expect(await getDocumentDiff(roots, file)).toMatchObject({ kind: "unchanged", baseRef: "origin/release/2.0" });
    clearPullRequestBases();
    expect(await getDocumentDiff(roots, file)).toMatchObject({ kind: "text", baseRef: "origin/main" });
  });

  test("listeners hear only a change of association or base", () => {
    const heard: string[] = [];
    const stop = onPullRequestBaseChange(changed => heard.push(changed));
    try {
      pullRequestInto(release2);
      pullRequestInto(release2);
      pullRequestInto(release1);
      setPullRequestBase(root, null);
      setPullRequestBase(root, null);
    } finally {
      stop();
    }
    expect(heard).toEqual([root, root, root]);
  });
});
