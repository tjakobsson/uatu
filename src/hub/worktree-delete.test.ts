import { describe, expect, test } from "bun:test";

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
