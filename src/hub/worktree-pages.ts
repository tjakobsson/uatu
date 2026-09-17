// Reusable lifecycle presentation. All identities, refs, destinations and
// credentials come from the caller; no fixture data or operation service.
import { escapeHtml as h } from "../shared/html";
import { hubPresentationPage } from "./pages";
import { worktreePickerScript } from "../shell/worktree-picker";
import { initialWorktreeBase } from "../shared/worktree-branches";

export type WorktreeRow = {
  id: string; name: string; path: string; branch: string; detached?: boolean;
  ownership: "main" | "uatu" | "external" | "uncertain";
  registered: boolean; running: boolean; availability?: "missing" | "replaced";
  checkout: string; base?: string; upstream?: string; authentication?: string; signing?: string;
  // Historical branch-creation snapshot, not current upstream or checkout base.
  readonly sourceRef?: string;
  parentId?: string; repositoryId?: string; configuration?: string;
};
export type WorktreePresentation = {
  view: "inventory" | "create" | "result" | "settings" | "delete" | "forget" | "configure" | "rename" | "folder" | "onboarding";
  source: WorktreeRow; rows: WorktreeRow[]; selected?: WorktreeRow;
  message?: string; error?: boolean; conflictId?: string; draft?: Record<string, string>;
  fresh: boolean; empty?: boolean; loading?: boolean; creationMode?: string;
  credentials: { id: string; label: string; disabled?: boolean; purpose?: "authentication" | "signing" }[];
  refs: { bases: [string, string][]; local: [string, string][]; remote: [string, string][]; freshness: string };
  defaults: { branch: string; parent: string; folder: string; name: string };
  prefix: string;
  // Which secondary views the host serves. Absent flags mean "served", so
  // the isolated review host keeps every link; the real Hub turns off the
  // views it manages on the dashboard instead.
  capabilities?: { settings?: boolean; rename?: boolean };
};

const STYLE = `<style>
.wt-content{line-height:1.5}
.wt-branches{max-height:264px;overflow:auto;border:1px solid var(--border-soft);border-radius:8px}.wt-branch{display:flex;gap:8px;align-items:center;padding:10px 12px;min-height:44px;cursor:pointer}.wt-branch span:first-child{flex:1;overflow-wrap:anywhere}.wt-branch small{font-size:11px;border:1px solid var(--border-medium);padding:1px 5px;border-radius:4px;color:var(--text-subtle)}.wt-branch[data-active]{background:var(--surface-hover,#8882)}.wt-branch[aria-selected=true]{box-shadow:inset 3px 0 var(--accent);color:var(--accent)}.wt-branch[aria-selected=true]:after{content:'✓'}.wt-creation .wt-actions{justify-content:flex-end;margin:0}.wt-creation h2{margin-bottom:16px}
.wt-content *{box-sizing:border-box}.wt-heading{margin:0 0 .4rem;font-size:1.35rem}.wt-lead,.wt-muted{color:var(--text-subtle)}.wt-muted{font-size:.85rem}
.wt-toolbar,.wt-actions{display:flex;flex-wrap:wrap;gap:.65rem;align-items:center;margin:.9rem 0}.wt-card{padding:1rem;border:1px solid var(--border-soft);border-radius:8px;margin:8px 0}.wt-card h3{margin:0;font-size:1rem}.wt-card-top{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}.wt-path{font: .8rem var(--mono-font-family);overflow-wrap:anywhere}
.wt-button,.wt-content button{display:inline-flex;align-items:center;min-height:40px;border:1px solid var(--border-medium);border-radius:6px;padding:.45rem .7rem;background:transparent;color:inherit;text-decoration:none;font:inherit}.wt-button.primary,.wt-content button.primary{background:var(--accent);color:white}.wt-content button:disabled{opacity:.5;cursor:wait}.wt-content .danger{border-color:var(--danger)}
.wt-notice{padding:1rem;border:1px solid var(--accent);border-radius:8px;margin:1rem 0;overflow-wrap:anywhere}.wt-notice.error{border-color:var(--danger)}.wt-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.wt-form{display:grid;gap:1rem}.wt-form label{display:grid;gap:.35rem;font-weight:600;font-size:.9rem}.wt-form label.check{display:flex;align-items:start;font-weight:400}.wt-form input:not([type=checkbox]),.wt-form select{width:100%;min-width:0;background:var(--surface,#fff);color:inherit;border:1px solid var(--border-medium);border-radius:5px;padding:.55rem}.wt-form fieldset{border:1px solid var(--border-soft);border-radius:6px;min-width:0}.wt-form legend{font-weight:600}.wt-summary{display:grid;grid-template-columns:8rem 1fr;gap:.55rem}.wt-summary dd{margin:0;overflow-wrap:anywhere}.wt-summary dt{color:var(--text-subtle)}.wt-content :focus-visible{outline:2px solid var(--accent);outline-offset:3px}.wt-content [hidden]{display:none!important}
@media(max-width:600px){.wt-grid{grid-template-columns:1fr}.wt-content button,.wt-button{min-height:44px}.wt-summary{grid-template-columns:1fr;gap:.2rem}.wt-summary dd{margin-bottom:.7rem}}
</style>`;

