// Read-only Git probes for the worktree service: capability floor, canonical
// repository/checkout identity, worktree inventory, and ref listing. Nothing
// here mutates a repository — creation and removal (tasks 4.x/5.x) build on
// these answers. Every probe is bounded (timeout + output cap), runs with a
// sanitized environment, and separates "proved absent" from "could not tell",
// because the callers fail closed on the latter.
//
// Supported Git surface
// ---------------------
// The floor is Git 2.36, where `git worktree list --porcelain -z` arrived:
// the NUL-terminated listing is the only form safe for a path containing a
// newline, and this module refuses to fall back to the line-based one.
// `rev-parse --path-format=absolute` (2.31), `worktree list`'s prunable
// annotation (2.32) and `worktree add --track -b` (2.9) are all older, so
// 2.36 is the single number to state. An older or unreadable Git makes every
// worktree operation unsupported rather than silently degrading.
//
// Knowingly unsupported cases, refused rather than half-handled:
//   * bare repositories and `--separate-git-dir` main checkouts are readable
//     (they appear in the inventory) but are never creation sources: a bare
//     repository has no main checkout to place siblings beside.
//   * submodules are not creation sources. A submodule keeps its own common
//     directory under the superproject's `.git/modules/<name>`, so
//     `repositoryContext()` reports the submodule's own identity and it is
//     never silently attributed to its superproject; but a worktree of a
//     submodule, and any attempt to reason about superproject/submodule ref
//     coupling, is out of scope here. The rename guard does inspect
//     submodule Git directories, because a submodule can own linked
//     worktrees of its own.
//   * `worktree list` is trusted as authoritative for a repository's linked
//     trees, including trees Uatu never registered. Arbitrary host scanning
//     is deliberately absent.

import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { WorktreeOperationError, type WorktreeIdentity } from "../shared/worktree-contract";

export const WORKTREE_GIT_MINIMUM_VERSION = "2.36.0";

const PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRun>;

export type GitRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
};

export type WorktreeGitOptions = {
  // Resolved at call time so a hub that re-resolves its tool paths is followed.
  gitCommand?: () => string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimit?: number;
  // Test seam; defaults to the bounded Bun.spawn runner below.
  run?: GitRunner;
};

// Probes are local and read-only: they must never contact a remote, never
// prompt, and never take a repository lock. Ambient GIT_DIR/GIT_WORK_TREE
// (a shell inside another checkout, a projected wrapper environment) would
// silently redirect every probe, so they are dropped; system/global config
// is kept, because `safe.directory` lives there and is what lets the daemon
// read a repository it does not own.
const DROPPED_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_WORK_TREE",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
];

export function buildWorktreeProbeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROPPED_ENVIRONMENT.includes(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - size;
      if (remaining <= 0) {
        exceeded = true;
        break;
      }
      chunks.push(next.value.slice(0, remaining));
      size += Math.min(remaining, next.value.length);
      if (next.value.length > remaining) {
        exceeded = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))), exceeded };
}

export function createGitRunner(options: WorktreeGitOptions = {}): GitRunner {
  const env = buildWorktreeProbeEnvironment(options.env);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const limit = options.outputLimit ?? OUTPUT_LIMIT;
  const command = options.gitCommand ?? (() => "git");
  return async (args, cwd) => {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([command(), ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
    } catch (error) {
      return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, outputExceeded: false };
    }
    let timedOut = false;
    const stop = () => {
      if (process.platform !== "win32" && child.pid > 0) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child.
        }
      }
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([
        readCapped(child.stdout as ReadableStream<Uint8Array>, limit),
        readCapped(child.stderr as ReadableStream<Uint8Array>, limit),
      ]);
      const exitCode = await child.exited;
      return { exitCode, stdout: stdout.text, stderr: stderr.text, timedOut, outputExceeded: stdout.exceeded || stderr.exceeded };
    } finally {
      clearTimeout(timer);
    }
  };
}

