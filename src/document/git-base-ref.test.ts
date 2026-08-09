import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveCompareBase, safeGit } from "./git-base-ref";

const tempDirectories: string[] = [];

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
