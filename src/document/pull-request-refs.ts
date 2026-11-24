// The explicit, narrow fetch of a pull request's head (add-github-pr-review
// D7, as narrowed by D17) and the private refs it keeps. The only Git write
// the session child makes, and only when the reviewer asks for it:
//
//   git -c fetch.fsckObjects=true fetch --no-tags --no-write-fetch-head
//       --no-recurse-submodules --refmap= [--depth=1] -- <remote>
//       +refs/pull/<n>/head:refs/uatu/pull/<n>/head
//       [+refs/heads/<base>:refs/remotes/<remote>/<base>]
//
// - It runs with the session's own Git credentials (the environment the Hub
//   projected into this child, or the user's own outside a Hub) and never
//   prompts: GIT_TERMINAL_PROMPT=0, and SSH in batch mode unless the
//   session's SSH command is projected.
// - It writes objects, the private ref and, only when the base commit isn't
//   local, the base's remote-tracking ref. Never the working tree, the index,
//   a local branch, another remote-tracking ref or FETCH_HEAD.
// - A shallow repository fetches with --depth=1.
// - `refs/uatu/*` is outside every refspec, so `git fetch --prune` leaves it
//   alone. At most PULL_REQUEST_REF_LIMIT are kept per repository: after a
//   fetch, the refs of pull requests known to be merged or closed go, then
//   the oldest (by their head commit's date) until the limit holds.

import { spawn } from "node:child_process";

import { classifyGitFetchFailure } from "../shared/git-fetch-failure";
import { pullRequestHeadRef } from "../shared/worktree-branches";
import { safeGit } from "./git-base-ref";
import { isObjectId } from "./git-objects";

export const PULL_REQUEST_REF_LIMIT = 20;
export const PULL_REQUEST_FETCH_TIMEOUT_MS = 120_000;
export const PRIVATE_PULL_REQUEST_REF_PREFIX = "refs/uatu/pull/";

export function privatePullRequestRef(number: number): string {
  return `${PRIVATE_PULL_REQUEST_REF_PREFIX}${number}/head`;
}

export type PullRequestFetchFailure = "missing-ref" | "no-credential" | "network" | "timeout" | "invalid" | "failed";

export type PullRequestFetchOutcome =
  | { ok: true; headOid: string | null; fetchedHead: boolean; fetchedBase: boolean }
  | { ok: false; failure: PullRequestFetchFailure; message: string };

