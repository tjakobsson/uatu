// The authenticated worktree surface (task 4.4).
//
// Shape and vocabulary are the ones the approved UI already speaks
// (src/shell/worktree-picker.ts): a same-origin presentation GET that
// renders through worktree-pages, and form-encoded action POSTs that answer
// `{ redirect, completion? }`. The picker owns navigation and focus; this
// module owns authorization, request validation and the mapping between the
// shared contract DTOs and that presentation.
//
// Authorization rules, applied by the Hub's gate before anything here runs
// and re-checked here where the operation is user-scoped:
//   * every route requires an authenticated Hub session;
//   * every mutation is POST + the Hub's same-origin check for cookie
//     transports (a bearer credential carries no ambient authority);
//   * an operation's progress and its retry belong to the user who started
//     it — another user is told it does not exist, not what it is.
//
// The server keeps no per-user draft state: a fetch or a refused creation
// round-trips its draft through the redirect's query string, which is what
// lets a bounded, stateless Hub preserve the name, query and a still-valid
// selection exactly as the approved flow requires.

import { sanitizeWorktreeMessage, type WorktreeCheckout, type WorktreeCreateRequest, type WorktreeError, type WorktreeInventory } from "../shared/worktree-contract";
import { worktreePage, type WorktreePresentation, type WorktreeRow } from "./worktree-pages";
import type { WorkspaceRegistry } from "./registry";
import type { WorktreeService } from "./worktree-service";

export const WORKTREE_PREFIX = "/worktrees";

// Views and operations the real Hub serves. `folder` is the read-only
// explanation of the Git-dependency rename guard. Display-name rename and
// parent credential settings are managed on the Hub dashboard's own rows,
// so the picker presentation is told not to link them (see `capabilities`)
// rather than rendering forms with no operation behind them.
const VIEWS = new Set(["inventory", "create", "result", "configure", "delete", "forget", "folder"]);
const ACTIONS = new Set(["refresh", "fetch", "create", "register", "start", "delete", "forget"]);
const CAPABILITIES = { settings: false, rename: false } as const;

// Draft fields carried across a redirect. Everything else in the query
// string is ignored, so a crafted link cannot inject an unexpected field.
const DRAFT_FIELDS = ["mode", "branch", "query", "selection"] as const;

