// The published worktree JSON family (task 6.2's server half).
//
// `/worktrees` (worktree-routes.ts) is the browser's server-rendered flow:
// HTML in, `{ redirect, completion }` out. An agent-invoked CLI needs neither
// — it needs the operations themselves, as data. So the same operations are
// published here as JSON, over the SAME WorktreeService, with the SAME
// safety and recovery rules. There is no second implementation of any check:
// this module is authorization, request validation, reference resolution and
// DTO mapping, and nothing else.
//
// Two credentials reach it, and only it:
//
//   * an ordinary Hub session (cookie or bearer). Cookie transports keep the
//     Hub's same-origin rule on every mutation; a bearer credential carries
//     no ambient authority and is exempt, exactly as elsewhere.
//   * a worktree capability (see worktree-capability.ts), which is pinned to
//     ONE repository family and is refused on every other Hub route before
//     that route's handler runs.
//
// A request that the Hub could process answers 200 and carries the
// operation's own structured outcome — including a refusal, which is a
// completed request with a sanitized `error`, not an HTTP failure. HTTP
// statuses are reserved for transport-level problems: unauthenticated,
// out of scope, malformed, unknown workspace, unavailable.

import {
  parseWorktreeCreateRequest,
  parseWorktreeDeleteRequest,
  WorktreeOperationError,
  worktreeError,
  type WorktreeCheckout,
  type WorktreeError,
  type WorktreeInventory,
  type WorktreeOperationResult,
  type WorktreeRefs,
  type WorktreeRefSelection,
} from "../shared/worktree-contract";
import { validWorktreeBranch } from "../shared/worktree-branches";
import { WORKTREE_API_PATH } from "../shared/worktree-context";
import type { WorktreeRouteDeps } from "./worktree-routes";

export { WORKTREE_API_PATH };

// The operations the JSON family serves. `list` is the GET on the family
// root; the rest are POSTs one path segment below it.
const ACTIONS = new Set(["create", "open", "delete"]);

export type WorktreeApiPrincipal = {
  readonly user: string;
  // Present for a capability token: the one main workspace whose repository
  // family this credential may operate on. A Hub session has none, and may
  // reach any workspace it can already see in the dashboard.
  readonly familyWorkspaceId?: string;
};

export type WorktreeApiDeps = Pick<
  WorktreeRouteDeps,
  "service" | "registry" | "startWorkspace" | "inventory" | "changed"
>;