export type GitCapabilities = {
  readonly available: boolean;
  readonly version: string | null;
  readonly supported: boolean;
  // Present when worktree operations are unsupported; already caller-safe.
  readonly reason?: string;
};

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map(part => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function probeGitCapabilities(directory: string, options: WorktreeGitOptions = {}): Promise<GitCapabilities> {
  const run = options.run ?? createGitRunner(options);
  const result = await run(["--version"], directory);
  if (result.exitCode !== 0 || result.timedOut) {
    return { available: false, version: null, supported: false, reason: "Git is not available on this Hub." };
  }
  // "git version 2.45.2" and vendor forms like "git version 2.39.5 (Apple Git-154)".
  const match = /git version (\d+(?:\.\d+)*)/.exec(result.stdout);
  if (!match?.[1]) {
    return { available: true, version: null, supported: false, reason: "Git did not report a recognizable version." };
  }
  const version = match[1];
  const supported = compareVersions(version, WORKTREE_GIT_MINIMUM_VERSION) >= 0;
  return {
    available: true,
    version,
    supported,
    ...(supported ? {} : { reason: `Worktree operations need Git ${WORKTREE_GIT_MINIMUM_VERSION} or newer; this Hub has ${version}.` }),
  };
}

// A canonical, path-derived identity. The hash is over the CANONICAL
// administrative directory — `<common>/worktrees/<name>` for a linked tree,
// the common directory itself for a main checkout — not over the checkout
// path, so a checkout that is moved (or reached through a symlink, or
// through /var vs /private/var) keeps one identity. A repository whose
// common directory itself moves is a different repository identity; that is
// the same boundary Git's own gitdir pointers have.
export function worktreeIdentityFor(commonDirectory: string, gitDirectory: string): { repositoryId: string; checkoutId: string } {
  return {
    repositoryId: digest(commonDirectory),
    checkoutId: digest(gitDirectory),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// Git names a linked tree's administrative directory after the checkout's
// folder and REUSES that name once the tree is removed, so the path-derived
// identity above is not unique over time: a different tree added later at
// the same path would inherit it — and with it any ownership recorded for
// the old tree. Uatu therefore stamps the trees it creates or registers with
// a random token inside that administrative directory. Git deletes the
// token together with the directory, so a later tree at the same path has
// no token and a different identity. Unstamped trees (external, never
// registered) keep the path-derived identity.
export const CHECKOUT_IDENTITY_FILE = "uatu-checkout";
const TOKEN_PATTERN = /^uatu-checkout-[0-9a-f-]{36}$/;

async function readIdentityToken(gitDirectory: string): Promise<string | null | "unreadable"> {
  try {
    const token = (await fs.readFile(path.join(gitDirectory, CHECKOUT_IDENTITY_FILE), "utf8")).trim();
    return TOKEN_PATTERN.test(token) ? token : "unreadable";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
}

// Idempotent: an existing valid token is kept. Only ever written into a
// LINKED tree's own administrative directory, never a main checkout's.
export async function stampCheckoutIdentity(checkoutPath: string, options: WorktreeGitOptions = {}): Promise<WorktreeIdentity> {
  const context = await repositoryContext(checkoutPath, options);
  if (context.kind !== "checkout") throw WorktreeOperationError.of("identity-uncertain", "The checkout could not be identified.");
  if (context.main) return context.identity;
  const existing = await readIdentityToken(context.gitDirectory);
  if (existing === "unreadable") throw WorktreeOperationError.of("identity-uncertain", "The checkout's identity could not be read.");
  if (existing === null) {
    await fs.writeFile(path.join(context.gitDirectory, CHECKOUT_IDENTITY_FILE), `uatu-checkout-${crypto.randomUUID()}\n`, { mode: 0o600, flag: "wx" });
  }
  const stamped = await repositoryContext(checkoutPath, options);
  if (stamped.kind !== "checkout") throw WorktreeOperationError.of("identity-uncertain", "The checkout could not be identified.");
  return stamped.identity;
}

export type RepositoryContext =
  | {
    readonly kind: "checkout";
    readonly identity: WorktreeIdentity;
    readonly commonDirectory: string;
    readonly gitDirectory: string;
    readonly topLevel: string | null;
    readonly main: boolean;
    readonly bare: boolean;
  }
  | { readonly kind: "not-a-repository" }
  // The probe failed WITHOUT proving the absence of a repository. Callers
  // must fail closed: this is what protects an unreadable repository from a
  // move that would break its links.
  | { readonly kind: "indeterminate"; readonly detail: string };

async function canonical(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

// Resolves the repository a directory belongs to. Git walks up from `cwd`,
// so this also answers "is this path inside a repository at all".
export async function repositoryContext(directory: string, options: WorktreeGitOptions = {}): Promise<RepositoryContext> {
  const run = options.run ?? createGitRunner(options);
  // `--show-toplevel` is asked for separately: in a bare repository it is a
  // fatal error, which would otherwise make every bare repository look
  // indeterminate — and a bare repository can own linked worktrees.
  const result = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--is-bare-repository"],
    directory,
  );
  if (result.timedOut) return { kind: "indeterminate", detail: "git repository probe timed out" };
  if (result.outputExceeded) return { kind: "indeterminate", detail: "git repository probe exceeded the output limit" };
  if (result.exitCode !== 0) {
    if (/not a git repository/i.test(result.stderr)) return { kind: "not-a-repository" };
    return { kind: "indeterminate", detail: result.stderr.trim() || `git rev-parse exited ${result.exitCode}` };
  }
  const lines = result.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
  const [commonDirectory, gitDirectory, bare] = lines;
  if (!commonDirectory || !gitDirectory) return { kind: "indeterminate", detail: "git rev-parse reported no repository directories" };
  const isBare = bare === "true";
  let topLevel: string | null = null;
  if (!isBare) {
    const toplevelResult = await run(["rev-parse", "--path-format=absolute", "--show-toplevel"], directory);
    if (toplevelResult.timedOut) return { kind: "indeterminate", detail: "git repository probe timed out" };
    if (toplevelResult.exitCode !== 0) {
      return { kind: "indeterminate", detail: toplevelResult.stderr.trim() || `git rev-parse exited ${toplevelResult.exitCode}` };
    }
    topLevel = toplevelResult.stdout.trim() || null;
  }
  const [canonicalCommon, canonicalGit, canonicalTop] = await Promise.all([
    canonical(commonDirectory),
    canonical(gitDirectory),
    topLevel === null ? Promise.resolve(null) : canonical(topLevel),
  ]);
  const main = canonicalCommon === canonicalGit;
  const identity = worktreeIdentityFor(canonicalCommon, canonicalGit);
  if (!main) {
    const token = await readIdentityToken(canonicalGit);
    if (token === "unreadable") return { kind: "indeterminate", detail: "the checkout's identity stamp could not be read" };
    if (token !== null) identity.checkoutId = digest(`${canonicalGit}\n${token}`);
  }
  return {
    kind: "checkout",
    identity,
    commonDirectory: canonicalCommon,
    gitDirectory: canonicalGit,
    topLevel: canonicalTop,
    main,
    bare: isBare,
  };
}

export type WorktreeRecord = {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly prunable: boolean;
};

export type WorktreeInventoryProbe =
  | { readonly kind: "inventory"; readonly records: readonly WorktreeRecord[] }
  | { readonly kind: "indeterminate"; readonly detail: string };

// `git worktree list --porcelain -z`: attributes are NUL-terminated and
// records are separated by an empty attribute (a second NUL). The -z form is
// the only one that survives a path containing a newline.
export function parseWorktreeListPorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: { path?: string; head?: string; branch?: string; detached?: boolean; bare?: boolean; locked?: boolean; lockReason?: string; prunable?: boolean } = {};
  const flush = () => {
    if (current.path !== undefined) {
      records.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        detached: current.detached === true,
        bare: current.bare === true,
        locked: current.locked === true,
        lockReason: current.lockReason ?? null,
        prunable: current.prunable === true,
      });
    }
    current = {};
  };
  for (const attribute of output.split("\0")) {
    if (attribute === "") {
      flush();
      continue;
    }
    const separator = attribute.indexOf(" ");
    const key = separator < 0 ? attribute : attribute.slice(0, separator);
    const value = separator < 0 ? "" : attribute.slice(separator + 1);
    if (key === "worktree") {
      flush();
      current.path = value;
    } else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      if (value !== "") current.lockReason = value;
    } else if (key === "prunable") current.prunable = true;
  }
  flush();
  return records;
}

