import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveCompareBase, safeGit, withGitCancellation } from "./git-base-ref";

const tempDirectories: string[] = [];

test("cancellation interrupts owned Git work without affecting another caller", async () => {
  const controller = new AbortController();
  // This command waits for stdin, so completion depends on cancellation,
  // rather than on guessing how long a fast Git command takes.
  const pending = withGitCancellation(controller.signal, () => safeGit(process.cwd(), ["hash-object", "--stdin"]));
  controller.abort(new Error("session stopped"));
  await expect(pending).rejects.toThrow("session stopped");
  expect((await safeGit(process.cwd(), ["--version"])).ok).toBe(true);
});

test("reading status leaves the index untouched, so the repository probe sees no change", async () => {
  const repo = await createRepo({ initialBranch: "main" });
  const index = path.join(repo, ".git", "index");
  const fingerprint = async () => { const s = await stat(index); return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; };
  // A touched-but-unchanged file is the stat refresh `git status` would cache.
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(repo, "README.md"), later, later);
  const before = await fingerprint();
  expect((await safeGit(repo, ["status", "--porcelain=v1"])).ok).toBe(true);
  expect(await fingerprint()).toBe(before);
  // Control: the same command with optional locks allowed rewrites the index.
  const env = { ...process.env };
  delete env.GIT_OPTIONAL_LOCKS;
  execFileSync("git", ["status", "--porcelain=v1"], { cwd: repo, env });
  expect(await fingerprint()).not.toBe(before);
});

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("resolveCompareBase", () => {
  test("returns dirty-worktree-only when no base is resolvable", async () => {
    const repo = await createRepo({ initialBranch: "feature" });

    const base = await resolveCompareBase(repo);

    expect(base.mode).toBe("dirty-worktree-only");
    expect(base.ref).toBe("HEAD");
    expect(base.mergeBase).toBeNull();
  });

  test("uses origin/HEAD when set as the remote default", async () => {
    const repo = await createRepo({ initialBranch: "main" });
    // Simulate a remote default branch by fabricating refs/remotes/origin/HEAD
    // and refs/remotes/origin/main pointing at the current HEAD.
    const head = (await safeGit(repo, ["rev-parse", "HEAD"])).ok
      ? (await safeGit(repo, ["rev-parse", "HEAD"])).stdout.trim()
      : "";
    await safeGit(repo, ["update-ref", "refs/remotes/origin/main", head]);
    await safeGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const base = await resolveCompareBase(repo);

    expect(base.mode).toBe("remote-default");
    expect(base.ref).toBe("origin/main");
  });

  test("falls back to origin/main when origin/HEAD is unset but origin/main exists", async () => {
    const repo = await createRepo({ initialBranch: "feature" });
    const head = (await safeGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await safeGit(repo, ["update-ref", "refs/remotes/origin/main", head]);

    const base = await resolveCompareBase(repo);

    expect(base.mode).toBe("fallback");
    expect(base.ref).toBe("origin/main");
  });

  test("falls back to origin/master when neither origin/HEAD nor origin/main exists", async () => {
    const repo = await createRepo({ initialBranch: "feature" });
    const head = (await safeGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await safeGit(repo, ["update-ref", "refs/remotes/origin/master", head]);

    const base = await resolveCompareBase(repo);

    expect(base.mode).toBe("fallback");
    expect(base.ref).toBe("origin/master");
  });

  test("falls back to local main when no remote refs exist", async () => {
    const repo = await createRepo({ initialBranch: "feature" });
    const head = (await safeGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await safeGit(repo, ["update-ref", "refs/heads/main", head]);

    const base = await resolveCompareBase(repo);

    expect(base.mode).toBe("fallback");
    expect(base.ref).toBe("main");
  });

  test("falls back to local master as the last priority step", async () => {
    const repo = await createRepo({ initialBranch: "feature" });
    const head = (await safeGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await safeGit(repo, ["update-ref", "refs/heads/master", head]);

    const base = await resolveCompareBase(repo);

    expect(base.mode).toBe("fallback");
    expect(base.ref).toBe("master");
  });
});

async function createRepo({ initialBranch }: { initialBranch: string }): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-base-ref-"));
  tempDirectories.push(repo);
  await safeGit(repo, ["init", `--initial-branch=${initialBranch}`]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", "Uatu Test"]);
  await writeFile(path.join(repo, "README.md"), "# Readme\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  return repo;
}
