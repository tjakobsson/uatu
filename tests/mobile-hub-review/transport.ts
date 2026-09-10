import type { MobileHubBackend, Invalidation, CloneStreamEvent } from "../../src/hub/mobile/backend";
import type { PersonalWorkspaceState } from "../../src/shell/personal-state";

/** Test-owned wire allowlist. No arbitrary backend property lookup or fallback. */
export const reviewMethods = [
  "readAuthentication", "signIn", "signOut", "readWorkspaces", "readWorkspace", "readCredentials", "readCredentialFacts", "readTools", "readToolConfiguration", "readDevices", "revokeDevice", "readDefaultFolder", "setDefaultFolder",
  "startWorkspace", "stopWorkspace", "renameWorkspace", "forgetWorkspace", "assignWorkspace", "assignCredential", "removeAssignment",
  "generateSsh", "importSsh", "generateOpenPgp", "importOpenPgp", "createToken", "readPublicKey", "unlockCredential", "lockSsh", "enableCredential", "disableCredential", "deleteCredential", "testCredential", "setToolOverride", "testTool",
  "browseFolders", "configureExisting", "createWorkspace", "createFolder", "renameFolder", "removeEmptyFolder", "submitClone", "reconcileCloneAttempt", "sendCloneInput", "cancelClone",
] as const satisfies ReadonlyArray<keyof MobileHubBackend>;
export type ReviewMethod = typeof reviewMethods[number];
type MissingReviewMethod = Exclude<keyof MobileHubBackend, ReviewMethod | "subscribeInvalidation" | "subscribeClone">;
const exhaustiveReviewMethods: MissingReviewMethod extends never ? true : never = true;
void exhaustiveReviewMethods;
type Wire = null | boolean | number | string | Wire[] | { [key: string]: Wire };

/** Reject ambiguous explicit facts; never fall back to parsing readiness prose. */
export function validateReviewFacts(method: ReviewMethod, value: unknown): void {
  const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid explicit synthetic fact"); return v as Record<string, unknown>; };
  const fact = (v: unknown, applicable: boolean, valid: (value: unknown) => boolean) => {
    const f = record(v);
    if (Object.keys(f).some(k => !["status", "value"].includes(k))) throw new Error("Unknown fact field");
    if (!applicable) { if (f.status !== "not-applicable" || "value" in f) throw new Error("Inapplicable synthetic fact has a value"); }
    else if (f.status === "unknown") { if ("value" in f) throw new Error("Unknown synthetic fact has a value"); }
    else if (f.status !== "known" || !valid(f.value)) throw new Error("Invalid known synthetic fact");
  };
  if (method === "readCredentialFacts") {
    const c = record(value);
    if (typeof c.id !== "string" || !c.id || !["ssh", "openpgp", "token"].includes(String(c.type)) || Object.keys(c).some(k => !["id", "type", "protection", "lock", "userId"].includes(k))) throw new Error("Invalid credential facts");
    fact(c.protection, c.type !== "token", v => v === "protected" || v === "unprotected");
    fact(c.lock, c.type !== "token", v => v === "locked" || v === "unlocked");
    fact(c.userId, c.type === "openpgp", v => typeof v === "string" && v.length > 0);
  }
  if (method === "readToolConfiguration") {
    const t = record(value);
    if (!["ssh", "ssh-agent", "ssh-add", "ssh-keygen", "gpg", "gpgconf", "git", "gh", "glab"].includes(String(t.tool)) || Object.keys(t).some(k => !["tool", "savedOverride"].includes(k))) throw new Error("Invalid tool configuration");
    fact(t.savedOverride, true, v => v === null || typeof v === "string" && v.startsWith("/"));
  }
  if (method === "reconcileCloneAttempt") {
    const a = record(value);
    if (!["accepted", "not-accepted", "pending", "expired"].includes(String(a.status)) || Object.keys(a).some(k => !["status", "jobId"].includes(k))) throw new Error("Invalid clone attempt state");
    if (a.status === "accepted" ? typeof a.jobId !== "string" || !a.jobId : "jobId" in a) throw new Error("Ambiguous clone attempt state");
  }
}

/** The actual workspace persistence client needs a semantic store too. Keep it
 * test-owned and strictly bound to this corpus, never accept arbitrary paths. */
