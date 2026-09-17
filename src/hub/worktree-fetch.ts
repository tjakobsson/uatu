// Explicit, credential-aware remote fetch for the worktree branch selector
// (task 4.2).
//
// The rule that shapes this module: the ONLY credential a fetch may use is
// the one the parent workspace's policy selects for that remote's host.
// There is no ambient fallback and no unselected fallback — not the Hub
// user's ~/.ssh identities, not ~/.netrc, not a global credential helper,
// not an inherited SSH_AUTH_SOCK, not an interactive prompt. A remote with
// no parent selection is fetched with credentials switched OFF, so a
// private remote fails with an actionable authentication error instead of
// quietly succeeding through whatever the daemon user happens to have.
//
// Freshness is reported, never assumed: a successful fetch stamps the
// listing, and every failure leaves the previous stamp and the cached refs
// exactly as they were (design §3: "Selecting a cached remote does not claim
// network freshness").

import {
  parseCloneRemote,
  stripAmbientCredentialEnvironment,
  type CloneCredentialProcessContext,
} from "./credential-context";
import type { CredentialAssignment } from "./credential-types";
import { WorktreeOperationError, type WorktreeError } from "../shared/worktree-contract";
import { assertGitArgumentSafe, createGitRunner, type GitRunner, type WorktreeGitOptions } from "./worktree-git";

export type WorktreeRemote = { readonly name: string; readonly url: string };

// The bounded spawn a fetch shares with every other Git probe — one
// timeout, one output cap, one process-group kill — with the fetch's own
// credential environment substituted per invocation.
export function createWorktreeFetchRunner(options: Omit<WorktreeGitOptions, "env" | "run"> = {}) {
  return (args: readonly string[], cwd: string, env: Record<string, string>) => createGitRunner({ ...options, env })(args, cwd);
}

// What the parent's policy says about ONE remote. "none" is a decision, not
// a gap: it runs the fetch with credentials disabled.
export type WorktreeFetchSelection =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly credentialId: string; readonly process: CloneCredentialProcessContext };

export interface WorktreeFetchPolicy {
  // Resolves the parent's selection for a remote. Throws a
  // WorktreeOperationError (fetch-authentication) when the parent selected a
  // credential that cannot be used right now — locked, disabled, deleted or
  // host-incompatible — rather than falling back to anything.
  select(parentWorkspaceId: string, remote: WorktreeRemote): Promise<WorktreeFetchSelection>;
}

export type ParentFetchPolicyOptions = {
  // The parent's assignments, read live at fetch time: a policy change on
  // the parent applies to the next fetch without any per-child state.
  assignments: () => readonly CredentialAssignment[];
  // The same resolver the clone flow uses: it owns locked/disabled/
  // capability/host validation and produces the process context.
  resolve: (remote: string, credentialId: string) => Promise<{ credentialId: string; process: CloneCredentialProcessContext } | undefined>;
};

