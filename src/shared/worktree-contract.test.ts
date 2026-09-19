import { describe, expect, test } from "bun:test";

import {
  canAdvanceWorktreePhase,
  canDeleteWorktree,
  isTerminalWorktreePhase,
  isWorktreePhase,
  parseWorktreeCheckout,
  parseWorktreeCreateRequest,
  parseWorktreeDeleteRequest,
  parseWorktreeForgetRequest,
  parseWorktreeError,
  unknownWorktreeInventory,
  WORKTREE_UNKNOWN_REPOSITORY,
  parseWorktreeInventory,
  parseWorktreeOperationResult,
  resolveWorktreeOwnership,
  sanitizeWorktreeMessage,
  WORKTREE_CREATE_PHASES,
  WORKTREE_MESSAGE_LIMIT,
  WorktreeOperationError,
  worktreeError,
  worktreePhases,
  type WorktreeCheckout,
  type WorktreeInventory,
  type WorktreeOperationResult,
} from "./worktree-contract";

// The contract has to serve every state the approved UX shows, so the client
// dialog (src/shell/worktree-dialog.ts) can render each of them from one
// published JSON family. The fixture table below is that claim, written
// once: one artifact per reviewed state, all of them wire-legal.

// One contract artifact per reviewed state. Every entry is parsed below, so
// a fixture that drifts out of the contract fails the suite.

const checkout = (overrides: Record<string, unknown> = {}): unknown => ({
  checkoutId: "checkout-sidebar",
  repositoryId: "repository-atlas",
  workspaceId: "atlas-sidebar",
  parentWorkspaceId: "atlas",
  path: "/demo/workspaces/atlas.worktrees/feature-sidebar",
  branch: "feature/sidebar",
  detached: false,
  main: false,
  ownership: "uatu",
  availability: "present",
  registered: true,
  running: false,
  locked: false,
  sourceRef: "main",
  ...overrides,
});

const inventory = (overrides: Record<string, unknown> = {}): unknown => ({
  repositoryId: "repository-atlas",
  sourceWorkspaceId: "atlas",
  status: "ready",
  checkouts: [checkout()],
  refs: { local: ["main", "feature/sidebar", "release"], remote: ["origin/release"], fetchedAt: null },
  ...overrides,
});

const failure = (overrides: Record<string, unknown>): unknown => ({
  ok: false,
  operationId: "operation-1",
  kind: "create",
  ...overrides,
});

type Fixture = { inventory?: unknown; result?: unknown };