export async function listWorktrees(directory: string, options: WorktreeGitOptions = {}): Promise<WorktreeInventoryProbe> {
  const run = options.run ?? createGitRunner(options);
  const result = await run(["worktree", "list", "--porcelain", "-z"], directory);
  if (result.timedOut) return { kind: "indeterminate", detail: "git worktree list timed out" };
  if (result.outputExceeded) return { kind: "indeterminate", detail: "git worktree list exceeded the output limit" };
  if (result.exitCode !== 0) return { kind: "indeterminate", detail: result.stderr.trim() || `git worktree list exited ${result.exitCode}` };
  return { kind: "inventory", records: parseWorktreeListPorcelain(result.stdout) };
}

export type RefListing =
  | { readonly kind: "refs"; readonly local: readonly string[]; readonly remote: readonly string[] }
  | { readonly kind: "indeterminate"; readonly detail: string };

// Cached repository refs. No network access: an explicit fetch is a separate,
// credential-aware operation (task 4.2), and these are never described as
// network-fresh.
export async function listRefs(directory: string, options: WorktreeGitOptions = {}): Promise<RefListing> {
  const run = options.run ?? createGitRunner(options);
  const result = await run(
    ["for-each-ref", "--format=%(refname)", "--", "refs/heads/**", "refs/remotes/**"],
    directory,
  );
  if (result.timedOut) return { kind: "indeterminate", detail: "git for-each-ref timed out" };
  if (result.outputExceeded) return { kind: "indeterminate", detail: "git for-each-ref exceeded the output limit" };
  if (result.exitCode !== 0) return { kind: "indeterminate", detail: result.stderr.trim() || `git for-each-ref exited ${result.exitCode}` };
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
    // `origin/HEAD` is a symbolic ref, not a branch anyone can check out.
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) remote.push(name);
    }
  }
  return { kind: "refs", local, remote };
}

