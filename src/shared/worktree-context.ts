// The agent-facing Hub context: how a process running inside a workspace —
// its terminal, and therefore any agent the user starts there — learns which
// Hub to ask for worktree operations, and proves it may ask.
//
// Design §7 requires a least-privilege, revocable mechanism with "no tokens
// in command lines, outputs or skill prose". The shape that satisfies all
// three at once is a FILE:
//
//   * the Hub writes `hub-context.json` (mode 0600) into the session child's
//     existing per-session runtime directory — the same directory, and the
//     same discipline, the credential projection already uses;
//   * the child's environment carries only the PATH to that file
//     (UATU_HUB_CONTEXT), so the secret is never in `env`, never in an
//     argument vector, and never in a process listing;
//   * the token inside authorizes ONLY the worktree JSON family, only for
//     one workspace's repository family, and is revoked when that session
//     stops or the workspace is forgotten.
//
// This module is pure: no Bun, no Node, no filesystem. Both sides import it —
// the Hub to format the file, the CLI to read it.

// The environment variable the Hub injects. Its value is a PATH, never a
// credential; anything that logs the environment logs a path.
export const WORKTREE_CONTEXT_ENV = "UATU_HUB_CONTEXT";

// The file's name inside the session's runtime directory.
export const WORKTREE_CONTEXT_FILENAME = "hub-context.json";

// The published JSON family the context authorizes, and nothing else.
export const WORKTREE_API_PATH = "/api/hub/worktrees";

// Capability tokens are recognizable by construction so the Hub can route a
// presented bearer credential to the capability store instead of the Hub
// session store — and refuse it outright on any other route. A Hub session
// id is 32 random bytes of base64url and does not carry this prefix.
export const WORKTREE_CAPABILITY_PREFIX = "uatu-wt-";

export function isWorktreeCapabilityToken(value: string): boolean {
  return value.startsWith(WORKTREE_CAPABILITY_PREFIX);
}

export type WorktreeHubContext = {
  readonly version: 1;
  // Origin of the Hub that issued the token, e.g. "http://127.0.0.1:4700".
  // The CLI talks to this origin and no other: an absent, expired or
  // unrecognized context never guesses a different Hub.
  readonly hubOrigin: string;
  // The workspace this context was issued for. Worktree operations run
  // against its repository family, resolved Hub-side.
  readonly workspaceId: string;
  // The capability token. Held only in this file and in the Hub's store.
  readonly token: string;
  // Unix epoch milliseconds. A backstop under revocation, not the primary
  // control: stopping the session revokes the token immediately.
  readonly expiresAt: number;
};

export function formatWorktreeHubContext(context: WorktreeHubContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

// Every refusal a malformed context can produce. The caller turns these into
// one actionable message; none of them ever quotes the token.
export class WorktreeContextError extends Error {}

function fail(message: string): never {
  throw new WorktreeContextError(message);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") fail(`the Hub context file is missing ${field}`);
  return value;
}

export function parseWorktreeHubContext(value: unknown): WorktreeHubContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("the Hub context file is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) fail("the Hub context file has an unsupported version");
  const hubOrigin = requiredString(record, "hubOrigin");
  let origin: URL;
  try {
    origin = new URL(hubOrigin);
  } catch {
    return fail("the Hub context file has an unusable hubOrigin");
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    fail("the Hub context file has an unusable hubOrigin");
  }
  const token = requiredString(record, "token");
  if (!isWorktreeCapabilityToken(token)) fail("the Hub context file does not hold a worktree capability");
  const expiresAt = record.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    fail("the Hub context file is missing expiresAt");
  }
  return {
    version: 1,
    hubOrigin: origin.origin,
    workspaceId: requiredString(record, "workspaceId"),
    token,
    expiresAt,
  };
}

export function isWorktreeHubContextExpired(context: WorktreeHubContext, now: number): boolean {
  return context.expiresAt <= now;
}