const FIXTURES: Record<string, Fixture> = {
  // --- inventory shape -----------------------------------------------------
  populated: { inventory: inventory() },
  empty: { inventory: inventory({ checkouts: [] }) },
  loading: { inventory: inventory({ status: "loading", checkouts: [] }) },
  "inventory-error": {
    inventory: inventory({
      status: "error",
      error: { code: "inventory-unavailable", message: "Inventory could not be refreshed. Retry refresh.", retry: "refresh" },
    }),
  },
  // --- main checkout identity ---------------------------------------------
  "non-main": { inventory: inventory({ checkouts: [checkout({ checkoutId: "checkout-main", workspaceId: "atlas", parentWorkspaceId: undefined, path: "/demo/workspaces/atlas", branch: "feature/current", main: true, ownership: "main", running: true, sourceRef: undefined })] }) },
  detached: { inventory: inventory({ checkouts: [checkout({ checkoutId: "checkout-main", workspaceId: "atlas", parentWorkspaceId: undefined, path: "/demo/workspaces/atlas", branch: null, detached: true, main: true, ownership: "main", running: true, sourceRef: undefined })] }) },
  "unknown-branch": { inventory: inventory({ checkouts: [checkout({ checkoutId: "checkout-main", workspaceId: "atlas", parentWorkspaceId: undefined, path: "/demo/workspaces/atlas", branch: null, main: true, ownership: "main", running: true, sourceRef: undefined })] }) },
  "mixed-lifecycle": { inventory: inventory({ checkouts: [checkout({ running: true })] }) },
  "all-stopped": { inventory: inventory({ checkouts: [checkout({ running: false })] }) },
  // --- Create from base selection -----------------------------------------
  "remote-main": { inventory: inventory({ refs: { local: ["feature/current"], remote: ["origin/main", "origin/release"], fetchedAt: null } }) },
  "ambiguous-main": { inventory: inventory({ refs: { local: ["feature/current"], remote: ["origin/main", "upstream/main"], fetchedAt: null } }) },
  "no-main": { inventory: inventory({ refs: { local: ["feature/current"], remote: ["origin/release"], fetchedAt: null } }) },
  stale: { inventory: inventory({ refs: { local: ["main"], remote: ["origin/release"], fetchedAt: null } }) },
  // --- fetch ---------------------------------------------------------------
  "fetch-auth": { result: failure({ kind: "fetch", error: { code: "fetch-authentication", message: "Fetch authentication failed. Correct credentials on the parent and retry.", retry: "retry-fetch" } }) },
  "fetch-network": { result: failure({ kind: "fetch", error: { code: "fetch-network", message: "Fetch network failure. Cached refs remain unchanged.", retry: "retry-fetch" } }) },
  "fetch-disappearance": { result: failure({ kind: "fetch", error: { code: "ref-unavailable", message: "The selected branch is no longer available. Choose another branch.", retry: "none" } }) },
  // --- creation refusals ---------------------------------------------------
  "branch-conflict": { result: failure({ phase: "validating", error: { code: "branch-exists", message: "Branch name already exists. Choose another name or use an existing local branch; no branch was reset.", retry: "none" } }) },
  "path-conflict": { result: failure({ phase: "reserving", error: { code: "destination-occupied", message: "Destination already exists. Existing content was preserved.", retry: "none" } }) },
  "checked-out": { result: failure({ phase: "validating", error: { code: "branch-in-use", message: "Branch already checked out. Open its existing checkout instead.", retry: "open-existing", conflictCheckoutId: "checkout-sidebar" } }) },
  // --- partial outcomes ----------------------------------------------------
  "registration-failure": {
    result: failure({
      phase: "registering",
      error: { code: "registration-failed", message: "Registration failed. The checkout and branch are retained. Retry registration.", retry: "retry-registration", retainedCheckoutId: "checkout-created-1", phase: "registering" },
      retainedCheckout: checkout({ checkoutId: "checkout-created-1", workspaceId: undefined, registered: false, sourceRef: "main" }),
    }),
  },
  "start-failure": {
    result: {
      ok: true,
      operationId: "operation-1",
      kind: "create",
      phase: "starting",
      checkout: checkout({ checkoutId: "checkout-created-1", workspaceId: "atlas-created-1" }),
      registered: true,
      started: false,
      startError: { code: "start-failed", message: "Start failed. The configured workspace remains stopped. Retry Start.", retry: "retry-start" },
    },
  },
  // --- discovery and availability -----------------------------------------
  discovery: { inventory: inventory({ checkouts: [checkout({ checkoutId: "checkout-agent", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/exploration", path: "/demo/workspaces/atlas-agent", sourceRef: undefined })] }) },
  missing: { inventory: inventory({ checkouts: [checkout({ checkoutId: "checkout-review", workspaceId: "atlas-review", ownership: "external", branch: "review/accessibility", availability: "missing", sourceRef: undefined })] }) },
  replaced: { inventory: inventory({ checkouts: [checkout({ checkoutId: "checkout-review", workspaceId: "atlas-review", ownership: "uncertain", branch: "review/accessibility", availability: "replaced", sourceRef: undefined })] }) },
  // --- deletion blockers ---------------------------------------------------
  dirty: { result: failure({ kind: "delete", phase: "preflight", error: { code: "local-data", message: "Save or discard tracked changes outside Uatu, then try again. Files and registration retained.", retry: "none" } }) },
  untracked: { result: failure({ kind: "delete", phase: "preflight", error: { code: "local-data", message: "Preserve or remove untracked files outside Uatu, then try again. Files and registration retained.", retry: "none" } }) },
  ignored: { result: failure({ kind: "delete", phase: "preflight", error: { code: "local-data", message: "Preserve or remove ignored files outside Uatu, then try again. Files and registration retained.", retry: "none" } }) },
  locked: { result: failure({ kind: "delete", phase: "preflight", error: { code: "git-lock", message: "Resolve the Git lock outside Uatu, then try again. Files and registration retained.", retry: "none" } }) },
  "in-use": { result: failure({ kind: "delete", phase: "preflight", error: { code: "external-activity", message: "External activity is using this checkout. Stop it outside Uatu, then try again.", retry: "none" } }) },
  nested: { result: failure({ kind: "delete", phase: "preflight", error: { code: "nested-dependency", message: "Resolve the nested checkout dependency outside Uatu, then try again.", retry: "none" } }) },
  "stop-failure": { result: failure({ kind: "delete", phase: "stopping", error: { code: "stop-failed", message: "Could not stop the Uatu session. Checkout and registration retained; no removal occurred.", retry: "retry-delete" } }) },
};

describe("worktree contract fixtures", () => {
  test("every reviewed state has one wire-legal artifact", () => {
    for (const [scenario, fixture] of Object.entries(FIXTURES)) {
      expect(`${scenario}:${Boolean(fixture.inventory ?? fixture.result)}`).toBe(`${scenario}:true`);
      if (fixture.inventory) expect(parseWorktreeInventory(fixture.inventory).repositoryId).toBe("repository-atlas");
      if (fixture.result) expect(parseWorktreeOperationResult(fixture.result).operationId).toBe("operation-1");
    }
  });

  test("occupancy conflicts point at the existing checkout instead of forcing", () => {
    const result = parseWorktreeOperationResult(FIXTURES["checked-out"].result) as Extract<WorktreeOperationResult, { ok: false }>;
    expect(result.error.code).toBe("branch-in-use");
    expect(result.error.retry).toBe("open-existing");
    expect(result.error.conflictCheckoutId).toBe("checkout-sidebar");
  });

  test("registration failure retains the exact checkout it created", () => {
    const result = parseWorktreeOperationResult(FIXTURES["registration-failure"].result) as Extract<WorktreeOperationResult, { ok: false }>;
    expect(result.error.retry).toBe("retry-registration");
    expect(result.retainedCheckout?.registered).toBe(false);
    expect(result.retainedCheckout?.workspaceId).toBeUndefined();
    expect(result.retainedCheckout?.checkoutId).toBe(result.error.retainedCheckoutId);
  });

  test("a failed explicit start still reports a successful stopped creation", () => {
    const result = parseWorktreeOperationResult(FIXTURES["start-failure"].result) as Extract<WorktreeOperationResult, { ok: true }>;
    expect(result.registered).toBe(true);
    expect(result.started).toBe(false);
    expect(result.startError?.retry).toBe("retry-start");
  });

  test("an errored inventory stays explicitly stale rather than empty", () => {
    const stale = parseWorktreeInventory(FIXTURES["inventory-error"].inventory) as WorktreeInventory;
    expect(stale.status).toBe("error");
    expect(stale.error?.retry).toBe("refresh");
    expect(stale.checkouts).toHaveLength(1);
  });

  test("detached and unknown main checkouts are explicit, never guessed", () => {
    for (const scenario of ["detached", "unknown-branch"] as const) {
      const [main] = parseWorktreeInventory(FIXTURES[scenario].inventory).checkouts;
      expect(main?.branch).toBeNull();
      expect(main?.main).toBe(true);
    }
    expect(parseWorktreeInventory(FIXTURES.detached.inventory).checkouts[0]?.detached).toBe(true);
    expect(parseWorktreeInventory(FIXTURES["unknown-branch"].inventory).checkouts[0]?.detached).toBe(false);
  });
});

describe("deletion is gated on verified ownership alone", () => {
  test("only verified Uatu-created present checkouts may be deleted", () => {
    const cases: [string, unknown, boolean][] = [
      ["owned and present", checkout(), true],
      ["the main checkout", checkout({ checkoutId: "checkout-main", workspaceId: "atlas", parentWorkspaceId: undefined, path: "/atlas", main: true, ownership: "main", sourceRef: undefined }), false],
      ["an external discovery", checkout({ checkoutId: "checkout-agent", workspaceId: undefined, registered: false, ownership: "external", sourceRef: undefined }), false],
      ["an owned but missing checkout", checkout({ availability: "missing" }), false],
      ["an uncertain identity at a replaced path", checkout({ ownership: "uncertain", availability: "replaced" }), false],
    ];
    for (const [what, value, deletable] of cases) {
      expect(`${what}:${canDeleteWorktree(parseWorktreeCheckout(value))}`).toBe(`${what}:${deletable}`);
    }
  });
});

describe("bounded operation phases", () => {
  test("phases advance forward only, within their own operation", () => {
    expect(worktreePhases("create")).toEqual(WORKTREE_CREATE_PHASES);
    expect(canAdvanceWorktreePhase("create", "creating", "registering")).toBe(true);
    expect(canAdvanceWorktreePhase("create", "creating", "creating")).toBe(false);
    expect(canAdvanceWorktreePhase("create", "registering", "creating")).toBe(false);
    expect(canAdvanceWorktreePhase("create", "validating", "removing" as never)).toBe(false);
    expect(canAdvanceWorktreePhase("delete", "fencing", "removing")).toBe(true);
  });

  test("the phase vocabulary is closed and has one terminal phase", () => {
    expect(isWorktreePhase("create", "creating")).toBe(true);
    expect(isWorktreePhase("create", "removing")).toBe(false);
    expect(isWorktreePhase("create", "almost-done")).toBe(false);
    expect(isTerminalWorktreePhase("create", "complete")).toBe(true);
    expect(isTerminalWorktreePhase("create", "starting")).toBe(false);
    expect(worktreePhases("delete").filter(phase => isTerminalWorktreePhase("delete", phase))).toEqual(["complete"]);
  });

  test("a result cannot carry a phase from another operation", () => {
    expect(() => parseWorktreeOperationResult(failure({ kind: "delete", phase: "registering", error: { code: "internal", message: "no", retry: "none" } })))
      .toThrow(/unknown phase/);
  });
});

describe("ownership and identity", () => {
  const atlas = { repositoryId: "repository-atlas", checkoutId: "checkout-sidebar" };
  const other = { repositoryId: "repository-atlas", checkoutId: "checkout-other" };

  test("the main checkout is the repository's, never an owned worktree", () => {
    expect(resolveWorktreeOwnership({ main: true, observed: atlas })).toEqual({ ownership: "main", availability: "present" });
  });

  test("provenance is matched by checkout identity, not by path", () => {
    expect(resolveWorktreeOwnership({ main: false, observed: atlas, provenance: { identity: atlas, path: "/moved/elsewhere" } }))
      .toEqual({ ownership: "uatu", availability: "present" });
  });

  test("a reused path never inherits an older record's ownership", () => {
    expect(resolveWorktreeOwnership({
      main: false,
      observed: other,
      observedPath: "/demo/atlas.worktrees/feature-sidebar",
      provenance: { identity: atlas, path: "/demo/atlas.worktrees/feature-sidebar" },
    })).toEqual({ ownership: "external", availability: "present" });
  });

  test("a registration pointing at a different checkout is uncertain, not repaired", () => {
    expect(resolveWorktreeOwnership({ main: false, observed: other, registered: atlas, provenance: { identity: atlas, path: "/demo" } }))
      .toEqual({ ownership: "uncertain", availability: "replaced" });
  });

  test("an unreadable identity is uncertain and blocks destructive actions", () => {
    const resolved = resolveWorktreeOwnership({ main: false, identityReadable: false, provenance: { identity: atlas, path: "/demo" } });
    expect(resolved).toEqual({ ownership: "uncertain", availability: "present" });
    expect(canDeleteWorktree({ ...resolved, main: false })).toBe(false);
  });

  test("a missing path keeps its classification and never becomes deletable", () => {
    const owned = resolveWorktreeOwnership({ main: false, registered: atlas, provenance: { identity: atlas, path: "/demo" } });
    expect(owned).toEqual({ ownership: "uatu", availability: "missing" });
    expect(canDeleteWorktree({ ...owned, main: false })).toBe(false);
    expect(resolveWorktreeOwnership({ main: false, registered: atlas })).toEqual({ ownership: "external", availability: "missing" });
  });

  test("an observed tree with no record is external, not adopted", () => {
    expect(resolveWorktreeOwnership({ main: false, observed: atlas })).toEqual({ ownership: "external", availability: "present" });
  });

  test("a path occupied by something that is not a checkout is a conflict", () => {
    expect(resolveWorktreeOwnership({ main: false, present: true, registered: atlas, provenance: { identity: atlas, path: "/demo" } }))
      .toEqual({ ownership: "uncertain", availability: "replaced" });
  });
});

describe("sanitized error contract", () => {
  test("absolute paths, credentials and tokens never reach a message", () => {
    const message = sanitizeWorktreeMessage(
      "fatal: could not read /Users/someone/repos/atlas/.git/worktrees/x; remote https://user:s3cr3t@example.test/repo.git rejected token=abcd1234 ghp_ABCDEFGHIJKLMNOP",
    );
    expect(message).not.toContain("/Users/someone");
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain("abcd1234");
    expect(message).not.toContain("ghp_ABCDEFGHIJKLMNOP");
    expect(message).toContain("[path]");
    expect(message).toContain("https://example.test");
  });

  test("control characters collapse and long output is bounded", () => {
    const message = sanitizeWorktreeMessage(`git said [31m\n${"x".repeat(1000)}`);
    expect(message.length).toBe(WORKTREE_MESSAGE_LIMIT);
    expect(message.endsWith("…")).toBe(true);
    expect(message).not.toContain(" ");
    expect(message).not.toContain("");
  });

  test("relative refs survive: only absolute paths are redacted", () => {
    expect(sanitizeWorktreeMessage("origin/release is not a local branch (refs/heads/main exists)"))
      .toBe("origin/release is not a local branch (refs/heads/main exists)");
  });

  test("errors built or parsed are sanitized either way", () => {
    expect(worktreeError("internal", "failed at /var/tmp/x").message).toBe("failed at [path]");
    expect(parseWorktreeError({ code: "internal", message: "failed at /var/tmp/x", retry: "none" }).message).toBe("failed at [path]");
  });

  test("the error vocabulary is closed", () => {
    expect(() => parseWorktreeError({ code: "made-up", message: "x", retry: "none" })).toThrow(/not a known value/);
    expect(() => parseWorktreeError({ code: "internal", message: "x", retry: "reboot" })).toThrow(/not a known value/);
    expect(() => parseWorktreeError({ code: "internal", message: "x", retry: "none", detail: "/private" })).toThrow(/unknown field/);
  });

  test("an operation error carries its sanitized detail", () => {
    const error = WorktreeOperationError.of("local-data", "ignored files under /home/me/atlas", { retry: "none" });
    expect(error.detail.code).toBe("local-data");
    expect(error.message).toBe("ignored files under [path]");
  });
});

describe("contract validation refuses shapes the UI could not trust", () => {
  test("an unregistered checkout cannot claim a workspace, and vice versa", () => {
    expect(() => parseWorktreeCheckout(checkout({ registered: false }))).toThrow(/workspaceId/);
    expect(() => parseWorktreeCheckout(checkout({ workspaceId: undefined }))).toThrow(/workspaceId/);
  });

  test("an unavailable checkout cannot be reported running", () => {
    expect(() => parseWorktreeCheckout(checkout({ availability: "missing", running: true }))).toThrow(/cannot be running/);
  });

  test("a detached checkout cannot also name a branch", () => {
    expect(() => parseWorktreeCheckout(checkout({ detached: true }))).toThrow(/cannot name a branch/);
  });

  test("inventory status and error must agree, and checkouts share one repository", () => {
    expect(() => parseWorktreeInventory(inventory({ status: "error" }))).toThrow(/status and error must agree/);
    expect(() => parseWorktreeInventory(inventory({ checkouts: [checkout({ repositoryId: "repository-beacon" })] }))).toThrow(/mixes repositories/);
  });

  test("create requests must agree with their base and reject option-like names", () => {
    expect(parseWorktreeCreateRequest({ sourceWorkspaceId: "atlas", mode: "new-branch", branch: "feature/login", base: { kind: "local", ref: "main" } }).base.ref).toBe("main");
    expect(() => parseWorktreeCreateRequest({ sourceWorkspaceId: "atlas", mode: "new-branch", base: { kind: "local", ref: "main" } })).toThrow(/requires a name/);
    expect(() => parseWorktreeCreateRequest({ sourceWorkspaceId: "atlas", mode: "new-branch", branch: "--force", base: { kind: "local", ref: "main" } })).toThrow(/valid branch name/);
    expect(() => parseWorktreeCreateRequest({ sourceWorkspaceId: "atlas", mode: "remote-tracking", branch: "release", base: { kind: "local", ref: "release" } })).toThrow(/remote ref/);
    expect(() => parseWorktreeCreateRequest({ sourceWorkspaceId: "atlas", mode: "existing-local", base: { kind: "remote", ref: "origin/release" } })).toThrow(/local ref/);
  });

  test("a successful result cannot also carry a failure", () => {
    expect(() => parseWorktreeOperationResult({ ok: true, operationId: "o", kind: "create", phase: "complete", registered: true, started: false, error: { code: "internal", message: "x", retry: "none" } }))
      .toThrow(/cannot carry an error/);
  });
});

describe("identity unknown (section 4 review item a)", () => {
  test("an unidentifiable repository has one wire-legal spelling that round-trips", () => {
    const inventory = unknownWorktreeInventory("atlas", worktreeError("inventory-unavailable", "The repository could not be inspected.", { retry: "refresh" }));
    expect(inventory.repositoryId).toBe(WORKTREE_UNKNOWN_REPOSITORY);
    expect(parseWorktreeInventory(JSON.parse(JSON.stringify(inventory)))).toEqual(inventory);
  });

  test("the reserved identity cannot pose as a settled listing or carry checkouts", () => {
    const base = unknownWorktreeInventory("atlas", worktreeError("not-found", "Not a repository."));
    const { error: _error, ...withoutError } = base;
    expect(() => parseWorktreeInventory({ ...withoutError, status: "ready" })).toThrow();
    const checkout = {
      checkoutId: "c", repositoryId: WORKTREE_UNKNOWN_REPOSITORY, path: "/r", branch: "main", detached: false, main: true,
      ownership: "main", availability: "present", registered: false, running: false, locked: false,
    };
    expect(() => parseWorktreeInventory({ ...base, checkouts: [checkout] })).toThrow();
    // An empty identity is still refused outright.
    expect(() => parseWorktreeInventory({ ...base, repositoryId: "" })).toThrow();
  });
});

describe("removal requests", () => {
  test("delete and forget requests are closed and typed", () => {
    expect(parseWorktreeDeleteRequest({ sourceWorkspaceId: "atlas", reference: "feature-x", stop: true })).toEqual({ sourceWorkspaceId: "atlas", reference: "feature-x", stop: true });
    expect(parseWorktreeForgetRequest({ sourceWorkspaceId: "atlas", reference: "feature-x" })).toEqual({ sourceWorkspaceId: "atlas", reference: "feature-x" });
    expect(() => parseWorktreeDeleteRequest({ sourceWorkspaceId: "atlas", reference: "x", force: true })).toThrow();
    expect(() => parseWorktreeDeleteRequest({ sourceWorkspaceId: "atlas", reference: "x", deleteBranch: true })).toThrow();
    expect(() => parseWorktreeDeleteRequest({ sourceWorkspaceId: "atlas", reference: "", stop: false })).toThrow();
    expect(() => parseWorktreeForgetRequest({ sourceWorkspaceId: "atlas", reference: "x", stop: "yes" })).toThrow();
  });
});
