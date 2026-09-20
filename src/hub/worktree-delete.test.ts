import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitRunner, listWorktrees } from "./worktree-git";
import { inspectRemovalSafety } from "./worktree-delete";

test.each(["index.lock", "rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_START"])("operation marker %s blocks an otherwise clean checkout", async marker => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-delete-marker-"));
  try {
    if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker)) await mkdir(path.join(root, marker));
    else await writeFile(path.join(root, marker), "state");
    const result = await inspectRemovalSafety({
      checkoutPath: root,
      records: [{ path: root, head: "abc", branch: "topic", bare: false, detached: false, locked: false, lockReason: null, prunable: false }],
      run: async args => ({ exitCode: 0, stdout: args[0] === "rev-parse" ? args.flatMap((arg, index) => arg === "--git-path" ? [path.join(root, args[index + 1]!)] : []).join("\n") + "\n" : "", stderr: "", timedOut: false, outputExceeded: false }),
    });
    expect(result?.detail.code).toBe("external-activity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean linked checkout paused at an interactive rebase edit cannot be removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-delete-rebase-"));
  const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_SEQUENCE_EDITOR: "sed -i.bak s/pick/edit/g" };
  const run = createGitRunner({ env });
  const git = async (args: string[], cwd = root) => {
    const result = await run(args, cwd);
    expect(result.exitCode).toBe(0);
    return result.stdout;
  };
  try {
    await git(["init", "--initial-branch=main"]);
    await git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"]);
    const checkout = path.join(root, "linked");
    await git(["worktree", "add", "-b", "topic", checkout]);
    await git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "topic"], checkout);
    await git(["rebase", "-i", "HEAD~1"], checkout);
    expect(await git(["status", "--porcelain"], checkout)).toBe("");
    const inventory = await listWorktrees(root, { env });
    if (inventory.kind !== "inventory") throw new Error("missing inventory");
    const canonical = (await git(["rev-parse", "--show-toplevel"], checkout)).trim();
    expect((await inspectRemovalSafety({ run, checkoutPath: canonical, records: inventory.records }))?.detail.code).toBe("external-activity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { buildWorktreeRemoveArguments, classifyWorktreeRemoveFailure, summarizePorcelainStatus } from "./worktree-delete";

describe("status summary", () => {
  test("counts tracked, untracked and ignored entries, skipping rename sources", () => {
    const output = [" M README.md", "R  new.md", "old.md", "?? scratch.txt", "!! .env.local", "!! build/", ""].join("\0");
    expect(summarizePorcelainStatus(output)).toEqual({ tracked: 2, untracked: 1, ignored: 2 });
    expect(summarizePorcelainStatus("")).toEqual({ tracked: 0, untracked: 0, ignored: 0 });
  });
});

describe("removal arguments", () => {
  test("are non-force, separator-guarded and absolute-only", () => {
    expect(buildWorktreeRemoveArguments("/repos/atlas.worktrees/feature-x")).toEqual(["worktree", "remove", "--", "/repos/atlas.worktrees/feature-x"]);
    expect(() => buildWorktreeRemoveArguments("relative/path")).toThrow();
    expect(() => buildWorktreeRemoveArguments("-f")).toThrow();
    expect(buildWorktreeRemoveArguments("/a").some(argument => argument === "--force" || argument === "-f")).toBe(false);
  });

  test("Git refusals map to the closed vocabulary with no path leaked", () => {
    expect(classifyWorktreeRemoveFailure("fatal: '/secret/tree' contains modified or untracked files, use --force to delete it").detail.code).toBe("local-data");
    expect(classifyWorktreeRemoveFailure("fatal: cannot remove a locked working tree").detail.code).toBe("git-lock");
    expect(classifyWorktreeRemoveFailure("fatal: working trees containing submodules cannot be moved or removed").detail.code).toBe("nested-dependency");
    expect(classifyWorktreeRemoveFailure("fatal: '/secret' is a main working tree").detail.code).toBe("ownership-required");
    const other = classifyWorktreeRemoveFailure("fatal: something at /home/someone/tree went wrong").detail;
    expect(other.code).toBe("conflict");
    expect(other.message).not.toContain("/home/");
  });
});
