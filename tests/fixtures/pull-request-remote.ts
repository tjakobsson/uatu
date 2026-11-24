// A local stand-in for a GitHub repository, for tests of the pull request
// file view's Git side (add-github-pr-review D7/D17): a bare remote whose
// `refs/pull/<n>/head` refs are pushed by a contributor clone, exactly the
// refs GitHub publishes, and a clone whose `origin` reads as
// `git@github.com:acme/widgets.git` (the transport fake's repository) while
// `url.<bare>.insteadOf` sends every fetch to the bare remote. No network:
// nothing here ever reaches github.com.
//
// Git runs in a clean environment (no global or system config, a private
// HOME), never the one a Hub-managed development workspace projects.

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const GITHUB_ORIGIN = "git@github.com:acme/widgets.git";

export type PullRequestRemote = {
  // The bare remote ("GitHub") and a contributor clone that makes commits.
  bare: string;
  contributor: string;
  // The reviewer's checkout, with `origin` at GITHUB_ORIGIN.
  checkout: string;
  env: Record<string, string>;
  git: (cwd: string, ...args: string[]) => Promise<string>;
  // Commits files on the contributor's current branch; answers the commit.
  commit: (files: Record<string, string | Uint8Array | null>, message?: string) => Promise<string>;
  // Publishes a commit as `refs/pull/<n>/head` on the bare remote.
  publishPullRequest: (number: number, oid: string) => Promise<void>;
  cleanup: () => void;
};

export async function createPullRequestRemote(): Promise<PullRequestRemote> {
  const root = mkdtempSync(path.join(os.tmpdir(), "uatu-pr-remote-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Uatu Test",
    GIT_AUTHOR_EMAIL: "uatu@example.test",
    GIT_COMMITTER_NAME: "Uatu Test",
    GIT_COMMITTER_EMAIL: "uatu@example.test",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
      cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    return stdout.trim();
  };
  const bare = path.join(root, "github.git");
  const contributor = path.join(root, "contributor");
  const checkout = path.join(root, "checkout");
  await git(root, "init", "--bare", bare);
  await git(root, "clone", "--quiet", bare, contributor);
  const commit = async (files: Record<string, string | Uint8Array | null>, message = "change") => {
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(contributor, file);
      if (contents === null) {
        await git(contributor, "rm", "--quiet", "--", file);
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
      await git(contributor, "add", "--", file);
    }
    await git(contributor, "commit", "--quiet", "--allow-empty", "-m", message);
    return git(contributor, "rev-parse", "HEAD");
  };
  await commit({ "README.md": "# widgets\n", "docs/guide.md": "# Guide\n\nFirst.\n" }, "initial");
  await git(contributor, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  await git(root, "clone", "--quiet", bare, checkout);
  await git(checkout, "remote", "set-url", "origin", GITHUB_ORIGIN);
  await git(checkout, "config", `url.${bare}.insteadOf`, GITHUB_ORIGIN);
  return {
    bare,
    contributor,
    checkout,
    env,
    git,
    commit,
    // Pushed as GitHub would hold it: the commit, and the pull request ref.
    publishPullRequest: async (number, oid) => { await git(contributor, "push", "--quiet", "--force", "origin", `${oid}:refs/pull/${number}/head`); },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Everything a fetch must leave alone: HEAD, the index, the working tree,
// local branches and remote-tracking refs (and FETCH_HEAD's absence).
export async function checkoutFingerprint(remote: PullRequestRemote): Promise<string> {
  const { git, checkout } = remote;
  const fetchHead = await Bun.file(path.join(checkout, ".git", "FETCH_HEAD")).exists();
  return [
    await git(checkout, "rev-parse", "HEAD"),
    await git(checkout, "symbolic-ref", "--quiet", "HEAD").catch(() => "detached"),
    await git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
    await git(checkout, "ls-files", "--stage"),
    await git(checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"),
    `FETCH_HEAD ${fetchHead}`,
  ].join("\n");
}

export async function writeFileIn(directory: string, file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await writeFile(path.join(directory, file), contents);
}
