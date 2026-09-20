// The one worktree dialog, rendered by the client from the Hub's published
// worktree JSON family (`/api/hub/worktrees`, see src/hub/worktree-api.ts).
//
// It replaces the retired server-rendered fragment flow: nothing here asks
// the Hub for presentation, and nothing here performs Git, registration or
// startup policy — every mutation is one bounded JSON operation whose
// refusal is an ordinary `{ok:false, error}` answer carrying the short
// actionable reason this module displays.
//
// Both entry points embed THIS module, unchanged:
//   * the in-workspace picker (src/shell/hub-nav.ts) imports its named
//     exports as ordinary ESM bindings;
//   * the Hub dashboard (src/hub/pages.ts) inlines `worktreeDialogScript`
//     as a plain, unbundled `<script>` tag.
// Runtime helpers stay in closed factory scopes. Canonical domain rules and
// contract parsers live in shared modules and are injected by stable property
// keys. Never concatenate independently minified functions expecting their
// lexical identifiers to match: each serialized factory must contain all its
// bindings or receive them as arguments. Production minifies identifiers, not
// property keys; the minified inline-script smoke test guards this seam.
//
// The API base is always supplied by the caller from `/api/hub/state`'s
// `worktreeApi` field. No root-relative Hub URL literal is built here, so
// shared/app-url-discipline.test.ts needs no allowlist entry for this file:
// the Hub API lives outside a session's base path and is therefore never
// passed through appUrl() (the same rule hub-nav.ts documents).

import { createWorktreeBranchRules } from "../shared/worktree-branches";
import { worktreeParsers, worktreeParsersScript, type WorktreeCheckout } from "../shared/worktree-contract";

/** One checkout as the inventory describes it, reduced to what the dialog
 *  renders. `id` is the registered workspace id when there is one and the
 *  canonical checkout identity otherwise — both are references the JSON
 *  family resolves. */
export type WorktreeDialogRow = {
  id: string;
  name: string;
  path: string;
  branch: string;
  ownership: "main" | "uatu" | "external" | "uncertain";
  registered: boolean;
  running: boolean;
  availability?: "missing" | "replaced";
  checkout: string;
  workspaceId?: string;
  main: boolean;
  /** Recorded branch-creation history, when the Hub has any. Never inferred. */
  sourceRef?: string;
};

/** The repository the dialog acts on: the Hub-state row of the MAIN
 *  checkout, whose display name titles every child and whose credential
 *  summary is the policy children inherit. */
export type WorktreeDialogSource = {
  id: string;
  name: string;
  authentication?: string;
  signing?: string;
};

export type WorktreeDialogOptions = {
  /** `/api/hub/state`'s `worktreeApi` — the published family's base path. */
  api: string;
  source: WorktreeDialogSource;
  /** `discover` is the fork menu's "Register worktree…" view: the compact
   *  list of checkouts Git lists for this repository that Uatu has NOT
   *  registered. There is no general inventory view — every registered
   *  checkout is managed from the picker's and the dashboard's own rows. */
  view: "discover" | "create" | "delete" | "register" | "forget" | "result";
  mode?: "new" | "existing";
  /** The checkout a non-inventory view acts on. */
  id?: string;
  message?: string;
  error?: boolean;
};

export type WorktreeDialogModel = {
  view: WorktreeDialogOptions["view"];
  source: WorktreeDialogSource & { path: string };
  rows: WorktreeDialogRow[];
  refs: { local: string[]; remote: string[] };
  selected?: WorktreeDialogRow;
  mode?: "new" | "existing";
  draft?: Record<string, string>;
  message?: string;
  error?: boolean;
  conflictId?: string;
  loading?: boolean;
  empty?: boolean;
  /** Delete: what a fresh preflight found. */
  requiresStop?: boolean;
  blocked?: boolean;
};

/** Defines every runtime helper the dialog needs, nested inside this one
 *  function, then assigns the public entry points onto `target` by property
 *  name. See the file header for why this shape is what makes
 *  `worktreeDialogScript` safe under minification. Installation does not touch
 *  the DOM; only invoking its UI entry points does. */