// Secondary Hub pages use ordinary browser navigation. In-workspace callers
// mount the same fragment through shell/worktree-picker's dialog controller.
const SCRIPT = `<script>(()=>{
${worktreePickerScript}
bindWorktreeBranches(document);
document.querySelector('[data-cancel]')?.addEventListener('click',()=>location.assign(location.pathname+'?view=inventory'));
const status=document.getElementById('operation-status');let busy=false;
document.querySelectorAll('form[data-operation]').forEach(form=>form.addEventListener('submit',async event=>{
event.preventDefault();if(busy)return;const data=new FormData(form);
if(form.action.endsWith('/fetch')){const creation=document.querySelector('form[action$="/create"]');if(creation)for(const [k,v]of new FormData(creation))data.set(k,v)}
busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);status.hidden=false;status.textContent=form.dataset.pending||'Working…';status.focus();
try{const response=await fetch(form.action,{method:'POST',body:data});if(!response.ok)throw Error('Request failed. Nothing was retried automatically.');location.assign((await response.json()).redirect)}catch(error){busy=false;status.setAttribute('role','alert');status.textContent=error.message;document.querySelectorAll('button').forEach(b=>b.disabled=b.hasAttribute('data-create')&&!!document.querySelector('[name=selection]')&&!document.querySelector('[name=selection]').value)}}));
const mode=document.querySelector('[name=mode]');function sync(){document.querySelectorAll('[data-modes]').forEach(g=>{g.hidden=!g.dataset.modes.split(' ').includes(mode.value);g.querySelectorAll('input,select').forEach(i=>i.disabled=g.hidden)})}if(mode){mode.onchange=sync;sync()}
window.addEventListener('pageshow',()=>{busy=false;status.hidden=true;document.querySelectorAll('button').forEach(b=>b.disabled=b.hasAttribute('data-create')&&!!document.querySelector('[name=selection]')&&!document.querySelector('[name=selection]').value)});document.querySelector('[role=alert]')?.focus();
})()</script>`;

