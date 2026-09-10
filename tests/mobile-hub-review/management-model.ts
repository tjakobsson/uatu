import type * as B from "../../src/hub/mobile/backend";
import type { CredentialAssignment, CredentialRecord, CredentialTool, PublicCredentialDto, PublicToolReadinessDto, ReadinessResult } from "../../src/hub/credential-types";
import type { WorkspaceEntry } from "../../src/hub/registry";
import type { ConfigureExistingInput } from "../../src/hub/onboarding";
import type { CloneJobEvent, CloneJobPhase, CloneJobResult } from "../../src/hub/clone-jobs";

export const FIXTURE_TIME = 1_783_036_800_000;
export const identity = { user: "reviewer", host: "mock.invalid", version: "review-only" };
export type Scenario = "mixed" | "empty" | "signed-out" | "branches" | "credentials" | "nested" | "unavailable-tools" | "all-running" | "all-stopped";
export type KeyState = "locked" | "unlocked" | "unprotected" | "unavailable";
export type ToolState = "ready" | "missing" | "incompatible" | "runtime-unavailable";
export type OnboardingFault = "needs-init" | "credential" | "git-init" | "register-failed" | "retained-checkout" | "committed-recovery" | "start-failed";
export type CloneOutcome = CloneJobResult["status"];
export type CloneAttemptRecord = { owner: number; state: B.CloneAttemptState };
export const tools: CredentialTool[] = ["ssh", "ssh-agent", "ssh-add", "ssh-keygen", "gpg", "gpgconf", "git", "gh", "glab"];
export class ModelProblem extends Error {
  constructor(readonly kind: B.BackendProblem["kind"], message: string) { super(message); }
}
export function requireValue(condition: unknown, message = "Invalid synthetic operation input.", kind: B.BackendProblem["kind"] = "invalid-input"): asserts condition {
  if (!condition) throw new ModelProblem(kind, message);
}
export function label(value: unknown, max = 256): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= max && !/[\p{Cc}\p{Cf}]/u.test(value));
  return value.trim();
}
export function folderName(value: unknown): string {
  const name = label(value); requireValue(!name.startsWith(".") && !/[\\/]/.test(name)); return name;
}
export function syntheticPath(value: unknown): string {
  requireValue(typeof value === "string" && value.startsWith("/synthetic") && !/[\\\0]/.test(value));
  const parts = value.split("/"); requireValue(parts[1] === "synthetic" && parts.slice(2).every(p => p !== "" && p !== "." && p !== ".." && !/[\p{Cc}\p{Cf}]/u.test(p)));
  return value;
}
export function host(value: unknown): string {
  requireValue(typeof value === "string" && value.trim() === value && !/\s/.test(value));
  let url: URL; try { url = new URL(value.includes("://") ? value : `https://${value}`); } catch { throw new ModelProblem("invalid-input", "Invalid synthetic credential host."); }
  requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/");
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  requireValue(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) || /^\[[0-9a-f:.]+\]$/.test(hostname));
  const port = url.port || (/:0*443\/?$/.test(value) ? "443" : "");
  return hostname + (port ? `:${port}` : "");
}
export function secretValid(value: unknown, allowEmpty = false, max = 4096): boolean {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) && !/\p{Cc}/u.test(value) && new TextEncoder().encode(value).length <= max;
}
/** Inspect size/source exclusivity, never read a File or retain pasted material. */
export function importValid(source: B.PrivateKeySource): boolean {
  if (!source || typeof source !== "object") return false;
  if (source.kind === "file") return !("text" in source) && !!source.file && Number.isFinite(source.file.size) && source.file.size > 0 && source.file.size <= 1_048_576;
  return source.kind === "paste" && !("file" in source) && typeof source.text === "string" && source.text.trim().length > 0 && !source.text.includes("\0") && new TextEncoder().encode(source.text).length <= 1_048_576;
}
const below = (path: string, parent: string) => path === parent || path.startsWith(parent + "/");
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const entryOf = (w: B.WorkspaceView): WorkspaceEntry => ({ id: w.id, path: w.path, displayName: w.displayName, backend: w.backend });
type Folder = { git: boolean; content: boolean; available: boolean };
type KeyRuntime = { state: KeyState; protected: boolean };
type Job = { id: string; owner: number; target: string; displayName: string; authentication: ConfigureExistingInput["authentication"]; signing: string | null; start: boolean; events: CloneJobEvent[]; listeners: Set<(event: B.CloneStreamEvent) => void>; phase: CloneJobPhase; result?: CloneJobResult; registeredId?: string; prompt: boolean; createdAt: number; lastActivity: number; finishedAt?: number };
const notify = (listener: (event: B.CloneStreamEvent) => void, event: B.CloneStreamEvent) => { try { listener(structuredClone(event)); } catch { /* listeners cannot change accepted job outcomes */ } };

