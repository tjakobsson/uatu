import type * as B from "../../src/hub/mobile/backend";
import type { CredentialAssignment, CredentialTool, PublicCredentialDto } from "../../src/hub/credential-types";
import { ManagementModel, ModelProblem, requireValue, label, host, syntheticPath, secretValid, importValid, tools, identity, type Scenario, type KeyState, type ToolState, type OnboardingFault, type CloneOutcome } from "./management-model";
export { FIXTURE_TIME, identity } from "./management-model";
export type { Scenario, KeyState, ToolState, OnboardingFault, CloneOutcome } from "./management-model";
export type Mutation = { sequence: number; at: number; method: keyof B.MobileHubBackend; outcome: "completed" | "rejected" | "missing-contract" | "indeterminate" };
type Method = keyof B.MobileHubBackend;
type InjectedOutcome = B.BackendProblem | "indeterminate-before" | "indeterminate-after";
const unavailable: B.BackendProblem = { kind: "unavailable", message: "Synthetic operation failed (review controller)." };

/** No private material or submitted File is retained, including while pending.
 * prepare() runs before a delay; only validated public intent and boolean
 * secret-validation facts enter an effect closure. This is presentation
 * simulation, NOT cryptographic validation or provider/tool execution. */
export function createSyntheticBackend() {
  let generation = 0;
  let epoch = 0;
  const workspaceEpochs = new Map<string, number>();
  let sequence = 0;
  const listeners = new Set<(event: B.Invalidation) => void>();
  const log: Mutation[] = [];
  const held = new Set<Method>();
  const holds = new Map<Method, Array<() => void>>();
  const failures = new Map<Method, InjectedOutcome>();
  const pendingCloneAttempts = new Map<string, Promise<B.OperationResult<B.CloneSubmission>>>();
  const emit = (event: B.Invalidation) => { for (const listener of [...listeners]) { try { listener(structuredClone(event)); } catch { /* a view listener cannot veto an accepted effect */ } } };
  const deliverClone = (listener: (event: B.CloneStreamEvent) => void, event: B.CloneStreamEvent) => { try { listener(structuredClone(event)); } catch { /* transport disposal cannot veto invalidation */ } };
  const model = new ManagementModel(event => {
    if (event.scope === "workspace") workspaceEpochs.set(event.workspaceId, (workspaceEpochs.get(event.workspaceId) ?? 0) + 1);
    emit({ ...event, generation: ++generation });
  });
  const record = (method: Method, outcome: Mutation["outcome"]) => { log.push({ sequence: ++sequence, at: model.clock, method, outcome }); if (log.length > 500) log.shift(); };
  const problem = (error: unknown): B.BackendProblem => error instanceof ModelProblem
    ? error.kind === "rate-limited" ? { kind: error.kind, message: error.message, retryAfterSeconds: 30 } : { kind: error.kind, message: error.message }
    : { kind: "invalid-input", message: "Invalid synthetic operation input; no raw diagnostic is retained." };
  const rejected = (method: Method, error: unknown) => { record(method, "rejected"); return { status: "rejected" as const, problem: problem(error) }; };
  const wait = async (method: Method) => { if (held.has(method)) await new Promise<void>(resolve => holds.set(method, [...(holds.get(method) ?? []), resolve])); };
  const mutate = async <T>(method: Method, effect: () => T, publicCall = false, scope: string[] = []): Promise<B.OperationResult<T>> => {
    const started = epoch; const versions = scope.map(id => workspaceEpochs.get(id) ?? 0); await wait(method);
    if (started !== epoch || (!model.authenticated && !publicCall)) return rejected(method, new ModelProblem("unauthorized", "Synthetic access changed; reconcile before retrying."));
    if (scope.some((id, index) => (workspaceEpochs.get(id) ?? 0) !== versions[index])) return rejected(method, new ModelProblem("conflict", "Synthetic workspace changed; reconcile before retrying."));
    const failure = failures.get(method);
    if (failure === "indeterminate-before") { record(method, "indeterminate"); return { status: "indeterminate", message: "Synthetic acceptance unknown; reconcile before retrying." }; }
    if (failure && typeof failure !== "string") { if (failure.kind === "unauthorized" && !publicCall) authenticateOut("unauthorized"); record(method, "rejected"); return { status: "rejected", problem: structuredClone(failure) }; }
    try {
      const value = structuredClone(effect());
      if (failure === "indeterminate-after") { record(method, "indeterminate"); return { status: "indeterminate", message: "Synthetic response lost after effect; reconcile before retrying." }; }
      record(method, "completed"); return { status: "completed", value };
    } catch (error) { return rejected(method, error); }
  };
  const attempt = <I, T>(method: Method, prepare: () => I, effect: (intent: I) => T, publicCall = false, scope: (intent: I) => string[] = () => []): Promise<B.OperationResult<T>> => {
    let intent: I; try { intent = prepare(); } catch (error) { return Promise.resolve(rejected(method, error)); }
    return mutate(method, () => effect(intent), publicCall, scope(intent));
  };
  const read = async <T>(method: Method, effect: () => T, publicCall = false, scope: string[] = []): Promise<B.ReadResult<T>> => {
    const started = epoch; const versions = scope.map(id => workspaceEpochs.get(id) ?? 0); await wait(method);
    if (started !== epoch || (!model.authenticated && !publicCall)) return { status: "unavailable", problem: { kind: "unauthorized", message: "Synthetic access changed; reload the view." } };
    if (scope.some((id, index) => (workspaceEpochs.get(id) ?? 0) !== versions[index])) return { status: "unavailable", problem: { kind: "conflict", message: "Synthetic workspace changed; reload the view." } };
    if (failures.has(method)) {
      const injected = failures.get(method); if (typeof injected === "object" && injected.kind === "unauthorized") authenticateOut("unauthorized");
      return { status: "unavailable", problem: typeof injected === "object" ? structuredClone(injected) : unavailable };
    }
    try { return { status: "available", value: structuredClone(effect()) }; } catch (error) { return { status: "unavailable", problem: problem(error) }; }
  };
  const authenticateOut = (reason: "signed-out" | "current-session-revoked" | "unauthorized") => {
    model.authenticated = false; model.authContext++; epoch++;
    for (const attempt of model.cloneAttempts.values()) if (attempt.state.status === "pending") attempt.state = { status: "expired" };
    for (const job of model.jobs.values()) { for (const listener of [...job.listeners]) deliverClone(listener, { type: "unavailable", reason: "unauthorized", message: "Synthetic session invalidated." }); job.listeners.clear(); }
    emit({ scope: "authentication", reason, generation: ++generation });
  };
  const keyDto = <T extends "ssh" | "openpgp" | "token">(id: string, type: T) => { const dto = model.dto(id); requireValue(dto.type === type); return dto as B.CredentialView<T>; };
  const target = <T extends B.CredentialTarget>(value: T): T => { requireValue(value && typeof value.id === "string" && ["ssh", "openpgp", "token"].includes(value.type)); return { id: value.id, type: value.type } as T; };
  const caps = (value: Array<"ssh-authentication" | "ssh-signing">) => { requireValue(Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(c => c === "ssh-authentication" || c === "ssh-signing")); return [...value]; };
  const keyCreation = (type: "ssh" | "openpgp", name: string, capabilities: Parameters<ManagementModel["addKey"]>[2], protectedKey: boolean, imported = false) => {
    requireValue(!imported || !model.importFails, "Synthetic private-key import rejected; no key material was read or retained.");
    for (const tool of type === "ssh" ? ["ssh-keygen", "ssh-add", "ssh-agent"] as const : ["gpg", "gpgconf"] as const) requireValue(model.tool(tool).results.every(r => r.status !== "unavailable"), "Required synthetic key tooling unavailable.", "unavailable");
    const c = model.addKey(type, name, capabilities, protectedKey);
    if (imported && type === "ssh" && protectedKey) model.keys.get(c.id)!.state = "unlocked";
    model.catalog("credentials"); return c.id;
  };
  const assignment = (a: CredentialAssignment): CredentialAssignment => a.role === "authentication"
    ? { workspaceId: label(a.workspaceId), credentialId: label(a.credentialId), role: a.role, host: host(a.host) }
    : (requireValue(a.role === "signing" && !("host" in a)), { workspaceId: label(a.workspaceId), credentialId: label(a.credentialId), role: "signing" });
  const onboarding = (i: Parameters<B.MobileHubBackend["configureExisting"]>[0]) => ({ path: syntheticPath(i.path), displayName: label(i.displayName, 64), authentication: i.authentication.map(a => ({ credentialId: label(a.credentialId), host: host(a.host) })), signing: i.signing === null ? null : label(i.signing), init: i.init, start: i.start });
  const backend: B.MobileHubBackend = {
    readAuthentication: () => read("readAuthentication", () => model.authenticated ? { status: "authenticated" as const, identity } : { status: "signed-out" as const }, true),
    signIn: intent => attempt("signIn", () => ({ valid: intent.user === "reviewer" && intent.password === "review-only", deviceLabel: intent.deviceLabel === undefined ? "Synthetic browser" : label(intent.deviceLabel) }), i => { requireValue(i.valid, "Invalid synthetic login.", "unauthorized"); model.authenticated = true; if (!model.devices.some(d => d.current)) { model.devices.push({ handle: "review-device", current: true, deviceLabel: i.deviceLabel, issuedAt: model.clock }); model.catalog("devices"); } return identity; }, true),
    signOut: () => mutate("signOut", () => { model.devices = model.devices.filter(d => !d.current); authenticateOut("signed-out"); return { status: "signed-out" as const }; }),
    readWorkspaces: () => read("readWorkspaces", () => model.workspaceViews()),
    readWorkspace: id => read("readWorkspace", () => { model.workspace(id); return model.workspaceViews().find(w => w.id === id)!; }, false, [id]),
    readCredentials: () => read("readCredentials", () => model.credentials.map(c => model.dto(c.id))),
    readCredentialFacts: value => read("readCredentialFacts", () => model.credentialFacts(value)),
    readTools: () => read("readTools", () => tools.map(t => model.tool(t))),
    readToolConfiguration: tool => read("readToolConfiguration", () => model.toolConfiguration(tool)),
    readDevices: () => read("readDevices", () => model.devices),
    revokeDevice: handle => mutate("revokeDevice", () => { const device = model.devices.find(d => d.handle === handle); requireValue(device, "Synthetic device not found.", "not-found"); model.devices = model.devices.filter(d => d !== device); if (device.current) authenticateOut("current-session-revoked"); else model.catalog("devices"); return { status: "revoked" as const, current: device.current }; }),
    readDefaultFolder: () => read("readDefaultFolder", () => model.defaultFolder()),
    setDefaultFolder: path => attempt("setDefaultFolder", () => path === null ? null : syntheticPath(path), path => { if (path !== null) model.folder(path); model.configured = path; model.catalog("default-folder"); return model.defaultFolder(); }),
    startWorkspace: intent => attempt("startWorkspace", () => { requireValue(["not-confirmed", "confirmed-without-credentials"].includes(intent.unassigned)); return { workspaceId: label(intent.workspaceId), confirmed: intent.unassigned === "confirmed-without-credentials" }; }, i => model.start(i.workspaceId, i.confirmed), false, i => [i.workspaceId]),
    stopWorkspace: id => mutate("stopWorkspace", () => model.stop(id), false, [id]),
    renameWorkspace: intent => attempt("renameWorkspace", () => ({ workspaceId: label(intent.workspaceId), displayName: label(intent.displayName, 64) }), i => { const w = model.workspace(i.workspaceId); w.displayName = i.displayName; model.catalog("workspaces"); return { id: w.id, path: w.path, displayName: w.displayName, backend: w.backend }; }, false, i => [i.workspaceId]),
    forgetWorkspace: id => mutate("forgetWorkspace", () => model.forget(id), false, [id]),
    assignWorkspace: intent => attempt("assignWorkspace", () => { requireValue(["edit-current", "assign-new"].includes(intent.mode)); const s = intent.selection; requireValue(s && (s.authentication || s.signing)); return [...(s.authentication ? [assignment({ workspaceId: intent.workspaceId, credentialId: s.authentication.credentialId, role: "authentication", host: s.authentication.host })] : []), ...(s.signing ? [assignment({ workspaceId: intent.workspaceId, credentialId: s.signing.credentialId, role: "signing" })] : [])]; }, values => model.assign(values, true), false, values => values.map(a => a.workspaceId)),
    assignCredential: intent => attempt("assignCredential", () => { requireValue(typeof intent.replace === "boolean"); return { assignment: assignment(intent.assignment), replace: intent.replace }; }, i => model.assign([i.assignment], i.replace)[0]!, false, i => [i.assignment.workspaceId]),
    removeAssignment: intent => attempt("removeAssignment", () => ({ assignment: assignment(intent.assignment), stop: intent.stop }), i => { const a = i.assignment; model.workspace(a.workspaceId); const exists = model.assignments.some(b => model.slot(a, b) && a.credentialId === b.credentialId); return model.coordinated(exists ? [a.workspaceId] : [], i.stop, () => { model.assignments = model.assignments.filter(b => !(model.slot(a, b) && a.credentialId === b.credentialId)); if (exists) { model.catalog("credentials"); model.catalog("workspaces"); } return { removed: exists }; }); }),
    generateSsh: intent => attempt("generateSsh", () => { requireValue(secretValid(intent.passphrase)); return { name: label(intent.name), caps: caps(intent.capabilities) }; }, i => keyDto(keyCreation("ssh", i.name, i.caps, true), "ssh")),
    importSsh: intent => attempt("importSsh", () => { requireValue(importValid(intent.source), "Choose exactly one nonempty import source, at most 1 MiB; no File was read."); requireValue(secretValid(intent.passphrase, true)); return { name: label(intent.name), caps: caps(intent.capabilities), protectedKey: intent.passphrase.length > 0 }; }, i => keyDto(keyCreation("ssh", i.name, i.caps, i.protectedKey, true), "ssh")),
    generateOpenPgp: intent => attempt("generateOpenPgp", () => { requireValue(secretValid(intent.passphrase)); return { name: label(intent.name), userId: label(intent.userId) }; }, i => {
      const id = keyCreation("openpgp", i.name, ["openpgp-signing"], true);
      const c = model.key({ id, type: "openpgp" });
      model.userIds.set(id, { status: "known", value: i.userId });
      c.metadata.publicKey = c.metadata.publicKey.replace("SYNTHETIC-PUBLIC-ONLY", `Comment: Synthetic user ID ${i.userId}\nSYNTHETIC-PUBLIC-ONLY`);
      return keyDto(id, "openpgp");
    }),
    importOpenPgp: intent => attempt("importOpenPgp", () => { requireValue(importValid(intent.source), "Choose exactly one nonempty import source, at most 1 MiB; no File was read."); return { name: label(intent.name) }; }, i => keyDto(keyCreation("openpgp", i.name, ["openpgp-signing"], true, true), "openpgp")),
    createToken: intent => attempt("createToken", () => { requireValue(typeof intent.token === "string" && intent.token.trim().length > 0 && !/[\0\r\n]/.test(intent.token) && new TextEncoder().encode(intent.token).length <= 65_536); return { name: label(intent.name), host: host(intent.host), username: intent.username === undefined ? undefined : label(intent.username), capabilities: [...intent.capabilities] }; }, i => { const c = model.addToken(i.name, i.host, i.username, i.capabilities); model.catalog("credentials"); return keyDto(c.id, "token"); }),
    readPublicKey: value => read("readPublicKey", () => { const c = model.key(value); return { id: c.id, type: c.type, ...c.metadata }; }),
    unlockCredential: intent => attempt("unlockCredential", () => { const t = target(intent.target); requireValue(secretValid(intent.passphrase, t.type === "ssh")); return { target: t, nonempty: intent.passphrase.length > 0 }; }, i => { const c = model.key(i.target); requireValue(c.enabled, "Disabled credential cannot unlock.", "conflict"); model.requireTools(c); const key = model.keys.get(c.id)!; requireValue(!model.unlockFails && key.state !== "unavailable" && (!key.protected || i.nonempty), "Synthetic unlock rejected; no passphrase retained."); key.state = key.protected ? "unlocked" : "unprotected"; model.catalog("credentials"); return model.dto(c.id) as B.CredentialView<"ssh" | "openpgp">; }),
    lockSsh: value => attempt("lockSsh", () => target(value), t => { requireValue(t.type === "ssh", "Only SSH supports individual lock."); const c = model.credential(t); model.keys.get(c.id)!.state = "locked"; model.catalog("credentials"); return keyDto(c.id, "ssh"); }),
    enableCredential: value => attempt("enableCredential", () => target(value), t => { const c = model.credential(t); c.enabled = true; model.refreshRestart(); model.catalog("credentials"); model.catalog("workspaces"); return model.dto(c.id); }),
    disableCredential: intent => attempt("disableCredential", () => ({ target: target(intent.target), stop: intent.stop }), i => { const c = model.credential(i.target); return model.coordinated(model.providerDependents(c), i.stop, () => { c.enabled = false; const key = model.keys.get(c.id); if (key) key.state = "locked"; model.refreshRestart(); model.catalog("credentials"); model.catalog("workspaces"); return model.dto(c.id); }); }),
    deleteCredential: intent => attempt("deleteCredential", () => { requireValue(intent.confirm === true && typeof intent.unassign === "boolean"); return { target: target(intent.target), unassign: intent.unassign, stop: intent.stop }; }, i => { const c = model.credential(i.target); const assigned = model.assignments.filter(a => a.credentialId === c.id); requireValue(i.unassign || !assigned.length, "Credential is assigned; explicit unassign is required.", "conflict"); return model.coordinated(model.providerDependents(c), i.stop, () => { model.credentials = model.credentials.filter(v => v.id !== c.id); model.keys.delete(c.id); model.assignments = model.assignments.filter(a => a.credentialId !== c.id); for (const a of assigned) if (model.workspace(a.workspaceId).runtime.status === "running") model.workspace(a.workspaceId).credentialRestartRequired = true; model.catalog("credentials"); model.catalog("workspaces"); return { deleted: true }; }); }),
    testCredential: value => attempt("testCredential", () => target(value), t => model.readiness(model.credential(t))),
    setToolOverride: intent => attempt("setToolOverride", () => { requireValue(tools.includes(intent.tool)); return { tool: intent.tool, path: intent.path === null ? null : syntheticPath(intent.path) }; }, i => { if (i.path === null) model.overrides.delete(i.tool); else model.overrides.set(i.tool, i.path); model.refreshRestart(); model.catalog("tools"); model.catalog("credentials"); model.catalog("workspaces"); return model.tool(i.tool); }),
    testTool: tool => mutate("testTool", () => model.tool(tool)),
    browseFolders: path => read("browseFolders", () => model.browse(path)),
    configureExisting: intent => attempt("configureExisting", () => { requireValue(typeof intent.init === "boolean" && typeof intent.start === "boolean"); return onboarding(intent); }, i => { requireValue(!model.reserved(i.path), "Synthetic path reserved by a clone.", "conflict"); return model.configure(i); }),
    createWorkspace: intent => attempt("createWorkspace", () => { requireValue(typeof intent.start === "boolean"); return { parent: syntheticPath(intent.parent), folderName: label(intent.folderName), displayName: label(intent.displayName, 64), authentication: intent.authentication.map(a => ({ credentialId: label(a.credentialId), host: host(a.host) })), signing: intent.signing === null ? null : label(intent.signing), start: intent.start, gitInitConsent: intent.gitInitConsent }; }, i => model.createWorkspace(i)),
    createFolder: intent => attempt("createFolder", () => ({ parent: syntheticPath(intent.parent), name: label(intent.name) }), i => model.createFolder(i.parent, i.name)),
    renameFolder: intent => attempt("renameFolder", () => ({ path: syntheticPath(intent.path), name: label(intent.name), stop: intent.stop }), i => model.renameFolder(i.path, i.name, i.stop)),
    removeEmptyFolder: intent => attempt("removeEmptyFolder", () => ({ path: syntheticPath(intent.path), stop: intent.stop }), i => model.removeFolder(i.path, i.stop)),
    submitClone: intent => {
      let attemptId: string;
      try { requireValue(model.authenticated, "Synthetic session signed out.", "unauthorized"); attemptId = model.attemptId(intent.attemptId); }
      catch (error) { return Promise.resolve(rejected("submitClone", error)); }
      const previous = model.cloneAttempts.get(attemptId);
      if (previous) {
        if (previous.owner !== model.authContext) return Promise.resolve(rejected("submitClone", new ModelProblem("unavailable", "Clone attempt unavailable in this authenticated context.")));
        const state = model.reconcileAttempt(attemptId);
        if (state.status === "accepted") return Promise.resolve({ status: "completed", value: { status: "accepted", jobId: state.jobId } });
        if (state.status === "pending") return pendingCloneAttempts.get(attemptId) ?? Promise.resolve({ status: "indeterminate", message: "Attempt remains pending; reconcile this same id." });
        return Promise.resolve(rejected("submitClone", new ModelProblem("conflict", "Attempt is fenced or expired. Reconcile; never blindly resubmit this id.")));
      }
      const admission = { owner: model.authContext, state: { status: "pending" } as B.CloneAttemptState };
      model.cloneAttempts.set(attemptId, admission);
      const pending = attempt("submitClone", () => {
      // Validate URL immediately and replace it with a host/transport-only URL
      // before any pending gate. Userinfo, query strings and remote paths never
      // enter retained job state or a held closure.
      let url: URL;
      try { url = /^[^@\s/:]+@[^:\s]+:.+$/.test(intent.url) ? new URL(`ssh://${intent.url.split("@")[1]!.split(":")[0]}/synthetic.git`) : new URL(intent.url); } catch { throw new ModelProblem("invalid-input", "Invalid synthetic clone URL."); }
      requireValue(["ssh:", "git+ssh:", "https:"].includes(url.protocol) && !url.password && !url.search && !url.hash && (url.protocol !== "https:" || !url.username));
      requireValue(typeof intent.start === "boolean");
      return { url: `${url.protocol}//${host(url.host)}/synthetic.git`, dest: syntheticPath(intent.dest), folderName: label(intent.folderName), displayName: label(intent.displayName, 64), credentialId: intent.credentialId === null ? null : label(intent.credentialId), retainedAuthentication: intent.retainedAuthentication.map(a => ({ credentialId: label(a.credentialId), host: host(a.host) })), signing: intent.signing === null ? null : label(intent.signing), start: intent.start };
      }, i => {
        requireValue(admission.owner === model.authContext && admission.state.status === "pending", "Clone attempt expired before acceptance.", "conflict");
        const result = model.submitClone(i);
        admission.state = result.status === "accepted" ? { status: "accepted", jobId: result.jobId } : { status: "not-accepted" };
        return result;
      }).then(result => {
        // Before-effect failure/loss is authoritatively no admission. A late
        // duplicate remains fenced. After-effect loss keeps accepted/jobId.
        if (admission.owner === model.authContext && admission.state.status === "pending") admission.state = { status: "not-accepted" };
        return result;
      }).finally(() => { if (pendingCloneAttempts.get(attemptId) === pending) pendingCloneAttempts.delete(attemptId); });
      pendingCloneAttempts.set(attemptId, pending); return pending;
    },
    reconcileCloneAttempt: intent => {
      const attemptId = intent.attemptId;
      return read("reconcileCloneAttempt", () => model.reconcileAttempt(attemptId));
    },
    subscribeClone: (intent, listener) => model.subscribeClone(intent, listener),
    sendCloneInput: intent => attempt("sendCloneInput", () => { requireValue(typeof intent.input === "string" && new TextEncoder().encode(intent.input).length <= 8192, "Synthetic clone input exceeds its size limit."); return { jobId: label(intent.jobId) }; }, i => { const j = model.ownedJob(i.jobId); requireValue(!j.result && j.phase === "cloning", "Synthetic clone input is inactive outside the cloning phase.", "conflict"); j.prompt = false; model.jobEvent(j, { type: "output", data: { output: "[masked input accepted]" } }); return { status: "accepted" as const }; }),
    cancelClone: id => mutate("cancelClone", () => { const j = model.ownedJob(id); if (j.result) return { status: "terminal" as const }; if (model.cloneCleanupFails) { model.finishClone(id, "cleanup-failed"); return { status: "cleanup-failed" as const, message: "Synthetic cleanup failed; checkout retained." }; } model.finishClone(id, "cancelled"); return { status: "cancelled" as const }; }),
    subscribeInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const checkMethod = (method: Method) => requireValue(Object.hasOwn(backend, method) && !method.startsWith("subscribe"), "Unknown or non-promise synthetic control method.");
  return {
    backend,
    workspaceAvailable: () => model.authenticated && model.workspaces.some(w => w.id === "atlas" && w.runtime.status === "running"),
    snapshot: () => ({ clock: model.clock, authenticated: model.authenticated, log: structuredClone(log), pending: [...holds].map(([method, waiters]) => ({ method, count: waiters.length })) }),
    inspect: () => structuredClone({ workspaces: model.workspaceViews(), credentials: model.credentials.map(c => model.dto(c.id)), credentialFacts: model.credentials.map(c => model.credentialFacts(c)), tools: tools.map(t => model.tool(t)), toolConfiguration: tools.map(t => model.toolConfiguration(t)), devices: model.devices, defaultFolder: model.defaultFolder(), folders: [...model.folders].map(([path, f]) => ({ path, ...f })), attempts: [...model.cloneAttempts].filter(([, a]) => a.owner === model.authContext).map(([attemptId, a]) => ({ attemptId, ...a.state })), jobs: [...model.jobs.values()].map(j => ({ id: j.id, target: j.target, phase: j.phase, prompt: j.prompt, result: j.result, events: j.events })) }),
    hold(method: Method) { checkMethod(method); held.add(method); },
    settle(method: Method, fail = false) { checkMethod(method); if (fail) failures.set(method, unavailable); else failures.delete(method); held.delete(method); const waiters = holds.get(method) ?? []; holds.delete(method); waiters.forEach(resolve => resolve()); },
    fail(method: Method, outcome: InjectedOutcome | null = unavailable) { checkMethod(method); if (outcome === null) failures.delete(method); else if (typeof outcome === "string") { requireValue(["indeterminate-before", "indeterminate-after"].includes(outcome)); failures.set(method, outcome); } else { requireValue(["invalid-input", "conflict", "not-found", "unavailable", "forbidden", "unauthorized", "rate-limited"].includes(outcome.kind)); failures.set(method, outcome.kind === "rate-limited" ? { kind: outcome.kind, message: "Synthetic rate limit; retry later.", retryAfterSeconds: Math.max(1, Math.min(3600, outcome.retryAfterSeconds)) } : { kind: outcome.kind, message: "Synthetic configured operation failure." }); } },
    setKeyState(id: string, state: KeyState) { const c = model.credential(id); requireValue(c.type !== "token" && ["locked", "unlocked", "unprotected", "unavailable"].includes(state)); model.keys.set(id, { state, protected: state === "unprotected" ? false : model.keys.get(id)!.protected }); model.catalog("credentials"); },
    setCredentialFactsUnknown(id: string, unknown: boolean) { model.credential(id); requireValue(typeof unknown === "boolean"); if (unknown) model.unknownCredentialFacts.add(id); else model.unknownCredentialFacts.delete(id); model.catalog("credentials"); },
    setOpenPgpUserId(id: string, userId: string | null) { const c = model.credential(id); requireValue(c.type === "openpgp", "Only OpenPGP has a public user-ID fact."); model.userIds.set(id, userId === null ? { status: "unknown" } : { status: "known", value: label(userId) }); model.catalog("credentials"); },
    setToolConfigurationUnknown(tool: CredentialTool, unknown: boolean) { requireValue(tools.includes(tool) && typeof unknown === "boolean"); if (unknown) model.unknownToolConfiguration.add(tool); else model.unknownToolConfiguration.delete(tool); model.catalog("tools"); },
    expireCloneAttempt(id: string) { model.attemptId(id); const a = model.cloneAttempts.get(id); requireValue(a && a.owner === model.authContext, "Attempt unavailable.", "unavailable"); a.state = { status: "expired" }; },
    setCredentialAvailable(id: string, available: boolean) { model.credential(id); requireValue(typeof available === "boolean"); if (available) model.unavailableCredentials.delete(id); else model.unavailableCredentials.add(id); model.catalog("credentials"); },
    setDeviceInventory(state: "empty" | "current-only" | "multiple") { requireValue(["empty", "current-only", "multiple"].includes(state)); model.devices = state === "empty" ? [] : [{ handle: "review-device", current: true, deviceLabel: "Synthetic browser", issuedAt: model.clock }, ...(state === "multiple" ? [{ handle: "review-other-device", current: false, deviceLabel: "Synthetic tablet", issuedAt: model.clock - 86_400_000 }] : [])]; model.catalog("devices"); },
    setToolState(tool: CredentialTool, state: ToolState) { requireValue(tools.includes(tool) && ["ready", "missing", "incompatible", "runtime-unavailable"].includes(state)); model.toolStates.set(tool, state); model.catalog("tools"); model.catalog("credentials"); },
    setStopFailure(id: string, fail = true) { model.workspace(id); if (fail) model.stopFailures.add(id); else model.stopFailures.delete(id); },
    setUnlockFailure(fail = true) { model.unlockFails = fail; },
    setImportFailure(fail = true) { model.importFails = fail; },
    setOnboardingFault(fault: OnboardingFault | null) { requireValue(fault === null || ["needs-init", "credential", "git-init", "register-failed", "retained-checkout", "committed-recovery", "start-failed"].includes(fault)); model.onboardingFault = fault; },
    setFolderFault(fault: "before-mutation" | "after-stop" | null) { requireValue(fault === null || ["before-mutation", "after-stop"].includes(fault)); model.folderFault = fault; },
    setFolderAvailable(path: string, available: boolean) { const f = model.folders.get(syntheticPath(path)); requireValue(f, "Synthetic folder missing.", "not-found"); f.available = available; model.catalog("default-folder"); },
    setCloneCleanupFailure(fail = true) { model.cloneCleanupFails = fail; },
    clonePhase(id: string, phase: "cloning" | "registering" | "starting") { model.clonePhase(id, phase); },
    cloneOutput(id: string, kind: "progress" | "prompt") { model.cloneOutput(id, kind); },
    finishClone(id: string, outcome: CloneOutcome = "succeeded") { return structuredClone(model.finishClone(id, outcome)); },
    disconnectClone(id: string) { const j = model.job(id); for (const listener of [...j.listeners]) deliverClone(listener, { type: "disconnected", message: "Synthetic stream interrupted; reconnect to the same accepted job." }); j.listeners.clear(); },
    expireClone(id: string) { const j = model.job(id); requireValue(j.result, "Running clone cannot expire; finish or cancel it.", "conflict"); for (const listener of j.listeners) deliverClone(listener, { type: "unavailable", reason: "not-found-or-expired", message: "Synthetic job expired." }); model.jobs.delete(id); },
    invalidateAuthentication() { authenticateOut("unauthorized"); },
    advance(ms: number) { model.advance(ms); },
    reset(scenario: Scenario = "mixed") {
      requireValue(["mixed", "empty", "signed-out", "branches", "credentials", "nested", "unavailable-tools", "all-running", "all-stopped"].includes(scenario));
      epoch++; generation++; workspaceEpochs.clear(); pendingCloneAttempts.clear(); model.reset(scenario);
      log.length = 0; sequence = 0; failures.clear(); held.clear();
      for (const waiters of holds.values()) waiters.forEach(resolve => resolve());
      holds.clear();
      for (const resource of ["workspaces", "credentials", "tools", "devices", "default-folder"] as const) emit({ scope: "catalog", resource, generation: ++generation });
      if (!model.authenticated) emit({ scope: "authentication", reason: "unauthorized", generation: ++generation });
    },
  };
}
