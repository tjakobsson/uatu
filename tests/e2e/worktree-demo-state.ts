// Test-only HTTP/state adapter. No filesystem, subprocess, credentials, Git or
// production service imports. All paths and credential labels are synthetic.
import type { WorktreePresentation, WorktreeRow } from "../../src/hub/worktree-pages";
import { validWorktreeBranch } from "../../src/shared/worktree-branches";

export const validBranch = validWorktreeBranch;
export function branchFolder(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase().slice(0, 100) || "branch";
}
function suffix(branch: string): string {
  let hash = 2166136261;
  for (const char of branch) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const scenarios = {
  "non-main": "Main checkout on feature/current", "remote-main": "Only origin/main available", "ambiguous-main": "Multiple remote main branches", "no-main": "No main branch available", "detached": "Detached main checkout", "unknown-branch": "Unknown main checkout branch",
  "mixed-lifecycle": "Mixed repositories · main stopped, child running", "all-stopped": "All checkouts stopped",
  populated: "Populated inventory", empty: "Empty linked inventory", loading: "Loading inventory",
  "branch-conflict": "Branch collision", "path-conflict": "Destination collision", "checked-out": "Branch already checked out",
  stale: "Stale remote refs", "fetch-auth": "Fetch authentication failure", "fetch-network": "Fetch network failure", "fetch-disappearance": "Fetch removes selected remote ref",
  "registration-failure": "Retained checkout / registration failure", "start-failure": "Start failure",
  discovery: "External discovery", missing: "Missing registered checkout", replaced: "Replaced path / uncertain identity",
  dirty: "Delete blocked: tracked changes", untracked: "Delete blocked: untracked files", ignored: "Delete blocked: ignored data",
  locked: "Delete blocked: Git lock", "in-use": "Delete blocked: external activity", nested: "Delete blocked: nested checkout",
  "stop-failure": "Stop failure", "inventory-error": "Inventory network error",
} as const;
export type Scenario = keyof typeof scenarios;

export class WorktreeDemoState {
  scenario: Scenario = "populated";
  latency = 0;
  rows: WorktreeRow[] = [];
  fresh = false;
  sequence = 0;
  generation = 0;
  message = "";
  error = false;
  conflictId?: string;
  draft: Record<string, string> = {};
  branches: string[] = [];
  repositoryRemoteRefs = new Map<string, string[]>();
  repositoryBranches = new Map<string, Set<string>>();
  branchSources = new Map<string, Map<string, string>>();
  ledger: { method: string; path: string; outcome: string }[] = [];
  sourceSelection = { workspace: "atlas", conversation: "source-conversation" };
  constructor() { this.reset("populated"); }
  reset(scenario: Scenario, latency = 0) {
    this.scenario = scenario; this.latency = Math.min(5000, Math.max(0, latency || 0));
    this.generation++; this.sequence = 0; this.fresh = false; this.message = ""; this.error = false;
    this.conflictId = undefined; this.draft = {}; this.ledger = [];
    this.branches = ["main", "feature/sidebar", "fix/navigation", "release"];
    this.repositoryRemoteRefs = new Map(["repository-atlas", "repository-beacon"].map(id => [id, ["origin/feature/search", "origin/release", "upstream/release"]]));
    this.repositoryBranches = new Map(["repository-atlas", "repository-beacon"].map(id => [id, new Set(this.branches)]));
    // Explicit synthetic history only; existing Git branches cannot reveal this.
    this.branchSources = new Map(["repository-atlas", "repository-beacon"].map(id => [id, new Map([["feature/sidebar", "main"]])]));
    this.sourceSelection = { workspace: "atlas", conversation: "source-conversation" };
    this.rows = [
      { id:"atlas", name:"Atlas", path:"/demo/workspaces/atlas", branch:"main", ownership:"main", registered:true, running:true, checkout:"checkout-main", authentication:"demo-auth", signing:"none" },
      { id:"atlas-sidebar", name:"Atlas · Sidebar", path:"/demo/workspaces/atlas-sidebar", branch:"feature/sidebar", ownership:"uatu", registered:true, running:false, checkout:"checkout-sidebar", base:"main · a1b2c3d", sourceRef:"main" },
      { id:"atlas-review", name:"Atlas · Review", path:"/demo/workspaces/atlas-review", branch:"review/accessibility", ownership:"external", registered:true, running:false, checkout:"checkout-review" },
    ];
    for (const row of this.rows) {
      row.repositoryId = "repository-atlas";
      if (row.ownership !== "main") { row.parentId = "atlas"; row.name = row.branch; }
    }
    this.rows[0]!.configuration = "default";
    this.rows[1]!.path = "/demo/workspaces/atlas.worktrees/feature-sidebar";
    this.rows.push({ id:"beacon", name:"Beacon", path:"/demo/workspaces/beacon", branch:"main", ownership:"main", registered:true, running:true, checkout:"checkout-beacon", repositoryId:"repository-beacon", authentication:"none", signing:"demo-signing", configuration:"review" });
    this.rows.push({ id:"beacon-sidebar", name:"feature/sidebar", path:"/demo/workspaces/beacon.worktrees/feature-sidebar", branch:"feature/sidebar", ownership:"uatu", registered:true, running:false, checkout:"checkout-beacon-sidebar", repositoryId:"repository-beacon", parentId:"beacon", sourceRef:"main" });
    if (scenario === "mixed-lifecycle") { this.rows[0]!.running = false; this.rows[1]!.running = true; this.rows[3]!.running = false; }
    if (scenario === "all-stopped") for (const row of this.rows) row.running = false;
    if (["non-main", "remote-main", "ambiguous-main", "no-main"].includes(scenario)) this.rows[0]!.branch = "feature/current";
    if (["remote-main", "ambiguous-main", "no-main"].includes(scenario)) this.repositoryBranches.get("repository-atlas")!.delete("main");
    if (scenario === "remote-main") this.repositoryRemoteRefs.set("repository-atlas", ["origin/main", "origin/release"]);
    if (scenario === "ambiguous-main") this.repositoryRemoteRefs.set("repository-atlas", ["origin/main", "upstream/main", "origin/release"]);
    if (scenario === "detached") { this.rows[0]!.branch = ""; this.rows[0]!.detached = true; }
    if (scenario === "unknown-branch") this.rows[0]!.branch = "";
    if(scenario === "missing" || scenario === "replaced") this.rows[2]!.availability = scenario;
    if(scenario === "replaced") this.rows[2]!.ownership = "uncertain";
    if(scenario === "stop-failure") this.rows[1]!.running = true;
    if(scenario === "empty") this.rows = this.rows.filter(row => row.ownership === "main");
    if(scenario === "inventory-error") this.fail("Inventory could not be refreshed. Showing explicitly stale inventory; retry Refresh inventory.");
  }
  fail(message: string) { this.message = message; this.error = true; }
  effective(row: WorktreeRow): WorktreeRow {
    const parent = this.rows.find(candidate => candidate.id === row.parentId && candidate.repositoryId === row.repositoryId);
    return parent ? { ...row, name: row.branch, authentication: parent.authentication, signing: parent.signing, configuration: parent.configuration } : row;
  }
  presentation(view: WorktreePresentation["view"], id?: string, sourceId?: string): WorktreePresentation {
    const selected = this.rows.find(row => row.id === id);
    const source = this.rows.find(row => row.id === (selected?.parentId ?? (selected?.ownership === "main" ? selected.id : sourceId)) && row.ownership === "main") ?? this.rows[0]!;
    return { view, source, rows:this.rows.filter(row => row.repositoryId === source.repositoryId).map(row => this.effective(row)), selected:selected ? this.effective(selected) : undefined,
      fresh:this.fresh, draft:this.draft, message:view === "delete" ? this.deletionBlocker() ?? (this.error ? this.message : "") : this.message, error:this.error || (view === "delete" && Boolean(this.deletionBlocker())), conflictId:this.conflictId,
      empty:this.scenario === "empty", loading:this.scenario === "loading", prefix:"/worktrees",
      defaults: { branch:"feature/checkout", parent:"/demo/workspaces", folder:"atlas-checkout", name:"Atlas · Checkout" },
      refs: { bases:[], local:[...new Set([...this.repositoryBranches.get(source.repositoryId!) ?? [], ...this.rows.filter(row => row.repositoryId === source.repositoryId && !row.detached).map(row => row.branch), "release"])].filter(Boolean).map(ref => [ref, ref]), remote:(this.repositoryRemoteRefs.get(source.repositoryId!) ?? []).map(ref => [ref, ref]), freshness:"Cached refs · last fetched 2 days ago · remote may have changed" },
      credentials:[{id:"demo-auth",label:"Demo HTTPS · ready (synthetic)",purpose:"authentication"},{id:"demo-signing",label:"Demo signing · ready (synthetic)",purpose:"signing"},{id:"locked",label:"Demo locked · unlock required",disabled:true},{id:"disabled",label:"Demo disabled · unavailable",disabled:true}],
    };
  }
  discover() {
    if(!this.rows.some(row => row.id === "atlas-agent")) this.rows.push({id:"atlas-agent",name:"agent/exploration",path:"/demo/workspaces/atlas-agent",branch:"agent/exploration",ownership:"external",registered:false,running:false,checkout:"checkout-agent",parentId:"atlas",repositoryId:"repository-atlas"});
  }
  // The harness calls only this finite allowlist. Unknown mutations never fall
  // through to the real Hub, even if a reviewer edits a form or URL.
  mutate(action: string, data: Record<string,string>): string {
    this.message = ""; this.error = false; this.conflictId = undefined;
    const row = this.rows.find(row => row.id === data.id);
    const source = this.rows.find(candidate => candidate.id === (row?.parentId ?? data.source ?? "atlas") && candidate.ownership === "main");
    const go = (view: string, id?: string) => `/worktrees?view=${view}&source=${encodeURIComponent(source?.id ?? "atlas")}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
    if (!source) { this.fail("Select a valid main workspace; children cannot create worktrees."); return go("inventory"); }
    if (action === "settings") {
      if (!row || row.ownership !== "main") { this.fail("Settings are managed only on the parent."); return go("inventory"); }
      row.authentication = data.authentication === "demo-auth" ? "demo-auth" : "none";
      row.signing = data.signing === "demo-signing" ? "demo-signing" : "none";
      row.configuration = data.configuration === "review" ? "review" : "default";
      this.message = "Parent policy updated. All children inherit these settings live; checkout and personal state unchanged.";
      return go("settings", row.id);
    }
    if(action === "refresh") {
      if(this.scenario === "discovery") this.discover();
      if(this.scenario === "loading" || this.scenario === "inventory-error") this.scenario = "populated";
      this.message = "Inventory refreshed. Your source workspace and conversation are unchanged."; return go("inventory");
    }
    if(action === "fetch") {
      this.draft = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "fetchCredential"));
      if(this.scenario === "fetch-auth") { this.fail("Fetch authentication failed. Correct credentials on the parent and retry. Cached refs remain unchanged."); this.scenario = "stale"; }
      else if(this.scenario === "fetch-network") { this.fail("Fetch network failure. Cached refs remain unchanged. Retry explicitly or confirm the displayed cached revision."); this.scenario = "stale"; }
      else {
        this.fresh = true;
        let remoteRefs = this.repositoryRemoteRefs.get(source.repositoryId!)!;
        if (this.scenario === "fetch-disappearance") remoteRefs = remoteRefs.filter(ref => `remote:${ref}` !== data.selection);
        if (!remoteRefs.includes("origin/fetched")) remoteRefs.push("origin/fetched");
        this.repositoryRemoteRefs.set(source.repositoryId!, remoteRefs);
        const refs = this.presentation("create", undefined, source.id).refs;
        if (data.selection && ![...refs.local.map(([ref]) => `local:${ref}`), ...refs.remote.map(([ref]) => `remote:${ref}`)].includes(data.selection)) {
          this.draft.selection = "";
          this.fail("The selected branch is no longer available. Choose another branch.");
        }
      }
      this.draft.mode = data.mode === "new" ? "new" : "existing";
      return go("create");
    }
    if(action === "create") {
      if (data.mode === "existing") {
        const separator = data.selection?.indexOf(":") ?? -1;
        const mode = data.selection?.slice(0, separator), ref = data.selection?.slice(separator + 1);
        if ((mode !== "local" && mode !== "remote") || !this.presentation("create", undefined, source.id).refs[mode].some(([value]) => value === ref)) { this.draft = { ...data }; this.fail("Select an available branch."); return go("create"); }
        data = { ...data, mode, [mode]: ref!, branch: mode === "remote" ? ref!.slice(ref!.indexOf("/") + 1) : ref!, cached: "1" };
      }
      if (data.mode === "new") {
        const separator = data.selection?.indexOf(":") ?? -1;
        const kind = data.selection?.slice(0, separator), ref = data.selection?.slice(separator + 1);
        if ((kind !== "local" && kind !== "remote") || !this.presentation("create", undefined, source.id).refs[kind].some(([value]) => value === ref)) {
          this.draft = { ...data, selection: "" }; this.fail("Select an available starting branch."); return go("create");
        }
        data = { ...data, base: ref! };
      }
      this.draft = { ...data };
      const branch = data.mode === "local" ? data.local : data.branch;
      let path = `${source.path}.worktrees/${branchFolder(branch ?? "")}`;
      if (this.rows.some(row => row.path.toLowerCase() === path.toLowerCase() && row.branch !== branch)) path += `-${suffix(branch ?? "")}`;
      if (data.mode === "local" && !this.presentation("create", undefined, source.id).refs.local.some(([value]) => value === data.local)) { this.fail("Selected ref is unavailable. Refresh and select a branch; no ref was substituted."); return go("create"); }
      if(!["new","local","remote"].includes(data.mode ?? "") || !branch || !validBranch(branch)) { this.fail("Invalid branch. Use a valid branch name, not an option, path traversal or revision expression."); return go("create"); }
      const occupied = this.rows.find(row => row.repositoryId === source.repositoryId && row.branch === branch);
      if(occupied || this.scenario === "checked-out") { this.fail("Branch already checked out. Open or configure its existing checkout instead; it cannot be forced into another tree."); this.conflictId = occupied?.id ?? source.id; return go("create"); }
      if(this.scenario === "branch-conflict" || (data.mode !== "local" && this.repositoryBranches.get(source.repositoryId!)?.has(branch))) { this.fail("Branch name already exists. Choose another name or use Existing local branch; no branch was reset."); return go("create"); }
      if(this.scenario === "path-conflict" || this.rows.some(row => row.path.toLowerCase() === path.toLowerCase())) { this.fail("Destination already exists. Resolve the collision externally or choose another branch; existing content was preserved."); return go("create"); }
      if(data.mode === "remote" && (!data.cached || !this.presentation("create", undefined, source.id).refs.remote.some(([value]) => value === data.remote))) { this.fail("Select an available remote branch. No ref was substituted."); return go("create"); }
      const id = `${source.id}-created-${++this.sequence}`;
      const sources = this.branchSources.get(source.repositoryId!)!;
      const sourceRef = data.mode === "new" ? data.base : data.mode === "remote" ? data.remote : sources.get(branch);
      const created: WorktreeRow = {id, name:branch, path, branch, parentId:source.id, repositoryId:source.repositoryId, ownership:"uatu", registered:this.scenario !== "registration-failure", running:false,checkout:`checkout-created-${this.sequence}`,base:data.mode === "new" ? data.base : data.mode === "remote" ? (data.remote === "origin/release" ? "d4e5f6a" : "b7c8d9e") : data.local, sourceRef, upstream:data.mode === "remote" ? data.remote : undefined};
      if (sourceRef) sources.set(branch, sourceRef);
      this.rows.push(created); if(!this.branches.includes(branch)) this.branches.push(branch);
      this.repositoryBranches.get(source.repositoryId!)?.add(branch);
      if(!created.registered) {
        created.authentication = "none"; created.signing = "none";
        this.fail("Registration failed. The checkout and branch are retained. Retry registration; do not create another checkout.");
        return go("configure",id);
      }
      this.message = "Worktree created and registered. Stopped by default; Start when you are ready.";
      if(data.start) return this.start(created,go);
      return go("result",id);
    }
    if(!row) { this.fail("Workspace identity not found. Refresh inventory."); return go("inventory"); }
    if(action === "register") {
      if(row.availability) { this.fail("Identity unavailable. Restore and verify the original checkout before registration."); return go("configure",row.id); }
      row.registered = true; row.name = row.branch;
      this.message = "Registered the retained checkout. No duplicate was created.";
      if(data.start) return this.start(row,go);
      return go("result",row.id);
    }
    if(action === "start") return this.start(row,go);
    if(action === "rename") { if (row.parentId) this.fail("Worktree name follows its branch; branch rename is out of scope."); else { row.name = data.name?.trim() || row.name; this.message = "Display name updated. Path, identity and stable URL unchanged."; } return go("rename",row.id); }
    if(action === "forget" || action === "delete") {
      const view = action;
      if(!data.confirm) { this.fail("Confirm the exact checkout and stop consequences first."); return go(view,row.id); }
      if(this.scenario === "stop-failure" && row.running) { this.fail("Could not stop the Uatu session. Checkout and registration retained. Resolve the session failure and retry; no removal occurred."); return go(view,row.id); }
      if(action === "forget") { row.running = false; row.registered = false; row.authentication = "none"; row.signing = "none"; this.message = "Removed from Hub. Checkout, branch, files and creation provenance preserved."; return go("inventory"); }
      if(row.ownership !== "uatu" || row.availability) { this.fail("Deletion refused: verified Uatu-created linked checkout identity is required."); return go("delete",row.id); }
       const blocker = this.deletionBlocker();
       if(blocker) { this.fail(blocker); return go("delete",row.id); }
      this.rows = this.rows.filter(candidate => candidate !== row);
      this.message = `Checkout ${row.path} removed; Hub registration cleared. Branch ${row.branch} preserved.`;
      return go("inventory");
    }
    throw new Error("Mutation not allowlisted");
  }
  private start(row: WorktreeRow, go: (view:string,id?:string)=>string) {
    if(!row.registered || row.availability) { this.fail("Start refused: register and verify the original checkout first."); return go("result",row.id); }
    if(this.scenario === "start-failure") { this.fail("Start failed. The configured workspace remains stopped with its assignments. Retry Start; do not create another checkout."); this.scenario = "populated"; return go("result",row.id); }
    row.running = true; return `/s/${encodeURIComponent(row.id)}/`;
  }
  deletionBlocker(): string | undefined {
    const blockers: Record<string,string> = { dirty:"Save or discard tracked changes outside Uatu, then try again.", untracked:"Preserve or remove untracked files outside Uatu, then try again.", ignored:"Preserve or remove ignored files outside Uatu, then try again.", locked:"Resolve the Git lock outside Uatu, then try again.", "in-use":"External activity is using this checkout. Stop it outside Uatu, then try again.", nested:"Resolve the nested checkout dependency outside Uatu, then try again." };
    return blockers[this.scenario] ? `${blockers[this.scenario]} Files and registration retained.` : undefined;
  }
}