export function worktreePage(m: WorktreePresentation, reviewChrome = "", reviewScript = "", fragment = false): string {
  const draft = m.draft ?? {};
  const serves = { settings: m.capabilities?.settings !== false, rename: m.capabilities?.rename !== false };
  const url = (view: string, id?: string) => `${m.prefix}?view=${view}&source=${encodeURIComponent(m.source.id)}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
  const link = (label: string, view: string, id?: string, primary = false) => `<a class="wt-button${primary ? " primary" : ""}" href="${h(url(view, id))}">${h(label)}</a>`;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${h(value)}">`;
  const post = (action: string, body: string, pending = "Working…") => `<form class="wt-form" method="post" action="${h(m.prefix)}/${action}" data-operation data-pending="${h(pending)}">${hidden("source", m.source.id)}${body}</form>`;
  const input = (name: string, label: string, fallback: string) => `<label>${h(label)}<input name="${name}" value="${h(draft[name] ?? fallback)}" required></label>`;
  const select = (name: string, label: string, values: [string, string][], fallback = values[0]?.[0] ?? "") => `<label>${h(label)}<select name="${name}">${values.map(([value, text]) => `<option value="${h(value)}"${(draft[name] ?? fallback) === value ? " selected" : ""}>${h(text)}</option>`).join("")}</select></label>`;
  const credentials = (name: string, label: string) => `<label>${label}<select name="${name}"><option value="none">None — no assignment</option>${m.credentials.filter(c => !c.purpose || c.purpose === name).map(c => `<option value="${h(c.id)}"${(m.source[name as "authentication" | "signing"] ?? "none") === c.id ? " selected" : ""}${c.disabled ? " disabled" : ""}>${h(c.label)}</option>`).join("")}</select></label>`;
  const assignments = `<aside class="wt-notice">Credentials and shared workspace configuration are managed only on <strong>${h(m.source.name)}</strong> and inherited live. Parent updates apply to every child; no child overrides. Authentication: ${h(m.source.authentication ?? "none")}; signing: ${h(m.source.signing ?? "none")}; configuration: ${h(m.source.configuration ?? "default")}. Files, preview selections, terminals, conversations and personal/device preferences remain separate. ${serves.settings ? link("Manage parent settings", "settings", m.source.id) : "Manage them from the parent's Configure on the Hub dashboard."}</aside>`;
  const source = `<p class="wt-lead">Repository <strong>${h(m.source.name)}</strong> · <span class="wt-path">${h(m.source.path)}</span><br>Current workspace selection and conversations remain unchanged.</p>`;
  const owner = (r: WorktreeRow) => ({ main: "Main checkout", uatu: "Uatu-created", external: "External · no cleanup ownership", uncertain: "Ownership uncertain" })[r.ownership];
  const state = (r: WorktreeRow) => r.availability === "missing" ? "Missing checkout" : r.availability === "replaced" ? "Identity conflict — path replaced" : r.registered ? r.running ? "Running" : "Stopped" : "Not registered";
  const primary = (r: WorktreeRow) => r.availability ? `<p role="alert">${h(state(r))}. Restore the original checkout externally, then retry refresh. Nothing will be recreated.</p>${post("refresh", "<button>Retry refresh</button>")}` : !r.registered ? link(r.ownership === "uatu" ? "Retry registration" : "Register workspace", "configure", r.id, true) : r.running ? `<a class="wt-button primary" href="/s/${encodeURIComponent(r.id)}/" data-opening>Open</a>` : post("start", `${hidden("id", r.id)}<button class="primary">Start</button>`, "Starting workspace… Opening when ready.");
  const summary = (r: WorktreeRow) => `<dl class="wt-summary">${[["Workspace", `${r.name} · ${r.id}`], ["Checkout", r.path], ["Branch", r.branch], ["Ownership", owner(r)], ["Status", state(r)], ["Identity", r.checkout], ...(r.base ? [["Starting revision", r.base]] : []), ...(r.upstream ? [["Upstream", r.upstream]] : []), ["Authentication", r.authentication ?? "none"], ["Signing", r.signing ?? "none"]].map(([label, value]) => `<dt>${h(label!)}</dt><dd>${h(value!)}</dd>`).join("")}</dl>`;
  const conflict = m.rows.find(row => row.id === m.conflictId);
  const notice = m.message ? `<div class="wt-notice${m.error ? " error" : ""}" role="${m.error ? "alert" : "status"}" tabindex="-1">${h(m.message)}${conflict ? `<div class="wt-actions">${primary(conflict)}</div>` : ""}</div>` : "";
  let body = "";
  if (m.view === "inventory") {
    body = `<h2 class="wt-heading" tabindex="-1">Repository worktrees</h2>${source}<div class="wt-toolbar">${link("Create worktree", "create", undefined, true)}${post("refresh", "<button>Refresh inventory</button>", "Refreshing inventory…")}</div>`;
    body += m.loading ? '<p role="status">Loading worktree inventory…</p>' : m.empty ? '<h3>No linked worktrees yet</h3><p>Create an independent checkout, or refresh to discover external trees.</p>' : m.rows.map(r => `<article class="wt-card" data-workspace="${h(r.id)}"><div class="wt-card-top"><h3>${h(r.name)}</h3><span>${state(r)}</span></div><p class="wt-path">${h(r.path)}</p><p class="wt-muted">${h(r.branch)} · ${owner(r)}</p><div class="wt-actions">${primary(r)}${r.ownership === "main" && serves.settings ? link("Configure", "settings", r.id) : ""}${r.registered ? link("Remove from Uatu", "forget", r.id) : ""}${r.ownership === "uatu" && !r.availability ? link("Delete worktree", "delete", r.id) : ""}${link("Rename folder", "folder", r.id)}</div></article>`).join("");
    body += '<p class="wt-muted">External discovery never opens or registers a checkout automatically.</p>';
  } else if (m.view === "onboarding") {
    body = `<h2 class="wt-heading">Add workspace</h2><p>Keep parallel work in a separate checkout.</p><div class="wt-actions">${link("Create worktree", "create", undefined, true)}${link("Browse repository worktrees", "inventory")}</div>`;
  } else if (m.view === "create") {
    const existing = m.creationMode === "existing" || ["local", "remote", "existing"].includes(draft.mode ?? "");
    const branches = [...m.refs.local.map(([ref]) => ({ ref, kind: "local" })), ...m.refs.remote.map(([ref]) => ({ ref, kind: "remote" }))];
    // A submitted draft (including an explicitly cleared selection) never defaults.
    const selection = draft.selection ?? (Object.keys(draft).length || existing ? "" : initialWorktreeBase(m.refs.local.map(([ref]) => ref), m.refs.remote.map(([ref]) => ref)));
    const query = draft.query ?? branches.find(({ ref, kind }) => `${kind}:${ref}` === selection)?.ref ?? "";
    const heading = `${existing ? "Existing branch" : "New branch / worktree"} · ${m.source.name}`;
    const branchField = `${hidden("selection", selection)}<div style="display:flex;gap:8px;align-items:end"><label style="flex:1;min-width:0">${existing ? "Branch" : "Create from"}<input name="query" value="${h(query)}" data-branch-search role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="wt-branch-list" placeholder="Search branches…" autocomplete="off"></label><button form="wt-fetch" aria-label="Fetch remote branches" title="Fetch remote branches" style="padding:8px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg></button></div><div id="wt-branch-list" class="wt-branches" role="listbox" aria-label="Branches">${branches.map(({ ref, kind }, index) => `<div id="wt-branch-${index}" class="wt-branch" role="option" aria-selected="${selection === `${kind}:${ref}`}" data-value="${h(`${kind}:${ref}`)}" data-search="${h(ref)}"><span>${h(ref)}</span><small>${kind === "remote" ? "Remote" : "Local"}</small></div>`).join("")}<p data-branch-empty class="wt-muted" role="status" hidden style="padding:12px">No matching branches</p></div>`;
    body = `<section class="wt-creation" data-creation><h2 class="wt-heading" tabindex="-1" style="overflow-wrap:anywhere">${h(heading)}</h2><form id="wt-fetch" method="post" action="${h(m.prefix)}/fetch" data-operation data-pending="Fetching remote branches…">${hidden("source", m.source.id)}</form>${post("create", `${hidden("mode", existing ? "existing" : "new")}${existing ? "" : input("branch", "Name", "")}${branchField}<div class="wt-actions"><button type="button" data-cancel>Cancel</button><button class="primary" data-create disabled>Create</button></div>`, "Creating…")}</section>`;
  } else if (m.selected && (m.view === "delete" || m.view === "result" || (m.view === "configure" && m.selected.ownership === "uatu"))) {
    const row = m.selected;
    const identity = `<p style="overflow-wrap:anywhere"><strong>${h(m.source.name)} / ${h(row.branch)}</strong></p>`;
    const cancel = '<button type="button" data-cancel>Cancel</button>';
    if (m.view === "delete") {
      const blocked = m.error || row.ownership !== "uatu" || Boolean(row.availability);
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Delete worktree?</h2>${identity}${blocked ? `${m.error ? `<p role="alert" tabindex="-1">${h(m.message ?? "Deletion could not be completed. Files and registration retained.")}</p>` : '<p role="alert" tabindex="-1">Only a verified Uatu-created checkout can be deleted. Restore or verify it outside Uatu.</p>'}<div class="wt-actions" style="justify-content:flex-end">${cancel}</div>` : post("delete", `${hidden("id", row.id)}${hidden("confirm", "1")}${row.running ? hidden("stop", "1") : ""}<p>${row.running ? "Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept." : "The worktree’s files will be removed. The Git branch will be kept."}</p><div class="wt-actions" style="justify-content:flex-end">${cancel}<button class="danger">${row.running ? "Stop and delete" : "Delete"}</button></div>`, "Rechecking worktree safety…")}</section>`;
    } else if (m.view === "configure") {
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Finish creating worktree</h2>${identity}${post("register", `${hidden("id", row.id)}<div class="wt-actions">${cancel}<button class="primary">Retry registration</button></div>`, "Retrying registration…")}</section>`;
    } else {
      body = `<section data-compact><h2 class="wt-heading" tabindex="-1">Open worktree</h2>${identity}${post("start", `${hidden("id", row.id)}<div class="wt-actions">${cancel}<button class="primary">Retry Open</button></div>`, "Opening workspace…")}</section>`;
    }
  } else if (m.selected) {
    const row = m.selected;
    const title = ({ forget: "Remove from Uatu", configure: "Register workspace", rename: "Rename workspace", folder: "Rename folder", settings: "Configure workspace" })[m.view as "forget" | "configure" | "rename" | "folder" | "settings"];
    body = `<h2 class="wt-heading" tabindex="-1">${h(title)}</h2><div class="wt-card">${summary(row)}</div>`;
    if (m.view === "configure") body += post("register", `${hidden("id", row.id)}${assignments}<p>Register as ${h(row.branch)} at its existing path. Registration does not move files, transfer cleanup ownership or copy conversations.</p><label class="check"><input type="checkbox" name="start">Start after registration</label><button class="primary">${row.ownership === "uatu" ? "Retry registration" : "Register workspace"}</button>`, "Verifying the same checkout → registering workspace…");
    else if (m.view === "forget") body += post("forget", `${hidden("id", row.id)}<p>Stop this workspace and remove Hub registration, assignments and personal state. <strong>Checkout, branch, files and creation provenance remain.</strong></p><label class="check"><input type="checkbox" name="confirm" required>Stop Uatu activity and remove only the Hub registration.</label><div class="wt-actions"><button>Remove from Uatu</button><button type="button" data-cancel>Keep registration</button></div>`, "Stopping workspace → removing Hub registration only…");
    else if (m.view === "rename") body += row.parentId ? '<p>Worktree names reflect the current local branch. Branch rename is outside this preview.</p>' : post("rename", `${hidden("id", row.id)}${input("name", "Workspace display name", row.name)}<p>Display name only; checkout path, running session and stable URL stay unchanged.</p><button>Save display name</button>`);
    else if (m.view === "folder") body += `<div class="wt-notice error" role="alert" tabindex="-1">Folder rename is blocked: linked/main/common-directory or ancestor dependencies could break Git links, including unregistered checkouts. Stopping does not make this move safe. No files have moved.</div>${row.parentId ? '<p>Name follows the local branch; branch rename is out of scope.</p>' : serves.rename ? link("Rename workspace instead", "rename", row.id) : "<p>You can still change the workspace's display name from the Hub dashboard.</p>"}`;
    else if (m.view === "settings" && row.ownership === "main") body += post("settings", `${hidden("id", row.id)}${credentials("authentication", "Parent authentication")}${credentials("signing", "Parent signing")}${select("configuration", "Shared workspace configuration", [["default", "Default project policy"], ["review", "Review project policy"]], row.configuration)}<p>Updates apply live to children. This does not change checkout runtime or personal/device preferences.</p><button>Save parent settings</button>`);
  }
  const compact = m.view === "create" || body.includes("data-compact");
  const content = `${STYLE}${compact ? "" : reviewChrome}<div class="wt-content"><div id="operation-status" class="wt-notice" role="status" tabindex="-1" hidden></div>${m.view === "delete" ? "" : notice}${body}${compact ? "" : `<div class="wt-toolbar">${m.view !== "inventory" ? link("Back to worktrees", "inventory") : '<a href="/clone">Add workspace options</a>'}</div>`}</div>`;
  return fragment ? content : hubPresentationPage("UatuCode Hub — Worktrees", `${content}${SCRIPT}${reviewScript}`, m.view === "create" || m.view === "onboarding" ? "clone" : "dashboard");
}