export function createReviewPersonalState(documentPaths: readonly string[] | ((path: string) => boolean), terminalId: string) {
  let value: PersonalWorkspaceState = { version: 1 };
  return {
    read: () => ({ ...value }),
    reset() { value = { version: 1 }; },
    patch(input: unknown): boolean {
      if (!input || typeof input !== "object" || Array.isArray(input)) return false;
      const allowed: Record<string, (v: unknown) => boolean> = {
        documentPath: v => typeof v === "string" && (typeof documentPaths === "function" ? documentPaths(v) : documentPaths.includes(v)),
        follow: v => typeof v === "boolean",
        previewMode: v => v === "rendered" || v === "source" || v === "diff",
        compareTarget: v => v === "base", // no last-commit fixture in this corpus
        filesFilter: v => v === "all" || v === "changed",
        lastPtyId: v => v === terminalId,
      };
      for (const [key, v] of Object.entries(input)) if (!Object.hasOwn(allowed, key) || (v !== null && !allowed[key]!(v))) return false;
      const next = { ...value } as Record<string, unknown>;
      for (const [key, v] of Object.entries(input)) { if (v === null) delete next[key]; else next[key] = v; }
      value = next as PersonalWorkspaceState;
      return true;
    },
  };
}
export async function serializeReviewValue(value: unknown): Promise<Wire> {
  if (value instanceof File) {
    if (value.size > 1024 * 1024) throw new Error("Synthetic File exceeds 1 MiB");
    // Management imports need source/size facts only. Never read/send private
    // key bytes or their filename; workspace attachment uploads use a separate
    // real client/protocol and are not this management transport.
    return { $reviewFile: true, size: value.size };
  }
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return Promise.all(value.map(serializeReviewValue));
  if (typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).filter(([, item]) => item !== undefined).map(async ([key, item]) => [key, await serializeReviewValue(item)])));
  throw new Error("Unsupported synthetic wire value");
}
export function deserializeReviewValue(value: Wire): unknown {
  if (Array.isArray(value)) return value.map(deserializeReviewValue);
  if (value && typeof value === "object") {
    if (value.$reviewFile === true) {
      if (Object.keys(value).some(key => !["$reviewFile", "size"].includes(key)) || typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0 || value.size > 1024 * 1024) throw new Error("Invalid synthetic File");
      return new File([new Uint8Array(value.size)], "synthetic-import.key", { lastModified: 0 });
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserializeReviewValue(item)]));
  }
  return value;
}
export function createReviewTransport(): MobileHubBackend {
  const invalidations = new Set<(event: Invalidation) => void>();
  let source: EventSource | undefined;
  let connected: Promise<void> | undefined;
  let generation = 0;
  let wireGeneration = -1;
  let authenticationEpoch = 0;
  const notify = (event: Invalidation, wire = true) => {
    // Server ordering and local delivery ordering are separate. Never turn a
    // replayed server event into a new invalidation merely by rebasing it.
    if (wire) { if (event.generation <= wireGeneration) return; wireGeneration = event.generation; }
    if (event.scope === "authentication") authenticationEpoch++;
    for (const listener of invalidations) listener({ ...event, generation: ++generation });
  };
  const call = async <K extends ReviewMethod>(method: K, ...args: Parameters<MobileHubBackend[K]>): Promise<Awaited<ReturnType<MobileHubBackend[K]>>> => {
    const epoch = authenticationEpoch;
    const readMethod = method.startsWith("read") || method === "browseFolders" || method === "reconcileCloneAttempt";
    const obsolete = () => (readMethod
      ? { status: "unavailable", problem: { kind: "unavailable", message: "This read belongs to a previous authentication context." } }
      : { status: "indeterminate", message: "This operation belongs to a previous authentication context; its outcome is not confirmed here." }) as Awaited<ReturnType<MobileHubBackend[K]>>;
    const unknownAcceptance = () => ({ status: "indeterminate", message: "Synthetic clone acceptance unknown. Reconcile the same attempt id before any new submission." }) as Awaited<ReturnType<MobileHubBackend[K]>>;
    try { await connected; } catch (error) { if (method === "submitClone") return unknownAcceptance(); throw error; }
    let response: Response;
    try {
      const body = JSON.stringify(await serializeReviewValue(args));
      if (epoch !== authenticationEpoch) return obsolete();
      response = await fetch(`/review/backend/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    }
    catch (error) { if (method === "submitClone") return unknownAcceptance(); throw error; }
    if (epoch !== authenticationEpoch) return obsolete();
    if (response.status === 401) {
      if (method !== "signIn") notify({ scope: "authentication", reason: "unauthorized", generation: 0 }, false);
      const problem = { kind: "unauthorized", message: "Synthetic session is no longer available." };
      return { status: method.startsWith("read") || method === "browseFolders" || method === "reconcileCloneAttempt" ? "unavailable" : "rejected", problem } as Awaited<ReturnType<MobileHubBackend[K]>>;
    }
    if (!response.ok) { if (method === "submitClone") return unknownAcceptance(); throw new Error(`Synthetic contract ${method} rejected (${response.status})`); }
    let result;
    try { result = await response.json(); }
    catch (error) { if (method === "submitClone") return unknownAcceptance(); throw error; }
    if (epoch !== authenticationEpoch) return obsolete();
    if (!result || !["available", "unavailable", "completed", "rejected", "indeterminate"].includes(result.status)) { if (method === "submitClone") return unknownAcceptance(); throw new Error(`Invalid synthetic result for ${method}`); }
    if (!(readMethod ? ["available", "unavailable"] : ["completed", "rejected", "indeterminate"]).includes(result.status)) { if (method === "submitClone") return unknownAcceptance(); throw new Error("Mismatched synthetic result kind"); }
    if (method === "submitClone" && result.status === "completed") {
      const v = result.value;
      if (!v || !(v.status === "accepted" && typeof v.jobId === "string" && v.jobId.length > 0 || v.status === "requires-unlock" && ["ssh", "openpgp"].includes(v.credential?.type) && typeof v.credential?.id === "string" && v.credential.id.length > 0)) return unknownAcceptance();
    }
    if (result.status === "available") {
      validateReviewFacts(method, result.value);
      if (method === "readCredentialFacts") {
        const target = args[0] as { id: string; type: string };
        if (result.value.id !== target.id || result.value.type !== target.type) throw new Error("Mismatched credential facts target");
      }
      if (method === "readToolConfiguration" && result.value.tool !== args[0]) throw new Error("Mismatched tool configuration target");
    }
    if (method === "signIn" && result.status === "completed") authenticationEpoch++;
    if (method !== "signIn" && result.problem?.kind === "unauthorized") notify({ scope: "authentication", reason: "unauthorized", generation: 0 }, false);
    else if (method === "signOut" && result.status === "completed" || method === "readAuthentication" && result.status === "available" && result.value?.status === "signed-out") authenticationEpoch++;
    return result;
  };
  const stream = (path: string, listener: (event: CloneStreamEvent) => void) => {
    const source = new EventSource(path);
    source.onmessage = event => listener(JSON.parse(event.data));
    source.onerror = () => { source.close(); listener({ type: "disconnected", message: "Synthetic clone transport disconnected. Reconnect to the same job." }); };
    return () => source.close();
  };
  return {
    readAuthentication: () => call("readAuthentication"), signIn: v => call("signIn", v), signOut: () => call("signOut"),
    readWorkspaces: () => call("readWorkspaces"), readWorkspace: v => call("readWorkspace", v), readCredentials: () => call("readCredentials"), readTools: () => call("readTools"), readDevices: () => call("readDevices"), revokeDevice: v => call("revokeDevice", v), readDefaultFolder: () => call("readDefaultFolder"), setDefaultFolder: v => call("setDefaultFolder", v),
    readCredentialFacts: v => call("readCredentialFacts", v), readToolConfiguration: v => call("readToolConfiguration", v), reconcileCloneAttempt: v => call("reconcileCloneAttempt", v),
    startWorkspace: v => call("startWorkspace", v), stopWorkspace: v => call("stopWorkspace", v), renameWorkspace: v => call("renameWorkspace", v), forgetWorkspace: v => call("forgetWorkspace", v), assignWorkspace: v => call("assignWorkspace", v), assignCredential: v => call("assignCredential", v), removeAssignment: v => call("removeAssignment", v),
    generateSsh: v => call("generateSsh", v), importSsh: v => call("importSsh", v), generateOpenPgp: v => call("generateOpenPgp", v), importOpenPgp: v => call("importOpenPgp", v), createToken: v => call("createToken", v), readPublicKey: v => call("readPublicKey", v), unlockCredential: v => call("unlockCredential", v), lockSsh: v => call("lockSsh", v), enableCredential: v => call("enableCredential", v), disableCredential: v => call("disableCredential", v), deleteCredential: v => call("deleteCredential", v), testCredential: v => call("testCredential", v), setToolOverride: v => call("setToolOverride", v), testTool: v => call("testTool", v),
    browseFolders: v => v === undefined ? call("browseFolders") : call("browseFolders", v), configureExisting: v => call("configureExisting", v), createWorkspace: v => call("createWorkspace", v), createFolder: v => call("createFolder", v), renameFolder: v => call("renameFolder", v), removeEmptyFolder: v => call("removeEmptyFolder", v), submitClone: v => call("submitClone", v), sendCloneInput: v => call("sendCloneInput", v), cancelClone: v => call("cancelClone", v),
    subscribeInvalidation: listener => {
      invalidations.add(listener);
      if (!source) {
        source = new EventSource("/review/invalidations");
        connected = new Promise<void>((resolve, reject) => {
          source!.onopen = () => resolve();
          source!.onerror = () => reject(new Error("Synthetic invalidation stream unavailable"));
        });
        source.onmessage = event => notify(JSON.parse(event.data));
      }
      return () => { invalidations.delete(listener); if (!invalidations.size) { source?.close(); source = undefined; connected = undefined; } };
    },
    subscribeClone: (v, listener) => stream(`/review/clone-events?jobId=${encodeURIComponent(v.jobId)}&afterEventId=${v.afterEventId}`, listener),
  };
}