export function installWorktreeDialog<T extends Record<string, unknown>>(
  target: T,
  branches: ReturnType<typeof createWorktreeBranchRules>,
  parsers: typeof worktreeParsers,
) {
  const { WORKTREE_BRANCH_NAME_MAX_LENGTH, validWorktreeBranch, initialWorktreeBase, localTrackingBranch } = branches;
  async function readResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
    if (!response.ok) throw new Error("Request failed. Nothing was retried automatically.");
    try { return parse(await response.json()); }
    catch { throw new Error("Invalid worktree response. Close and retry. Nothing was retried automatically."); }
  }

  /** F7 (2026-09-19 live test): the refs "Existing branch" may offer. A
   *  branch some checkout already has is not a choice — the Hub refuses a
   *  worktree on it ("That branch is already checked out…"), so listing it
   *  can only produce that refusal. A remote ref whose derived local
   *  tracking name already exists locally is excluded for the same reason:
   *  the existing rule makes that a conflict, never a reset, so this dialog
   *  could never create it either. "New branch / worktree" is deliberately
   *  unaffected — a checked-out base is perfectly valid to branch FROM. */
  function worktreeExistingRefs(
    rows: { branch?: string }[],
    refs: { local: string[]; remote: string[] },
  ): { local: string[]; remote: string[] } {
    const occupied = new Set(rows
      .map(row => row.branch)
      .filter((branch): branch is string => typeof branch === "string" && branch !== ""));
    const locals = new Set(refs.local);
    return {
      local: refs.local.filter(ref => !occupied.has(ref)),
      remote: refs.remote.filter(ref => {
        const tracking = localTrackingBranch(ref);
        return !occupied.has(tracking) && !locals.has(tracking);
      }),
    };
  }

  /** F11 (2026-09-19 live test): the one fork glyph every surface draws —
   *  a long sideways trunk with a branch curving off it — defined here so
   *  the SPA's picker (shell/hub-nav.ts) and the dashboard's inlined copy
   *  of this module (hub/pages.ts, which reads it by this plain name off
   *  `window`) cannot drift apart. */
  const worktreeForkIcon = '<svg viewBox="0 0 32 20" width="30" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="6" r="2.4"/><circle cx="28" cy="6" r="2.4"/><circle cx="28" cy="15" r="2.4"/><path d="M6.4 6h19.2M6.4 6.8c7 1.5 8 8.2 15 8.2h4.2"/></svg>';

  function worktreeEscape(value: unknown): string {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Verbatim from the retired server-rendered presentation: the dialog looks
  // the same because it IS the same stylesheet, now shipped with the client.
  function worktreeDialogStyle(): string {
    return `<style>
.wt-content{line-height:1.5}
.wt-branches{max-height:264px;overflow:auto;border:1px solid var(--border-soft);border-radius:8px}.wt-branch{display:flex;gap:8px;align-items:center;padding:10px 12px;min-height:44px;cursor:pointer}.wt-branch span:first-child{flex:1;overflow-wrap:anywhere}.wt-branch small{font-size:11px;border:1px solid var(--border-medium);padding:1px 5px;border-radius:4px;color:var(--text-subtle)}.wt-branch[data-active]{background:var(--surface-hover,#8882)}.wt-branch[aria-selected=true]{box-shadow:inset 3px 0 var(--accent);color:var(--accent)}.wt-branch[aria-selected=true]:after{content:'✓'}.wt-creation .wt-actions{justify-content:flex-end;margin:0}.wt-creation h2{margin-bottom:16px}
.wt-content *{box-sizing:border-box}.wt-heading{margin:0 0 .4rem;font-size:1.35rem}.wt-lead,.wt-muted{color:var(--text-subtle)}.wt-muted{font-size:.85rem;overflow-wrap:anywhere}
.wt-toolbar,.wt-actions{display:flex;flex-wrap:wrap;gap:.65rem;align-items:center;margin:.9rem 0}.wt-card{padding:1rem;border:1px solid var(--border-soft);border-radius:8px;margin:8px 0}.wt-card h3{margin:0;font-size:1rem;overflow-wrap:anywhere}.wt-card-top{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}.wt-path{font: .8rem var(--mono-font-family);overflow-wrap:anywhere}
.wt-card-path{font: .8rem var(--mono-font-family);color:var(--text-subtle);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.wt-form p{overflow-wrap:anywhere}
.wt-button,.wt-content button{display:inline-flex;align-items:center;min-height:40px;border:1px solid var(--border-medium);border-radius:6px;padding:.45rem .7rem;background:transparent;color:inherit;text-decoration:none;font:inherit}.wt-button.primary,.wt-content button.primary{background:var(--accent);color:white}.wt-content button:disabled{opacity:.5;cursor:wait}.wt-content .danger{border-color:var(--danger)}
.wt-notice{padding:1rem;border:1px solid var(--accent);border-radius:8px;margin:1rem 0;overflow-wrap:anywhere}.wt-notice.error{border-color:var(--danger)}.wt-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.wt-form{display:grid;gap:1rem}.wt-form label{display:grid;gap:.35rem;font-weight:600;font-size:.9rem}.wt-form label.check{display:flex;align-items:start;font-weight:400}.wt-form input:not([type=checkbox]),.wt-form select{width:100%;min-width:0;background:var(--surface,#fff);color:inherit;border:1px solid var(--border-medium);border-radius:5px;padding:.55rem}.wt-form fieldset{border:1px solid var(--border-soft);border-radius:6px;min-width:0}.wt-form legend{font-weight:600}.wt-summary{display:grid;grid-template-columns:8rem 1fr;gap:.55rem}.wt-summary dd{margin:0;overflow-wrap:anywhere}.wt-summary dt{color:var(--text-subtle)}.wt-content :focus-visible{outline:2px solid var(--accent);outline-offset:3px}.wt-content [hidden]{display:none!important}
@media(max-width:600px){.wt-grid{grid-template-columns:1fr}.wt-content button,.wt-button{min-height:44px}.wt-summary{grid-template-columns:1fr;gap:.2rem}.wt-summary dd{margin-bottom:.7rem}}
</style>`;
  }

  /** The row's lifecycle label. Availability outranks registration: a missing
   *  or replaced path is never reported as merely stopped. */
  function worktreeRowState(row: WorktreeDialogRow): string {
    if (row.availability === "missing") return "Missing checkout";
    if (row.availability === "replaced") return "Identity conflict — path replaced";
    if (!row.registered) return "Not registered";
    return row.running ? "Running" : "Stopped";
  }

  /** The one muted provenance line a non-main checkout carries, wherever it
   *  is shown: the picker's menu rows (hub-nav.ts), the dashboard's rows
   *  (pages.ts) and this dialog's register list. Ownership outranks recorded
   *  history, because "from main" on a tree Uatu did not create would claim
   *  provenance Uatu does not have; `origin unknown` is therefore reserved
   *  for a Uatu-owned branch with no recorded creation history. Never
   *  inferred from names or paths — the Hub's verified provenance decides. */
  function worktreeProvenanceLabel(row: { ownership?: string; sourceRef?: string }): string {
    if (row.ownership === "external") return "External worktree";
    if (row.ownership === "uncertain") return "Ownership uncertain";
    return row.sourceRef ? `from ${row.sourceRef}` : "origin unknown";
  }

  /** Maps one inventory checkout onto the dialog's row. `sourceName` titles
   *  the repository's own main checkout; a child IS its branch. */
  function worktreeRowFrom(checkout: Record<string, unknown>, sourceName: string): WorktreeDialogRow {
    const branch = typeof checkout.branch === "string" ? checkout.branch : "";
    const workspaceId = typeof checkout.workspaceId === "string" ? checkout.workspaceId : undefined;
    const checkoutId = String(checkout.checkoutId ?? "");
    const main = checkout.main === true;
    return {
      id: workspaceId ?? checkoutId,
      name: main ? sourceName || branch || "Repository" : branch || "detached",
      path: String(checkout.path ?? ""),
      branch,
      ownership: checkout.ownership === "main" || checkout.ownership === "uatu"
        || checkout.ownership === "external" || checkout.ownership === "uncertain"
        ? checkout.ownership : "uncertain",
      registered: checkout.registered === true,
      running: checkout.running === true,
      ...(checkout.availability === "missing" || checkout.availability === "replaced"
        ? { availability: checkout.availability as "missing" | "replaced" }
        : {}),
      checkout: checkoutId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      main,
      ...(typeof checkout.sourceRef === "string" && checkout.sourceRef !== ""
        ? { sourceRef: checkout.sourceRef }
        : {}),
    };
  }

  /** The one row action a state deserves, plus the recovery text an
   *  unavailable checkout replaces it with. Nothing here recreates anything:
   *  a missing or replaced path only ever offers another authoritative read. */
  function worktreeRowPrimary(row: WorktreeDialogRow): string {
    const h = worktreeEscape;
    if (row.availability) {
      return `<p role="alert">${h(worktreeRowState(row))}. Restore the original checkout externally, then retry refresh. Nothing will be recreated.</p>`
        + `<button data-action="refresh">Retry refresh</button>`;
    }
    if (!row.registered) {
      return `<button class="primary" data-action="view" data-view="register" data-id="${h(row.id)}">${row.ownership === "uatu" ? "Retry registration" : "Register workspace"}</button>`;
    }
    if (row.running) {
      return `<a class="wt-button primary" href="/s/${encodeURIComponent(row.id)}/" data-opening>Open</a>`;
    }
    return `<button class="primary" data-action="start" data-id="${h(row.id)}">Start</button>`;
  }

  /** The whole view as markup. Pure over the model, so every unit test drives
   *  the same renderer the browser runs. */
  function renderWorktreeView(m: WorktreeDialogModel): string {
    const h = worktreeEscape;
    const conflict = m.conflictId === undefined ? undefined : m.rows.find(row =>
      row.id === m.conflictId || row.checkout === m.conflictId || row.path === m.conflictId);
    const notice = m.message === undefined || m.message === ""
      ? ""
      : `<div class="wt-notice${m.error ? " error" : ""}" role="${m.error ? "alert" : "status"}" tabindex="-1">${h(m.message)}${conflict ? `<div class="wt-actions">${worktreeRowPrimary(conflict)}</div>` : ""}</div>`;
    const identity = m.selected
      ? `<p style="overflow-wrap:anywhere"><strong>${h(m.source.name)} / ${h(m.selected.branch)}</strong></p>`
      : "";
    const cancel = '<button type="button" data-cancel>Cancel</button>';
    // Until the first authoritative answer lands, a view shows its own title
    // and nothing else: no form the user can type a draft into that the first
    // render would then replace.
    const pending = '<p role="status">Loading worktree inventory…</p>';
    // A compact view's loading state keeps Cancel reachable and names what it
    // is waiting for, rather than leaving the user with nothing clickable.
    const pendingWith = (text: string) => `<p role="status">${h(text)}</p><div class="wt-actions" style="justify-content:flex-end">${cancel}</div>`;
    // The inventory read (or, for delete, its own preflight) can fail after a
    // compact view has already committed to a specific checkout. When that
    // leaves no matching row, the form must never render silently disabled —
    // it must not render at all, replaced by the actionable reason.
    const notFound = (fallback: string) =>
      `<p role="alert" tabindex="-1">${h(m.message ?? fallback)}</p><div class="wt-actions" style="justify-content:flex-end">${cancel}</div>`;
    let body = "";
    if (m.view === "discover") {
      // "Register worktree…": ONLY the checkouts Git lists for this
      // repository that Uatu has not registered — a tree created outside
      // Uatu, or a Uatu-created checkout whose registration did not
      // complete. Everything already registered is managed from the rows
      // the picker and the dashboard already show (including their inline
      // Retry refresh for a missing or replaced path), so there is no
      // general inventory view, no Refresh/Create toolbar and no main row.
      const unregistered = m.rows.filter(row => !row.registered && !row.main);
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Register worktree</h2>`
        + `<p class="wt-lead">Worktrees of <strong>${h(m.source.name)}</strong> that Git lists and Uatu has not registered. Registering never moves files, transfers cleanup ownership or copies conversations.</p>`;
      body += m.loading
        ? pendingWith("Loading worktree inventory…")
        : unregistered.length === 0
          ? `${m.error ? "" : '<p role="status">Every worktree Git lists is registered.</p>'}<div class="wt-actions" style="justify-content:flex-end">${cancel}</div>`
          : unregistered.map(r => `<article class="wt-card" data-workspace="${h(r.id)}"><div class="wt-card-top"><h3>${h(r.branch || r.name)}</h3></div><p class="wt-muted">${h(worktreeProvenanceLabel(r))}</p><p class="wt-card-path" title="${h(r.path)}">${h(r.path)}</p><div class="wt-actions">${worktreeRowPrimary(r)}</div></article>`).join("")
            + `<div class="wt-actions" style="justify-content:flex-end">${cancel}</div>`;
      body += `</section>`;
    } else if (m.view === "create") {
      const draft = m.draft ?? {};
      const existing = m.mode === "existing";
      // Existing mode offers only branches no checkout holds; New mode keeps
      // every ref, because branching FROM a checked-out base is legal.
      const offered = existing ? worktreeExistingRefs(m.rows, m.refs) : m.refs;
      const branches = [
        ...offered.local.map(ref => ({ ref, kind: "local" })),
        ...offered.remote.map(ref => ({ ref, kind: "remote" })),
      ];
      // (d) Nothing left to choose: say why, and leave Create disabled —
      // it is only ever enabled by committing an option.
      const noneOffered = existing && branches.length === 0;
      // The initial base rule applies ONLY to a freshly opened New dialog:
      // a draft that came back from a fetch or a refused create keeps exactly
      // what the user chose, including an explicitly cleared choice.
      const selection = draft.selection ?? (m.draft || existing ? "" : initialWorktreeBase([...m.refs.local], [...m.refs.remote]));
      const query = draft.query ?? branches.find(({ ref, kind }) => `${kind}:${ref}` === selection)?.ref ?? "";
      const heading = `${existing ? "Existing branch" : "New branch / worktree"} · ${m.source.name}`;
      const name = existing ? "" : `<label>Name<input name="branch" value="${h(draft.branch ?? "")}" required></label>`
        // W2: a name over the shared 64-character ceiling is refused before
        // Git ever runs. updateWorktreeCreate() keeps this in sync with the
        // input as the user types; it starts hidden because an untouched
        // field is never too long.
        + `<p class="wt-muted" data-branch-name-hint role="status" hidden></p>`;
      const options = branches.map(({ ref, kind }, index) =>
        `<div id="wt-branch-${index}" class="wt-branch" role="option" aria-selected="${selection === `${kind}:${ref}`}" data-value="${h(`${kind}:${ref}`)}" data-search="${h(ref)}"><span>${h(ref)}</span><small>${kind === "remote" ? "Remote" : "Local"}</small></div>`).join("");
      const field = `<input type="hidden" name="selection" value="${h(selection)}">`
        + `<div style="display:flex;gap:8px;align-items:end"><label style="flex:1;min-width:0">${existing ? "Branch" : "Create from"}<input name="query" value="${h(query)}" data-branch-search role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="wt-branch-list" placeholder="Search branches…" autocomplete="off"></label>`
        + `<button type="button" data-fetch aria-label="Fetch remote branches" title="Fetch remote branches" style="padding:8px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg></button></div>`
        + `<div id="wt-branch-list" class="wt-branches" role="listbox" aria-label="Branches">${options}<p data-branch-empty class="wt-muted" role="status"${noneOffered ? "" : " hidden"} style="padding:12px">${noneOffered ? "Every branch is already checked out. Create a new branch instead." : "No matching branches"}</p></div>`
        // W11: "Existing branch" silently commits mode:"remote-tracking" for a
        // remote selection. bindWorktreeBranches() fills this in, and keeps it
        // in sync, whenever the committed selection is a remote ref — using
        // the exact same derivation the Hub uses server-side.
        + (existing ? `<p class="wt-muted" data-remote-hint hidden></p>` : "");
      body = `<section class="wt-creation" data-creation><h2 class="wt-heading" tabindex="-1" style="overflow-wrap:anywhere">${h(heading)}</h2>`
        + (m.loading ? pending : `<form class="wt-form" data-operation="create" data-pending="Creating…">${name}${field}<div class="wt-actions">${cancel}<button class="primary" data-create disabled>Create</button></div></form>`)
        + `</section>`;
    } else if (m.view === "delete") {
      const running = m.requiresStop === true;
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Delete worktree?</h2>${identity}`
        + (m.loading ? pendingWith("Checking worktree…") : m.blocked
          ? `<p role="alert" tabindex="-1">${h(m.message ?? "Only a verified Uatu-created checkout can be deleted. Restore or verify it outside Uatu.")}</p><div class="wt-actions" style="justify-content:flex-end">${cancel}</div>`
          : `<form class="wt-form" data-operation="delete" data-pending="Rechecking worktree safety…"><p>${running ? "Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept." : "The worktree’s files will be removed. The Git branch will be kept."}</p><div class="wt-actions" style="justify-content:flex-end">${cancel}<button class="danger">${running ? "Stop and delete" : "Delete"}</button></div></form>`)
        + `</section>`;
    } else if (m.view === "register") {
      const retry = m.selected?.ownership === "uatu";
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Register workspace</h2>${identity}`
        + (m.loading ? pendingWith("Loading checkout…") : !m.selected ? notFound("That workspace could not be found. Close and try again.")
          : `<aside class="wt-notice">Credentials and shared workspace configuration are managed only on <strong>${h(m.source.name)}</strong> and inherited live. Parent updates apply to every child; no child overrides. Authentication: ${h(m.source.authentication ?? "none")}; signing: ${h(m.source.signing ?? "none")}; configuration: default. Files, preview selections, terminals, conversations and personal/device preferences remain separate. Manage them from the parent's Configure on the Hub dashboard.</aside>`
        + `<form class="wt-form" data-operation="register" data-pending="Verifying the same checkout → registering workspace…"><p>Register as ${h(m.selected?.branch ?? "")} at its existing path. Registration does not move files, transfer cleanup ownership or copy conversations.</p><label class="check"><input type="checkbox" name="start">Start after registration</label><div class="wt-actions">${cancel}<button class="primary">${retry ? "Retry registration" : "Register workspace"}</button></div></form>`)
        + `</section>`;
    } else if (m.view === "forget") {
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Remove from Uatu</h2>${identity}`
        + (m.loading ? pendingWith("Loading checkout…") : !m.selected ? notFound("That workspace could not be found. Close and try again.")
          : `<form class="wt-form" data-operation="forget" data-pending="Stopping workspace → removing Hub registration only…"><p>Stop this workspace and remove Hub registration, assignments and personal state. <strong>Checkout, branch, files and creation provenance remain.</strong></p><label class="check"><input type="checkbox" name="confirm" required>Stop Uatu activity and remove only the Hub registration.</label><div class="wt-actions"><button>Remove from Uatu</button><button type="button" data-cancel>Keep registration</button></div></form>`)
        + `</section>`;
    } else {
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Open worktree</h2>${identity}`
        + (m.loading ? pendingWith("Loading checkout…") : `<form class="wt-form" data-operation="open" data-pending="Opening workspace…"><div class="wt-actions">${cancel}<button class="primary">Retry Open</button></div></form>`)
        + `</section>`;
    }
    // Every view is compact now: the fork menu opens exactly the view the
    // user asked for, and each one ends in Cancel or its own committed
    // operation. No view links "Back to worktrees" — there is no general
    // inventory to go back to.
    return `${worktreeDialogStyle()}<div class="wt-content"><div id="operation-status" class="wt-notice" role="status" tabindex="-1" hidden></div>${m.view === "delete" ? "" : notice}${body}</div>`;
  }

  function updateWorktreeCreate(root: ParentNode): void {
    const button = root.querySelector<HTMLButtonElement>("[data-create]");
    if (!button) return;
    const name = root.querySelector<HTMLInputElement>('[name="branch"]');
    const selection = root.querySelector<HTMLInputElement>('[name="selection"]');
    // W2: the one invalid-name reason worth naming inline — the others
    // (option-like, traversal, …) are refused just as silently as before.
    const hint = root.querySelector<HTMLElement>('[data-branch-name-hint]');
    if (hint) {
      const tooLong = Boolean(name) && [...name!.value].length > WORKTREE_BRANCH_NAME_MAX_LENGTH;
      hint.hidden = !tooLong;
      hint.textContent = tooLong ? `Branch names are limited to ${WORKTREE_BRANCH_NAME_MAX_LENGTH} characters in Uatu.` : "";
    }
    button.disabled = Boolean((root as Element).hasAttribute?.("data-operation-busy") || root.querySelector('[data-operation-busy]')) || !selection?.value || Boolean(name && !validWorktreeBranch(name.value));
  }

  function bindWorktreeBranches(root: ParentNode): void {
    const input = root.querySelector<HTMLInputElement>("[data-branch-search]");
    if (!input) return;
    const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
    options.forEach(option => option.setAttribute("aria-label", `${option.querySelector("span")!.textContent} ${option.querySelector("small")!.textContent}`));
    const selected = root.querySelector<HTMLInputElement>('[name="selection"]')!;
    const submit = root.querySelector<HTMLButtonElement>('[data-create]')!;
    const empty = root.querySelector<HTMLElement>('[data-branch-empty]')!;
    const listbox = root.querySelector<HTMLElement>('[role="listbox"]')!;
    const expand = (open: boolean) => {
      listbox.hidden = !open;
      input.setAttribute("aria-expanded", String(open));
      if (!open) input.removeAttribute("aria-activedescendant");
    };
    let active = -1;
    const visible = () => options.filter(option => !option.hidden);
    const activate = (index: number) => {
      const list = visible(); active = list.length ? (index + list.length) % list.length : -1;
      options.forEach(option => option.removeAttribute("data-active"));
      const option = list[active];
      if (option) { option.setAttribute("data-active", "true"); input.setAttribute("aria-activedescendant", option.id); option.scrollIntoView?.({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant");
    };
    const remoteHint = root.querySelector<HTMLElement>('[data-remote-hint]');
    // W11: "Existing branch" commits mode:"remote-tracking" for a remote
    // selection with no copy saying so. Name the local branch it will create —
    // derived exactly like the Hub derives it — whenever the committed
    // selection is a remote ref.
    const updateRemoteHint = () => {
      if (!remoteHint) return;
      const value = selected.value;
      const prefix = "remote:";
      if (!value.startsWith(prefix)) { remoteHint.hidden = true; remoteHint.textContent = ""; return; }
      const ref = value.slice(prefix.length);
      remoteHint.hidden = false;
      remoteHint.textContent = `Creates local branch ${localTrackingBranch(ref)} tracking ${ref}.`;
    };
    const choose = (option: HTMLElement) => {
      selected.value = option.dataset.value!;
      input.value = option.dataset.search!;
      options.forEach(item => item.setAttribute("aria-selected", String(item === option)));
      updateWorktreeCreate(root);
      updateRemoteHint();
      // A committed value is not a filter. Reopening allows reviewing all refs.
      options.forEach(item => item.hidden = false);
      empty.hidden = true;
      expand(false);
    };
    const filter = () => {
      const query = input.value.toLocaleLowerCase().replace(/\s/g, "");
      for (const option of options) {
        let cursor = 0;
        for (const char of option.dataset.search!.toLocaleLowerCase()) if (char === query[cursor]) cursor++;
        option.hidden = cursor < query.length;
      }
      empty.hidden = visible().length > 0;
      expand(true);
      activate(0);
    };
    input.addEventListener("input", () => {
      selected.value = "";
      options.forEach(option => option.setAttribute("aria-selected", "false"));
      submit.disabled = true;
      updateRemoteHint();
      filter();
    });
    const reopen = () => {
      if (selected.value) { options.forEach(option => option.hidden = false); empty.hidden = true; expand(true); activate(options.findIndex(option => option.dataset.value === selected.value)); }
      else filter();
    };
    input.addEventListener("focus", reopen);
    input.addEventListener("click", reopen);
    input.addEventListener("keydown", event => {
      if (event.key === "Escape" && !listbox.hidden) { event.preventDefault(); event.stopPropagation(); expand(false); }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (listbox.hidden) reopen(); else activate(active + (event.key === "ArrowDown" ? 1 : -1)); }
      if (event.key === "Enter") { event.preventDefault(); if (!listbox.hidden) { const option = visible()[active]; if (option) choose(option); } }
    });
    // Canceling `pointerdown` keeps the input focused, so the list does not
    // collapse (and the footer does not move) between press and release.
    // WebKit, however, treats a canceled `pointerdown` from a TOUCH as
    // "this gesture is not a tap" and never synthesizes the mouse
    // compatibility events — including `click`. On iOS Safari that made every
    // option and every footer button in this dialog inert: tapping a branch
    // never committed it (Create stayed disabled forever) and tapping Cancel
    // did nothing. The guard is therefore applied to mouse pointers only,
    // which is the only input that has the blur-between-down-and-up problem.
    const keepFocus = (event: PointerEvent) => { if (event.pointerType === "mouse") event.preventDefault(); };
    // A tap therefore blurs the input, which collapses the list — and a
    // collapsed (display:none) option never receives the `click` WebKit would
    // otherwise synthesize, so `click` alone can never commit a branch on
    // touch. Commit on `pointerup` instead, for the option the press started
    // on; a drag that scrolls the list fires `pointercancel` and commits
    // nothing. `click` stays for mouse, keyboard-synthesized clicks and DOM
    // stubs with no pointer events; choosing twice is idempotent.
    let pressed: HTMLElement | null = null;
    options.forEach(option => {
      option.addEventListener("pointerdown", event => { pressed = option; keepFocus(event as PointerEvent); });
      option.addEventListener("pointercancel", () => { pressed = null; });
      option.addEventListener("pointerup", event => {
        if (pressed !== option) return;
        pressed = null;
        // Refocusing on touch would reopen the on-screen keyboard over the
        // dialog the user has just finished with.
        if ((event as PointerEvent).pointerType === "mouse") input.focus();
        choose(option);
      });
      option.addEventListener("click", () => { input.focus(); choose(option); });
    });
    root.querySelectorAll<HTMLElement>(".wt-actions button").forEach(button => {
      button.addEventListener("pointerdown", keepFocus as EventListener);
    });
    input.addEventListener("blur", () => expand(false));
    const initial = options.find(option => option.dataset.value === selected.value);
    if (initial) choose(initial);
    else { selected.value = ""; filter(); }
    root.querySelector('[name="branch"]')?.addEventListener("input", () => updateWorktreeCreate(root));
    updateWorktreeCreate(root);
  }

  /** The one committed-operation confirmation: `Created <branch>`, a
   *  deletion, a removal. It sits at the TOP of the viewport, under the
   *  desktop WebView's titlebar inset and above the app header, centered —
   *  where the user is already looking after a dialog closes there, rather
   *  than at the bottom edge a phone's own chrome competes with. Its colour
   *  is the app's success palette (`--success` for the border and
   *  `--success-soft` for the tint behind it, both defined by both
   *  stylesheets: src/styles.css for the SPA and SHARED_STYLE for the Hub's
   *  own pages), with `--text-strong` on it — comfortably past AA in either
   *  scheme, and never dependent on a `color-mix()` of a `light-dark()`
   *  token, which does not follow the used color scheme in every engine.
   *  Same content,
   *  same Open/Dismiss buttons, same role=status in both surfaces, because
   *  both run THIS function. */
  function showWorktreeConfirmation(message: string, open?: (button: HTMLButtonElement) => void): void {
    document.querySelector("[data-worktree-confirmation]")?.remove();
    const notice = document.createElement("div");
    notice.dataset.worktreeConfirmation = "";
    notice.dataset.tone = "success";
    notice.setAttribute("role", "status");
    notice.style.cssText = "position:fixed;z-index:2100;top:calc(16px + var(--titlebar-inset,0px));left:50%;transform:translateX(-50%);box-sizing:border-box;width:max-content;max-width:calc(100vw - 32px);display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--success,#2da44e);border-radius:8px;background:var(--success-soft,#dafbe1);color:var(--text-strong,#1f2328);box-shadow:0 4px 24px #0003;font:14px/20px system-ui";
    const check = document.createElement("span");
    check.textContent = "\u2713";
    check.setAttribute("aria-hidden", "true");
    check.style.cssText = "flex-shrink:0;font-weight:700;color:var(--success-strong,var(--success,#1a7f37))";
    notice.append(check);
    const label = document.createElement("span"); label.textContent = message; label.style.cssText = "min-width:0;overflow-wrap:anywhere"; notice.append(label);
    if (open) { const button = document.createElement("button"); button.type = "button"; button.textContent = "Open"; button.style.cssText = "flex-shrink:0;min-width:44px;min-height:44px;padding:8px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:600;text-decoration:underline"; button.onclick = () => open(button); notice.append(button); }
    const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "\u00d7"; dismiss.setAttribute("aria-label", "Dismiss confirmation"); dismiss.style.cssText = "flex-shrink:0;min-width:44px;min-height:44px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer"; dismiss.onclick = () => notice.remove(); notice.append(dismiss);
    document.body.append(notice);
  }

  /** The three-item creation/discovery menu a main checkout's fork control
   *  opens. Nothing is mutated here; each item only opens the dialog in its
   *  view/mode — "Register worktree…" is the one entry point, from both the
   *  picker and the dashboard, to the checkouts Git lists that Uatu has not
   *  registered. */
  function openWorktreeFork(
    options: { api: string; source: WorktreeDialogSource },
    anchor: HTMLElement,
    returnFocus: HTMLElement = anchor,
  ): void {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Create worktree");
    menu.style.cssText = "position:fixed;z-index:2000;width:232px;padding:6px;border:1px solid var(--border-medium,#888);border-radius:10px;background:var(--surface,#fff);color:var(--text-strong,inherit);box-shadow:0 8px 32px #0003;font:14px system-ui";
    anchor.setAttribute("aria-expanded", "true");
    const controller = new AbortController();
    const close = (restore = false) => { controller.abort(); menu.remove(); anchor.setAttribute("aria-expanded", "false"); if (restore) anchor.focus(); };
    const items: { label: string; view: "create" | "discover"; mode?: "new" | "existing" }[] = [
      { label: "New branch / worktree", view: "create", mode: "new" },
      { label: "Existing branch", view: "create", mode: "existing" },
      { label: "Register worktree…", view: "discover" },
    ];
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      button.style.cssText = "display:block;text-align:left;width:100%;min-height:44px;padding:10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer";
      button.addEventListener("focus", () => button.style.background = "var(--surface-hover,#8882)");
      button.addEventListener("blur", () => button.style.background = "transparent");
      button.onclick = () => {
        close();
        openWorktreeDialog({ api: options.api, source: options.source, view: item.view, mode: item.mode }, returnFocus);
      };
      menu.append(button);
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - 232, innerWidth - 240))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector("button")!.focus();
    menu.addEventListener("keydown", event => {
      const buttons = [...menu.querySelectorAll("button")];
      const count = buttons.length;
      // W12: ArrowUp used to advance exactly like ArrowDown (fine with two
      // items, wrong with three); Tab used to let the menu item it removes
      // keep focus, dropping it into the document. Both are fixed the same
      // way — an explicit index for every key, and an explicit return of
      // focus to the anchor whenever the menu closes from the keyboard.
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        // No item focused (index -1, only reachable before the menu's own
        // initial-focus takes effect): ArrowDown starts at the first item and
        // ArrowUp starts at the last, like an ordinary roving-tabindex menu.
        const next = event.key === "Home" ? 0
          : event.key === "End" ? count - 1
          : event.key === "ArrowUp" ? (index < 0 ? count - 1 : (index - 1 + count) % count)
          : (index < 0 ? 0 : (index + 1) % count);
        buttons[next]!.focus();
      }
      if (event.key === "Tab") { event.preventDefault(); close(true); }
    });
    document.addEventListener("pointerdown", event => { if (!menu.contains(event.target as Node)) close(); }, { signal: controller.signal });
    window.addEventListener("pagehide", () => close(), { signal: controller.signal });
  }

  /** The shadow-DOM dialog itself. It owns navigation between views, focus,
   *  the busy fence and the one JSON request each transition or operation
   *  makes — and nothing else. */
  function openWorktreeDialog(options: WorktreeDialogOptions, returnFocus: HTMLElement): void {
    const api = options.api;
    const source = options.source;
    if (!api) return;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Worktrees");
    dialog.style.cssText = "width:min(420px,calc(100vw - 24px));max-height:calc(100dvh - 48px - var(--titlebar-inset,0px));margin:calc(24px + var(--titlebar-inset,0px)) auto 24px;padding:0;border:1px solid var(--border-medium);border-radius:12px;background:var(--surface);color:var(--text-strong);box-shadow:0 16px 64px #0004";
    const host = document.createElement("div");
    dialog.append(host);
    const root = host.attachShadow({ mode: "open" });
    // No dialog chrome: every view is compact and carries its own single
    // <h2>, which focuses it and labels the dialog, and its own Cancel. The
    // retired general inventory was the only wide view, and the only one
    // that needed a separate title bar and Close button.
    root.innerHTML = `<style>:host{font:14px system-ui}main{padding:16px}button,input,select{font:inherit;padding:8px;max-width:100%;box-sizing:border-box}a{color:inherit}button,a{cursor:pointer}[hidden]{display:none!important}</style><main></main>`;
    const main = root.querySelector("main")!;
    const close = () => dialog.close();

    let busy = false;
    // Read-only navigation is single-flight too, but unlike a mutation it
    // must leave Cancel/Escape available while inventory or preflight waits.
    let navigating = false;
    let revision = 0;
    let checkouts: WorktreeCheckout[] = [];
    let refs: { local: string[]; remote: string[] } = { local: [], remote: [] };
    let view = options.view;
    let mode = options.mode;
    let selectedId = options.id;
    let draft: Record<string, string> | undefined;
    let message = options.message;
    let error = options.error === true;
    let conflictId: string | undefined;
    let loading = true;
    let requiresStop = false;
    let blocked = false;

    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    const controller = new AbortController();
    window.addEventListener("pagehide", close, { signal: controller.signal });
    dialog.addEventListener("close", () => {
      controller.abort();
      revision++;
      dialog.remove();
      returnFocus.focus();
    }, { once: true });

    function model(): WorktreeDialogModel {
      const rows = checkouts.map(checkout => worktreeRowFrom(checkout, source.name));
      const mainRow = rows.find(row => row.main) ?? rows.find(row => row.id === source.id);
      const selected = selectedId === undefined ? undefined : rows.find(row => row.id === selectedId);
      return {
        view,
        source: { ...source, path: mainRow?.path ?? "" },
        rows,
        refs,
        ...(selected === undefined ? {} : { selected }),
        ...(mode === undefined ? {} : { mode }),
        ...(draft === undefined ? {} : { draft }),
        ...(message === undefined ? {} : { message }),
        error,
        ...(conflictId === undefined ? {} : { conflictId }),
        loading,
        empty: rows.every(row => row.main),
        requiresStop,
        blocked,
      };
    }

    function render(): void {
      main.innerHTML = renderWorktreeView(model());
      // The view's own single heading labels the dialog, whatever it is.
      const title = main.querySelector<HTMLElement>("h2");
      if (title) dialog.setAttribute("aria-label", title.textContent!);
      bindWorktreeBranches(main);
      // An actionable reason outranks everything. Otherwise a form view puts
      // the caret where the user types; the register list, which has no
      // field, focuses its heading rather than its Cancel button.
      (main.querySelector<HTMLElement>("[role=alert]")
        ?? (view === "discover" ? title : main.querySelector<HTMLElement>('input:not([type=hidden]), [data-cancel]')))?.focus();
    }

    async function request<T>(path: string, parse: (value: unknown) => T, body?: Record<string, unknown>): Promise<T> {
      let response: Response;
      try {
        response = body === undefined
          ? await fetch(path, { signal: controller.signal, headers: { accept: "application/json" } })
          : await fetch(path, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sourceWorkspaceId: source.id, ...body }),
          });
      } catch (failure) {
        // W4: an aborted request (the dialog closing mid-flight) is left as
        // itself — every caller already checks controller.signal.aborted and
        // discards it silently. Any other transport failure (offline, DNS,
        // CORS, …) is the browser's raw "Failed to fetch"; replace it with the
        // same actionable sentence a non-2xx response gets.
        if (controller.signal.aborted) throw failure;
        throw new Error("Request failed. Nothing was retried automatically.");
      }
      return readResponse(response, parse);
    }

    // The authoritative inventory read. A transport failure is reported as an
    // ordinary in-dialog alert, never as an empty repository.
    async function loadInventory(): Promise<boolean> {
      const current = ++revision;
      loading = checkouts.length === 0;
      main.setAttribute("aria-busy", "true");
      try {
        const payload = await request(`${api}?source=${encodeURIComponent(source.id)}`, parsers.parseWorktreeInventoryResponse);
        if (current !== revision) return false;
        const inventory = payload.inventory;
        checkouts = [...inventory.checkouts];
        const listed = inventory.refs;
        refs = {
          local: [...listed.local],
          remote: [...listed.remote],
        };
        if (inventory.status === "error") {
          message = inventory.error?.message ?? "Worktree inventory unavailable. Close and retry.";
          error = true;
        }
        return true;
      } catch (failure) {
        if (controller.signal.aborted || current !== revision) return false;
        message = failure instanceof Error ? failure.message : String(failure);
        error = true;
        return false;
      } finally {
        loading = false;
        if (current === revision) main.removeAttribute("aria-busy");
      }
    }

    // Deletion's consequences are never assumed: a fresh read-only preflight
    // decides between Delete, Stop and delete, and a blocker.
    async function loadPreflight(): Promise<void> {
      const row = model().selected;
      requiresStop = false;
      blocked = false;
      if (!row) { blocked = true; message = "No worktree of this repository matches that name."; error = true; return; }
      try {
        const outcome = await request(`${api}/preflight-delete`, parsers.parseWorktreeDeletionPreflight, { reference: row.id });
        if (outcome.ok === true) requiresStop = outcome.requiresStop === true;
        else { message = outcome.error.message; error = true; }
      } catch (failure) {
        if (controller.signal.aborted) return;
        message = failure instanceof Error ? failure.message : String(failure);
        error = true;
      }
      blocked = error || row.ownership !== "uatu" || Boolean(row.availability);
    }

    async function go(next: WorktreeDialogOptions["view"], id?: string, nextMode?: "new" | "existing"): Promise<void> {
      if (busy || navigating || controller.signal.aborted) return;
      navigating = true;
      try {
        view = next;
        selectedId = id;
        mode = nextMode;
        draft = undefined;
        message = undefined;
        error = false;
        conflictId = undefined;
        requiresStop = false;
        blocked = false;
        await loadInventory();
        if (!controller.signal.aborted && view === "delete") await loadPreflight();
        if (!controller.signal.aborted) render();
      } finally {
        navigating = false;
      }
    }

    function startBusy(pending: string): HTMLElement {
      busy = true;
      main.setAttribute("data-operation-busy", "");
      main.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
      const status = main.querySelector<HTMLElement>("#operation-status")!;
      status.hidden = false;
      status.setAttribute("role", "status");
      status.textContent = pending;
      status.focus();
      return status;
    }

    function endBusy(): void {
      busy = false;
      main.removeAttribute("data-operation-busy");
      main.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = false);
      updateWorktreeCreate(main);
    }

    function fail(status: HTMLElement, failure: unknown): void {
      if (controller.signal.aborted) return;
      status.setAttribute("role", "alert");
      status.textContent = failure instanceof Error ? failure.message : String(failure);
    }

    // A committed operation: the dialog closes, every open page is told, and
    // the outcome is a small confirmation with an explicit Open — never an
    // automatic switch. `removedId` names a workspace this operation
    // unregistered: if this page is showing it, the existing safe exit is a
    // navigation back to the source rather than a toast over a dead session.
    function committed(text: string, openId?: string, removedId?: string): void {
      close();
      window.dispatchEvent(new Event("uatu:worktrees-changed"));
      if (removedId !== undefined && location.pathname.startsWith(`/s/${encodeURIComponent(removedId)}/`)) {
        location.assign(`/s/${encodeURIComponent(source.id)}/`);
        return;
      }
      showWorktreeConfirmation(text, openId === undefined ? undefined : async button => {
        button.disabled = true;
        button.textContent = "Opening…";
        try {
          const response = await fetch(`${api}/open`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sourceWorkspaceId: source.id, reference: openId, start: true }),
          });
          if (!response.ok) throw new Error("Could not open workspace. Retry Open.");
          const outcome = await readResponse(response, value => parsers.parseWorktreeEndpointResult(value, "start"));
          if (outcome.ok === true && outcome.started === true) {
            location.assign(`/s/${encodeURIComponent(openId)}/`);
            return;
          }
          const reason = (outcome.ok ? outcome.startError : outcome.error)?.message
            ?? "Could not open workspace. Retry Open.";
          button.closest("[data-worktree-confirmation]")?.remove();
          openWorktreeDialog({ api, source, view: "result", id: openId, message: reason, error: true }, returnFocus);
        } catch (failure) {
          button.parentElement!.querySelector("span")!.textContent = failure instanceof Error ? failure.message : String(failure);
          button.disabled = false; button.textContent = "Open";
        }
      });
    }

    async function startWorkspace(id: string): Promise<void> {
      const status = startBusy("Starting workspace… Opening when ready.");
      try {
        const outcome = await request(`${api}/open`, value => parsers.parseWorktreeEndpointResult(value, "start"), { reference: id, start: true });
        if (outcome.ok === true && outcome.started === true) {
          location.assign(`/s/${encodeURIComponent(id)}/`);
          return;
        }
        const reason = (outcome.ok ? outcome.startError : outcome.error)?.message
          ?? "The workspace could not be started.";
        endBusy();
        view = "result"; selectedId = id; mode = undefined; draft = undefined;
        message = reason; error = true; conflictId = undefined;
        render();
        return;
      } catch (failure) {
        fail(status, failure);
      }
      endBusy();
    }

    // The creation draft exactly as it stands in the DOM. Read field by field
    // rather than through FormData, so the same code path is drivable in a
    // DOM stub and so an empty field is simply absent, like the retired
    // flow's query-string draft.
    function creationDraft(): Record<string, string> {
      const value = (name: string) => main.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "";
      return {
        ...(value("branch") ? { branch: value("branch") } : {}),
        ...(value("query") ? { query: value("query") } : {}),
        ...(value("selection") ? { selection: value("selection") } : {}),
      };
    }

    async function submitCreate(form: HTMLFormElement): Promise<void> {
      draft = creationDraft();
      const selection = draft.selection ?? "";
      const separator = selection.indexOf(":");
      const kind = selection.slice(0, separator);
      const ref = selection.slice(separator + 1);
      if ((kind !== "local" && kind !== "remote") || ref === "") {
        message = "Select an available branch."; error = true; conflictId = undefined;
        render();
        return;
      }
      const branch = (draft.branch ?? "").trim();
      if (mode !== "existing" && branch === "") {
        message = "Enter a name for the new branch."; error = true; conflictId = undefined;
        render();
        return;
      }
      const status = startBusy(form.dataset.pending ?? "Working…");
      try {
        const outcome = await request(`${api}/create`, value => parsers.parseWorktreeEndpointResult(value, "create"), mode === "existing"
          ? { mode: kind === "remote" ? "remote-tracking" : "existing-local", base: { kind, ref } }
          : { mode: "new-branch", branch, base: { kind, ref } });
        if (outcome.ok === true) {
          const checkout = outcome.checkout;
          committed(checkout?.branch ? `Created ${checkout.branch}` : "Worktree created.", checkout?.workspaceId);
          return;
        }
        const detail = outcome.error;
        const retained = outcome.retainedCheckout;
        endBusy();
        // Git created the tree and a later step did not: the retry acts on
        // THAT checkout, never on a second creation.
        if (retained) {
          view = "register";
          selectedId = retained.workspaceId ?? retained.checkoutId;
          mode = undefined; draft = undefined; conflictId = undefined;
          message = detail.message;
          error = true;
          await loadInventory();
          if (!controller.signal.aborted) render();
          return;
        }
        message = detail.message;
        error = true;
        conflictId = detail.conflictCheckoutId;
        // The occupying checkout must be offered by its CURRENT state, so the
        // inventory is re-read before the conflict's own action is rendered.
        if (conflictId !== undefined) await loadInventory();
        if (!controller.signal.aborted) render();
        return;
      } catch (failure) {
        fail(status, failure);
      }
      endBusy();
    }

    async function submitFetch(): Promise<void> {
      if (!main.querySelector('form[data-operation="create"]')) return;
      // Name, query and a still-valid choice all survive a fetch untouched.
      const kept = creationDraft();
      const status = startBusy("Fetching remote branches…");
      try {
        const outcome = await request(`${api}/fetch`, parsers.parseWorktreeRefsResponse, {});
        const listed = outcome.refs;
        if (listed) refs = { local: [...listed.local], remote: [...listed.remote] };
        endBusy();
        draft = kept;
        conflictId = undefined;
        if (outcome.ok !== true) {
          message = outcome.error.message;
          error = true;
          render();
          return;
        }
        // A selection that disappeared is cleared rather than substituted; the
        // name and the query survive untouched.
        // The same filter the list is rendered with, so a choice the fetch
        // turned into an occupied branch is cleared rather than left
        // committed against a list that no longer offers it.
        const offered = mode === "existing" ? worktreeExistingRefs(checkouts.map(checkout => worktreeRowFrom(checkout, source.name)), refs) : refs;
        const available = new Set([...offered.local.map(ref => `local:${ref}`), ...offered.remote.map(ref => `remote:${ref}`)]);
        if (kept.selection !== undefined && !available.has(kept.selection)) {
          delete draft.selection;
          message = "That branch is no longer available. Choose another branch.";
          error = true;
        } else {
          message = undefined;
          error = false;
        }
        render();
        return;
      } catch (failure) {
        fail(status, failure);
      }
      endBusy();
    }

    async function submitDelete(form: HTMLFormElement): Promise<void> {
      const row = model().selected;
      if (!row) return;
      const status = startBusy(form.dataset.pending ?? "Working…");
      try {
        const outcome = await request(`${api}/delete`, value => parsers.parseWorktreeEndpointResult(value, "delete"), { reference: row.id, confirm: true, stop: requiresStop });
        if (outcome.ok === true) {
          committed("Worktree deleted. Branch kept.", undefined, row.id);
          return;
        }
        endBusy();
        message = outcome.error.message;
        error = true;
        blocked = true;
        render();
        return;
      } catch (failure) {
        fail(status, failure);
      }
      endBusy();
    }

    async function submitRegister(form: HTMLFormElement): Promise<void> {
      const row = model().selected;
      if (!row) return;
      const start = form.querySelector<HTMLInputElement>('[name="start"]')?.checked === true;
      const status = startBusy(form.dataset.pending ?? "Working…");
      try {
        const outcome = await request(`${api}/register`, value => parsers.parseWorktreeEndpointResult(value, "register"), { reference: row.id, start });
        if (outcome.ok === true) {
          const checkout = outcome.checkout;
          committed(checkout?.branch ? `${checkout.ownership === "uatu" ? "Created" : "Registered"} ${checkout.branch}` : "Worktree registered.", checkout?.workspaceId);
          return;
        }
        endBusy();
        message = outcome.error.message;
        error = true;
        render();
        return;
      } catch (failure) {
        fail(status, failure);
      }
      endBusy();
    }

    async function submitForget(form: HTMLFormElement): Promise<void> {
      const row = model().selected;
      if (!row) return;
      if (form.querySelector<HTMLInputElement>('[name="confirm"]')?.checked !== true) {
        message = "Confirm to continue. Nothing changed.";
        error = true;
        render();
        return;
      }
      const status = startBusy(form.dataset.pending ?? "Working…");
      try {
        const outcome = await request(`${api}/forget`, value => parsers.parseWorktreeEndpointResult(value, "forget"), { reference: row.id });
        if (outcome.ok === true) {
          committed("Removed from Uatu. Checkout, branch and files were kept.", undefined, row.id);
          return;
        }
        endBusy();
        message = outcome.error.message;
        error = true;
        render();
        return;
      } catch (failure) {
        fail(status, failure);
      }
      endBusy();
    }

    main.addEventListener("click", event => {
      const target = event.target as Element;
      if (target.closest("[data-cancel]")) { if (!busy) close(); return; }
      if (target.closest("[data-fetch]")) { if (!busy && !navigating) void submitFetch(); return; }
      const action = target.closest<HTMLElement>("[data-action]");
      if (action) {
        if (busy || navigating) return;
        const kind = action.dataset.action;
        // "Retry refresh" re-reads authoritative inventory and re-renders
        // the view the user is in (it is reachable from an occupancy
        // refusal's own row), never a navigation elsewhere and never a
        // recreation.
        if (kind === "refresh") {
          void (async () => { await loadInventory(); if (!controller.signal.aborted) render(); })();
          return;
        }
        if (kind === "start") { void startWorkspace(action.dataset.id!); return; }
        if (kind === "view") {
          void go(action.dataset.view as WorktreeDialogOptions["view"], action.dataset.id, action.dataset.mode as "new" | "existing" | undefined);
        }
        return;
      }
      const link = target.closest<HTMLAnchorElement>("a[data-opening]");
      if (!link) return;
      if (busy || navigating) { event.preventDefault(); return; }
      busy = true;
      const status = main.querySelector<HTMLElement>("#operation-status")!;
      status.hidden = false;
      status.textContent = "Opening workspace…";
      status.focus();
    });

    main.addEventListener("submit", event => {
      event.preventDefault();
      if (busy || navigating) return;
      const form = event.target as HTMLFormElement;
      const operation = form.dataset.operation;
      if (operation === "create") void submitCreate(form);
      else if (operation === "delete") void submitDelete(form);
      else if (operation === "register") void submitRegister(form);
      else if (operation === "forget") void submitForget(form);
      else if (operation === "open") void startWorkspace(model().selected?.id ?? selectedId ?? "");
    });

    // A committed change elsewhere refreshes only the idle register list. An
    // open form, a pending operation and the active document, terminal and
    // conversation are all left exactly as they are.
    window.addEventListener("uatu:worktrees-invalidated", () => {
      if (!busy && view === "discover") void go("discover");
    }, { signal: controller.signal });

    document.body.append(dialog);
    dialog.showModal();
    render();
    void go(view, selectedId, mode).then(() => {
      // An entry point that opened straight into a message (a failed start)
      // keeps it; `go` clears state for ordinary navigation only.
      if (options.message !== undefined && message === undefined) {
        message = options.message;
        error = options.error === true;
        render();
      }
    });
  }

  return Object.assign(target, {
    WORKTREE_BRANCH_NAME_MAX_LENGTH,
    validWorktreeBranch,
    initialWorktreeBase,
    localTrackingBranch,
    worktreeExistingRefs,
    worktreeForkIcon,
    worktreeEscape,
    worktreeDialogStyle,
    worktreeRowState,
    worktreeProvenanceLabel,
    worktreeRowFrom,
    worktreeRowPrimary,
    renderWorktreeView,
    updateWorktreeCreate,
    bindWorktreeBranches,
    showWorktreeConfirmation,
    openWorktreeDialog,
    openWorktreeFork,
  });
}

