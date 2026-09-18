// Worktree capability tokens (task 6.1's transport).
//
// A Hub session is NOT least privilege: it authorizes the dashboard, every
// credential route, every workspace's proxied session and an interactive
// shell. Handing one to a process inside a workspace — which is what an
// agent running in the terminal is — would give that agent the whole Hub.
//
// So worktree operations get their own credential, with a deliberately
// narrow grant:
//
//   * ONE repository family (the `sourceWorkspaceId` main workspace and its
//     registered linked worktrees). A token for workspace A cannot touch B.
//   * ONE user, on whose behalf the Hub performs the operation — the same
//     identity the UI's operations are journaled and scoped by.
//   * ONE route family: `/api/hub/worktrees…`. The Hub refuses a capability
//     presented on any other path before that path's handler ever runs.
//   * A bounded lifetime, and revocation that is immediate and server-side:
//     the record dies when the session child stops, and when the workspace
//     (or its parent) is forgotten or removed.
//
// The store mirrors HubSessionStore's discipline — opaque ids, an atomic
// owner-only file in the Hub state dir, dead records compacted on load and
// on save — with one difference: the secret is NEVER stored. The file keeps
// a SHA-256 digest, so a leaked state file cannot be replayed against a
// running Hub.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import {
  formatWorktreeHubContext,
  isWorktreeCapabilityToken,
  WORKTREE_CAPABILITY_PREFIX,
  type WorktreeHubContext,
} from "../shared/worktree-context";

// The backstop lifetime. Revocation on stop is the primary control; this
// bounds a token whose Hub died without running its revocation, and it is
// short enough that a forgotten context file stops working on its own. An
// expired context fails with "restart the workspace", which is an action the
// user can take, not a dead end.
export const WORKTREE_CAPABILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type WorktreeCapabilityRecord = {
  // Opaque public handle. Safe to log; it authenticates nothing on its own.
  id: string;
  // SHA-256 of the secret half, hex. The secret itself is never persisted.
  tokenHash: string;
  user: string;
  // The session child the token was issued to.
  workspaceId: string;
  // The main workspace whose repository family the token may operate on.
  sourceWorkspaceId: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
};

