// Which GitHub repository a checkout belongs to, and what its branch says
// about its pull request (design D3, D4). Everything here is derived
// server-side from Git, never from client input.
//
// - Remote URLs: scp-like SSH (`git@host:owner/name.git`), `ssh://`,
//   `https://` and `git://`, with or without `.git`.
// - Base repository: the remote `gh repo set-default` marked
//   (`remote.<name>.gh-resolved = base`), then `upstream`, then `origin`.
// - Hosts: github.com and ghe.com (GitHub Enterprise Cloud with data
//   residency) always count; any other host only when `gh` is signed in to it
//   (GitHub Enterprise Server), which the caller decides.
// - Branch facts: the branch, HEAD, and its upstream (`branch.<b>.remote`,
//   `branch.<b>.merge`). An upstream of `refs/pull/<n>/head` names pull
//   request <n> outright (fork checkouts, `gh pr checkout`).

import { safeGit } from "../document/git-base-ref";
import type { GithubRepositoryRef } from "../shared/github-contract";

export type RemoteRepository = GithubRepositoryRef & { remote: string };

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

// Host, owner and name from a remote URL, or null for anything else (a local
// path, a URL with a deeper path, a host with a port we can't map).
export function parseRemoteUrl(url: string): GithubRepositoryRef | null {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  host = host.toLowerCase();
  // `ssh.github.com` (port 443 SSH) is github.com.
  if (host === "ssh.github.com") host = "github.com";
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === "." || name === "..") return null;
  return { host, owner, name };
}

export function isAlwaysGithubHost(host: string): boolean {
  return host === "github.com" || host === "ghe.com" || host.endsWith(".ghe.com");
}

export type RepositoryGitFacts = {
  // remote name → fetch URL
  remotes: Map<string, string>;
  // The remote `gh repo set-default` resolved as the base, if any.
  ghResolvedBase: string | null;
  branch: string | null;
  detached: boolean;
  headOid: string | null;
  upstreamRemote: string | null;
  upstreamMerge: string | null;
};

// The base repository's remote: gh-resolved, then upstream, then origin.
export function baseRemoteName(facts: Pick<RepositoryGitFacts, "remotes" | "ghResolvedBase">): string | null {
  for (const name of [facts.ghResolvedBase, "upstream", "origin"]) {
    if (name && facts.remotes.has(name)) return name;
  }
  return null;
}

export type DetectionInput =
  | { kind: "detached" }
  | { kind: "number"; number: number }
  | { kind: "head"; headRefName: string; headOwner: string };

// What to look for (design D4). `upstreamRepository` is the upstream remote's
// repository when it is on the base's host.
export function detectionInput(
  facts: Pick<RepositoryGitFacts, "branch" | "detached" | "upstreamMerge">,
  base: GithubRepositoryRef,
  upstreamRepository: GithubRepositoryRef | null,
): DetectionInput {
  if (facts.detached || !facts.branch) return { kind: "detached" };
  const pull = /^refs\/pull\/(\d{1,9})\/head$/.exec(facts.upstreamMerge ?? "");
  if (pull) return { kind: "number", number: Number(pull[1]) };
  const upstreamBranch = facts.upstreamMerge?.startsWith("refs/heads/") ? facts.upstreamMerge.slice("refs/heads/".length) : null;
  const headOwner = upstreamRepository && upstreamRepository.host === base.host ? upstreamRepository.owner : base.owner;
  return { kind: "head", headRefName: upstreamBranch || facts.branch, headOwner };
}

// One key for everything detection depends on: a change in any of them
// re-detects, nothing else does.
export function detectionKey(facts: RepositoryGitFacts, base: RemoteRepository | null): string {
  return [base ? `${base.host}/${base.owner}/${base.name}` : "", facts.branch ?? "", facts.detached ? "detached" : "", facts.headOid ?? "", facts.upstreamRemote ?? "", facts.upstreamMerge ?? ""].join("\n");
}

// Reads the facts with three local Git calls (no network).
export async function readRepositoryGitFacts(root: string): Promise<RepositoryGitFacts | null> {
  const [config, symbolic, head] = await Promise.all([
    safeGit(root, ["config", "-z", "--get-regexp", "^(remote\\..+\\.(url|gh-resolved)|branch\\..+\\.(remote|merge))$"]),
    safeGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    safeGit(root, ["rev-parse", "--quiet", "--verify", "HEAD"]),
  ]);
  // `config --get-regexp` exits 1 when nothing matches; anything else is a
  // broken repository.
  if (!config.ok && config.stdout !== "") return null;
  const entries = parseConfigZ(config.ok ? config.stdout : "");
  const remotes = new Map<string, string>();
  let ghResolvedBase: string | null = null;
  for (const [key, value] of entries) {
    const remote = /^remote\.(.+)\.(url|gh-resolved)$/.exec(key);
    if (!remote) continue;
    if (remote[2] === "url" && !remotes.has(remote[1]!)) remotes.set(remote[1]!, value);
    if (remote[2] === "gh-resolved" && value === "base") ghResolvedBase = remote[1]!;
  }
  const branch = symbolic.ok ? symbolic.stdout.trim() || null : null;
  const lookup = (suffix: string) => (branch ? entries.find(([key]) => key === `branch.${branch}.${suffix}`)?.[1] ?? null : null);
  return {
    remotes,
    ghResolvedBase,
    branch,
    detached: branch === null,
    headOid: head.ok ? head.stdout.trim() || null : null,
    upstreamRemote: lookup("remote"),
    upstreamMerge: lookup("merge"),
  };
}

// `git config -z` output: `key\nvalue\0` per entry. Keys are lowercased by Git
// except for the subsection (remote and branch names), which keeps its case.
export function parseConfigZ(output: string): [string, string][] {
  return output.split("\0").filter(Boolean).map(entry => {
    const newline = entry.indexOf("\n");
    return newline < 0 ? [entry, ""] : [entry.slice(0, newline), entry.slice(newline + 1)];
  });
}