export function isWorktreeApiPath(pathname: string): boolean {
  return pathname === WORKTREE_API_PATH || pathname.startsWith(`${WORKTREE_API_PATH}/`);
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// Every answer carries an operation id, refusals included: an agent that
// reports a failure should be able to name the attempt it is reporting.
function operationId(): string {
  return crypto.randomUUID();
}

function refusal(kind: "create" | "open" | "delete", error: WorktreeError): Response {
  const resultKind = kind === "open" ? "start" : kind;
  return json(200, { ok: false, operationId: operationId(), kind: resultKind, error } satisfies WorktreeOperationResult);
}

// Finds the checkout a caller named. A registered workspace id and a
// canonical checkout id are passed through untouched — those are the
// service's own vocabulary. An exact branch name is resolved against the
// AUTHORITATIVE inventory, which is a naming lookup and nothing more: the
// canonical identity it yields is what every safety check then runs on, so a
// reused path or a renamed folder cannot be addressed through a stale name.
export function resolveWorktreeReference(
  inventory: WorktreeInventory,
  reference: string,
): { ok: true; reference: string; checkout: WorktreeCheckout } | { ok: false; error: WorktreeError } {
  const byId = inventory.checkouts.find(
    checkout => checkout.workspaceId === reference || checkout.checkoutId === reference,
  );
  if (byId) return { ok: true, reference, checkout: byId };
  const byBranch = inventory.checkouts.filter(checkout => !checkout.main && checkout.branch === reference);
  if (byBranch.length === 1) {
    const checkout = byBranch[0]!;
    return { ok: true, reference: checkout.workspaceId ?? checkout.checkoutId, checkout };
  }
  if (byBranch.length > 1) {
    return {
      ok: false,
      error: worktreeError("conflict", "More than one checkout has that branch. Name the workspace id instead.", { retry: "refresh" }),
    };
  }
  return {
    ok: false,
    error: worktreeError("not-found", "No worktree of this repository matches that name.", { retry: "refresh" }),
  };
}

// Resolves an unqualified `--from` ref against the repository's own ref
// listing. "feature/login" is a valid LOCAL branch name and "origin/main" is
// a remote-qualified one, and nothing about the strings tells them apart —
// only the listing does. A ref that is not there is refused; a ref that is
// both is refused as ambiguous. Nothing is ever substituted for a near match.
export function resolveWorktreeBase(
  refs: Pick<WorktreeRefs, "local" | "remote">,
  ref: string,
): { ok: true; base: WorktreeRefSelection } | { ok: false; error: WorktreeError } {
  const local = refs.local.includes(ref);
  const remote = refs.remote.includes(ref);
  if (local && remote) {
    return {
      ok: false,
      error: worktreeError("conflict", `Both a local and a remote branch are named ${ref}. Name the exact one.`),
    };
  }
  if (local) return { ok: true, base: { kind: "local", ref } };
  if (remote) return { ok: true, base: { kind: "remote", ref } };
  return {
    ok: false,
    error: worktreeError("ref-unavailable", `No branch named ${ref} is available in this repository.`, { retry: "retry-fetch" }),
  };
}

export function createWorktreeApi(deps: WorktreeApiDeps) {
  const inventoryFor = async (sourceWorkspaceId: string, reason: "open" | "manual"): Promise<WorktreeInventory> =>
    (await deps.inventory?.(sourceWorkspaceId, reason)) ?? deps.service.inventory(sourceWorkspaceId);

  const committed = (sourceWorkspaceId: string, also?: string[]) => {
    try {
      deps.changed?.(sourceWorkspaceId, also);
    } catch {
      // Invalidation is a notification; it never fails the operation.
    }
  };

  // A child's operations run against its parent, which owns the repository
  // family and its credential policy — the same mapping the HTML flow makes.
  const sourceIdFor = (requested: string): string =>
    deps.registry.byId(requested)?.worktree?.parentWorkspaceId ?? requested;

  // Resolves and authorizes the repository family one request names.
  const resolveSource = (
    requested: string,
    principal: WorktreeApiPrincipal,
  ): { ok: true; source: string } | { ok: false; response: Response } => {
    if (requested === "") {
      return { ok: false, response: json(400, { error: "source workspace id required" }) };
    }
    const source = sourceIdFor(requested);
    if (!deps.registry.byId(source)) {
      return { ok: false, response: json(404, { error: "unknown workspace" }) };
    }
    // A capability is pinned to one family. Another family is refused
    // without describing it — the credential does not get to learn that a
    // workspace it may not touch exists.
    if (principal.familyWorkspaceId !== undefined && principal.familyWorkspaceId !== source) {
      return { ok: false, response: json(403, { error: "this credential authorizes another workspace" }) };
    }
    return { ok: true, source };
  };

  const list = async (url: URL, principal: WorktreeApiPrincipal): Promise<Response> => {
    const resolved = resolveSource(url.searchParams.get("source") ?? principal.familyWorkspaceId ?? "", principal);
    if (!resolved.ok) return resolved.response;
    return json(200, { inventory: await inventoryFor(resolved.source, "manual") });
  };

  const create = async (body: unknown, source: string, principal: WorktreeApiPrincipal): Promise<Response> => {
    const { baseRef, ...record } = body as Record<string, unknown>;
    // Branch grammar is checked BEFORE the repository is read, so an
    // option-like name, a revision expression or a traversal is refused as
    // input rather than reported as a missing ref — and never gets near a
    // Git argument list.
    if (record.branch !== undefined && (typeof record.branch !== "string" || !validWorktreeBranch(record.branch))) {
      return refusal("create", worktreeError("invalid-input", "That is not a valid branch name."));
    }
    let base = record.base;
    // A caller that names one ref instead of committing a qualified
    // selection gets it resolved HERE, against the authoritative listing —
    // the same data the UI's combobox offers. The client neither guesses nor
    // reads a repository to find out.
    if (base === undefined && typeof baseRef === "string") {
      let refs: WorktreeRefs;
      try {
        refs = await deps.service.refs(source);
      } catch (error) {
        return refusal("create", error instanceof WorktreeOperationError
          ? error.detail
          : worktreeError("inventory-unavailable", "The repository's branches are unavailable.", { retry: "refresh" }));
      }
      const resolved = resolveWorktreeBase(refs, baseRef);
      if (!resolved.ok) return refusal("create", resolved.error);
      base = resolved.base;
    }
    let request;
    try {
      request = parseWorktreeCreateRequest({ ...record, base, sourceWorkspaceId: source });
    } catch (error) {
      return refusal("create", worktreeError("invalid-input", error instanceof Error ? error.message : "The request is not valid."));
    }
    const result = await deps.service.create(principal.user, request);
    if (result.ok || result.retainedCheckout) committed(source);
    return json(200, result);
  };

  const open = async (body: unknown, source: string): Promise<Response> => {
    const record = (body ?? {}) as Record<string, unknown>;
    const reference = typeof record.reference === "string" ? record.reference : "";
    if (reference === "") {
      return refusal("open", worktreeError("invalid-input", "Name the worktree to open."));
    }
    const start = record.start === true;
    const inventory = await inventoryFor(source, "open");
    if (inventory.status === "error") {
      return refusal("open", inventory.error ?? worktreeError("inventory-unavailable", "The worktree inventory is unavailable.", { retry: "refresh" }));
    }
    const resolved = resolveWorktreeReference(inventory, reference);
    if (!resolved.ok) return refusal("open", resolved.error);
    const checkout = resolved.checkout;
    if (!checkout.registered || checkout.workspaceId === undefined) {
      return refusal("open", worktreeError(
        "not-found",
        "That checkout is not registered with Uatu. Register it from the workspace picker first.",
        { retry: "refresh", conflictCheckoutId: checkout.checkoutId },
      ));
    }
    if (checkout.availability !== "present") {
      return refusal("open", worktreeError(
        checkout.availability === "missing" ? "not-found" : "identity-uncertain",
        checkout.availability === "missing"
          ? "That checkout is no longer at its registered path. Resolve it before opening."
          : "A different checkout occupies that path. Resolve the conflict before opening.",
        { retry: "refresh" },
      ));
    }
    const workspaceId = checkout.workspaceId;
    // Already running, or the caller only asked where it is: report, never
    // start implicitly. Starting is explicit intent, as it is in the UI.
    if (checkout.running || !start) {
      return json(200, {
        ok: true,
        operationId: operationId(),
        kind: "start",
        phase: "complete",
        checkout,
        registered: true,
        started: checkout.running,
      } satisfies WorktreeOperationResult);
    }
    const started = await deps.startWorkspace(workspaceId);
    committed(source);
    // A failed explicit start does NOT fail the operation: the workspace
    // stays configured and stopped, and this reports why — the same rule
    // creation's post-commit start follows.
    return json(200, {
      ok: true,
      operationId: operationId(),
      kind: "start",
      phase: "complete",
      checkout: { ...checkout, running: started.ok },
      registered: true,
      started: started.ok,
      ...(started.ok ? {} : { startError: worktreeError("start-failed", started.message, { retry: "retry-start" }) }),
    } satisfies WorktreeOperationResult);
  };

  const remove = async (body: unknown, source: string, principal: WorktreeApiPrincipal): Promise<Response> => {
    const record = (body ?? {}) as Record<string, unknown>;
    // The explicit confirmation IS the authorization, exactly as the
    // destructive button is in the dialog. There is no force path past any
    // blocker, and no branch deletion anywhere.
    if (record.confirm !== true) {
      return refusal("delete", worktreeError("invalid-input", "Confirm deletion to continue. Nothing was removed."));
    }
    const reference = typeof record.reference === "string" ? record.reference : "";
    const inventory = await inventoryFor(source, "open");
    if (inventory.status === "error") {
      return refusal("delete", inventory.error ?? worktreeError("inventory-unavailable", "The worktree inventory is unavailable.", { retry: "refresh" }));
    }
    const resolved = resolveWorktreeReference(inventory, reference);
    if (!resolved.ok) return refusal("delete", resolved.error);
    let request;
    try {
      request = parseWorktreeDeleteRequest({
        sourceWorkspaceId: source,
        reference: resolved.reference,
        ...(record.stop === undefined ? {} : { stop: record.stop }),
      });
    } catch (error) {
      return refusal("delete", worktreeError("invalid-input", error instanceof Error ? error.message : "The request is not valid."));
    }
    const result = await deps.service.delete(principal.user, request);
    if (!result.ok) {
      // A cleanup that failed after verified removal still changed what
      // every open page must show.
      if (result.phase === "unregistering") committed(source, [resolved.reference]);
      return json(200, result);
    }
    committed(source, [resolved.reference]);
    return json(200, result);
  };

  return {
    // GET  /api/hub/worktrees?source=<workspaceId>
    // POST /api/hub/worktrees/{create,open,delete}
    async handle(request: Request, url: URL, principal: WorktreeApiPrincipal): Promise<Response> {
      const pathname = url.pathname;
      if (pathname === WORKTREE_API_PATH) {
        if (request.method !== "GET") return json(405, { error: "method not allowed" });
        return list(url, principal);
      }
      const action = pathname.slice(`${WORKTREE_API_PATH}/`.length);
      if (!ACTIONS.has(action)) return json(404, { error: "unknown worktree operation" });
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json(400, { error: "invalid JSON body" });
      }
      const requested = (body as Record<string, unknown>).sourceWorkspaceId;
      const resolved = resolveSource(
        typeof requested === "string" && requested !== "" ? requested : principal.familyWorkspaceId ?? "",
        principal,
      );
      if (!resolved.ok) return resolved.response;
      try {
        if (action === "create") return await create(body, resolved.source, principal);
        if (action === "open") return await open(body, resolved.source);
        return await remove(body, resolved.source, principal);
      } catch (error) {
        // Every refusal the service raises is already sanitized; anything
        // else becomes the contract's generic internal error rather than a
        // stack trace or a path.
        const detail = error instanceof WorktreeOperationError
          ? error.detail
          : worktreeError("internal", "The worktree operation could not be completed.");
        return refusal(action as "create" | "open" | "delete", detail);
      }
    },
  };
}