// Populated once at module load, purely to give every ordinary ESM importer
// (hub-nav.ts and this file's own test) a normal named
// binding. No DOM is touched by this call — only function/const definitions
// and property assignment — so it is just as safe to run inside the Hub's
// server process (which never invokes the DOM-touching members) as in a
// browser.
const runtime = installWorktreeDialog({} as Record<string, unknown>, createWorktreeBranchRules(), worktreeParsers);

export const WORKTREE_BRANCH_NAME_MAX_LENGTH = runtime.WORKTREE_BRANCH_NAME_MAX_LENGTH;
export const validWorktreeBranch = runtime.validWorktreeBranch;
export const initialWorktreeBase = runtime.initialWorktreeBase;
export const localTrackingBranch = runtime.localTrackingBranch;
export const worktreeForkIcon = runtime.worktreeForkIcon;
export const worktreeEscape = runtime.worktreeEscape;
export const worktreeDialogStyle = runtime.worktreeDialogStyle;
export const worktreeRowState = runtime.worktreeRowState;
export const worktreeProvenanceLabel = runtime.worktreeProvenanceLabel;
export const worktreeRowFrom = runtime.worktreeRowFrom;
export const worktreeRowPrimary = runtime.worktreeRowPrimary;
export const renderWorktreeView = runtime.renderWorktreeView;
export const updateWorktreeCreate = runtime.updateWorktreeCreate;
export const bindWorktreeBranches = runtime.bindWorktreeBranches;
export const showWorktreeConfirmation = runtime.showWorktreeConfirmation;
export const openWorktreeDialog = runtime.openWorktreeDialog;
export const openWorktreeFork = runtime.openWorktreeFork;

// The one script the Hub dashboard (src/hub/pages.ts) inlines verbatim into
// a plain, unbundled `<script>` tag, so a page load gets the exact same
// dialog the in-app picker (src/shell/hub-nav.ts) imports as a normal
// module — regardless of how aggressively the app.ts bundle that also
// contains this module gets minified. See installWorktreeDialog's own doc
// comment for why this particular shape (one function, self-invoked,
// assigning its public surface onto `window` by property name) survives
// minification where the former per-function `.toString()` array did not.
export const worktreeDialogScript = `(${installWorktreeDialog.toString()})(window,(${createWorktreeBranchRules.toString()})(),${worktreeParsersScript});`;