export function createParentFetchPolicy(options: ParentFetchPolicyOptions): WorktreeFetchPolicy {
  return {
    async select(parentWorkspaceId, remote) {
      let host: string | undefined;
      try {
        host = parseCloneRemote(remote.url).host;
      } catch {
        host = undefined;
      }
      const assignment = options.assignments().find(item =>
        item.workspaceId === parentWorkspaceId && item.role === "authentication" && host !== undefined && item.host === host);
      if (!assignment) return { kind: "none" };
      let resolved;
      try {
        resolved = await options.resolve(remote.url, assignment.credentialId);
      } catch (error) {
        // Locked, disabled, deleted or incompatible. Reported as an
        // authentication problem to fix ON THE PARENT; nothing else is tried.
        throw WorktreeOperationError.of(
          "fetch-authentication",
          `The parent's selected credential cannot be used: ${error instanceof Error ? error.message : String(error)}. Fix it on the parent workspace, then fetch again.`,
          { retry: "retry-fetch" },
          { cause: error },
        );
      }
      if (!resolved) return { kind: "none" };
      return { kind: "selected", credentialId: resolved.credentialId, process: resolved.process };
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function openSshOption(name: string, value: string): string {
  const quoted = value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return shellQuote(`${name}="${quoted}"`);
}

// The environment every worktree fetch runs in. Everything a Git or SSH
// process could read a credential from is either removed or pointed at
// nothing; the selected credential is added back explicitly below.
export function buildWorktreeFetchEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  selection: WorktreeFetchSelection = { kind: "none" },
): Record<string, string> {
  const env = stripAmbientCredentialEnvironment(source);
  for (const key of ["GIT_SSL_CERT", "GIT_SSL_KEY", "GIT_SSL_CERT_PASSWORD_PROTECTED", "GIT_PROXY_COMMAND", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_ASKPASS", "SSH_ASKPASS"]) {
    delete env[key];
  }
  // Non-interactive by construction: a fetch that would prompt fails fast
  // instead of hanging a bounded operation.
  env.GIT_TERMINAL_PROMPT = "0";
  env.SSH_ASKPASS_REQUIRE = "never";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  // The repository's own config still applies (it holds the remote URLs);
  // the system and global layers do not, so no ambient URL rewrite, HTTP
  // header, TLS client key or credential helper can take part.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  // libcurl would otherwise read ~/.netrc even with helpers disabled.
  env.HOME = "/dev/null";
  // -F /dev/null drops ~/.ssh/config (its IdentityFile entries are additive
  // even under IdentitiesOnly); IdentityAgent=none and IdentityFile=none
  // exclude an inherited agent and the default ~/.ssh/id_* identities.
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentityFile=none -o IdentitiesOnly=yes -o BatchMode=yes";
  if (selection.kind === "selected" && selection.process.type === "ssh") {
    env.SSH_AUTH_SOCK = selection.process.agentSocket;
    env.GIT_SSH_COMMAND = [
      shellQuote(selection.process.sshPath),
      "-F /dev/null",
      `-o ${openSshOption("IdentityAgent", selection.process.agentSocket)}`,
      `-o ${openSshOption("IdentityFile", selection.process.publicKeyPath)}`,
      "-o IdentitiesOnly=yes",
      "-o BatchMode=yes",
    ].join(" ");
  }
  return env;
}

export function buildWorktreeFetchArguments(
  repositoryPath: string,
  remote: WorktreeRemote,
  selection: WorktreeFetchSelection = { kind: "none" },
): string[] {
  assertGitArgumentSafe(remote.name, "remote");
  const args = [
    "-c", "core.askPass=",
    // Clears the helper LIST: no inherited helper can contribute a secret.
    "-c", "credential.helper=",
    // The repository is Hub-registered and read through its own path; state
    // it explicitly rather than depending on a global safe.directory entry
    // that this isolated environment deliberately cannot see.
    "-c", `safe.directory=${repositoryPath}`,
  ];
  if (selection.kind === "selected" && selection.process.type === "https") {
    const helper = [
      "!env",
      `UATU_HUB_STATE_ROOT=${shellQuote(selection.process.stateRoot)}`,
      `UATU_CREDENTIAL_ID=${shellQuote(selection.process.credentialId)}`,
      ...selection.process.uatuArgv.map(shellQuote),
      "--git-credential-helper",
    ].join(" ");
    args.push("-c", `credential.https://${selection.process.host}.helper=${helper}`);
  }
  // --prune is what lets a disappeared remote branch disappear from the
  // selector instead of lingering as a selectable ghost.
  args.push("fetch", "--prune", "--", remote.name);
  return args;
}

// `git config -z --get-regexp` emits NUL-separated "key\nvalue" records, so
// a URL containing a newline cannot smuggle a second entry.
export function parseWorktreeRemotes(output: string): WorktreeRemote[] {
  const remotes: WorktreeRemote[] = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const separator = record.indexOf("\n");
    if (separator < 0) continue;
    const key = record.slice(0, separator);
    const url = record.slice(separator + 1);
    const name = /^remote\.(.+)\.url$/.exec(key)?.[1];
    if (name && url !== "" && !remotes.some(remote => remote.name === name)) remotes.push({ name, url });
  }
  // "origin" first: the conventional remote is the one a stale listing is
  // usually about.
  return remotes.sort((left, right) => Number(right.name === "origin") - Number(left.name === "origin"));
}

// Bounded: a repository with dozens of remotes must not turn one explicit
// Fetch into a dozen network round trips.
export const WORKTREE_FETCH_REMOTE_LIMIT = 4;

export async function listWorktreeRemotes(run: GitRunner, repositoryPath: string): Promise<WorktreeRemote[]> {
  const result = await run(["config", "-z", "--get-regexp", "^remote\\..*\\.url$"], repositoryPath);
  // Exit code 1 is "no matches" — a repository with no remote at all.
  if (result.timedOut) {
    throw WorktreeOperationError.of("fetch-network", "Reading the repository's remotes timed out. Cached branches are unchanged.", { retry: "retry-fetch" });
  }
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    throw WorktreeOperationError.of("fetch-network", "The repository's remotes could not be read. Cached branches are unchanged.", { retry: "retry-fetch" });
  }
  return parseWorktreeRemotes(result.stdout).slice(0, WORKTREE_FETCH_REMOTE_LIMIT);
}

// Authentication is decided before network: "unable to access … 403" is an
// authentication problem whose text also matches the transport patterns.
const AUTHENTICATION_PATTERNS = [
  /authentication failed/i,
  /permission denied/i,
  /could not read (?:username|password)/i,
  /terminal prompts disabled/i,
  /access denied/i,
  /\b(?:401|403)\b/,
  /repository not found/i,
  /invalid username or (?:password|token)/i,
  /publickey/i,
  /host key verification failed/i,
];

const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /connection (?:refused|reset|timed out)/i,
  /network is unreachable/i,
  /no route to host/i,
  /operation timed out/i,
  /unable to access/i,
  /failed to connect/i,
  /does not appear to be a git repository/i,
];