export type PullRequestFetchInput = {
  repoRoot: string;
  remote: string;
  number: number;
  // Fetch the head into the private ref (false: it is already local).
  head: boolean;
  // Also fetch this base branch into its remote-tracking ref.
  baseRefName?: string | null;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

// A remote name from the repository's own config, still checked as an
// argument: it follows `--`, but never as an option or a refspec.
function safeRemote(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes("..");
}

// GitHub's base branch name, checked before it becomes part of a refspec.
async function safeBranch(repoRoot: string, name: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-") || name.includes(":")) return false;
  const result = await safeGit(repoRoot, ["check-ref-format", "--branch", name]);
  return result.ok;
}

export async function isShallowRepository(repoRoot: string): Promise<boolean> {
  const result = await safeGit(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  return result.ok && result.stdout.trim() === "true";
}

// The session's environment, made non-interactive. A projected SSH command
// (the Hub's wrapper) is kept; without one, ssh runs in batch mode.
export function pullRequestFetchEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return {
    ...source,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
    LC_ALL: "C",
    ...(source.GIT_SSH_COMMAND || source.GIT_SSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
  };
}

export async function fetchPullRequestRefs(input: PullRequestFetchInput): Promise<PullRequestFetchOutcome> {
  const { repoRoot, remote, number } = input;
  if (!Number.isInteger(number) || number < 1 || !safeRemote(remote)) {
    return { ok: false, failure: "invalid", message: "That pull request or remote can't be fetched." };
  }
  const refspecs: string[] = [];
  if (input.head) refspecs.push(`+${pullRequestHeadRef(number)}:${privatePullRequestRef(number)}`);
  const base = input.baseRefName ?? null;
  if (base !== null) {
    if (!(await safeBranch(repoRoot, base))) return { ok: false, failure: "invalid", message: `The base branch name ${base} can't be fetched.` };
    refspecs.push(`+refs/heads/${base}:refs/remotes/${remote}/${base}`);
  }
  if (refspecs.length === 0) return { ok: true, headOid: await privateHead(repoRoot, number), fetchedHead: false, fetchedBase: false };
  const shallow = await isShallowRepository(repoRoot);
  const args = [
    "-c", "fetch.fsckObjects=true",
    // --refmap= keeps the remote's configured refspecs out of it: only the
    // destinations named here are written.
    "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=",
    ...(shallow ? ["--depth=1"] : []),
    "--", remote, ...refspecs,
  ];
  const result = await runFetch(repoRoot, args, pullRequestFetchEnvironment(input.env), input.timeoutMs ?? PULL_REQUEST_FETCH_TIMEOUT_MS);
  if (result.timedOut) {
    return { ok: false, failure: "timeout", message: `Fetching #${number} from ${remote} took longer than ${Math.round((input.timeoutMs ?? PULL_REQUEST_FETCH_TIMEOUT_MS) / 1000)} s and was stopped; the repository may be too large to fetch here.` };
  }
  if (result.code !== 0) {
    const kind = classifyGitFetchFailure(result.stderr, { namedRef: true });
    // Which refspec was missing: the head (the usual case) or the base.
    if (kind === "missing-ref") {
      const baseMissing = base !== null && result.stderr.includes(`refs/heads/${base}`);
      return {
        ok: false,
        failure: "missing-ref",
        message: baseMissing
          ? `${remote} has no branch ${base}, the pull request's base.`
          : `${remote} doesn't publish #${number}'s head (${pullRequestHeadRef(number)}); it may not be the pull request's GitHub repository.`,
      };
    }
    if (kind === "authentication") {
      return { ok: false, failure: "no-credential", message: `Git couldn't sign in to ${remote}: this session has no Git credential that ${remote} accepts.` };
    }
    if (kind === "network") return { ok: false, failure: "network", message: `Git couldn't reach ${remote}. Check the connection and try again.` };
    return { ok: false, failure: "failed", message: `Git couldn't fetch #${number} from ${remote}.` };
  }
  return { ok: true, headOid: input.head ? await privateHead(repoRoot, number) : null, fetchedHead: input.head, fetchedBase: base !== null };
}

async function privateHead(repoRoot: string, number: number): Promise<string | null> {
  const resolved = await safeGit(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${privatePullRequestRef(number)}^{commit}`]);
  const oid = resolved.ok ? resolved.stdout.trim() : "";
  return isObjectId(oid) ? oid : null;
}

export type PrivatePullRequestRef = { number: number; oid: string; committedAt: number };

export async function listPullRequestRefs(repoRoot: string): Promise<PrivatePullRequestRef[]> {
  const result = await safeGit(repoRoot, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(committerdate:unix)", PRIVATE_PULL_REQUEST_REF_PREFIX]);
  if (!result.ok) return [];
  const refs: PrivatePullRequestRef[] = [];
  for (const line of result.stdout.split("\n")) {
    const [name = "", oid = "", date = ""] = line.split("\t");
    const number = /^refs\/uatu\/pull\/(\d+)\/head$/.exec(name)?.[1];
    if (number) refs.push({ number: Number(number), oid, committedAt: Number(date) || 0 });
  }
  return refs;
}

// Keeps at most `limit` private refs: first drops the `closed` pull
// requests' refs, then the oldest, never `protect`. Answers the numbers
// whose refs were deleted.
export async function prunePullRequestRefs(repoRoot: string, options: { protect: readonly number[]; closed?: readonly number[]; limit?: number }): Promise<number[]> {
  const limit = options.limit ?? PULL_REQUEST_REF_LIMIT;
  const refs = await listPullRequestRefs(repoRoot);
  const protect = new Set(options.protect);
  const closed = new Set(options.closed ?? []);
  const drop = new Set(refs.filter(ref => closed.has(ref.number) && !protect.has(ref.number)).map(ref => ref.number));
  const remaining = refs.filter(ref => !drop.has(ref.number)).sort((a, b) => a.committedAt - b.committedAt || a.number - b.number);
  let excess = remaining.length - limit;
  for (const ref of remaining) {
    if (excess <= 0) break;
    if (protect.has(ref.number)) continue;
    drop.add(ref.number);
    excess -= 1;
  }
  if (drop.size === 0) return [];
  const input = [...drop].map(number => `delete ${privatePullRequestRef(number)}\n`).join("");
  const result = await safeGit(repoRoot, ["update-ref", "--stdin"], { input });
  return result.ok ? [...drop].sort((a, b) => a - b) : [];
}

function runFetch(cwd: string, args: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let stderr = "";
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8"); });
    child.on("error", error => { stderr += String(error); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}
