import { describe, expect, test } from "bun:test";

import {
  initialWorktreeBase,
  localTrackingBranch,
  validWorktreeBranch,
  worktreeDestinationCandidates,
  worktreeFolderName,
} from "./worktree-branches";

describe("branch names", () => {
  test("accepts ordinary branch spellings, slashes included", () => {
    for (const branch of ["main", "feature/login", "release-2.1", "user/fix_1", "功能/登录"]) {
      expect(`${branch}:${validWorktreeBranch(branch)}`).toBe(`${branch}:true`);
    }
  });

  test("rejects option-like, revision and traversal spellings", () => {
    for (const branch of ["", "-f", "--force", "-", "@", "/leading", "a//b", "a..b", "a@{0}", "a b", "a~1", "a^", "a:b", "a?", "a*", "a\\b", "a[", "trailing/", "trailing.", ".hidden", "x/.hidden", "x.lock", "a\u0000b"]) {
      expect(`${JSON.stringify(branch)}:${validWorktreeBranch(branch)}`).toBe(`${JSON.stringify(branch)}:false`);
    }
  });
});

describe("initial Create from base", () => {
  test("prefers local main, then the sole remote main, never the current checkout", () => {
    expect(initialWorktreeBase(["feature/current", "main"], ["origin/main"])).toBe("local:main");
    expect(initialWorktreeBase(["feature/current"], ["origin/main", "origin/release"])).toBe("remote:origin/main");
  });

  test("leaves ambiguous or absent mains unselected", () => {
    expect(initialWorktreeBase(["feature/current"], ["origin/main", "upstream/main"])).toBe("");
    expect(initialWorktreeBase(["feature/current"], ["origin/release"])).toBe("");
  });
});

describe("remote tracking names", () => {
  test("removes only the remote prefix", () => {
    expect(localTrackingBranch("origin/feature/login")).toBe("feature/login");
    expect(localTrackingBranch("upstream/release")).toBe("release");
    expect(localTrackingBranch("release")).toBe("release");
  });
});

describe("predetermined destinations", () => {
  test("sanitizes only the folder, never the branch", () => {
    expect(worktreeFolderName("feature/login")).toBe("feature-login");
    expect(worktreeFolderName("Feature/Login")).toBe("feature-login");
    expect(worktreeDestinationCandidates("/repos/atlas", "feature/login")[0]).toBe("/repos/atlas.worktrees/feature-login");
  });

  test("a unicode or exotic branch still yields a usable folder", () => {
    expect(worktreeFolderName("功能/登录")).toBe("branch");
    expect(worktreeFolderName("--weird")).toBe("weird");
    expect(worktreeFolderName("x".repeat(200)).length).toBe(100);
  });

  test("two branches that sanitize alike get deterministic distinct fallbacks", () => {
    const [first, firstFallback] = worktreeDestinationCandidates("/repos/atlas", "feature/login");
    const [second, secondFallback] = worktreeDestinationCandidates("/repos/atlas", "feature-login");
    expect(second).toBe(first);
    expect(secondFallback).not.toBe(firstFallback);
    expect(worktreeDestinationCandidates("/repos/atlas", "feature/login")[1]).toBe(firstFallback);
  });

  test("the destination is a sibling of the main folder, on either separator", () => {
    expect(worktreeDestinationCandidates("/repos/atlas/", "release")[0]).toBe("/repos/atlas.worktrees/release");
    expect(worktreeDestinationCandidates("C:\\repos\\atlas", "release")[0]).toBe("C:\\repos\\atlas.worktrees\\release");
  });
});
