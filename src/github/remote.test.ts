import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeGit } from "../document/git-base-ref";
import { baseRemoteName, detectionInput, parseConfigZ, parseRemoteUrl, readRepositoryGitFacts } from "./remote";

describe("parseRemoteUrl", () => {
  test.each([
    ["git@github.com:acme/widgets.git", "github.com"],
    ["git@github.com:acme/widgets", "github.com"],
    ["ssh://git@github.com/acme/widgets.git", "github.com"],
    ["ssh://git@ssh.github.com:443/acme/widgets.git", "github.com"],
    ["https://github.com/acme/widgets.git", "github.com"],
    ["https://github.com/acme/widgets", "github.com"],
    ["https://user@github.com/acme/widgets/", "github.com"],
    ["git://github.com/acme/widgets.git", "github.com"],
    ["https://GHE.Example.com/acme/widgets.git", "ghe.example.com"],
    ["git@acme.ghe.com:acme/widgets.git", "acme.ghe.com"],
  ])("%s", (url, host) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner: "acme", name: "widgets" });
  });

  test.each([
    "/srv/git/widgets.git",
    "../widgets",
    "file:///srv/git/acme/widgets.git",
    "https://github.com/acme",
    "https://github.com/acme/widgets/tree/main",
    "https://github.com/acme/..",
    "C:\\repos\\widgets",
  ])("rejects %s", url => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});

describe("baseRemoteName", () => {
  const remotes = (...names: string[]) => new Map(names.map(name => [name, `git@github.com:${name}/widgets.git`]));
  test("gh repo set-default wins, then upstream, then origin", () => {
    expect(baseRemoteName({ remotes: remotes("origin", "upstream", "fork"), ghResolvedBase: "fork" })).toBe("fork");
    expect(baseRemoteName({ remotes: remotes("origin", "upstream"), ghResolvedBase: null })).toBe("upstream");
    expect(baseRemoteName({ remotes: remotes("origin"), ghResolvedBase: null })).toBe("origin");
    expect(baseRemoteName({ remotes: remotes("mine"), ghResolvedBase: null })).toBeNull();
    expect(baseRemoteName({ remotes: remotes("origin"), ghResolvedBase: "gone" })).toBe("origin");
  });
});

describe("detectionInput", () => {
  const base = { host: "github.com", owner: "acme", name: "widgets" };
  test("a detached HEAD has no pull request", () => {
    expect(detectionInput({ branch: null, detached: true, upstreamMerge: null }, base, null)).toEqual({ kind: "detached" });
  });
  test("an upstream of refs/pull/<n>/head names the number", () => {
    expect(detectionInput({ branch: "pr/57", detached: false, upstreamMerge: "refs/pull/57/head" }, base, base)).toEqual({ kind: "number", number: 57 });
  });
  test("the upstream branch name and its remote's owner (a fork) are the head", () => {
    const fork = { host: "github.com", owner: "me", name: "widgets" };
    expect(detectionInput({ branch: "login", detached: false, upstreamMerge: "refs/heads/feature/login" }, base, fork))
      .toEqual({ kind: "head", headRefName: "feature/login", headOwner: "me" });
  });
  test("without an upstream, the local name and the base owner", () => {
    expect(detectionInput({ branch: "feature/login", detached: false, upstreamMerge: null }, base, null))
      .toEqual({ kind: "head", headRefName: "feature/login", headOwner: "acme" });
  });
});

describe("readRepositoryGitFacts", () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  async function repository(): Promise<string> {
    const root = mkdtempSync(path.join(os.tmpdir(), "uatu-github-remote-"));
    roots.push(root);
    const git = (...args: string[]) => safeGit(root, args);
    await git("init", "--initial-branch=main");
    await git("config", "user.email", "t@example.test");
    await git("config", "user.name", "T");
    await git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init");
    return root;
  }

  test("reads remotes, gh-resolved, the branch and its upstream with no network", async () => {
    const root = await repository();
    await safeGit(root, ["remote", "add", "origin", "git@github.com:me/widgets.git"]);
    await safeGit(root, ["remote", "add", "Upstream-Two", "https://github.com/acme/widgets.git"]);
    await safeGit(root, ["config", "remote.Upstream-Two.gh-resolved", "base"]);
    await safeGit(root, ["checkout", "-b", "Feature/Login"]);
    await safeGit(root, ["config", "branch.Feature/Login.remote", "origin"]);
    await safeGit(root, ["config", "branch.Feature/Login.merge", "refs/heads/feature/login"]);
    const facts = (await readRepositoryGitFacts(root))!;
    expect([...facts.remotes.keys()].sort()).toEqual(["Upstream-Two", "origin"]);
    expect(facts.ghResolvedBase).toBe("Upstream-Two");
    expect(baseRemoteName(facts)).toBe("Upstream-Two");
    expect(facts.branch).toBe("Feature/Login");
    expect(facts.detached).toBe(false);
    expect(facts.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(facts.upstreamRemote).toBe("origin");
    expect(facts.upstreamMerge).toBe("refs/heads/feature/login");
  });

  test("a repository with no remotes and a detached HEAD", async () => {
    const root = await repository();
    await safeGit(root, ["checkout", "--detach"]);
    const facts = (await readRepositoryGitFacts(root))!;
    expect(facts.remotes.size).toBe(0);
    expect(facts.detached).toBe(true);
    expect(facts.branch).toBeNull();
  });

  test("parseConfigZ splits key and value", () => {
    expect(parseConfigZ("remote.origin.url\ngit@github.com:a/b.git\0branch.x.merge\nrefs/heads/x\0")).toEqual([
      ["remote.origin.url", "git@github.com:a/b.git"],
      ["branch.x.merge", "refs/heads/x"],
    ]);
  });
});