export type WorktreeStartOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type WorktreeRouteDeps = {
  service: WorktreeService;
  registry: Pick<WorkspaceRegistry, "byId" | "byPath" | "list">;
  // The Hub's own session start, with its recovery fences. Worktree routes
  // never spawn a child themselves.
  startWorkspace: (workspaceId: string) => Promise<WorktreeStartOutcome>;
  // The parent's live credential policy, for the inherited-policy notice.
  credentialSummary?: (workspaceId: string) => { authentication: string; signing: string };
  // The authoritative inventory read, through the reconciler when the Hub
  // has one (so a read also updates the change baseline). Defaults to the
  // service directly.
  inventory?: (sourceWorkspaceId: string, reason: "open" | "manual") => Promise<WorktreeInventory>;
  // A Uatu operation committed: invalidate every page that shows this
  // repository, immediately.
  // `also` names workspaces an operation just unregistered, whose own open
  // pages the family lookup can no longer find.
  changed?: (sourceWorkspaceId: string, also?: string[]) => void;
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function freshnessLabel(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return "Cached branches · not fetched in this Hub session · the remote may have changed";
  const minutes = Math.max(0, Math.round((now - fetchedAt) / 60_000));
  if (minutes < 1) return "Fetched just now";
  if (minutes < 60) return `Fetched ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `Fetched ${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function worktreeRowFor(
  checkout: WorktreeCheckout,
  deps: Pick<WorktreeRouteDeps, "registry" | "credentialSummary">,
): WorktreeRow {
  const entry = checkout.workspaceId === undefined ? undefined : deps.registry.byId(checkout.workspaceId);
  // Policy is disclosed from the parent for a child, from the workspace
  // itself for a main checkout: a relationship, never a copied value.
  const policyOwner = entry?.worktree?.parentWorkspaceId ?? checkout.workspaceId;
  const policy = policyOwner === undefined ? undefined : deps.credentialSummary?.(policyOwner);
  return {
    // An unregistered checkout is addressed by its canonical checkout
    // identity; a registered one by its stable workspace id.
    id: checkout.workspaceId ?? checkout.checkoutId,
    // The child's name IS its branch; only a main checkout keeps a label.
    name: checkout.main ? entry?.displayName ?? checkout.branch ?? "Repository" : checkout.branch ?? entry?.displayName ?? "detached",
    path: checkout.path,
    branch: checkout.branch ?? "",
    ...(checkout.detached ? { detached: true } : {}),
    ownership: checkout.ownership,
    registered: checkout.registered,
    running: checkout.running,
    ...(checkout.availability === "present" ? {} : { availability: checkout.availability }),
    checkout: checkout.checkoutId,
    ...(checkout.upstream === undefined ? {} : { upstream: checkout.upstream }),
    ...(checkout.sourceRef === undefined ? {} : { sourceRef: checkout.sourceRef }),
    ...(checkout.parentWorkspaceId === undefined ? {} : { parentId: checkout.parentWorkspaceId }),
    repositoryId: checkout.repositoryId,
    ...(policy ? { authentication: policy.authentication, signing: policy.signing } : {}),
  };
}

export function presentationFor(options: {
  view: WorktreePresentation["view"];
  inventory: WorktreeInventory;
  deps: Pick<WorktreeRouteDeps, "registry" | "credentialSummary">;
  selectedId?: string;
  draft?: Record<string, string>;
  creationMode?: string;
  message?: string;
  error?: boolean;
  conflictId?: string;
  now?: number;
}): WorktreePresentation {
  const { inventory, deps } = options;
  const rows = inventory.checkouts.map(checkout => worktreeRowFor(checkout, deps));
  const sourceEntry = deps.registry.byId(inventory.sourceWorkspaceId);
  // The repository's main checkout is the policy owner and the fork target;
  // a source that is itself a child resolves to its parent's main row.
  const source = rows.find(row => row.ownership === "main")
    ?? rows.find(row => row.id === inventory.sourceWorkspaceId)
    ?? {
      id: inventory.sourceWorkspaceId,
      name: sourceEntry?.displayName ?? inventory.sourceWorkspaceId,
      path: sourceEntry?.path ?? "",
      branch: "",
      ownership: "main" as const,
      registered: sourceEntry !== undefined,
      running: false,
      checkout: inventory.repositoryId,
      repositoryId: inventory.repositoryId,
    };
  const fetchedAt = inventory.refs.fetchedAt;
  return {
    view: options.view,
    source,
    rows,
    ...(options.selectedId === undefined ? {} : { selected: rows.find(row => row.id === options.selectedId) }),
    ...(options.message === undefined ? {} : { message: options.message }),
    error: options.error === true,
    ...(options.conflictId === undefined ? {} : { conflictId: options.conflictId }),
    draft: options.draft ?? {},
    // "fresh" claims a network fetch in THIS flow; a cached listing never does.
    fresh: false,
    ...(options.creationMode === undefined ? {} : { creationMode: options.creationMode }),
    // "No linked worktrees yet" is about the LINKED trees; the repository's
    // own main checkout is always there.
    empty: rows.every(row => row.ownership === "main"),
    loading: false,
    credentials: [],
    refs: {
      bases: [],
      local: inventory.refs.local.map(ref => [ref, ref] as [string, string]),
      remote: inventory.refs.remote.map(ref => [ref, ref] as [string, string]),
      freshness: freshnessLabel(fetchedAt, options.now ?? Date.now()),
    },
    defaults: { branch: "", parent: "", folder: "", name: "" },
    prefix: WORKTREE_PREFIX,
    capabilities: CAPABILITIES,
  };
}

function draftFrom(source: URLSearchParams | FormData): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of DRAFT_FIELDS) {
    const value = source.get(field);
    if (typeof value === "string" && value !== "") draft[field] = value;
  }
  return draft;
}

function redirectTo(options: {
  view: string;
  source: string;
  id?: string;
  draft?: Record<string, string>;
  message?: string;
  error?: boolean;
  conflict?: string;
}): string {
  const params = new URLSearchParams({ view: options.view, source: options.source });
  if (options.id !== undefined) params.set("id", options.id);
  if (options.draft !== undefined) {
    // Marks the view as carrying a SUBMITTED draft, however empty it is:
    // the initial base rules apply only when a dialog is first opened, never
    // to a draft that came back from a fetch or a refused creation.
    params.set("draft", "1");
    for (const [key, value] of Object.entries(options.draft)) params.set(key, value);
  }
  if (options.message !== undefined) params.set("message", options.message);
  if (options.error === true) params.set("error", "1");
  if (options.conflict !== undefined) params.set("conflict", options.conflict);
  return `${WORKTREE_PREFIX}?${params.toString()}`;
}

// A create form as the approved dialog submits it, mapped onto the shared
// create request. An unparsable selection is a refusal, never a guess.
export function createRequestFrom(form: FormData, sourceWorkspaceId: string): WorktreeCreateRequest {
  const selection = String(form.get("selection") ?? "");
  const separator = selection.indexOf(":");
  const kind = selection.slice(0, separator);
  const ref = selection.slice(separator + 1);
  if ((kind !== "local" && kind !== "remote") || ref === "") {
    throw new Error("Select an available branch.");
  }
  const mode = String(form.get("mode") ?? "");
  if (mode === "new") {
    const branch = String(form.get("branch") ?? "").trim();
    if (branch === "") throw new Error("Enter a name for the new branch.");
    return { sourceWorkspaceId, mode: "new-branch", branch, base: { kind, ref }, start: form.get("start") !== null };
  }
  if (mode !== "existing") throw new Error("Select an available branch.");
  return {
    sourceWorkspaceId,
    mode: kind === "remote" ? "remote-tracking" : "existing-local",
    base: { kind, ref },
    start: form.get("start") !== null,
  };
}

export function createWorktreeRoutes(deps: WorktreeRouteDeps) {
  const inventoryFor = async (sourceWorkspaceId: string, reason: "open" | "manual" = "open"): Promise<WorktreeInventory> =>
    (await deps.inventory?.(sourceWorkspaceId, reason)) ?? deps.service.inventory(sourceWorkspaceId);
  const committed = (sourceWorkspaceId: string, also?: string[]) => {
    try {
      deps.changed?.(sourceWorkspaceId, also);
    } catch {
      // Invalidation is a notification; it never fails the operation.
    }
  };

  // The main workspace a fork targets: a child's operations are performed
  // against its parent, which is the repository's policy owner.
  const sourceIdFor = (requested: string): string => deps.registry.byId(requested)?.worktree?.parentWorkspaceId ?? requested;

  const render = async (url: URL): Promise<Response> => {
    const view = url.searchParams.get("view") ?? "inventory";
    if (!VIEWS.has(view)) return json(404, { error: "unknown worktree view" });
    const requested = url.searchParams.get("source") ?? url.searchParams.get("id") ?? "";
    const sourceWorkspaceId = sourceIdFor(requested);
    if (!deps.registry.byId(sourceWorkspaceId)) return json(404, { error: "unknown workspace" });
    const inventory = await inventoryFor(sourceWorkspaceId);
    const creationMode = url.searchParams.get("mode") ?? undefined;
    // Opening a fresh creation dialog discards any older draft, so the
    // initial base rules apply exactly once — on opening, never on a
    // submitted draft or after a fetch.
    const fresh = view === "create" && creationMode !== undefined && url.searchParams.get("draft") !== "1";
    const message = url.searchParams.get("message");
    const model = presentationFor({
      view: view as WorktreePresentation["view"],
      inventory,
      deps,
      ...(url.searchParams.get("id") === null ? {} : { selectedId: url.searchParams.get("id")! }),
      draft: fresh ? {} : draftFrom(url.searchParams),
      ...(creationMode === undefined ? {} : { creationMode }),
      ...(fresh || message === null ? {} : { message: sanitizeWorktreeMessage(message) }),
      error: !fresh && url.searchParams.get("error") === "1",
      ...(url.searchParams.get("conflict") === null ? {} : { conflictId: url.searchParams.get("conflict")! }),
    });
    if (inventory.status === "error" && model.message === undefined) {
      model.message = inventory.error?.message;
      model.error = true;
    }
    if (view === "delete" && model.selected && !model.error) {
      // The dialog's consequences come from a fresh preflight: a blocker
      // replaces them, and a running (or starting) tree asks for Stop and
      // delete. Nothing here mutates.
      const preflight = await deps.service.preflightDelete({ sourceWorkspaceId, reference: model.selected.id });
      if (!preflight.ok) {
        model.message = preflight.error.message;
        model.error = true;
      } else {
        model.selected = { ...model.selected, running: preflight.requiresStop };
      }
    }
    return html(worktreePage(model, "", "", url.searchParams.get("fragment") === "1"));
  };

  const failure = (source: string, view: string, error: WorktreeError, draft?: Record<string, string>, id?: string) => json(200, {
    redirect: redirectTo({
      view,
      source,
      ...(id === undefined ? {} : { id }),
      ...(draft === undefined ? {} : { draft }),
      message: error.message,
      error: true,
      ...(error.conflictCheckoutId === undefined ? {} : { conflict: error.conflictCheckoutId }),
    }),
  });

  const act = async (request: Request, action: string, user: string): Promise<Response> => {
    if (!ACTIONS.has(action)) return json(405, { error: "unsupported worktree operation" });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, { error: "invalid worktree operation request" });
    }
    const requested = String(form.get("source") ?? "");
    const source = sourceIdFor(requested);
    if (!deps.registry.byId(source)) return json(404, { error: "unknown workspace" });

    if (action === "refresh") {
      const inventory = await inventoryFor(source, "manual");
      return json(200, {
        redirect: redirectTo({
          view: "inventory",
          source,
          message: inventory.status === "error"
            ? inventory.error!.message
            : "Inventory refreshed. Your workspace and conversation selection are unchanged.",
          error: inventory.status === "error",
        }),
      });
    }

    if (action === "fetch") {
      const draft = draftFrom(form);
      const outcome = await deps.service.fetch(source);
      if (outcome.error) return failure(source, "create", outcome.error, draft);
      // A selection that disappeared from the refreshed listing is cleared
      // rather than substituted; the name and query survive untouched.
      const available = new Set([
        ...outcome.refs.local.map(ref => `local:${ref}`),
        ...outcome.refs.remote.map(ref => `remote:${ref}`),
      ]);
      if (draft.selection !== undefined && !available.has(draft.selection)) {
        delete draft.selection;
        return json(200, {
          redirect: redirectTo({
            view: "create",
            source,
            draft,
            message: "That branch is no longer available. Choose another branch.",
            error: true,
          }),
        });
      }
      return json(200, { redirect: redirectTo({ view: "create", source, draft }) });
    }

    if (action === "create") {
      const draft = draftFrom(form);
      let createRequest: WorktreeCreateRequest;
      try {
        createRequest = createRequestFrom(form, source);
      } catch (error) {
        return json(200, {
          redirect: redirectTo({
            view: "create",
            source,
            draft,
            message: error instanceof Error ? error.message : "Select an available branch.",
            error: true,
          }),
        });
      }
      const result = await deps.service.create(user, createRequest);
      // A retained checkout is a committed change too: the picker must show it.
      if (result.ok || result.retainedCheckout) committed(source);
      if (!result.ok) {
        // A retained checkout keeps its own recovery view, so the retry acts
        // on that same tree instead of creating another one.
        if (result.retainedCheckout) {
          // The recovery view is addressed by the RETAINED CHECKOUT, so the
          // retry acts on that verified tree rather than on a job number.
          return json(200, {
            redirect: redirectTo({
              view: "configure",
              source,
              id: result.retainedCheckout.checkoutId,
              message: result.error.message,
              error: true,
            }),
          });
        }
        return failure(source, "create", result.error, draft);
      }
      return json(200, {
        redirect: redirectTo({ view: "result", source, id: result.checkout!.workspaceId! }),
        completion: {
          message: `Created ${result.checkout!.branch}`,
          id: result.checkout!.workspaceId!,
          source,
        },
      });
    }

    if (action === "register") {
      const reference = String(form.get("id") ?? "");
      const result = await deps.service.registerExisting(user, source, reference, form.get("start") !== null);
      if (result.ok) committed(source);
      if (!result.ok) {
        return json(200, {
          redirect: redirectTo({ view: "configure", source, id: reference, message: result.error.message, error: true }),
        });
      }
      const verb = result.checkout!.ownership === "uatu" ? "Created" : "Registered";
      return json(200, {
        redirect: redirectTo({ view: "result", source, id: result.checkout!.workspaceId! }),
        completion: { message: `${verb} ${result.checkout!.branch}`, id: result.checkout!.workspaceId!, source },
      });
    }

    if (action === "delete") {
      const reference = String(form.get("id") ?? "");
      // The destructive button is the authorization; a request without it
      // is not a confirmed deletion.
      if (form.get("confirm") !== "1") {
        return json(200, { redirect: redirectTo({ view: "delete", source, id: reference, message: "Confirm deletion to continue. Nothing was removed.", error: true }) });
      }
      const result = await deps.service.delete(user, { sourceWorkspaceId: source, reference, stop: form.get("stop") === "1" });
      if (!result.ok) {
        // A cleanup that failed after verified removal still changed what
        // the picker must show.
        if (result.phase === "unregistering") committed(source, [reference]);
        return json(200, { redirect: redirectTo({ view: "delete", source, id: reference, message: result.error.message, error: true }) });
      }
      committed(source, [reference]);
      return json(200, {
        redirect: redirectTo({ view: "inventory", source, message: "Worktree deleted. Branch kept." }),
        completion: { message: "Worktree deleted. Branch kept.", deleted: reference, source },
      });
    }

    if (action === "forget") {
      const reference = String(form.get("id") ?? "");
      if (form.get("confirm") === null) {
        return json(200, { redirect: redirectTo({ view: "forget", source, id: reference, message: "Confirm to continue. Nothing changed.", error: true }) });
      }
      // The confirmation's wording is "Stop Uatu activity and remove only the
      // Hub registration": it authorizes the stop, and nothing more.
      const result = await deps.service.forget(user, { sourceWorkspaceId: source, reference, stop: true });
      if (!result.ok) {
        return json(200, { redirect: redirectTo({ view: "forget", source, id: reference, message: result.error.message, error: true }) });
      }
      committed(source, [reference]);
      const message = "Removed from Uatu. Checkout, branch and files were kept.";
      return json(200, {
        redirect: redirectTo({ view: "inventory", source, message }),
        completion: { message, deleted: reference, source },
      });
    }

    const workspaceId = String(form.get("id") ?? "");
    const entry = deps.registry.byId(workspaceId);
    if (!entry) return json(404, { error: "unknown workspace" });
    const started = await deps.startWorkspace(workspaceId);
    committed(source);
    if (!started.ok) {
      return json(200, {
        redirect: redirectTo({ view: "result", source, id: workspaceId, message: started.message, error: true }),
      });
    }
    return json(200, { redirect: `/s/${encodeURIComponent(workspaceId)}/` });
  };

  return {
    // GET /worktrees[?view=…] — the approved presentation, whole page or
    // picker fragment.
    render,
    // POST /worktrees/<action> — one bounded operation.
    act,
    // GET /worktrees/operation — the pending operation, for its initiator
    // only. Another user's operation is reported as absent.
    async operation(user: string): Promise<Response> {
      const progress = await deps.service.progress(user);
      if (!progress) return json(404, { error: "no pending worktree operation" });
      return json(200, { operation: progress });
    },
  };
}