export function classifyWorktreeFetchFailure(stderr: string, remote: WorktreeRemote): WorktreeError {
  const text = stderr.trim();
  if (AUTHENTICATION_PATTERNS.some(pattern => pattern.test(text))) {
    return WorktreeOperationError.of(
      "fetch-authentication",
      `Fetch authentication failed for ${remote.name}. Correct the credentials on the parent workspace and retry; cached branches are unchanged.`,
      { retry: "retry-fetch" },
    ).detail;
  }
  if (NETWORK_PATTERNS.some(pattern => pattern.test(text))) {
    return WorktreeOperationError.of(
      "fetch-network",
      `Could not reach ${remote.name}. Cached branches are unchanged; retry explicitly or use a displayed cached branch.`,
      { retry: "retry-fetch" },
    ).detail;
  }
  // Unrecognized: report Git's own words, sanitized (no secret, no absolute
  // host path), rather than guessing which of the two it was.
  return WorktreeOperationError.of(
    "fetch-network",
    `Fetch failed for ${remote.name}: ${text}. Cached branches are unchanged.`,
    { retry: "retry-fetch" },
  ).detail;
}

export type WorktreeFetchOutcome =
  | { readonly ok: true; readonly fetchedAt: number; readonly remotes: readonly string[] }
  | { readonly ok: false; readonly error: WorktreeError; readonly remotes: readonly string[] };

export type WorktreeFetchOptions = {
  run: GitRunner;
  repositoryPath: string;
  parentWorkspaceId: string;
  policy: WorktreeFetchPolicy;
  // The environment the child inherits, minus everything ambient.
  env?: NodeJS.ProcessEnv;
  // Runs one fetch with the selected credential's environment. Injected so
  // the bounded runner, its timeout and its process-group kill stay in one
  // place (worktree-git's createGitRunner) rather than being reimplemented.
  runWith: (args: readonly string[], cwd: string, env: Record<string, string>) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  now?: () => number;
};

// One explicit Fetch remote branches action: every remote the parent's
// policy can speak for, stopping at the first failure. Partial success is
// still reported as a failure, because the listing it produced is not the
// fresh listing the user asked for.
export async function fetchWorktreeRemotes(options: WorktreeFetchOptions): Promise<WorktreeFetchOutcome> {
  const now = options.now ?? Date.now;
  const remotes = await listWorktreeRemotes(options.run, options.repositoryPath);
  const fetched: string[] = [];
  for (const remote of remotes) {
    let selection: WorktreeFetchSelection;
    try {
      selection = await options.policy.select(options.parentWorkspaceId, remote);
    } catch (error) {
      if (error instanceof WorktreeOperationError) return { ok: false, error: error.detail, remotes: fetched };
      throw error;
    }
    const result = await options.runWith(
      buildWorktreeFetchArguments(options.repositoryPath, remote, selection),
      options.repositoryPath,
      buildWorktreeFetchEnvironment(options.env, selection),
    );
    if (result.timedOut) {
      return {
        ok: false,
        error: WorktreeOperationError.of("fetch-network", `Fetching ${remote.name} timed out. Cached branches are unchanged.`, { retry: "retry-fetch" }).detail,
        remotes: fetched,
      };
    }
    if (result.exitCode !== 0) {
      return { ok: false, error: classifyWorktreeFetchFailure(result.stderr || result.stdout, remote), remotes: fetched };
    }
    fetched.push(remote.name);
  }
  return { ok: true, fetchedAt: now(), remotes: fetched };
}