function digest(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isExpired(record: WorktreeCapabilityRecord, now: number): boolean {
  return record.expiresAt <= now;
}

function isDead(record: WorktreeCapabilityRecord, now: number): boolean {
  return record.revokedAt !== undefined || isExpired(record, now);
}

export class WorktreeCapabilityStore {
  private records = new Map<string, WorktreeCapabilityRecord>();
  private saveCounter = 0;
  private mutationChain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(
    private readonly filePath: string,
    options: { now?: () => number; maxAgeMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? WORKTREE_CAPABILITY_MAX_AGE_MS;
  }

  // Missing or corrupt reads as "no capabilities": every live session's
  // token is reissued when that session next starts, and refusing to start
  // the Hub over a half-written file would be worse than one re-grant.
  async load(): Promise<void> {
    this.records = new Map();
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      return;
    }
    const list = (raw as { capabilities?: unknown })?.capabilities;
    if (!Array.isArray(list)) return;
    const now = this.now();
    for (const entry of list) {
      const record = entry as Record<string, unknown>;
      if (
        typeof record?.id !== "string" || record.id === ""
        || typeof record.tokenHash !== "string" || record.tokenHash === ""
        || typeof record.user !== "string"
        || typeof record.workspaceId !== "string"
        || typeof record.sourceWorkspaceId !== "string"
        || typeof record.issuedAt !== "number"
        || typeof record.expiresAt !== "number"
        || (record.revokedAt !== undefined && typeof record.revokedAt !== "number")
      ) {
        continue;
      }
      const parsed: WorktreeCapabilityRecord = {
        id: record.id,
        tokenHash: record.tokenHash,
        user: record.user,
        workspaceId: record.workspaceId,
        sourceWorkspaceId: record.sourceWorkspaceId,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
      };
      if (record.revokedAt !== undefined) parsed.revokedAt = record.revokedAt as number;
      if (isDead(parsed, now)) continue;
      this.records.set(parsed.id, parsed);
    }
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async issue(grant: {
    user: string;
    workspaceId: string;
    sourceWorkspaceId: string;
    ttlMs?: number;
  }): Promise<{ token: string; record: WorktreeCapabilityRecord }> {
    const id = crypto.randomBytes(16).toString("base64url");
    const secret = crypto.randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const record: WorktreeCapabilityRecord = {
      id,
      tokenHash: digest(secret),
      user: grant.user,
      workspaceId: grant.workspaceId,
      sourceWorkspaceId: grant.sourceWorkspaceId,
      issuedAt,
      expiresAt: issuedAt + Math.min(grant.ttlMs ?? this.maxAgeMs, this.maxAgeMs),
    };
    this.records.set(id, record);
    await this.persist();
    return { token: `${WORKTREE_CAPABILITY_PREFIX}${id}.${secret}`, record };
  }

  // The single verification path. Unknown, revoked, expired, malformed and
  // "right id, wrong secret" all read the same way: absent.
  resolve(token: string): WorktreeCapabilityRecord | null {
    if (!isWorktreeCapabilityToken(token)) return null;
    const body = token.slice(WORKTREE_CAPABILITY_PREFIX.length);
    const separator = body.indexOf(".");
    if (separator <= 0) return null;
    const record = this.records.get(body.slice(0, separator));
    if (!record || isDead(record, this.now())) return null;
    return sameDigest(record.tokenHash, digest(body.slice(separator + 1))) ? record : null;
  }

  async revoke(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.revokedAt !== undefined) return false;
    record.revokedAt = this.now();
    await this.persist();
    return true;
  }

  // Revokes every capability a workspace can reach: the ones issued TO that
  // session child, and the ones whose repository family it owns. The first
  // covers "the session stopped"; the second covers "the parent workspace
  // was forgotten or removed", after which the family no longer exists.
  async revokeForWorkspace(workspaceId: string): Promise<number> {
    const now = this.now();
    let revoked = 0;
    for (const record of this.records.values()) {
      if (record.revokedAt !== undefined) continue;
      if (record.workspaceId !== workspaceId && record.sourceWorkspaceId !== workspaceId) continue;
      record.revokedAt = now;
      revoked += 1;
    }
    if (revoked > 0) await this.persist();
    return revoked;
  }

  // Live records, for diagnostics and tests. Never exposes a secret —
  // there is none to expose.
  list(): WorktreeCapabilityRecord[] {
    const now = this.now();
    return [...this.records.values()].filter(record => !isDead(record, now));
  }

  private persist(): Promise<void> {
    const next = this.mutationChain.then(() => this.save(), () => this.save());
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  private async save(): Promise<void> {
    const now = this.now();
    const capabilities = [...this.records.values()].filter(record => !isDead(record, now));
    const serialized = `${JSON.stringify({ version: 1, capabilities }, null, 2)}\n`;
    const temp = `${this.filePath}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    try {
      await fs.writeFile(temp, serialized, { mode: 0o600 });
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

// --- the session-child projection -----------------------------------------

// What the session backend needs to project a context into a child, and to
// take it back when that child exits. Kept as a seam so the backend never
// imports the store, and so a Hub without worktree operations simply has no
// issuer and injects nothing.
export type WorktreeContextIssuer = {
  issue(workspaceId: string): Promise<{ context: WorktreeHubContext; revoke: () => Promise<void> } | undefined>;
};

export type WorktreeContextIssuerOptions = {
  store: Pick<WorktreeCapabilityStore, "issue" | "revoke">;
  // The Hub's own origin, resolved late: the listening port is only known
  // after the server starts, and a config port of 0 is ephemeral. An empty
  // string means "not serving yet" and issues nothing.
  hubOrigin: () => string;
  // The main workspace whose repository family this workspace belongs to,
  // or undefined when it is not part of one.
  sourceWorkspaceId: (workspaceId: string) => string | undefined;
  // Whose authority the capability carries. Deliberately allowed to answer
  // "nobody": a workspace terminal is shared by every Hub user who can reach
  // it, so on a multi-user Hub there is no single principal to attribute an
  // agent's request to, and the Hub issues no capability rather than
  // guessing one. The CLI then reports an actionable context error.
  user: (workspaceId: string) => string | undefined;
  ttlMs?: number;
};

export function createWorktreeContextIssuer(options: WorktreeContextIssuerOptions): WorktreeContextIssuer {
  return {
    async issue(workspaceId) {
      const hubOrigin = options.hubOrigin();
      if (hubOrigin === "") return undefined;
      const sourceWorkspaceId = options.sourceWorkspaceId(workspaceId);
      if (sourceWorkspaceId === undefined) return undefined;
      const user = options.user(workspaceId);
      if (user === undefined) return undefined;
      const issued = await options.store.issue({
        user,
        workspaceId,
        sourceWorkspaceId,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      });
      return {
        context: {
          version: 1,
          hubOrigin,
          workspaceId,
          token: issued.token,
          expiresAt: issued.record.expiresAt,
        },
        revoke: async () => {
          await options.store.revoke(issued.record.id);
        },
      };
    },
  };
}

// Serializes a context for the child's runtime directory. Exported so the
// backend's write and the tests share one spelling.
export function worktreeContextFileBody(context: WorktreeHubContext): string {
  return formatWorktreeHubContext(context);
}