// Occupancy is scoped to ONE repository identity: the same branch name in a
// different repository is not a conflict (spec: "Same branch in separate
// repositories").
export function checkoutForBranch(records: readonly WorktreeRecord[], branch: string): WorktreeRecord | undefined {
  return records.find(record => record.branch === branch);
}

// Guards every value that reaches a Git argument list. `--` separators cover
// paths and refs positionally, but an option-like value can still be read as
// an option by a subcommand that takes no separator, so leading dashes are
// refused outright rather than escaped.
export function assertGitArgumentSafe(value: string, field: string): string {
  if (value === "" || value.startsWith("-") || value.includes("\0") || /[\p{Cc}]/u.test(value)) {
    throw WorktreeOperationError.of("invalid-input", `${field} is not a usable value`);
  }
  return value;
}

export type CheckoutInspection = {
  // The path exists on disk (whatever it holds).
  readonly present: boolean;
  // The identity Git reports there, absent when it could not be established.
  readonly identity?: WorktreeIdentity;
  // False when the path is present but its identity could not be read: the
  // caller must treat the checkout as uncertain and retain its content.
  readonly identityReadable: boolean;
  readonly detail?: string;
};

// The one probe ownership resolution and restart recovery share: what is at
// this path right now, and can we prove what it is.
export async function inspectCheckout(checkoutPath: string, options: WorktreeGitOptions = {}): Promise<CheckoutInspection> {
  let present: boolean;
  try {
    present = (await fs.lstat(checkoutPath)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { present: false, identityReadable: true };
    return { present: true, identityReadable: false, detail: `checkout path could not be read (${code ?? "unknown"})` };
  }
  if (!present) return { present: false, identityReadable: true };
  const context = await repositoryContext(checkoutPath, options);
  if (context.kind === "checkout") {
    // Git walks up: a plain directory inside a repository would otherwise
    // answer with its ancestor's identity.
    const top = context.topLevel === null ? null : await canonical(context.topLevel);
    if (top !== null && top !== await canonical(checkoutPath)) {
      return { present: true, identityReadable: true, detail: "path is not a checkout root" };
    }
    return { present: true, identity: context.identity, identityReadable: true };
  }
  if (context.kind === "not-a-repository") return { present: true, identityReadable: true, detail: "path is not a Git checkout" };
  return { present: true, identityReadable: false, detail: context.detail };
}

export type CheckoutHead =
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "detached" }
  | { readonly kind: "unknown" };

export type CheckoutGitLink = "directory" | "file" | "none";

const HEAD_LIMIT = 4096;

async function readSmall(file: string): Promise<string | null> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(HEAD_LIMIT);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_LIMIT, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

// What `<checkout>/.git` is: a directory for a main checkout, a `gitdir:`
// file for a linked worktree (or a separate-git-dir main checkout). A cheap,
// subprocess-free fact for list views that must not run Git per row.
export async function checkoutGitLink(checkoutPath: string): Promise<CheckoutGitLink> {
  try {
    const stats = await fs.lstat(path.join(checkoutPath, ".git"));
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "none";
  } catch {
    return "none";
  }
}

// The checkout's CURRENT HEAD, read from the Git administrative files
// without spawning Git — for the Hub state list, which is polled. Anything
// unexpected is "unknown", never a guessed `main`. A symbolic ref outside
// refs/heads (rare, hand-edited) is also unknown.
export async function readCheckoutHead(checkoutPath: string): Promise<CheckoutHead> {
  const link = await checkoutGitLink(checkoutPath);
  let gitDirectory: string;
  if (link === "directory") gitDirectory = path.join(checkoutPath, ".git");
  else if (link === "file") {
    const pointer = await readSmall(path.join(checkoutPath, ".git"));
    const match = pointer === null ? null : /^gitdir: (.+)$/m.exec(pointer);
    if (!match?.[1]) return { kind: "unknown" };
    gitDirectory = path.resolve(checkoutPath, match[1].trim());
  } else return { kind: "unknown" };
  const head = (await readSmall(path.join(gitDirectory, "HEAD")))?.trim();
  if (!head) return { kind: "unknown" };
  const symbolic = /^ref: refs\/heads\/(.+)$/.exec(head);
  if (symbolic?.[1]) return { kind: "branch", branch: symbolic[1] };
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return { kind: "detached" };
  return { kind: "unknown" };
}
