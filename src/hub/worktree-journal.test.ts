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
  writeRemovalMarker,
  removalMarkerPresent,
  type WorktreeCreateIntent,
  type WorktreeDeleteIntent,
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

const INTENT: Omit<WorktreeCreateIntent, "version"> = {
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
  async function recoverAt(phase: WorktreeCreateIntent["phase"], inspection: CheckoutInspection, options: {
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
  async function fixture(registrar: WorktreeRegistrar, options: { phase?: WorktreeCreateIntent["phase"] } = {}) {
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

describe("removal intent and restart recovery (5.4)", () => {
  async function setup(phase: WorktreeDeleteIntent["phase"]) {
    const root = await stateRoot();
    const administrativeDirectory = path.join(root, "common", "worktrees", "feature-login");
    await nodeFs.mkdir(administrativeDirectory, { recursive: true });
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    await provenance.record({ ...IDENTITY, path: INTENT.destination, branch: "feature/login", sourceRef: "main", operationId: "create-1", createdBy: "dev", createdAt: 1 });
    const intent: Omit<WorktreeDeleteIntent, "version"> = {
      operationId: "delete-1",
      kind: "delete",
      phase: "preflight",
      user: "dev",
      repositoryId: IDENTITY.repositoryId,
      sourceWorkspaceId: "atlas",
      sourcePath: "/repos/atlas",
      destination: INTENT.destination,
      checkoutId: IDENTITY.checkoutId,
      administrativeDirectory,
      branch: "feature/login",
      workspaceId: "feature-login",
    };
    await journal.begin(intent);
    if (phase !== "preflight") await journal.advance("delete-1", phase);
    const cleaned: string[] = [];
    return { root, journal, provenance, administrativeDirectory, cleaned, completeRemoval: async (pending: WorktreeDeleteIntent) => { cleaned.push(pending.operationId); await provenance.forgetCheckout(pending.checkoutId); } };
  }

  test("a removal intent refuses creation fields and a creation intent refuses removal fields", async () => {
    const root = await stateRoot();
    const journal = new WorktreeJournal(worktreeJournalPath(root));
    await expect(journal.begin({ ...INTENT, administrativeDirectory: "/x" } as never)).rejects.toThrow();
    const removal = { operationId: "d", kind: "delete", phase: "preflight", user: "u", repositoryId: "r", sourceWorkspaceId: "a", sourcePath: "/a", destination: "/b", checkoutId: "c", administrativeDirectory: "/c", branch: "x", mode: "new-branch" };
    await expect(journal.begin(removal as never)).rejects.toThrow();
    const { mode: _mode, ...valid } = removal;
    const recorded = await journal.begin(valid as never);
    expect((recorded as { kind: string }).kind).toBe("delete");
    // Phases stay in the removal vocabulary.
    await expect(journal.advance("d", "creating")).rejects.toThrow();
    await expect(journal.begin(INTENT)).rejects.toThrow();
  });

  test("interrupted before removal: files and registration untouched, fence lifted", async () => {
    for (const phase of ["preflight", "fencing", "stopping", "rechecking"] as const) {
      const { journal, provenance, completeRemoval, cleaned } = await setup(phase);
      const outcome = await recoverWorktreeOperation({ journal, provenance, inspect: async () => present(), completeRemoval });
      expect(outcome?.kind).toBe("removal-not-performed");
      expect(cleaned).toEqual([]);
      expect(await provenance.byCheckoutId(IDENTITY.checkoutId)).toBeDefined();
      expect(await journal.read()).toBeUndefined();
    }
  });

  test("interrupted during removal with our marker still present: not removed, marker cleared", async () => {
    const { journal, provenance, administrativeDirectory, completeRemoval, cleaned } = await setup("removing");
    await writeRemovalMarker(administrativeDirectory, "delete-1");
    const outcome = await recoverWorktreeOperation({ journal, provenance, inspect: async () => present(), completeRemoval });
    expect(outcome?.kind).toBe("removal-not-performed");
    expect(cleaned).toEqual([]);
    expect(await removalMarkerPresent(administrativeDirectory, "delete-1")).toBe(false);
  });

  test("interrupted after Git removed the tree: cleanup finishes, provenance goes, branch history stays", async () => {
    const { journal, provenance, completeRemoval, cleaned } = await setup("removing");
    const outcome = await recoverWorktreeOperation({ journal, provenance, inspect: async () => ({ present: false, identityReadable: true }), completeRemoval });
    expect(outcome?.kind).toBe("removed");
    expect(cleaned).toEqual(["delete-1"]);
    expect(await provenance.byCheckoutId(IDENTITY.checkoutId)).toBeUndefined();
    expect(await provenance.branchOrigin(IDENTITY.repositoryId, "feature/login")).toBe("main");
    expect(await journal.read()).toBeUndefined();
  });

  test("a new tree reusing the path and identity is recognized as a new occupant and left alone", async () => {
    // Git reuses the administrative name, so the identity matches; the
    // missing marker is what proves our tree was removed.
    const { journal, provenance, completeRemoval, cleaned } = await setup("removing");
    const outcome = await recoverWorktreeOperation({ journal, provenance, inspect: async () => present(), completeRemoval });
    expect(outcome?.kind).toBe("removed");
    expect(cleaned).toEqual(["delete-1"]);
    // The occupant cannot inherit ownership from the removed tree.
    const ownership = await ownershipForCheckout({ provenance, inspection: present(), checkoutPath: INTENT.destination });
    expect(ownership.ownership).toBe("external");
  });

  test("a cleanup persistence failure keeps the record at unregistering for a later retry", async () => {
    const { journal, provenance } = await setup("removing");
    const failing = await recoverWorktreeOperation({
      journal, provenance, inspect: async () => ({ present: false, identityReadable: true }),
      completeRemoval: async () => { throw new Error("disk full"); },
    });
    expect(failing?.kind).toBe("removal-cleanup-pending");
    expect((await journal.read())?.phase).toBe("unregistering");
    const retried = await recoverWorktreeOperation({ journal, provenance, inspect: async () => ({ present: false, identityReadable: true }), completeRemoval: async () => undefined });
    expect(retried?.kind).toBe("removed");
    expect(await journal.read()).toBeUndefined();
  });

  test("unreadable state or a contradicted record is uncertain and kept", async () => {
    const unreadable = await setup("removing");
    const outcome = await recoverWorktreeOperation({ ...unreadable, inspect: async () => ({ present: true, identityReadable: false, detail: "EACCES" }) });
    expect(outcome?.kind).toBe("uncertain");
    expect(await unreadable.journal.read()).toBeDefined();
    const contradicted = await setup("unregistering");
    await writeRemovalMarker(contradicted.administrativeDirectory, "delete-1");
    const second = await recoverWorktreeOperation({ ...contradicted, inspect: async () => present() });
    expect(second?.kind).toBe("uncertain");
    expect(contradicted.cleaned).toEqual([]);
  });
});

describe("branch creation history (5.5)", () => {
  test("survives checkout removal, is kept by a checkout of the existing branch, and is replaced by a new creation", async () => {
    const root = await stateRoot();
    const provenance = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    await provenance.record({ ...IDENTITY, path: "/a", branch: "feature/login", sourceRef: "release", operationId: "o1", createdBy: "dev", createdAt: 1 });
    await provenance.forgetCheckout(IDENTITY.checkoutId);
    expect(await provenance.branchOrigin(IDENTITY.repositoryId, "feature/login")).toBe("release");
    await provenance.record({ ...IDENTITY, checkoutId: "checkout-2", path: "/b", branch: "feature/login", operationId: "o2", createdBy: "dev", createdAt: 2 });
    const reopened = new WorktreeProvenanceStore(worktreeProvenancePath(root));
    expect(await reopened.branchOrigin(IDENTITY.repositoryId, "feature/login")).toBe("release");
    expect(await reopened.branchOrigin("another-repository", "feature/login")).toBeUndefined();
    await reopened.record({ ...IDENTITY, checkoutId: "checkout-3", path: "/c", branch: "feature/login", sourceRef: "main", operationId: "o3", createdBy: "dev", createdAt: 3 });
    expect(await reopened.branchOrigin(IDENTITY.repositoryId, "feature/login")).toBe("main");
  });
});