export class ManagementModel {
  clock = FIXTURE_TIME;
  authenticated = true;
  workspaces: B.WorkspaceView[] = [];
  credentials: CredentialRecord[] = [];
  assignments: CredentialAssignment[] = [];
  keys = new Map<string, KeyRuntime>();
  unavailableCredentials = new Set<string>();
  unknownCredentialFacts = new Set<string>();
  userIds = new Map<string, B.KnownFact<string>>();
  unknownToolConfiguration = new Set<CredentialTool>();
  authContext = 0;
  readonly cloneAttempts = new Map<string, CloneAttemptRecord>();
  toolStates = new Map<CredentialTool, ToolState>();
  overrides = new Map<CredentialTool, string>();
  folders = new Map<string, Folder>();
  devices: B.DeviceView[] = [];
  configured: string | null = null;
  jobs = new Map<string, Job>();
  projected = new Map<string, Set<string>>();
  private runningRevisions = new Map<string, string>();
  stopFailures = new Set<string>();
  unlockFails = false;
  importFails = false;
  onboardingFault: OnboardingFault | null = null;
  folderFault: "before-mutation" | "after-stop" | null = null;
  cloneCleanupFails = false;
  private serial = 0;
  constructor(private readonly changed: (event: { scope: "catalog"; resource: "workspaces" | "credentials" | "tools" | "devices" | "default-folder" } | { scope: "workspace"; workspaceId: string; reason: "stopped" | "removed" }) => void) { this.reset(); }
  catalog(resource: "workspaces" | "credentials" | "tools" | "devices" | "default-folder") { this.changed({ scope: "catalog", resource }); }
  newWorkspace(path: string, displayName: string, id = `workspace-${++this.serial}`): B.WorkspaceView {
    return { id, path, displayName, backend: "local", runtime: { status: "stopped" }, branch: { kind: "named", name: "review/main" }, assignments: [], credentialRestartRequired: false, workspaceApiRevision: 14 };
  }
  reset(scenario: Scenario = "mixed") {
    this.authContext++;
    // Retain only opaque non-secret tombstones: a pre-reset attempt must not
    // become an authoritative "not accepted" merely because jobs were reset.
    for (const attempt of this.cloneAttempts.values()) attempt.state = { status: "expired" };
    this.unknownCredentialFacts.clear(); this.userIds.clear(); this.unknownToolConfiguration.clear();
    this.runningRevisions.clear();
    this.unavailableCredentials.clear();
    for (const job of this.jobs.values()) for (const listener of job.listeners) notify(listener, { type: "unavailable", reason: "not-found-or-expired", message: "Synthetic review reset; job expired." });
    this.clock = FIXTURE_TIME; this.authenticated = scenario !== "signed-out"; this.serial = 0; this.jobs.clear(); this.assignments = []; this.configured = null; this.projected.clear(); this.stopFailures.clear(); this.keys.clear(); this.toolStates.clear(); this.overrides.clear(); this.folders.clear(); this.onboardingFault = null; this.folderFault = null; this.unlockFails = false; this.importFails = false; this.cloneCleanupFails = false;
    this.devices = [{ handle: "review-device", current: true, deviceLabel: "Synthetic browser", issuedAt: FIXTURE_TIME }, { handle: "review-other-device", current: false, deviceLabel: "Synthetic tablet", issuedAt: FIXTURE_TIME - 86_400_000 }];
    this.workspaces = scenario === "empty" ? [] : [this.newWorkspace("/synthetic/atlas", "Atlas", "atlas"), this.newWorkspace("/synthetic/notes", "Notes", "notes")];
    if (this.workspaces[0]) { this.workspaces[0].runtime = { status: "running", shells: { status: "ready", value: [{ label: "Synthetic terminal", attached: true }] } }; this.projected.set("atlas", new Set()); }
    if (this.workspaces[1]) this.workspaces[1].branch = { kind: "unborn", name: "draft" };
    this.folders.set("/synthetic", { git: false, content: false, available: true });
    for (const [path, git, content, available] of [["/synthetic/existing", true, true, true], ["/synthetic/empty-folder", false, false, true], ["/synthetic/denied", false, false, false], ["/synthetic/group", false, false, true]] as const) this.folders.set(path, { git, content, available });
    for (const w of this.workspaces) this.folders.set(w.path, { git: true, content: true, available: true });
    if (scenario === "nested") {
      for (const [id, path] of [["nested-parent", "/synthetic/group"], ["nested-child", "/synthetic/group/child"]]) { const w = this.newWorkspace(path!, "Nested", id); w.runtime = { status: "running", shells: { status: "ready", value: [] } }; this.workspaces.push(w); this.folders.set(path!, { git: false, content: false, available: true }); this.projected.set(w.id, new Set()); }
    }
    if (scenario === "branches") {
      const branches: B.BranchState[] = [{ kind: "detached", commit: "abc1234" }, { kind: "non-git" }, { kind: "loading" }, { kind: "unavailable", message: "Synthetic metadata unavailable." }];
      branches.forEach((branch, i) => { const w = this.newWorkspace(`/synthetic/branch-${i}`, "Notes", `branch-${i}`); w.branch = branch; this.workspaces.push(w); this.folders.set(w.path, { git: branch.kind !== "non-git", content: true, available: true }); });
    }
    this.credentials = [];
    if (scenario !== "empty") {
      this.addKey("ssh", "Review SSH (locked)", ["ssh-authentication", "ssh-signing"], true, "ssh-locked");
      this.addKey("ssh", "Review SSH (unprotected)", ["ssh-authentication"], false, "ssh-open");
      this.addKey("openpgp", "Review signing", ["openpgp-signing"], true, "pgp-locked");
      this.userIds.set("pgp-locked", { status: "known", value: "Review signer <review@mock.invalid>" });
      this.addToken("Review HTTPS and GitHub", "github.com", "reviewer", ["https-git", "github-cli"], "token-github");
      this.addToken("Review GitLab (disabled)", "gitlab.com", "reviewer", ["https-git", "gitlab-cli"], "token-gitlab").enabled = false;
      if (scenario === "credentials") { this.assignments = [{ workspaceId: "atlas", credentialId: "token-github", role: "authentication", host: "github.com" }, { workspaceId: "notes", credentialId: "ssh-locked", role: "authentication", host: "github.com" }, { workspaceId: "notes", credentialId: "pgp-locked", role: "signing" }]; this.projected.set("atlas", new Set(["token-github"])); }
    }
    for (const tool of tools) this.toolStates.set(tool, scenario === "unavailable-tools" ? (tool === "git" ? "incompatible" : "missing") : "ready");
    if (scenario === "all-running") for (const w of this.workspaces) { w.runtime = { status: "running", shells: { status: "ready", value: [] } }; this.projected.set(w.id, new Set()); }
    if (scenario === "all-stopped") { for (const w of this.workspaces) w.runtime = { status: "stopped" }; this.projected.clear(); }
    for (const w of this.workspaces) if (w.runtime.status === "running") this.runningRevisions.set(w.id, this.revision(w.id));
  }
  private revision(id: string) { const assignments = this.assignments.filter(a => a.workspaceId === id).map(a => ({ ...a, credential: this.credentials.find(c => c.id === a.credentialId) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); return JSON.stringify({ assignments, overrides: [...this.overrides].sort(([a], [b]) => a.localeCompare(b)) }); }
  refreshRestart() { for (const w of this.workspaces) w.credentialRestartRequired = w.runtime.status === "running" && this.runningRevisions.get(w.id) !== this.revision(w.id); }
  workspace(id: string) { const w = this.workspaces.find(w => w.id === id); requireValue(w, "Synthetic workspace not found.", "not-found"); return w; }
  workspaceViews() { return this.workspaces.map(w => ({ ...w, assignments: this.assignments.filter(a => a.workspaceId === w.id) })); }
  credential(target: B.CredentialTarget | string) {
    const id = typeof target === "string" ? target : target.id;
    const c = this.credentials.find(c => c.id === id); requireValue(c, "Synthetic credential not found.", "not-found");
    requireValue(typeof target === "string" || c.type === target.type, "Credential type does not match target."); return c;
  }
  key(target: B.KeyTarget) { const c = this.credential(target); requireValue(c.type !== "token", "Token credentials have no public key or unlock action."); return c; }
  tool(tool: CredentialTool): PublicToolReadinessDto {
    requireValue(tools.includes(tool), "Unknown synthetic credential tool."); const state = this.toolStates.get(tool) ?? "ready";
    // Tool association is known here, before anonymous rows cross the backend seam.
    const results: ReadinessResult[] = [
      { layer: "binary", status: state === "missing" ? "unavailable" : "ready", message: `${tool}: ${state === "missing" ? "Software not found; configure an executable override" : "Software available"} (simulated; no executable probed).` },
      { layer: "version", status: state === "incompatible" ? "unavailable" : state === "missing" ? "not-applicable" : "ready", message: `${tool}: ${state === "incompatible" ? "Version is incompatible" : state === "missing" ? "Version check does not apply because software is missing" : "Version is compatible"} (simulated).` },
      { layer: "runtime", status: state === "runtime-unavailable" ? "unavailable" : state === "missing" ? "not-applicable" : "ready", message: `${tool}: ${state === "runtime-unavailable" ? "Local service unavailable" : state === "missing" ? "Local operation check does not apply because software is missing" : "Local operation ready"} (simulated; no process launched).` },
    ];
    return { tool, path: this.overrides.get(tool) ?? (state === "missing" ? null : `/synthetic/bin/${tool}`), version: state === "missing" ? null : "synthetic-1", results, guidance: state === "ready" ? null : "Choose a synthetic tool override or change the tool-readiness scenario." };
  }
  requiredTools(c: CredentialRecord): CredentialTool[] { return c.type === "ssh" ? ["ssh", "ssh-agent", "ssh-add", "ssh-keygen", ...(c.capabilities.includes("ssh-signing") ? ["git" as const] : [])] : c.type === "openpgp" ? ["gpg", "gpgconf", "git"] : ["git", ...(c.capabilities.includes("github-cli") ? ["gh" as const] : []), ...(c.capabilities.includes("gitlab-cli") ? ["glab" as const] : [])]; }
  readiness(c: CredentialRecord): ReadinessResult[] {
    const results = this.requiredTools(c).flatMap(t => this.tool(t).results.filter(r => r.layer !== "runtime" || c.type !== "token"));
    const key = this.keys.get(c.id);
    results.push({ layer: "credential", status: c.enabled && key?.state !== "unavailable" && !this.unavailableCredentials.has(c.id) ? "ready" : "unavailable", message: !c.enabled ? "Credential is disabled." : key?.state === "unavailable" || this.unavailableCredentials.has(c.id) ? "Synthetic private material unavailable." : "Synthetic credential available." });
    results.push({ layer: "capability", status: c.enabled && (!key || key.state === "unlocked" || key.state === "unprotected") ? "ready" : "unavailable", message: key?.state === "locked" ? "Credential is locked; unlock before use." : key?.state === "unprotected" ? "Unprotected SSH key is available in the synthetic agent." : key?.state === "unlocked" ? "Credential is unlocked in the synthetic agent." : c.type === "token" ? "Synthetic token capability; no provider request performed." : "Synthetic capability unavailable." });
    return results;
  }
  dto(id: string): PublicCredentialDto { const c = this.credential(id); return { ...c, assignments: this.assignments.filter(a => a.credentialId === id), readiness: this.readiness(c) }; }
  credentialFacts(target: B.CredentialTarget): B.CredentialFacts {
    const c = this.credential(target);
    if (c.type === "token") return { id: c.id, type: c.type, protection: { status: "not-applicable" }, lock: { status: "not-applicable" }, userId: { status: "not-applicable" } };
    const key = this.keys.get(c.id); const unknown = this.unknownCredentialFacts.has(c.id);
    const protection: B.KnownFact<"protected" | "unprotected"> = !unknown && key ? { status: "known", value: key.protected ? "protected" : "unprotected" } : { status: "unknown" };
    const lock: B.KnownFact<"locked" | "unlocked"> = !unknown && key && key.state !== "unavailable" ? { status: "known", value: key.state === "locked" ? "locked" : "unlocked" } : { status: "unknown" };
    return c.type === "ssh" ? { id: c.id, type: c.type, protection, lock, userId: { status: "not-applicable" } } : { id: c.id, type: c.type, protection, lock, userId: unknown ? { status: "unknown" } : this.userIds.get(c.id) ?? { status: "unknown" } };
  }
  toolConfiguration(tool: CredentialTool): B.ToolConfiguration {
    requireValue(tools.includes(tool), "Unknown synthetic tool.");
    return { tool, savedOverride: this.unknownToolConfiguration.has(tool) ? { status: "unknown" } : { status: "known", value: this.overrides.get(tool) ?? null } };
  }
  attemptId(value: unknown): string { requireValue(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value), "Invalid synthetic clone attempt id."); return value; }
  reconcileAttempt(id: string): B.CloneAttemptState {
    this.attemptId(id); const record = this.cloneAttempts.get(id);
    if (!record) { const state = { status: "not-accepted" as const }; this.cloneAttempts.set(id, { owner: this.authContext, state }); return state; }
    requireValue(record.owner === this.authContext, "Clone attempt unavailable in this authenticated context.", "unavailable");
    if (record.state.status === "accepted" && !this.jobs.has(record.state.jobId)) record.state = { status: "expired" };
    return record.state;
  }
  addKey<T extends "ssh" | "openpgp">(type: T, name: string, capabilities: CredentialRecord["capabilities"], protectedKey: boolean, id = `credential-${++this.serial}`): Extract<CredentialRecord, { type: T }> {
    const base = { id, name: label(name), enabled: true, createdAt: new Date(this.clock).toISOString(), metadata: { fingerprint: `SYNTHETIC:${id}`, publicKey: type === "ssh" ? `ssh-ed25519 SYNTHETIC-PUBLIC-ONLY ${id}` : `-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC-PUBLIC-ONLY ${id}\n-----END PGP PUBLIC KEY BLOCK-----` } };
    const c: CredentialRecord = type === "ssh" ? { ...base, type, capabilities: capabilities as Array<"ssh-authentication" | "ssh-signing"> } : { ...base, type: "openpgp", capabilities: ["openpgp-signing"] };
    this.credentials.push(c); this.keys.set(id, { state: protectedKey ? "locked" : "unprotected", protected: protectedKey });
    return c as Extract<CredentialRecord, { type: T }>;
  }
  addToken(name: string, tokenHost: string, username: string | undefined, capabilities: Array<"https-git" | "github-cli" | "gitlab-cli">, id = `credential-${++this.serial}`) {
    requireValue(capabilities.length > 0 && new Set(capabilities).size === capabilities.length && capabilities.every(c => ["https-git", "github-cli", "gitlab-cli"].includes(c)) && !(capabilities.includes("github-cli") && capabilities.includes("gitlab-cli")));
    const c: Extract<CredentialRecord, { type: "token" }> = { id, name: label(name), type: "token", enabled: true, createdAt: new Date(this.clock).toISOString(), capabilities: [...capabilities], metadata: { host: host(tokenHost), ...(username === undefined ? {} : { username: label(username) }) } }; this.credentials.push(c); return c;
  }
  requireTools(c: CredentialRecord) { requireValue(this.requiredTools(c).every(t => this.tool(t).results.every(r => r.status !== "unavailable")), "Required synthetic tooling is unavailable or incompatible.", "unavailable"); requireValue(!this.unavailableCredentials.has(c.id), "Synthetic credential material unavailable.", "unavailable"); }
  validateAssignment(a: CredentialAssignment): CredentialAssignment {
    this.workspace(a.workspaceId); const c = this.credential(a.credentialId);
    requireValue(c.enabled, "Disabled credentials cannot be assigned.", "conflict");
    if (a.role === "authentication") { const normalized = host(a.host); requireValue((c.type === "ssh" && c.capabilities.includes("ssh-authentication")) || (c.type === "token" && (c.capabilities.includes("https-git") || c.capabilities.includes("github-cli") || c.capabilities.includes("gitlab-cli"))), "Credential cannot authenticate."); requireValue(c.type !== "token" || normalized === c.metadata.host, "Token assignment host must match its host."); return { workspaceId: a.workspaceId, credentialId: a.credentialId, role: a.role, host: normalized }; }
    requireValue(a.role === "signing" && ((c.type === "ssh" && c.capabilities.includes("ssh-signing")) || c.type === "openpgp"), "Credential cannot sign.");
    requireValue(!("host" in a), "Signing assignments do not have a host."); return { workspaceId: a.workspaceId, credentialId: a.credentialId, role: a.role };
  }
  slot(a: CredentialAssignment, b: CredentialAssignment) { return a.workspaceId === b.workspaceId && a.role === b.role && (a.role !== "authentication" || (b.role === "authentication" && a.host === b.host)); }
  assign(values: CredentialAssignment[], replace: boolean) {
    const normalized = values.map(a => this.validateAssignment(a));
    requireValue(!normalized.some((a, i) => normalized.slice(i + 1).some(b => this.slot(a, b))), "Duplicate assignment slot.");
    for (const a of normalized) requireValue(replace || !this.assignments.some(b => this.slot(a, b) && a.credentialId !== b.credentialId), "Assignment replacement needs explicit consent.", "conflict");
    let changed = false;
    for (const a of normalized) { if (this.assignments.some(b => this.slot(a, b) && a.credentialId === b.credentialId)) continue; this.assignments = this.assignments.filter(b => !this.slot(a, b)); this.assignments.push(a); changed = true; }
    this.refreshRestart();
    if (changed) { this.catalog("credentials"); this.catalog("workspaces"); }
    return normalized;
  }
  stop(id: string): { status: "stopped" | "already-stopped" } {
    const w = this.workspace(id); if (w.runtime.status === "stopped") return { status: "already-stopped" };
    requireValue(!this.stopFailures.has(id), "Synthetic stop failed; catalog was not changed. Some prior dependent sessions may have stopped.", "unavailable");
    w.runtime = { status: "stopped" }; w.credentialRestartRequired = false; this.projected.delete(id); this.runningRevisions.delete(id); this.changed({ scope: "workspace", workspaceId: id, reason: "stopped" }); return { status: "stopped" };
  }
  coordinated<T>(ids: string[], consent: B.StopConsent, effect: () => T): B.CoordinatedResult<T> {
    requireValue(consent === "ask" || consent === "stop-dependent-workspaces");
    const running = [...new Set(ids)].filter(id => this.workspace(id).runtime.status === "running").sort();
    if (running.length && consent === "ask") return { status: "needs-stop", workspaceIds: running };
    for (const id of running) this.stop(id);
    return { status: "completed", value: effect() };
  }
  providerDependents(c: CredentialRecord) { return c.type === "token" && c.capabilities.some(cap => cap === "github-cli" || cap === "gitlab-cli") ? [...this.projected].filter(([, ids]) => ids.has(c.id)).map(([id]) => id) : []; }
  start(id: string, confirm: boolean): B.StartWorkspaceResult {
    const w = this.workspace(id); if (w.runtime.status === "running") return { status: "running", workspaceId: id };
    this.folder(w.path);
    const assignments = this.assignments.filter(a => a.workspaceId === id);
    if (!assignments.length && !confirm) return { status: "confirm-unassigned", workspaceId: id };
    const locked: B.KeyTarget[] = [];
    for (const a of assignments) { const c = this.credential(a.credentialId); requireValue(c.enabled, "An assigned credential is disabled.", "conflict"); this.requireTools(c); const state = this.keys.get(c.id)?.state; requireValue(state !== "unavailable" && !this.unavailableCredentials.has(c.id), "Assigned credential is unavailable.", "unavailable"); if (state === "locked" && c.type !== "token" && !locked.some(k => k.id === c.id)) locked.push({ id: c.id, type: c.type }); }
    if (locked.length) return { status: "requires-unlock", credentials: locked as [B.KeyTarget, ...B.KeyTarget[]] };
    w.runtime = { status: "running", shells: { status: "ready", value: [] } }; w.credentialRestartRequired = false; this.projected.set(id, new Set(assignments.map(a => a.credentialId))); this.runningRevisions.set(id, this.revision(id)); this.catalog("workspaces"); return { status: "running", workspaceId: id };
  }
  folder(path: string) { const p = syntheticPath(path); const f = this.folders.get(p); requireValue(f, "Synthetic folder not found.", "not-found"); requireValue(f.available, "Synthetic folder permission unavailable.", "forbidden"); return f; }
  defaultFolder() { const available = this.configured !== null && this.folders.get(this.configured)?.available === true; return { configured: this.configured, configuredAvailable: available, effective: available ? this.configured! : "/synthetic" }; }
  browse(path = this.defaultFolder().effective): B.FolderListing {
    this.folder(path); return { path, parent: path === "/synthetic" ? null : parentOf(path), directories: [...this.folders].filter(([p]) => p !== path && parentOf(p) === path).sort(([a], [b]) => a.localeCompare(b)).map(([p, f]) => { const w = this.workspaceViews().find(w => w.path === p); return { name: p.slice(path.length + 1), git: f.git, registration: w ? { status: "registered", workspace: entryOf(w), runtime: w.runtime } : { status: "unregistered" } }; }) };
  }
  reserved(path: string) { return [...this.jobs.values()].some(j => !j.result && (below(path, j.target) || below(j.target, path))); }
  createFolder(parent: string, name: string) { this.folder(parent); const path = `${parent}/${folderName(name)}`; requireValue(!this.folders.has(path) && !this.reserved(path), "Synthetic folder destination exists or is reserved.", "conflict"); this.folders.set(path, { git: false, content: false, available: true }); return { path }; }
  renameFolder(path: string, name: string, consent: B.StopConsent) {
    requireValue(consent === "ask" || consent === "stop-dependent-workspaces", "Invalid stop consent.");
    this.folder(path); requireValue(path !== "/synthetic" && !this.reserved(path), "Synthetic root/reserved folder cannot move.", "conflict"); const target = `${parentOf(path)}/${folderName(name)}`;
    const affected = this.workspaces.filter(w => below(w.path, path));
    if (target === path) return { status: "completed" as const, value: { path, workspaceIds: affected.map(w => w.id) } };
    requireValue(!this.folders.has(target) && !this.reserved(target), "Synthetic destination collision.", "conflict"); requireValue(this.folderFault !== "before-mutation", "Synthetic folder preflight failed.", "unavailable");
    return this.coordinated(affected.map(w => w.id), consent, () => { requireValue(this.folderFault !== "after-stop", "Synthetic folder rename failed after dependent stops; paths unchanged.", "unavailable"); for (const [p, f] of [...this.folders]) if (below(p, path)) { this.folders.delete(p); this.folders.set(target + p.slice(path.length), f); } for (const w of affected) w.path = target + w.path.slice(path.length); this.catalog("workspaces"); this.catalog("default-folder"); return { path: target, workspaceIds: affected.map(w => w.id) }; });
  }
  removeFolder(path: string, consent: B.StopConsent) {
    const f = this.folder(path); requireValue(path !== "/synthetic" && !this.reserved(path), "Cannot remove synthetic root or reserved folder.", "conflict"); requireValue(!f.content && !f.git && ![...this.folders.keys()].some(p => p !== path && below(p, path)), "Folder is not empty; no synthetic files were deleted.", "conflict");
    const affected = this.workspaces.filter(w => below(w.path, path)); requireValue(!affected.some(w => w.path !== path), "Nested registrations prevent empty-folder removal.", "conflict"); requireValue(this.folderFault !== "before-mutation", "Synthetic remove preflight failed.", "unavailable");
    return this.coordinated(affected.map(w => w.id), consent, () => { requireValue(this.folderFault !== "after-stop", "Synthetic removal failed after stop; folder retained.", "unavailable"); this.folders.delete(path); const w = affected[0]; if (w) this.forget(w.id); this.catalog("default-folder"); return { path, ...(w ? { workspaceId: w.id } : {}) }; });
  }
  forget(id: string) { const w = this.workspaces.find(w => w.id === id); if (!w) return { status: "not-found" as const }; requireValue(w.runtime.status === "stopped", "Stop before forgetting the registration.", "conflict"); this.workspaces = this.workspaces.filter(w => w.id !== id); this.assignments = this.assignments.filter(a => a.workspaceId !== id); this.projected.delete(id); this.changed({ scope: "workspace", workspaceId: id, reason: "removed" }); this.catalog("credentials"); return { status: "forgotten" as const }; }
  configure(input: ConfigureExistingInput, createdFolder = false): B.OnboardingOutcome {
    const path = syntheticPath(input.path); const f = this.folder(path); const existing = this.workspaces.find(w => w.path === path);
    if (existing) return { status: "configured", result: { entry: entryOf(existing), created: false, alreadyRegistered: true, createdFolder: false, started: false, startError: null } };
    if (!f.git && !input.init) return { status: "failed", code: "needs-init", message: "Explicit Git initialization consent is required." };
    const name = label(input.displayName, 64); const w = this.newWorkspace(path, name);
    // Validate selections against a temporary registration, then remove it before
    // effects. No partially applied assignment can escape a validation error.
    this.workspaces.push(w); let values: CredentialAssignment[];
    try { values = [...input.authentication.map(a => ({ ...a, workspaceId: w.id, role: "authentication" as const })), ...(input.signing ? [{ workspaceId: w.id, credentialId: input.signing, role: "signing" as const }] : [])].map(a => this.validateAssignment(a)); requireValue(!values.some((a, i) => values.slice(i + 1).some(b => this.slot(a, b))), "Duplicate onboarding authentication host."); }
    catch { this.workspaces.pop(); return { status: "failed", code: "credential", message: "Synthetic onboarding credential selection is invalid." }; }
    this.workspaces.pop();
    const fault = this.onboardingFault;
    if (fault === "needs-init" || fault === "credential" || fault === "git-init") return { status: "failed", code: fault, message: "Synthetic onboarding preflight failed." };
    f.git = true; f.content = true;
    if (fault === "register-failed" || fault === "retained-checkout") return { status: "failed", code: fault === "retained-checkout" ? "recovery-required" : "internal", message: "Synthetic registration failed; checkout retained for Existing folder recovery.", retainedPath: path };
    this.workspaces.push(w); this.assignments.push(...values); this.catalog("workspaces"); this.catalog("credentials");
    if (fault === "committed-recovery") return { status: "failed", code: "recovery-pending", message: "Synthetic registration committed; recovery acknowledgement pending.", retainedPath: path, committedEntry: entryOf(w) };
    let started = false; let startError: string | null = null;
    if (input.start) { try { requireValue(fault !== "start-failed", "Synthetic start failed.", "unavailable"); const result = this.start(w.id, true); started = result.status === "running"; if (!started) startError = "Assigned synthetic keys require unlock; configured workspace retained stopped."; } catch { startError = "Synthetic start failed; configured workspace retained stopped."; } }
    return { status: "configured", result: { entry: entryOf(w), created: true, alreadyRegistered: false, createdFolder, ...(started ? { started: true, startError: null } : { started: false, startError }) } };
  }
  createWorkspace(input: B.CreateNewWorkspaceIntent): B.OnboardingOutcome {
    requireValue(input.gitInitConsent === "confirmed", "Explicit Git-init consent is required."); this.folder(input.parent); const path = `${input.parent}/${folderName(input.folderName)}`; requireValue(!this.folders.has(path) && !this.reserved(path), "Synthetic workspace destination exists or is reserved.", "conflict");
    this.folders.set(path, { git: false, content: false, available: true });
    try { const result = this.configure({ path, displayName: input.displayName, authentication: input.authentication, signing: input.signing, init: true, start: input.start }, true); if (result.status === "failed" && !result.retainedPath && !result.committedEntry) this.folders.delete(path); return result; } catch (error) { this.folders.delete(path); throw error; }
  }
  submitClone(input: B.CloneIntent): B.CloneSubmission {
    // A remote is validated but never retained: it may contain secret query or
    // userinfo. Only the normalized transport/host are used for compatibility.
    let transport: "ssh" | "https"; let remoteHost: string;
    if (/^[^@\s/:]+@[^:\s]+:.+$/.test(input.url)) { transport = "ssh"; remoteHost = host(input.url.split("@")[1]!.split(":")[0]!); }
    else { let remote: URL; try { remote = new URL(input.url); } catch { throw new ModelProblem("invalid-input", "Invalid synthetic clone URL."); } requireValue(["https:", "ssh:", "git+ssh:"].includes(remote.protocol) && !remote.password && !remote.search && !remote.hash && (remote.protocol !== "https:" || !remote.username), "Synthetic clone requires an SSH or HTTPS remote without embedded secrets."); transport = remote.protocol === "https:" ? "https" : "ssh"; remoteHost = host(remote.host); }
    this.folder(input.dest); const target = `${input.dest}/${folderName(input.folderName)}`; requireValue(!this.folders.has(target) && !this.reserved(target), "Clone destination exists or is reserved.", "conflict");
    if (input.credentialId) { const c = this.credential(input.credentialId); requireValue(c.enabled, "Selected clone credential is disabled.", "conflict"); requireValue(transport === "ssh" ? c.type === "ssh" && c.capabilities.includes("ssh-authentication") : c.type === "token" && c.capabilities.includes("https-git") && c.metadata.host === remoteHost, "Selected clone credential is incompatible with transport/host."); this.requireTools(c); requireValue(!this.unavailableCredentials.has(c.id), "Clone credential unavailable.", "unavailable"); if (c.type === "ssh" && this.keys.get(c.id)?.state === "locked") return { status: "requires-unlock", credential: { id: c.id, type: "ssh" } }; requireValue(this.keys.get(c.id)?.state !== "unavailable", "Clone credential unavailable.", "unavailable"); }
    const probe = this.newWorkspace(target, label(input.displayName, 64)); this.workspaces.push(probe);
    let retained: CredentialAssignment[]; try { retained = [...input.retainedAuthentication.map(a => this.validateAssignment({ ...a, workspaceId: probe.id, role: "authentication" })), ...(input.signing ? [this.validateAssignment({ workspaceId: probe.id, credentialId: input.signing, role: "signing" })] : [])]; requireValue(!retained.some((a, i) => retained.slice(i + 1).some(b => this.slot(a, b))), "Duplicate retained authentication host."); } finally { this.workspaces.pop(); }
    const id = `clone-${++this.serial}`; const job: Job = { id, owner: this.authContext, target, displayName: probe.displayName, authentication: retained.filter((a): a is Extract<CredentialAssignment, { role: "authentication" }> => a.role === "authentication").map(a => ({ credentialId: a.credentialId, host: a.host })), signing: input.signing, start: input.start, phase: "cloning", events: [], listeners: new Set(), prompt: false, createdAt: this.clock, lastActivity: this.clock };
    this.jobs.set(id, job); this.jobEvent(job, { type: "phase", data: { phase: "cloning" } }); return { status: "accepted", jobId: id };
  }
  job(id: string) { const j = this.jobs.get(id); requireValue(j, "Synthetic clone job missing or expired.", "not-found"); return j; }
  ownedJob(id: string) { const j = this.job(id); requireValue(j.owner === this.authContext, "Synthetic clone job unavailable in this authenticated context.", "not-found"); return j; }
  jobEvent(job: Job, value: { type: "phase"; data: { phase: CloneJobPhase } } | { type: "output"; data: { output: string } } | { type: "result"; data: CloneJobResult }) {
    const event = { id: (job.events.at(-1)?.id ?? 0) + 1, ...value } as CloneJobEvent;
    job.events.push(event); if (job.events.length > 200) job.events.shift(); job.lastActivity = this.clock;
    for (const listener of [...job.listeners]) notify(listener, { type: "job-event", event });
  }
  clonePhase(id: string, phase: CloneJobPhase) {
    const j = this.job(id); requireValue(!j.result && ["cloning", "registering", "starting"].includes(phase), "Clone is terminal or phase invalid.", "conflict");
    requireValue(["cloning", "registering", "starting"].indexOf(phase) >= ["cloning", "registering", "starting"].indexOf(j.phase), "Clone phases cannot move backwards.");
    requireValue(phase !== "starting" || j.start, "Start was not requested.");
    if (phase !== "cloning") this.folders.set(j.target, { git: true, content: true, available: true });
    if (phase === "starting" && !j.registeredId) {
      const configured = this.configure({ path: j.target, displayName: j.displayName, authentication: j.authentication, signing: j.signing, init: false, start: false });
      requireValue(configured.status === "configured", "Synthetic registration failed before start phase.", "unavailable"); j.registeredId = configured.result.entry.id;
    }
    j.phase = phase; this.jobEvent(j, { type: "phase", data: { phase } });
  }
  cloneOutput(id: string, kind: "progress" | "prompt") { const j = this.job(id); requireValue(!j.result && ["progress", "prompt"].includes(kind), "Clone is terminal or output control invalid.", "conflict"); j.prompt = kind === "prompt"; this.jobEvent(j, { type: "output", data: { output: kind === "prompt" ? "Synthetic remote input required (all input is masked)." : "Synthetic checkout progress; no remote contacted." } }); }
  finishClone(id: string, outcome: CloneOutcome, timeoutReason: "inactivity" | "lifetime" = "inactivity"): CloneJobResult {
    const j = this.job(id); requireValue(!j.result, "Clone job already terminal.", "conflict"); requireValue(["succeeded", "clone-failed", "register-failed", "start-failed", "cleanup-failed", "cancelled", "timed-out"].includes(outcome), "Unknown synthetic clone outcome."); requireValue(outcome !== "start-failed" || j.start, "Start was not requested.");
    let result: CloneJobResult;
    if (outcome === "cancelled" || outcome === "timed-out" || outcome === "clone-failed") {
      if (j.registeredId) { this.stop(j.registeredId); this.forget(j.registeredId); }
      this.folders.delete(j.target);
      result = outcome === "clone-failed" ? { status: outcome, target: j.target, error: "Synthetic clone failed; no checkout retained." } : { status: outcome, target: j.target, ...(outcome === "timed-out" ? { reason: timeoutReason } : {}) };
    }
    else {
      this.folders.set(j.target, { git: true, content: true, available: true });
      if (outcome === "register-failed" || outcome === "cleanup-failed") {
        requireValue(outcome !== "register-failed" || !j.registeredId, "Registration already committed; choose start-failed or cleanup-failed.");
        result = { status: outcome, target: j.target, error: "Synthetic checkout retained; cleanup or registration incomplete.", ...(j.registeredId ? { workspaceId: j.registeredId } : {}) };
      }
      else {
        const previousFault = this.onboardingFault; this.onboardingFault = outcome === "start-failed" ? "start-failed" : null;
        let configured: B.OnboardingOutcome; try {
          if (j.registeredId) {
            const w = this.workspace(j.registeredId); let started = false; let startError: string | null = null;
            if (j.start) { try { requireValue(outcome !== "start-failed", "Synthetic start failed."); const startedResult = this.start(w.id, true); started = startedResult.status === "running"; if (!started) startError = "Synthetic assigned credentials require unlock."; } catch { startError = "Synthetic start failed; registration retained stopped."; } }
            configured = { status: "configured", result: { entry: entryOf(w), created: true, alreadyRegistered: false, createdFolder: false, ...(started ? { started: true, startError: null } : { started: false, startError }) } };
          } else configured = this.configure({ path: j.target, displayName: j.displayName, authentication: j.authentication, signing: j.signing, init: false, start: j.start });
        } finally { this.onboardingFault = previousFault; }
        if (configured.status === "failed") result = { status: "register-failed", target: j.target, error: "Synthetic registration failed; checkout retained." };
        else if (configured.result.startError) result = { status: "start-failed", target: j.target, workspaceId: configured.result.entry.id, error: configured.result.startError };
        else result = { status: "succeeded", target: j.target, workspaceId: configured.result.entry.id, running: configured.result.started };
      }
    }
    j.result = result; j.finishedAt = this.clock; j.prompt = false; this.jobEvent(j, { type: "result", data: result }); j.listeners.clear(); return result;
  }
  subscribeClone(intent: { jobId: string; afterEventId: number }, listener: (event: B.CloneStreamEvent) => void) {
    const j = this.jobs.get(intent.jobId);
    if (!this.authenticated || !j || j.owner !== this.authContext) { notify(listener, { type: "unavailable", reason: this.authenticated ? "not-found-or-expired" : "unauthorized", message: "Synthetic clone stream unavailable." }); return () => {}; }
    requireValue(Number.isSafeInteger(intent.afterEventId) && intent.afterEventId >= 0 && intent.afterEventId <= (j.events.at(-1)?.id ?? 0), "Invalid clone replay cursor.");
    if (j.events[0] && intent.afterEventId < j.events[0].id - 1) { notify(listener, { type: "unavailable", reason: "not-found-or-expired", message: "Synthetic replay retention gap." }); return () => {}; }
    for (const event of j.events.filter(e => e.id > intent.afterEventId)) notify(listener, { type: "job-event", event }); if (!j.result) j.listeners.add(listener); return () => { j.listeners.delete(listener); };
  }
  advance(ms: number) { requireValue(Number.isSafeInteger(ms) && ms >= 0); this.clock += ms; for (const j of [...this.jobs.values()]) { if (!j.result && this.clock - j.createdAt >= 3_600_000) this.finishClone(j.id, "timed-out", "lifetime"); else if (!j.result && this.clock - j.lastActivity >= 600_000) this.finishClone(j.id, "timed-out"); if (j.result && j.finishedAt !== undefined && this.clock - j.finishedAt >= 300_000) { for (const listener of j.listeners) notify(listener, { type: "unavailable", reason: "not-found-or-expired", message: "Synthetic job retention expired." }); this.jobs.delete(j.id); } } }
}
