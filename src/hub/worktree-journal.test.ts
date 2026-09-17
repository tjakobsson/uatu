import { afterEach, describe, expect, test } from "bun:test";
import { promises as nodeFs } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { worktreeJournalPath, worktreeProvenancePath } from "./state-dir";
import {
  ownershipForCheckout,
  recoverWorktreeOperation,
  registerCreatedWorktree,
  WorktreeJournal,
  WorktreeProvenanceStore,
  type WorktreeOperationIntent,
  type WorktreeRegistrar,
} from "./worktree-journal";
import type { CheckoutInspection } from "./worktree-git";
import { WorktreeOperationError } from "../shared/worktree-contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function stateRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-state-"));
  directories.push(directory);
  return directory;
}

const IDENTITY = { repositoryId: "repository-atlas", checkoutId: "checkout-created-1" };

const INTENT: Omit<WorktreeOperationIntent, "version"> = {
  operationId: "operation-1",
  kind: "create",
  phase: "validating",
  user: "dev",
  repositoryId: IDENTITY.repositoryId,
  sourceWorkspaceId: "atlas",
  sourcePath: "/repos/atlas",
  destination: "/repos/atlas.worktrees/feature-login",
  mode: "new-branch",
  branch: "feature/login",
  base: { kind: "local", ref: "main" },
  sourceRef: "main",
};

function present(identity = IDENTITY): CheckoutInspection {
  return { present: true, identity, identityReadable: true };
}

