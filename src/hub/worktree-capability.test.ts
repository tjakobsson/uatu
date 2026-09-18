import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WORKTREE_CAPABILITY_PREFIX } from "../shared/worktree-context";
import {
  createWorktreeContextIssuer,
  WORKTREE_CAPABILITY_MAX_AGE_MS,
  WorktreeCapabilityStore,
  worktreeContextFileBody,
} from "./worktree-capability";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function store(options: { now?: () => number; maxAgeMs?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-capability-"));
  directories.push(directory);
  const filePath = path.join(directory, "worktree-capabilities.json");
  const instance = new WorktreeCapabilityStore(filePath, options);
  await instance.load();
  return { instance, filePath };
}

const grant = { user: "reviewer", workspaceId: "atlas", sourceWorkspaceId: "atlas" };

describe("worktree capability store", () => {
  test("issues a prefixed token that resolves to its grant", async () => {
    const { instance } = await store();
    const issued = await instance.issue(grant);
    expect(issued.token.startsWith(WORKTREE_CAPABILITY_PREFIX)).toBe(true);
    const resolved = instance.resolve(issued.token);
    expect(resolved).toMatchObject({ user: "reviewer", workspaceId: "atlas", sourceWorkspaceId: "atlas" });
    expect(resolved!.id).toBe(issued.record.id);
  });

  test("persists the digest, never the secret, in an owner-only file", async () => {
    const { instance, filePath } = await store();
    const issued = await instance.issue(grant);
    const raw = await readFile(filePath, "utf8");
    const secret = issued.token.slice(issued.token.indexOf(".") + 1);
    // A leaked state file must not be replayable against a running Hub.
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(issued.token);
    expect(raw).toContain(issued.record.tokenHash);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  test("a wrong secret on a real handle is absent, not an error", async () => {
    const { instance } = await store();
    const issued = await instance.issue(grant);
    const handle = issued.token.slice(0, issued.token.indexOf("."));
    expect(instance.resolve(`${handle}.not-the-secret`)).toBeNull();
    expect(instance.resolve("")).toBeNull();
    expect(instance.resolve(`${WORKTREE_CAPABILITY_PREFIX}no-separator`)).toBeNull();
    // A Hub session id presented here authorizes nothing.
    expect(instance.resolve("an-ordinary-hub-session-id")).toBeNull();
  });

  test("revocation is immediate and survives a reload", async () => {
    const { instance, filePath } = await store();
    const issued = await instance.issue(grant);
    expect(await instance.revoke(issued.record.id)).toBe(true);
    expect(instance.resolve(issued.token)).toBeNull();
    expect(await instance.revoke(issued.record.id)).toBe(false);
    const reloaded = new WorktreeCapabilityStore(filePath);
    await reloaded.load();
    expect(reloaded.resolve(issued.token)).toBeNull();
  });

  test("a stopped or forgotten workspace takes its whole family's capabilities", async () => {
    const { instance } = await store();
    const child = await instance.issue({ user: "reviewer", workspaceId: "feature-login", sourceWorkspaceId: "atlas" });
    const parent = await instance.issue(grant);
    const other = await instance.issue({ user: "reviewer", workspaceId: "beacon", sourceWorkspaceId: "beacon" });
    // Forgetting the parent ends the family: both tokens scoped to it die.
    expect(await instance.revokeForWorkspace("atlas")).toBe(2);
    expect(instance.resolve(child.token)).toBeNull();
    expect(instance.resolve(parent.token)).toBeNull();
    // An unrelated workspace is untouched.
    expect(instance.resolve(other.token)).not.toBeNull();
  });

  test("expiry is a backstop and is bounded by the maximum age", async () => {
    let clock = 1_000;
    const { instance } = await store({ now: () => clock });
    const issued = await instance.issue({ ...grant, ttlMs: WORKTREE_CAPABILITY_MAX_AGE_MS * 10 });
    expect(issued.record.expiresAt).toBe(1_000 + WORKTREE_CAPABILITY_MAX_AGE_MS);
    clock = issued.record.expiresAt;
    expect(instance.resolve(issued.token)).toBeNull();
    expect(instance.list()).toEqual([]);
  });

  test("a reload compacts dead records rather than keeping history", async () => {
    let clock = 1_000;
    const { instance, filePath } = await store({ now: () => clock, maxAgeMs: 100 });
    await instance.issue(grant);
    clock = 2_000;
    const reloaded = new WorktreeCapabilityStore(filePath, { now: () => clock });
    await reloaded.load();
    expect(reloaded.list()).toEqual([]);
  });
});

describe("session-child context issuer", () => {
  const issuerStore = async () => (await store()).instance;

  test("projects origin, workspace and expiry, and revokes on request", async () => {
    const instance = await issuerStore();
    const issuer = createWorktreeContextIssuer({
      store: instance,
      hubOrigin: () => "http://127.0.0.1:4700",
      sourceWorkspaceId: () => "atlas",
      user: () => "reviewer",
    });
    const issued = await issuer.issue("feature-login");
    expect(issued!.context).toMatchObject({ version: 1, hubOrigin: "http://127.0.0.1:4700", workspaceId: "feature-login" });
    expect(instance.resolve(issued!.context.token)).toMatchObject({ sourceWorkspaceId: "atlas", user: "reviewer" });
    // The file body is exactly what the CLI parses.
    expect(JSON.parse(worktreeContextFileBody(issued!.context))).toEqual(issued!.context);
    await issued!.revoke();
    expect(instance.resolve(issued!.context.token)).toBeNull();
  });

  test("issues nothing rather than guessing a Hub, a family or a principal", async () => {
    const instance = await issuerStore();
    const base = {
      store: instance,
      hubOrigin: () => "http://127.0.0.1:4700",
      sourceWorkspaceId: () => "atlas" as string | undefined,
      user: () => "reviewer" as string | undefined,
    };
    // Not serving yet: no origin to name.
    expect(await createWorktreeContextIssuer({ ...base, hubOrigin: () => "" }).issue("atlas")).toBeUndefined();
    // Not part of a repository family.
    expect(await createWorktreeContextIssuer({ ...base, sourceWorkspaceId: () => undefined }).issue("atlas")).toBeUndefined();
    // No single principal to act on behalf of (a multi-user Hub).
    expect(await createWorktreeContextIssuer({ ...base, user: () => undefined }).issue("atlas")).toBeUndefined();
    expect(instance.list()).toEqual([]);
  });
});