// A filesystem that fails one named operation, to prove a persistence
// failure never leaves a claim behind.
function failingFs(failOn: keyof typeof nodeFs, message = "disk full"): typeof nodeFs {
  return new Proxy(nodeFs, {
    get(target, property, receiver) {
      if (property === failOn) {
        return async () => {
          throw Object.assign(new Error(message), { code: "ENOSPC" });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as typeof nodeFs;
}

describe("durable operation intent", () => {
  test("records intent before the mutation, with 0600 permissions", async () => {
    const root = await stateRoot();
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    const record = await journal.begin(INTENT);
    expect(record.phase).toBe("validating");
    expect(record.sourceRef).toBe("main");
    const stats = await nodeFs.lstat(worktreeJournalPath(root));
    expect(stats.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(worktreeJournalPath(root), "utf8")).operationId).toBe("operation-1");
  });

  test("re-recording the same operation is idempotent; a different one is refused", async () => {
    const journal = new WorktreeJournal(worktreeJournalPath(await stateRoot()));
    await journal.begin(INTENT);
    await journal.advance("operation-1", "creating");
    // A retry of the same operation must find its own record, not reset it.
    expect((await journal.begin(INTENT)).phase).toBe("creating");
    await expect(journal.begin({ ...INTENT, operationId: "operation-2" })).rejects.toThrow(/still in progress/);
  });

  test("phases only advance, and never into another operation's vocabulary", async () => {
    const journal = new WorktreeJournal(worktreeJournalPath(await stateRoot()));
    await journal.begin(INTENT);
    await journal.advance("operation-1", "creating");
    await expect(journal.advance("operation-1", "validating")).rejects.toThrow(/cannot move from creating to validating/);
    await expect(journal.advance("operation-1", "removing" as never)).rejects.toThrow(/cannot move/);
    await expect(journal.advance("operation-9", "verifying")).rejects.toThrow(/no pending worktree operation/);
    expect((await journal.read())?.phase).toBe("creating");
  });

  test("an unreadable record is kept, not cleared, and blocks further operations", async () => {
    const root = await stateRoot();
    await nodeFs.writeFile(worktreeJournalPath(root), `{"version":99,"operationId":"x"}\n`, { mode: 0o600 });
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    await expect(journal.read()).rejects.toBeInstanceOf(WorktreeOperationError);
    await expect(journal.begin(INTENT)).rejects.toThrow(/could not be read/);
    expect(await readFile(worktreeJournalPath(root), "utf8")).toContain(`"version":99`);
  });

  test("a failed journal write leaves no record and no temporary file", async () => {
    const root = await stateRoot();
    const journal = new WorktreeJournal(worktreeJournalPath(root), { fs: failingFs("rename") });
    await expect(journal.begin(INTENT)).rejects.toThrow(/disk full/);
    // Nothing published, and the temp file cleaned up: the caller must not
    // begin a Git mutation behind an unwritten record.
    expect(await new WorktreeJournal(worktreeJournalPath(root)).read()).toBeUndefined();
    expect((await nodeFs.readdir(root)).filter(entry => entry.includes("pending-worktree"))).toEqual([]);
  });
});

describe("durable provenance", () => {
  test("survives forgetting and is recovered by re-registering the same checkout", async () => {
    const root = await stateRoot();
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    await provenance.record({ ...IDENTITY, path: INTENT.destination, branch: "feature/login", sourceRef: "main", operationId: "operation-1", createdBy: "dev", createdAt: Date.now() });

    // Forget removes the registration elsewhere; provenance is untouched.
    const reloaded = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    const ownership = await ownershipForCheckout({ provenance: reloaded, inspection: present(), checkoutPath: INTENT.destination });
    expect(ownership.ownership).toBe("uatu");
    expect(ownership.record?.sourceRef).toBe("main");

    // Re-registered: same identity, so the same record answers again.
    const reregistered = await ownershipForCheckout({
      provenance: reloaded,
      inspection: present(),
      checkoutPath: INTENT.destination,
      registeredIdentity: IDENTITY,
    });
    expect(reregistered.ownership).toBe("uatu");
  });

  test("a reused path never inherits ownership from an older record", async () => {
    const root = await stateRoot();
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    await provenance.record({ ...IDENTITY, path: INTENT.destination, branch: "feature/login", operationId: "operation-1", createdBy: "dev", createdAt: Date.now() });
    const occupant = { repositoryId: "repository-atlas", checkoutId: "checkout-someone-else" };
    const ownership = await ownershipForCheckout({ provenance, inspection: present(occupant), checkoutPath: INTENT.destination });
    expect(ownership.ownership).toBe("external");
    expect(ownership.record).toBeUndefined();
    // The old record is still there for the tree it actually describes.
    expect(await provenance.byPath(INTENT.destination)).toBeDefined();
  });

  test("a replaced registered path is uncertain, never repaired", async () => {
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(await stateRoot()));
    await provenance.record({ ...IDENTITY, path: INTENT.destination, branch: "feature/login", operationId: "operation-1", createdBy: "dev", createdAt: Date.now() });
    const ownership = await ownershipForCheckout({
      provenance,
      inspection: present({ repositoryId: "repository-other", checkoutId: "checkout-other" }),
      checkoutPath: INTENT.destination,
      registeredIdentity: IDENTITY,
    });
    expect(ownership).toEqual({ ownership: "uncertain", availability: "replaced" });
  });

  test("recording one checkout twice replaces its record rather than duplicating it", async () => {
    const root = await stateRoot();
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    const entry = { ...IDENTITY, path: INTENT.destination, branch: "feature/login", operationId: "operation-1", createdBy: "dev", createdAt: 1 };
    await provenance.record(entry);
    await provenance.record({ ...entry, createdAt: 2 });
    expect((await provenance.load()).length).toBe(1);
    expect((await new WorktreeProvenanceStore(worktreeProvenancePath(root)).load())[0]?.createdAt).toBe(2);
  });

  test("a failed provenance write reports failure and claims nothing", async () => {
    const root = await stateRoot();
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root), { fs: failingFs("open") });
    await expect(provenance.record({ ...IDENTITY, path: INTENT.destination, branch: "feature/login", operationId: "operation-1", createdBy: "dev", createdAt: 1 }))
      .rejects.toThrow(/disk full/);
    const fresh = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    expect(await fresh.byCheckoutId(IDENTITY.checkoutId)).toBeUndefined();
    expect((await ownershipForCheckout({ provenance: fresh, inspection: present(), checkoutPath: INTENT.destination })).ownership).toBe("external");
  });
});

describe("restart recovery at every creation boundary", () => {
  async function recoverAt(phase: WorktreeOperationIntent["phase"], inspection: CheckoutInspection, options: {
    checkoutId?: string;
    registeredWorkspaceId?: (checkoutPath: string) => string | undefined;
  } = {}) {
    const root = await stateRoot();
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    await journal.begin({ ...INTENT, phase, ...(options.checkoutId === undefined ? {} : { checkoutId: options.checkoutId }) });
    const outcome = await recoverWorktreeOperation({
      journal,
      provenance,
      inspect: async () => inspection,
      ...(options.registeredWorkspaceId ? { registeredWorkspaceId: options.registeredWorkspaceId } : {}),
    });
    return { outcome, journal, provenance };
  }

  test("interrupted before Git ran: nothing was created and the fence lifts", async () => {
    const { outcome, journal, provenance } = await recoverAt("reserving", { present: false, identityReadable: true });
    expect(outcome).toEqual({ kind: "nothing-created", operationId: "operation-1" });
    expect(await journal.read()).toBeUndefined();
    expect(await provenance.load()).toEqual([]);
  });

  test("interrupted after Git created the tree: retained and registrable", async () => {
    const { outcome, journal, provenance } = await recoverAt("creating", present());
    expect(outcome).toEqual({
      kind: "retained-unregistered",
      operationId: "operation-1",
      checkoutPath: INTENT.destination,
      identity: IDENTITY,
    });
    // Provenance is recovered from the journal, so a crash between Git and
    // the provenance write still leaves a provably owned checkout.
    expect((await provenance.byCheckoutId(IDENTITY.checkoutId))?.sourceRef).toBe("main");
    expect(await journal.read()).toBeUndefined();
  });

  test("interrupted after registration committed: completed", async () => {
    const { outcome } = await recoverAt("registering", present(), {
      checkoutId: IDENTITY.checkoutId,
      registeredWorkspaceId: () => "atlas-feature-login",
    });
    expect(outcome).toEqual({ kind: "completed", operationId: "operation-1", workspaceId: "atlas-feature-login" });
  });

  test("a journal that reached complete still reports a retained checkout if the registration is gone", async () => {
    const { outcome } = await recoverAt("complete", present(), { checkoutId: IDENTITY.checkoutId, registeredWorkspaceId: () => undefined });
    expect(outcome?.kind).toBe("retained-unregistered");
  });

  test("a destination occupied before creation began is uncertain and kept", async () => {
    const { outcome, journal, provenance } = await recoverAt("reserving", present());
    expect(outcome?.kind).toBe("uncertain");
    // Content retained, no ownership asserted, and the record stays for a
    // human to reconcile.
    expect(await provenance.load()).toEqual([]);
    expect((await journal.read())?.operationId).toBe("operation-1");
  });

  test("another repository's checkout at the destination is never claimed", async () => {
    const { outcome, provenance } = await recoverAt("creating", present({ repositoryId: "repository-beacon", checkoutId: "checkout-beacon" }));
    expect(outcome?.kind).toBe("uncertain");
    if (outcome?.kind === "uncertain") expect(outcome.detail).toContain("another repository");
    expect(await provenance.load()).toEqual([]);
  });

  test("a different checkout than the one recorded is never claimed", async () => {
    const { outcome } = await recoverAt("verifying", present({ repositoryId: IDENTITY.repositoryId, checkoutId: "checkout-different" }), { checkoutId: IDENTITY.checkoutId });
    expect(outcome?.kind).toBe("uncertain");
  });

  test("non-checkout content and unreadable identities are retained, never removed", async () => {
    const occupied = await recoverAt("creating", { present: true, identityReadable: true });
    expect(occupied.outcome?.kind).toBe("uncertain");
    const unreadable = await recoverAt("creating", { present: true, identityReadable: false, detail: "dubious ownership" });
    expect(unreadable.outcome?.kind).toBe("uncertain");
    expect(await unreadable.provenance.load()).toEqual([]);
  });

  test("no pending record means nothing to recover", async () => {
    const root = await stateRoot();
    const outcome = await recoverWorktreeOperation({
      journal: new WorktreeJournal(worktreeJournalPath(root)),
      provenance: new WorktreeProvenanceStore(worktreeProvenancePath(root)),
      inspect: async () => ({ present: false, identityReadable: true }),
    });
    expect(outcome).toBeUndefined();
  });
});

describe("registration and assignment", () => {
  async function fixture(registrar: WorktreeRegistrar, options: { phase?: WorktreeOperationIntent["phase"] } = {}) {
    const root = await stateRoot();
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    await journal.begin({ ...INTENT, phase: options.phase ?? "verifying", checkoutId: IDENTITY.checkoutId });
    return { journal, provenance, registrar, inspect: async () => present(), operationId: "operation-1" };
  }

  test("registers the verified checkout under its exact branch name and clears the record", async () => {
    const calls: unknown[] = [];
    const context = await fixture({
      register: async input => {
        calls.push(input);
        return { workspaceId: "atlas-feature-login", started: false };
      },
    });
    const result = await registerCreatedWorktree(context);
    expect(result).toEqual({ workspaceId: "atlas-feature-login", started: false });
    // The VERIFIED identity travels with the registration: it is what the
    // registrar records as the child's relationship, so a later retry
    // recognizes the same checkout instead of registering a second one.
    expect(calls).toEqual([{ path: INTENT.destination, displayName: "feature/login", parentWorkspaceId: "atlas", identity: IDENTITY, start: false }]);
    expect(await context.journal.read()).toBeUndefined();
    expect((await context.provenance.byCheckoutId(IDENTITY.checkoutId))?.branch).toBe("feature/login");
  });

  test("registration failure retains the checkout and offers exactly one retry action", async () => {
    let attempts = 0;
    const context = await fixture({
      register: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("registry write failed at /var/state/registry.json");
        return { workspaceId: "atlas-feature-login", started: false };
      },
    });
    const failure = await registerCreatedWorktree(context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorktreeOperationError);
    if (failure instanceof WorktreeOperationError) {
      expect(failure.detail.code).toBe("registration-failed");
      expect(failure.detail.retry).toBe("retry-registration");
      expect(failure.detail.retainedCheckoutId).toBe(IDENTITY.checkoutId);
      // Sanitized: no state-root path reaches the compact originating flow.
      expect(failure.detail.message).not.toContain("/var/state");
    }
    // The record survives at `registering`, so the retry resumes here.
    expect((await context.journal.read())?.phase).toBe("registering");

    const retried = await registerCreatedWorktree(context);
    expect(retried.workspaceId).toBe("atlas-feature-login");
    expect(attempts).toBe(2);
    // Exactly one checkout, recorded once: no second tree was created.
    expect((await context.provenance.load()).length).toBe(1);
  });

  test("a start failure still reports a registered, stopped workspace", async () => {
    const context = await fixture({
      register: async () => ({ workspaceId: "atlas-feature-login", started: false, startError: "backend refused" }),
    });
    expect(await registerCreatedWorktree({ ...context, start: true }))
      .toEqual({ workspaceId: "atlas-feature-login", started: false, startError: "backend refused" });
  });

  test("a path that no longer holds the created checkout is never registered", async () => {
    const context = await fixture({ register: async () => ({ workspaceId: "nope", started: false }) });
    const replaced = registerCreatedWorktree({ ...context, inspect: async () => present({ repositoryId: IDENTITY.repositoryId, checkoutId: "checkout-different" }) });
    await expect(replaced).rejects.toThrow(/no longer holds the checkout/);
    const missing = registerCreatedWorktree({ ...context, inspect: async () => ({ present: false, identityReadable: true }) });
    await expect(missing).rejects.toThrow(/could not be verified/);
  });

  test("an unverified operation cannot be registered at all", async () => {
    const root = await stateRoot();
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    await journal.begin({ ...INTENT, phase: "creating" });
    await expect(registerCreatedWorktree({
      journal,
      provenance: new WorktreeProvenanceStore(worktreeProvenancePath(root)),
      registrar: { register: async () => ({ workspaceId: "nope", started: false }) },
      inspect: async () => present(),
      operationId: "operation-1",
    })).rejects.toThrow(/has not been verified/);
  });
});
