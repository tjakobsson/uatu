import { expect, test } from "bun:test";
import type * as B from "../../src/hub/mobile/backend";
import { parsePublicCredentialDto, parsePublicToolReadinessDto } from "../../src/hub/credential-types";
import { createSyntheticBackend, FIXTURE_TIME, type CloneOutcome, type OnboardingFault } from "./backend";
import { previewExamples, previewImagePath } from "./preview-corpus";

const completed = <T>(result: B.OperationResult<T>): T => { expect(result.status).toBe("completed"); if (result.status !== "completed") throw new Error(JSON.stringify(result)); return result.value; };
const available = <T>(result: B.ReadResult<T>): T => { expect(result.status).toBe("available"); if (result.status !== "available") throw new Error(JSON.stringify(result)); return result.value; };
const ssh = { id: "ssh-locked", type: "ssh" } as const;
const pgp = { id: "pgp-locked", type: "openpgp" } as const;
const token = { id: "token-github", type: "token" } as const;
const authAssignment = (workspaceId = "notes", credentialId: string = ssh.id, host = "github.com"): Extract<import("../../src/hub/credential-types").CredentialAssignment, { role: "authentication" }> => ({ workspaceId, credentialId, host, role: "authentication" });
let attemptCounter = 0;
const cloneIntent = (overrides: Partial<B.CloneSubmissionIntent> = {}): B.CloneSubmissionIntent => ({ attemptId: `test-attempt-${++attemptCounter}`, url: "https://github.com/review/synthetic.git", dest: "/synthetic", folderName: "checkout", displayName: "Review checkout", credentialId: token.id, retainedAuthentication: [], signing: null, start: false, ...overrides });
const existing = (overrides: Partial<Parameters<B.MobileHubBackend["configureExisting"]>[0]> = {}) => ({ path: "/synthetic/existing", displayName: "Existing review", authentication: [], signing: null, init: false, start: false, ...overrides });
const jobId = async (f: ReturnType<typeof createSyntheticBackend>, intent = cloneIntent()) => { const value = completed(await f.backend.submitClone(intent)); expect(value.status).toBe("accepted"); if (value.status !== "accepted") throw new Error("expected accepted"); return value.jobId; };

test("seeded populated workspace picker folders match every preview example and reads never mutate", async () => {
  const expected = new Map<string, boolean>();
  for (const path of [...previewExamples.map(example => example.path), previewImagePath.slice(1)]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const directory = parts.slice(0, i).join("/");
      expected.set(directory, (expected.get(directory) ?? false) || i === parts.length - 1);
    }
  }
  const f = createSyntheticBackend();
  for (const scenario of [null, "mixed", "branches", "credentials", "all-running", "all-stopped", "nested"] as const) {
    if (scenario) f.reset(scenario);
    const before = f.inspect();
    const events: unknown[] = [];
    const unsubscribe = f.backend.subscribeInvalidation(event => events.push(event));
    for (const workspace of before.workspaces) {
      if (!before.folders.find(folder => folder.path === workspace.path)!.content) continue;
      const root = available(await f.backend.browseFolders(workspace.path));
      expect(root.directories.map(directory => directory.name)).toContain("examples");
      for (const [relativePath, content] of expected) {
        const path = `${workspace.path}/${relativePath}`;
        const listing = available(await f.backend.browseFolders(path));
        expect(listing.path).toBe(path);
        expect(listing.parent).toBe(path.slice(0, path.lastIndexOf("/")));
        expect(before.folders.find(folder => folder.path === path)).toEqual({ path, git: false, content, available: true });
        const children = [...expected.keys()].filter(child => child.slice(0, child.lastIndexOf("/")) === relativePath).map(child => child.split("/").pop()!).sort();
        expect(listing.directories.map(directory => directory.name).sort()).toEqual(children);
        expect(listing.directories.every(directory => !directory.git && directory.registration.status === "unregistered")).toBe(true);
      }
    }
    expect(f.inspect()).toEqual(before);
    expect(f.snapshot().log).toEqual([]);
    expect(events).toEqual([]);
    unsubscribe();
  }
});

test("example seeding preserves empty lifecycle fixtures and does not fabricate dynamic checkout contents", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  for (const path of ["/synthetic/group", "/synthetic/empty-folder", "/synthetic/existing"]) expect(available(await b.browseFolders(path)).directories).toEqual([]);
  f.reset("nested");
  expect(available(await b.browseFolders("/synthetic/group")).directories.map(directory => directory.name)).toEqual(["child"]);
  expect(available(await b.browseFolders("/synthetic/group/child")).directories).toEqual([]);
  completed(await b.createFolder({ parent: "/synthetic", name: "dynamic" }));
  completed(await b.configureExisting(existing({ path: "/synthetic/dynamic", init: true })));
  const before = f.inspect(); const log = f.snapshot().log;
  expect(available(await b.browseFolders("/synthetic/dynamic")).directories).toEqual([]);
  expect(f.inspect()).toEqual(before);
  expect(f.snapshot().log).toEqual(log);
  f.reset("empty");
  expect(f.inspect().folders.some(folder => folder.path.includes("/examples"))).toBe(false);
});

test("populated catalogs use actual public DTOs and layered lock/tool readiness", async () => {
  const f = createSyntheticBackend(); const credentials = available(await f.backend.readCredentials());
  expect(credentials.map(c => c.type)).toEqual(["ssh", "ssh", "openpgp", "token", "token"]);
  credentials.forEach(c => expect(parsePublicCredentialDto(c)).toEqual(c));
  expect(credentials.find(c => c.id === ssh.id)?.readiness).toContainEqual({ layer: "capability", status: "unavailable", message: "Credential is locked; unlock before use." });
  expect(credentials.find(c => c.id === "ssh-open")?.readiness.some(r => r.message.includes("Unprotected"))).toBe(true);
  available(await f.backend.readTools()).forEach(t => expect(parsePublicToolReadinessDto(t)).toEqual(t));
  f.setToolState("ssh", "missing"); expect(available(await f.backend.readCredentials())[0]!.readiness.some(r => r.layer === "binary" && r.status === "unavailable")).toBe(true);
  expect(f.snapshot().log).toEqual([]); // reads never start tools or workspaces
});

test("workspace lifecycle separates confirmation/unlock/start, stop and forgetting files", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  expect(completed(await b.startWorkspace({ workspaceId: "notes", unassigned: "not-confirmed" })).status).toBe("confirm-unassigned");
  expect(available(await b.readWorkspace("notes")).runtime.status).toBe("stopped");
  expect((await b.forgetWorkspace("atlas")).status).toBe("rejected");
  completed(await b.stopWorkspace("atlas")); expect(completed(await b.stopWorkspace("atlas"))).toEqual({ status: "already-stopped" });
  expect(completed(await b.forgetWorkspace("atlas"))).toEqual({ status: "forgotten" });
  expect(completed(await b.forgetWorkspace("atlas"))).toEqual({ status: "not-found" });
  expect(available(await b.browseFolders()).directories.find(d => d.name === "atlas")?.registration.status).toBe("unregistered");
  expect((await b.readWorkspace("atlas")).status).toBe("unavailable");
  expect(completed(await b.renameWorkspace({ workspaceId: "notes", displayName: "  Duplicate friendly name  " })).displayName).toBe("Duplicate friendly name");
  expect((await b.renameWorkspace({ workspaceId: "notes", displayName: "\u202e" })).status).toBe("rejected");
  f.reset("credentials");
  const required = completed(await b.startWorkspace({ workspaceId: "notes", unassigned: "not-confirmed" }));
  expect(required).toEqual({ status: "requires-unlock", credentials: [ssh, pgp] });
  completed(await b.unlockCredential({ target: ssh, passphrase: "disposable" }));
  expect(available(await b.readWorkspace("notes")).runtime.status).toBe("stopped");
  completed(await b.unlockCredential({ target: pgp, passphrase: "disposable" }));
  expect(completed(await b.startWorkspace({ workspaceId: "notes", unassigned: "not-confirmed" })).status).toBe("running");
});

test("every key creation/import operation validates source and erases secrets before pending", async () => {
  const f = createSyntheticBackend(); const b = f.backend; const secret = "DO-NOT-RETAIN-PRIVATE-MATERIAL";
  const generated = completed(await b.generateSsh({ name: "Generated SSH", capabilities: ["ssh-authentication", "ssh-signing"], passphrase: secret }));
  expect(generated.type).toBe("ssh"); expect(generated.readiness.some(r => r.message.includes("locked"))).toBe(true);
  const imported = completed(await b.importSsh({ name: "Imported SSH", capabilities: ["ssh-signing"], passphrase: secret, source: { kind: "paste", text: secret } }));
  expect(imported.readiness.some(r => r.message.includes("unlocked"))).toBe(true);
  const gp = completed(await b.generateOpenPgp({ name: "Generated OpenPGP", userId: "Disposable review user", passphrase: secret })); expect(gp.type).toBe("openpgp");
  expect(gp.metadata.publicKey).toContain("Synthetic user ID Disposable review user");
  let reads = 0;
  const file = { size: 10, text() { reads++; throw new Error("must not read a File"); } } as unknown as File;
  const ip = completed(await b.importOpenPgp({ name: "Imported OpenPGP", source: { kind: "file", file } })); expect(ip.type).toBe("openpgp"); expect(reads).toBe(0);
  f.hold("importSsh");
  const mutable = { name: "Held SSH", capabilities: ["ssh-authentication"] as Array<"ssh-authentication">, passphrase: secret, source: { kind: "file" as const, file } };
  const pending = b.importSsh(mutable); mutable.name = "mutated after submit"; mutable.capabilities.length = 0;
  expect(JSON.stringify([f.snapshot(), f.inspect()])).not.toContain(secret);
  f.settle("importSsh"); expect(completed(await pending).name).toBe("Held SSH"); expect(reads).toBe(0);
  for (const source of [{ kind: "paste", text: "" }, { kind: "paste", text: "x", file }, { kind: "file", file: { size: 1_048_577 } }, { kind: "file", file, text: "both" }]) expect((await b.importOpenPgp({ name: "Bad", source: source as B.PrivateKeySource })).status).toBe("rejected");
  expect((await b.generateSsh({ name: "Bad", capabilities: [], passphrase: secret })).status).toBe("rejected");
  expect((await b.generateOpenPgp({ name: "Bad", userId: "u", passphrase: "" })).status).toBe("rejected");
  f.setImportFailure(); expect((await b.importOpenPgp({ name: "Bad format", source: { kind: "paste", text: secret } })).status).toBe("rejected");
  expect(JSON.stringify([f.snapshot(), f.inspect()])).not.toContain(secret);
});

test("public key/unlock/SSH-only lock/enable/disable/test enforce credential type", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  expect(available(await b.readPublicKey(ssh)).publicKey).toContain("SYNTHETIC-PUBLIC-ONLY");
  expect(available(await b.readPublicKey(pgp)).type).toBe("openpgp");
  expect((await b.readPublicKey(token as unknown as B.KeyTarget)).status).toBe("unavailable");
  expect((await b.lockSsh(pgp as unknown as B.CredentialTarget<"ssh">)).status).toBe("rejected");
  expect((await b.unlockCredential({ target: token as unknown as B.KeyTarget, passphrase: "x" })).status).toBe("rejected");
  f.setUnlockFailure(); expect((await b.unlockCredential({ target: ssh, passphrase: "x" })).status).toBe("rejected");
  f.setUnlockFailure(false); completed(await b.unlockCredential({ target: ssh, passphrase: "x" })); completed(await b.lockSsh(ssh));
  expect(completed(await b.testCredential(ssh)).some(r => r.status === "unavailable")).toBe(true);
  const disabled = completed(await b.disableCredential({ target: pgp, stop: "ask" })); expect(disabled.status).toBe("completed");
  expect((await b.unlockCredential({ target: pgp, passphrase: "x" })).status).toBe("rejected");
  expect(completed(await b.enableCredential(pgp)).enabled).toBe(true);
  completed(await b.lockSsh({ id: "ssh-open", type: "ssh" }));
  expect(completed(await b.unlockCredential({ target: { id: "ssh-open", type: "ssh" }, passphrase: "" })).readiness.some(r => r.message.includes("Unprotected"))).toBe(true);
  expect((await b.unlockCredential({ target: pgp, passphrase: "" })).status).toBe("rejected");
  f.setKeyState(ssh.id, "unavailable"); expect((await b.unlockCredential({ target: ssh, passphrase: "x" })).status).toBe("rejected");
});

test("token creation normalizes host and never accepts unsupported capability combinations", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  const dto = completed(await b.createToken({ name: "Only HTTPS", host: "https://EXAMPLE.COM/", username: "reviewer", token: "disposable-token", capabilities: ["https-git"] }));
  expect(dto.metadata.host).toBe("example.com"); expect(JSON.stringify(f.inspect())).not.toContain("disposable-token");
  for (const caps of [[], ["github-cli", "gitlab-cli"], ["https-git", "https-git"]]) expect((await b.createToken({ name: "Invalid", host: "github.com", token: "x", capabilities: caps as Parameters<B.MobileHubBackend["createToken"]>[0]["capabilities"] })).status).toBe("rejected");
  for (const host of ["*", "https://user:secret@example.com", "github.com/path", "bad host"]) expect((await b.createToken({ name: "Bad host", host, token: "x", capabilities: ["https-git"] })).status).toBe("rejected");
  expect((await b.createToken({ name: "Bad secret", host: "github.com", token: "x\ny", capabilities: ["https-git"] })).status).toBe("rejected");
});

test("assignment edits atomically preserve unselected roles/hosts, no-op and replace intent", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  completed(await b.assignWorkspace({ workspaceId: "notes", mode: "assign-new", selection: { authentication: { credentialId: ssh.id, host: "GitHub.com" }, signing: { credentialId: pgp.id } } }));
  expect(available(await b.readWorkspace("notes")).assignments).toHaveLength(2);
  const events: B.Invalidation[] = []; const unsubscribe = b.subscribeInvalidation(e => events.push(e));
  completed(await b.assignWorkspace({ workspaceId: "notes", mode: "edit-current", selection: { signing: { credentialId: pgp.id } } })); expect(events).toHaveLength(0);
  completed(await b.assignCredential({ assignment: authAssignment("notes", "ssh-open", "example.com"), replace: false }));
  expect((await b.assignCredential({ assignment: authAssignment("notes", "ssh-open"), replace: false })).status).toBe("rejected");
  completed(await b.assignCredential({ assignment: authAssignment("notes", "ssh-open"), replace: true }));
  expect(available(await b.readWorkspace("notes")).assignments).toHaveLength(3);
  const before = f.inspect().credentials;
  expect((await b.assignWorkspace({ workspaceId: "notes", mode: "edit-current", selection: { authentication: { credentialId: token.id, host: "github.com" }, signing: { credentialId: token.id } } })).status).toBe("rejected");
  expect(f.inspect().credentials).toEqual(before);
  expect((await b.assignCredential({ assignment: authAssignment("notes", token.id, "example.com"), replace: true })).status).toBe("rejected");
  unsubscribe();
});

test("unassignment cancellation does not stop; confirmed stop precedes catalog mutation", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  const a = authAssignment("atlas", "ssh-open"); completed(await b.assignCredential({ assignment: a, replace: false }));
  expect(available(await b.readWorkspace("atlas")).credentialRestartRequired).toBe(true);
  expect(completed(await b.removeAssignment({ assignment: a, stop: "ask" }))).toEqual({ status: "needs-stop", workspaceIds: ["atlas"] });
  expect(available(await b.readWorkspace("atlas")).runtime.status).toBe("running");
  f.setStopFailure("atlas"); expect((await b.removeAssignment({ assignment: a, stop: "stop-dependent-workspaces" })).status).toBe("rejected"); expect(available(await b.readWorkspace("atlas")).assignments).toContainEqual(a);
  f.setStopFailure("atlas", false); const order: string[] = []; b.subscribeInvalidation(e => order.push(e.scope === "workspace" ? "stop" : e.scope === "catalog" ? e.resource : "auth"));
  expect(completed(await b.removeAssignment({ assignment: a, stop: "stop-dependent-workspaces" }))).toEqual({ status: "completed", value: { removed: true } });
  expect(order.indexOf("stop")).toBeLessThan(order.indexOf("credentials"));
  expect(completed(await b.removeAssignment({ assignment: a, stop: "ask" }))).toEqual({ status: "completed", value: { removed: false } });
});

test("provider revocation tracks projected tokens even after assignment changes; partial stops leave catalog", async () => {
  const f = createSyntheticBackend(); f.reset("credentials"); const b = f.backend;
  completed(await b.assignCredential({ assignment: authAssignment("notes", token.id), replace: true }));
  completed(await b.removeAssignment({ assignment: { workspaceId: "notes", credentialId: pgp.id, role: "signing" }, stop: "ask" }));
  completed(await b.startWorkspace({ workspaceId: "notes", unassigned: "not-confirmed" }));
  // Replace A's current catalog assignment without replacing its running projection.
  completed(await b.assignCredential({ assignment: authAssignment("atlas", "ssh-open"), replace: true }));
  expect(completed(await b.disableCredential({ target: token, stop: "ask" }))).toEqual({ status: "needs-stop", workspaceIds: ["atlas", "notes"] });
  f.setStopFailure("notes"); expect((await b.disableCredential({ target: token, stop: "stop-dependent-workspaces" })).status).toBe("rejected");
  expect(available(await b.readWorkspace("atlas")).runtime.status).toBe("stopped"); expect(available(await b.readWorkspace("notes")).runtime.status).toBe("running"); expect(f.inspect().credentials.find(c => c.id === token.id)?.enabled).toBe(true);
  f.setStopFailure("notes", false); expect(completed(await b.disableCredential({ target: token, stop: "stop-dependent-workspaces" })).status).toBe("completed");
  completed(await b.enableCredential(token));
  expect((await b.deleteCredential({ target: token, confirm: true, unassign: false, stop: "ask" })).status).toBe("rejected");
  expect(completed(await b.deleteCredential({ target: token, confirm: true, unassign: true, stop: "ask" }))).toEqual({ status: "completed", value: { deleted: true } });
  expect(f.inspect().credentials.some(c => c.id === token.id)).toBe(false);
});

test("tool overrides, missing/incompatible/runtime diagnostics and default-folder fallback", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  for (const state of ["missing", "incompatible", "runtime-unavailable"] as const) { f.setToolState("gpg", state); expect(completed(await b.testTool("gpg")).results.some(r => r.status === "unavailable")).toBe(true); }
  expect(completed(await b.setToolOverride({ tool: "gpg", path: "/synthetic/bin/custom-gpg" })).path).toBe("/synthetic/bin/custom-gpg");
  f.setToolState("gpg", "ready"); expect(completed(await b.testTool("gpg")).results.every(r => r.status === "ready")).toBe(true);
  expect(completed(await b.setToolOverride({ tool: "gpg", path: null })).path).toBe("/synthetic/bin/gpg");
  expect((await b.setToolOverride({ tool: "gpg", path: "relative" })).status).toBe("rejected"); expect((await b.testTool("shell" as CredentialTool)).status).toBe("rejected");
  expect(completed(await b.setDefaultFolder("/synthetic/existing"))).toMatchObject({ configuredAvailable: true, effective: "/synthetic/existing" });
  f.setFolderAvailable("/synthetic/existing", false); expect(available(await b.readDefaultFolder())).toEqual({ configured: "/synthetic/existing", configuredAvailable: false, effective: "/synthetic" });
  expect((await b.browseFolders("/synthetic/existing")).status).toBe("unavailable");
  expect(completed(await b.setDefaultFolder(null))).toEqual({ configured: null, configuredAvailable: false, effective: "/synthetic" });
  expect((await b.setDefaultFolder("/synthetic/missing")).status).toBe("rejected");
});

test("folder creation, nested registration rename and empty removal preserve ids/names", async () => {
  const f = createSyntheticBackend(); f.reset("nested"); const b = f.backend;
  expect(completed(await b.createFolder({ parent: "/synthetic", name: "new-folder" }))).toEqual({ path: "/synthetic/new-folder" });
  for (const name of ["../escape", ".hidden", "new-folder", "\u202e"]) expect((await b.createFolder({ parent: "/synthetic", name })).status).toBe("rejected");
  expect((await b.createFolder({ parent: "/synthetic/denied", name: "blocked" })).status).toBe("rejected");
  expect(completed(await b.renameFolder({ path: "/synthetic/group", name: "moved", stop: "ask" }))).toEqual({ status: "needs-stop", workspaceIds: ["nested-child", "nested-parent"] });
  f.setFolderFault("after-stop"); expect((await b.renameFolder({ path: "/synthetic/group", name: "moved", stop: "stop-dependent-workspaces" })).status).toBe("rejected"); expect(available(await b.readWorkspace("nested-child")).path).toBe("/synthetic/group/child");
  f.setFolderFault(null); const renamed = completed(await b.renameFolder({ path: "/synthetic/group", name: "moved", stop: "stop-dependent-workspaces" })); expect(renamed).toMatchObject({ status: "completed", value: { path: "/synthetic/moved" } });
  expect(available(await b.readWorkspace("nested-child"))).toMatchObject({ id: "nested-child", path: "/synthetic/moved/child", displayName: "Nested", runtime: { status: "stopped" } });
  expect((await b.removeEmptyFolder({ path: "/synthetic/moved", stop: "ask" })).status).toBe("rejected");
  expect(completed(await b.removeEmptyFolder({ path: "/synthetic/moved/child", stop: "ask" }))).toEqual({ status: "completed", value: { path: "/synthetic/moved/child", workspaceId: "nested-child" } });
  expect((await b.readWorkspace("nested-child")).status).toBe("unavailable");
  expect(completed(await b.removeEmptyFolder({ path: "/synthetic/new-folder", stop: "ask" }))).toEqual({ status: "completed", value: { path: "/synthetic/new-folder" } });
  expect((await b.removeEmptyFolder({ path: "/synthetic/existing", stop: "ask" })).status).toBe("rejected");
});

test("onboarding distinguishes already registered, explicit init, create folder, and requested start", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  expect(completed(await b.configureExisting(existing({ path: "/synthetic/atlas", displayName: "Must not rename", start: true })))).toMatchObject({ status: "configured", result: { created: false, alreadyRegistered: true, started: false, entry: { displayName: "Atlas" } } });
  expect(completed(await b.configureExisting(existing({ path: "/synthetic/empty-folder" })))).toMatchObject({ status: "failed", code: "needs-init" });
  const configured = completed(await b.configureExisting(existing({ path: "/synthetic/empty-folder", init: true, authentication: [{ credentialId: ssh.id, host: "github.com" }], signing: pgp.id, start: true })));
  expect(configured).toMatchObject({ status: "configured", result: { created: true, createdFolder: false, started: false } });
  if (configured.status === "configured") { expect(configured.result.startError).toContain("unlock"); expect(available(await b.readWorkspace(configured.result.entry.id)).assignments).toHaveLength(2); }
  const created = completed(await b.createWorkspace({ parent: "/synthetic", folderName: "created", displayName: "Friendly label", authentication: [], signing: null, start: true, gitInitConsent: "confirmed" }));
  expect(created).toMatchObject({ status: "configured", result: { created: true, createdFolder: true, started: true, startError: null, entry: { path: "/synthetic/created", displayName: "Friendly label" } } });
  expect((await b.createWorkspace({ parent: "/synthetic", folderName: "no-consent", displayName: "No", authentication: [], signing: null, start: false, gitInitConsent: "no" as "confirmed" })).status).toBe("rejected");
});

for (const fault of ["needs-init", "credential", "git-init", "register-failed", "retained-checkout", "committed-recovery", "start-failed"] as OnboardingFault[]) test(`onboarding controlled ${fault} preserves truthful partial facts`, async () => {
  const f = createSyntheticBackend(); f.setOnboardingFault(fault);
  const result = completed(await f.backend.createWorkspace({ parent: "/synthetic", folderName: "faulted", displayName: "Faulted", authentication: [], signing: null, start: true, gitInitConsent: "confirmed" }));
  if (fault === "start-failed") expect(result).toMatchObject({ status: "configured", result: { created: true, started: false, startError: expect.any(String) } });
  else if (fault === "committed-recovery") expect(result).toMatchObject({ status: "failed", committedEntry: { path: "/synthetic/faulted" }, retainedPath: "/synthetic/faulted" });
  else if (fault === "register-failed" || fault === "retained-checkout") expect(result).toMatchObject({ status: "failed", retainedPath: "/synthetic/faulted" });
  else { expect(result.status).toBe("failed"); expect(f.inspect().folders.some(v => v.path === "/synthetic/faulted")).toBe(false); }
});

test("clone unlock is independent, host/capability selection fail closed and retained roles are explicit", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  const intent = cloneIntent({ url: "git@github.com:review/synthetic.git", credentialId: ssh.id, retainedAuthentication: [{ credentialId: token.id, host: "github.com" }], signing: pgp.id });
  expect(completed(await b.submitClone(intent))).toEqual({ status: "requires-unlock", credential: ssh }); expect(f.inspect().jobs).toHaveLength(0);
  completed(await b.unlockCredential({ target: ssh, passphrase: "disposable" })); expect(f.inspect().jobs).toHaveLength(0);
  const authorized = { ...intent, attemptId: "unlocked-attempt" };
  const id = await jobId(f, authorized); expect(f.inspect().jobs).toHaveLength(1);
  expect((await b.submitClone(intent)).status).toBe("rejected"); // reservation prevents duplicate submission
  expect(completed(await b.submitClone(authorized))).toEqual({ status: "accepted", jobId: id });
  f.finishClone(id); const result = f.inspect().jobs[0]!.result!; expect(result.status).toBe("succeeded");
  if (result.status === "succeeded") { const workspace = available(await b.readWorkspace(result.workspaceId)); expect(workspace.assignments.map(a => a.credentialId)).toEqual([token.id, pgp.id]); expect(workspace.runtime.status).toBe("stopped"); }
  for (const bad of [cloneIntent({ folderName: "bad1", credentialId: pgp.id }), cloneIntent({ folderName: "bad2", url: "https://example.com/repo" }), cloneIntent({ folderName: "bad3", credentialId: "token-gitlab" }), cloneIntent({ folderName: "bad4", url: "https://user:private@github.com/repo" }), cloneIntent({ folderName: "bad5", url: "file:///private/repo", credentialId: null })]) expect((await b.submitClone(bad)).status).toBe("rejected");
  expect(JSON.stringify(f.inspect())).not.toContain("review/synthetic.git");
});

test("clone streams mask all input, replay exact event cursor and unsubscribe is not cancellation", async () => {
  const f = createSyntheticBackend(); const id = await jobId(f); const events: B.CloneStreamEvent[] = [];
  const unsubscribe = f.backend.subscribeClone({ jobId: id, afterEventId: 0 }, event => events.push(event));
  f.cloneOutput(id, "progress"); f.cloneOutput(id, "prompt");
  expect(completed(await f.backend.sendCloneInput({ jobId: id, input: "DO-NOT-RETAIN-PROMPT" }))).toEqual({ status: "accepted" });
  expect(JSON.stringify([events, f.inspect(), f.snapshot()])).not.toContain("DO-NOT-RETAIN-PROMPT");
  expect(JSON.stringify(events)).toContain("[masked input accepted]");
  expect((await f.backend.sendCloneInput({ jobId: id, input: "x".repeat(8193) })).status).toBe("rejected");
  unsubscribe(); f.clonePhase(id, "registering"); expect(events).toHaveLength(4); expect(f.inspect().jobs[0]!.result).toBeUndefined();
  const replay: B.CloneStreamEvent[] = []; f.backend.subscribeClone({ jobId: id, afterEventId: 3 }, e => replay.push(e)); expect(replay).toHaveLength(2);
  f.disconnectClone(id); expect(replay.at(-1)?.type).toBe("disconnected");
  f.finishClone(id); expect(replay.at(-1)?.type).toBe("disconnected");
  const afterDisconnect: B.CloneStreamEvent[] = []; f.backend.subscribeClone({ jobId: id, afterEventId: 5 }, e => afterDisconnect.push(e)); expect(afterDisconnect[0]).toMatchObject({ type: "job-event", event: { type: "result", data: { status: "succeeded" } } });
  expect(completed(await f.backend.cancelClone(id))).toEqual({ status: "terminal" });
  f.expireClone(id); const expired: B.CloneStreamEvent[] = []; f.backend.subscribeClone({ jobId: id, afterEventId: 0 }, e => expired.push(e)); expect(expired[0]).toMatchObject({ type: "unavailable", reason: "not-found-or-expired" });
});

for (const outcome of ["succeeded", "clone-failed", "register-failed", "start-failed", "cleanup-failed", "cancelled", "timed-out"] as CloneOutcome[]) test(`clone controlled terminal ${outcome} reports retained checkout/registration truthfully`, async () => {
  const f = createSyntheticBackend(); const id = await jobId(f, cloneIntent({ start: outcome === "start-failed" || outcome === "succeeded" }));
  const result = f.finishClone(id, outcome); expect(result.status).toBe(outcome);
  const exists = f.inspect().folders.some(folder => folder.path === "/synthetic/checkout");
  expect(exists).toBe(!["clone-failed", "cancelled", "timed-out"].includes(outcome));
  const workspace = f.inspect().workspaces.find(w => w.path === "/synthetic/checkout");
  expect(!!workspace).toBe(outcome === "succeeded" || outcome === "start-failed");
  if (workspace) expect(workspace.runtime.status).toBe(outcome === "succeeded" ? "running" : "stopped");
});

test("clone cancellation/cleanup failure and clock timeout/retention controls", async () => {
  const f = createSyntheticBackend(); const first = await jobId(f);
  expect(completed(await f.backend.cancelClone(first))).toEqual({ status: "cancelled" });
  const second = await jobId(f); f.setCloneCleanupFailure(); expect(completed(await f.backend.cancelClone(second))).toMatchObject({ status: "cleanup-failed" });
  f.reset(); const third = await jobId(f); f.advance(600_000); expect(f.inspect().jobs.find(j => j.id === third)?.result).toMatchObject({ status: "timed-out", reason: "inactivity" }); f.advance(300_000); expect(f.inspect().jobs).toHaveLength(0);
});

test("auth, devices, forbidden reads, stable clock and detached snapshots remain isolated", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  expect(available(await b.readAuthentication()).status).toBe("authenticated"); expect(available(await b.readDevices())).toHaveLength(2);
  expect(completed(await b.revokeDevice("review-other-device"))).toEqual({ status: "revoked", current: false }); expect(f.snapshot().authenticated).toBe(true);
  expect(completed(await b.revokeDevice("review-device"))).toEqual({ status: "revoked", current: true }); expect((await b.readCredentials()).status).toBe("unavailable");
  expect((await b.signIn({ user: "private-user", password: "DO-NOT-RETAIN" })).status).toBe("rejected"); completed(await b.signIn({ user: "reviewer", password: "review-only" }));
  const catalog = available(await b.readCredentials()); catalog.length = 0; expect(available(await b.readCredentials()).length).toBeGreaterThan(0);
  completed(await b.signOut()); expect(available(await b.readAuthentication())).toEqual({ status: "signed-out" });
  const another = createSyntheticBackend(); expect(another.snapshot().authenticated).toBe(true); expect(JSON.stringify(f.snapshot())).not.toContain("DO-NOT-RETAIN");
  f.reset(); expect(f.snapshot()).toEqual({ clock: FIXTURE_TIME, authenticated: true, log: [], pending: [] });
});

test("pending failures, reset, unauthorized generations and indeterminate reconciliation", async () => {
  const f = createSyntheticBackend(); f.hold("renameWorkspace");
  const failed = f.backend.renameWorkspace({ workspaceId: "atlas", displayName: "No change" });
  expect(f.snapshot().pending).toEqual([{ method: "renameWorkspace", count: 1 }]); f.settle("renameWorkspace", true); expect((await failed).status).toBe("rejected");
  f.hold("generateSsh"); const stale = f.backend.generateSsh({ name: "Stale", capabilities: ["ssh-authentication"], passphrase: "DO-NOT-RETAIN" }); f.reset(); expect((await stale).status).toBe("rejected"); expect(f.inspect().credentials.some(c => c.name === "Stale")).toBe(false);
  f.hold("readCredentials"); const read = f.backend.readCredentials(); f.invalidateAuthentication(); f.settle("readCredentials"); expect((await read).status).toBe("unavailable");
  f.reset(); f.fail("renameWorkspace", "indeterminate-after"); expect((await f.backend.renameWorkspace({ workspaceId: "atlas", displayName: "Effect committed" })).status).toBe("indeterminate"); expect(available(await f.backend.readWorkspace("atlas")).displayName).toBe("Effect committed");
  f.fail("stopWorkspace", "indeterminate-before"); expect((await f.backend.stopWorkspace("atlas")).status).toBe("indeterminate"); expect(f.workspaceAvailable()).toBe(true);
  f.fail("signIn", { kind: "rate-limited", message: "DO-NOT-RETAIN", retryAfterSeconds: 20 }); expect(await f.backend.signIn({ user: "reviewer", password: "review-only" })).toMatchObject({ status: "rejected", problem: { kind: "rate-limited", retryAfterSeconds: 20 } });
  expect(() => f.hold("unknown" as keyof B.MobileHubBackend)).toThrow(); expect(() => f.reset("unknown" as "mixed")).toThrow();
  expect(JSON.stringify([f.snapshot(), f.inspect()])).not.toContain("DO-NOT-RETAIN");
});

test("all scenario reset variants replace management state and no generic missing-contract remains", async () => {
  const f = createSyntheticBackend(); const before = f.inspect();
  const id = await jobId(f); const events: B.CloneStreamEvent[] = []; f.backend.subscribeClone({ jobId: id, afterEventId: 0 }, e => events.push(e));
  f.reset(); expect(events.at(-1)).toMatchObject({ type: "unavailable" }); expect(f.inspect()).toEqual(before);
  f.reset("empty"); expect(available(await f.backend.readCredentials())).toEqual([]); expect(available(await f.backend.readWorkspaces())).toEqual([]);
  f.reset("branches"); expect(new Set(available(await f.backend.readWorkspaces()).map(w => w.branch.kind)).size).toBe(6);
  f.reset("unavailable-tools"); expect(available(await f.backend.readTools()).every(t => t.results.some(r => r.status === "unavailable"))).toBe(true);
  f.reset("signed-out"); expect((await f.backend.readTools()).status).toBe("unavailable");
});

type CredentialTool = import("../../src/hub/credential-types").CredentialTool;

test("clone phase registration is visible before requested start; cancellation cleans synthetic partial commit", async () => {
  const f = createSyntheticBackend(); const id = await jobId(f, cloneIntent({ start: true }));
  f.clonePhase(id, "registering"); expect(f.inspect().folders.some(folder => folder.path === "/synthetic/checkout")).toBe(true);
  f.clonePhase(id, "starting"); expect(f.inspect().workspaces.find(w => w.path === "/synthetic/checkout")?.runtime.status).toBe("stopped");
  expect(() => f.clonePhase(id, "cloning")).toThrow();
  expect((await f.backend.sendCloneInput({ jobId: id, input: "discarded" })).status).toBe("rejected");
  expect(completed(await f.backend.cancelClone(id)).status).toBe("cancelled");
  expect(f.inspect().workspaces.some(w => w.path === "/synthetic/checkout")).toBe(false); expect(f.inspect().folders.some(folder => folder.path === "/synthetic/checkout")).toBe(false);
  const second = await jobId(f, cloneIntent({ start: true })); f.clonePhase(second, "starting"); expect(f.finishClone(second)).toMatchObject({ status: "succeeded", running: true });
});

test("clone lifetime timeout differs from inactivity, replay retention gaps reject, callbacks cannot change effects", async () => {
  const f = createSyntheticBackend(); const id = await jobId(f);
  f.backend.subscribeClone({ jobId: id, afterEventId: 0 }, () => { throw new Error("view callback failed"); });
  for (let i = 0; i < 201; i++) f.cloneOutput(id, "progress");
  const gap: B.CloneStreamEvent[] = []; f.backend.subscribeClone({ jobId: id, afterEventId: 0 }, e => gap.push(e)); expect(gap[0]).toMatchObject({ type: "unavailable" });
  for (let i = 0; i < 7; i++) { f.advance(500_000); f.cloneOutput(id, "progress"); }
  f.advance(100_000); expect(f.inspect().jobs[0]?.result).toMatchObject({ status: "timed-out", reason: "lifetime" });
  expect(() => f.backend.subscribeClone({ jobId: id, afterEventId: 9999 }, () => {})).toThrow();
});

test("provider deletion consent, key deletion and source restrictions are explicit", async () => {
  const f = createSyntheticBackend(); f.reset("credentials"); const b = f.backend;
  expect(completed(await b.deleteCredential({ target: token, confirm: true, unassign: true, stop: "ask" }))).toEqual({ status: "needs-stop", workspaceIds: ["atlas"] });
  f.setStopFailure("atlas"); expect((await b.deleteCredential({ target: token, confirm: true, unassign: true, stop: "stop-dependent-workspaces" })).status).toBe("rejected"); expect(f.inspect().credentials.some(c => c.id === token.id)).toBe(true);
  f.setStopFailure("atlas", false); expect(completed(await b.deleteCredential({ target: token, confirm: true, unassign: true, stop: "stop-dependent-workspaces" }))).toEqual({ status: "completed", value: { deleted: true } });
  expect((await b.deleteCredential({ target: ssh, confirm: false as true, unassign: true, stop: "ask" })).status).toBe("rejected");
  completed(await b.deleteCredential({ target: ssh, confirm: true, unassign: true, stop: "ask" }));
  expect((await b.readPublicKey(ssh)).status).toBe("unavailable");
  const unprotected = completed(await b.importSsh({ name: "No encryption", capabilities: ["ssh-authentication"], passphrase: "", source: { kind: "paste", text: "synthetic import source" } }));
  expect(unprotected.readiness.some(r => r.message.includes("Unprotected"))).toBe(true);
  expect((await b.generateSsh({ name: "Bad passphrase", capabilities: ["ssh-authentication"], passphrase: "x\tsecret" })).status).toBe("rejected");
  f.setToolState("ssh-keygen", "missing"); expect((await b.generateSsh({ name: "No tooling", capabilities: ["ssh-authentication"], passphrase: "x" })).status).toBe("rejected");
});

test("disabled/unavailable assignments never become unassigned confirmation; stop invalidates pending effects", async () => {
  const f = createSyntheticBackend(); f.reset("credentials"); const b = f.backend;
  completed(await b.disableCredential({ target: ssh, stop: "ask" }));
  expect(await b.startWorkspace({ workspaceId: "notes", unassigned: "confirmed-without-credentials" })).toMatchObject({ status: "rejected", problem: { kind: "conflict" } });
  completed(await b.enableCredential(ssh)); f.setKeyState(ssh.id, "unavailable"); expect((await b.startWorkspace({ workspaceId: "notes", unassigned: "confirmed-without-credentials" })).status).toBe("rejected");
  f.hold("renameWorkspace"); const pending = b.renameWorkspace({ workspaceId: "atlas", displayName: "Must not commit" }); completed(await b.stopWorkspace("atlas")); f.settle("renameWorkspace"); expect((await pending).status).toBe("rejected"); expect(available(await b.readWorkspace("atlas")).displayName).toBe("Atlas");
  f.setFolderAvailable("/synthetic/atlas", false); expect((await b.startWorkspace({ workspaceId: "atlas", unassigned: "confirmed-without-credentials" })).status).toBe("rejected");
});

test("catalog empty/missing material and authoritative unauthorized controls are independent", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  f.setDeviceInventory("empty"); expect(available(await b.readDevices())).toEqual([]);
  f.setDeviceInventory("current-only"); expect(available(await b.readDevices())).toHaveLength(1);
  f.setCredentialAvailable(token.id, false); expect(completed(await b.testCredential(token)).some(r => r.layer === "credential" && r.status === "unavailable")).toBe(true);
  expect((await b.submitClone(cloneIntent())).status).toBe("rejected");
  f.setCredentialAvailable(token.id, true); expect(completed(await b.testCredential(token)).every(r => r.status === "ready")).toBe(true);
  f.reset("all-running"); expect(available(await b.readWorkspaces()).every(w => w.runtime.status === "running")).toBe(true);
  f.reset("all-stopped"); expect(available(await b.readWorkspaces()).every(w => w.runtime.status === "stopped")).toBe(true);
  const invalidations: B.Invalidation[] = []; b.subscribeInvalidation(event => invalidations.push(event));
  f.fail("readCredentials", { kind: "unauthorized", message: "private upstream message" }); expect((await b.readCredentials()).status).toBe("unavailable");
  expect(f.snapshot().authenticated).toBe(false); expect(invalidations.at(-1)).toMatchObject({ scope: "authentication", reason: "unauthorized" });
  expect((await b.readWorkspaces()).status).toBe("unavailable");
});

test("workspace invalidation is scoped: stopping A cannot discard pending management of B", async () => {
  const f = createSyntheticBackend(); f.hold("renameWorkspace");
  const pending = f.backend.renameWorkspace({ workspaceId: "notes", displayName: "Independent B" });
  completed(await f.backend.stopWorkspace("atlas")); f.settle("renameWorkspace");
  expect(completed(await pending).displayName).toBe("Independent B");
  f.reset("credentials"); const b = f.backend;
  const original = authAssignment("atlas", token.id);
  completed(await b.assignCredential({ assignment: authAssignment("atlas", "ssh-open"), replace: true }));
  expect(available(await b.readWorkspace("atlas")).credentialRestartRequired).toBe(true);
  completed(await b.assignCredential({ assignment: original, replace: true }));
  expect(available(await b.readWorkspace("atlas")).credentialRestartRequired).toBe(false);
});

test("explicit credential facts distinguish protection, lock, user ID and unknown/not-applicable", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  expect(available(await b.readCredentialFacts(ssh))).toEqual({ id: ssh.id, type: "ssh", protection: { status: "known", value: "protected" }, lock: { status: "known", value: "locked" }, userId: { status: "not-applicable" } });
  const open = { id: "ssh-open", type: "ssh" } as const;
  completed(await b.lockSsh(open)); expect(available(await b.readCredentialFacts(open))).toMatchObject({ protection: { value: "unprotected" }, lock: { value: "locked" } });
  completed(await b.unlockCredential({ target: open, passphrase: "" })); expect(available(await b.readCredentialFacts(open))).toMatchObject({ protection: { value: "unprotected" }, lock: { value: "unlocked" } });
  expect(available(await b.readCredentialFacts(token))).toEqual({ id: token.id, type: "token", protection: { status: "not-applicable" }, lock: { status: "not-applicable" }, userId: { status: "not-applicable" } });
  expect(available(await b.readCredentialFacts(pgp))).toMatchObject({ userId: { status: "known", value: "Review signer <review@mock.invalid>" } });
  f.setOpenPgpUserId(pgp.id, null); expect(available(await b.readCredentialFacts(pgp))).toMatchObject({ userId: { status: "unknown" } });
  f.setCredentialFactsUnknown(ssh.id, true); expect(available(await b.readCredentialFacts(ssh))).toMatchObject({ protection: { status: "unknown" }, lock: { status: "unknown" } });
  // Readiness prose is still present; the explicit unknown result wins.
  expect(f.inspect().credentials.find(c => c.id === ssh.id)!.readiness.some(r => r.message.includes("locked"))).toBe(true);
  f.setCredentialFactsUnknown(ssh.id, false); expect(available(await b.readCredentialFacts(ssh))).toMatchObject({ lock: { value: "locked" } });
  const generated = completed(await b.generateOpenPgp({ name: "Named signer", userId: "Public review user", passphrase: "disposable" }));
  expect(available(await b.readCredentialFacts({ id: generated.id, type: "openpgp" }))).toMatchObject({ userId: { status: "known", value: "Public review user" } });
  const imported = completed(await b.importOpenPgp({ name: "Unknown imported user", source: { kind: "paste", text: "opaque synthetic import" } }));
  expect(available(await b.readCredentialFacts({ id: imported.id, type: "openpgp" }))).toMatchObject({ userId: { status: "unknown" } });
});

test("saved tool configuration is independent of effective path and detection availability", async () => {
  const f = createSyntheticBackend(); const b = f.backend;
  expect(available(await b.readToolConfiguration("git"))).toEqual({ tool: "git", savedOverride: { status: "known", value: null } });
  expect(completed(await b.testTool("git")).path).toBe("/synthetic/bin/git");
  completed(await b.setToolOverride({ tool: "git", path: "/synthetic/bin/custom-git" })); f.setToolState("git", "missing");
  expect(available(await b.readToolConfiguration("git"))).toMatchObject({ savedOverride: { status: "known", value: "/synthetic/bin/custom-git" } });
  f.setToolConfigurationUnknown("git", true); expect(available(await b.readToolConfiguration("git"))).toMatchObject({ savedOverride: { status: "unknown" } });
  f.reset(); expect(available(await b.readToolConfiguration("git"))).toMatchObject({ savedOverride: { value: null } });
});

test("one clone attempt id is idempotent while pending and after acceptance", async () => {
  const f = createSyntheticBackend(); const b = f.backend; const intent = cloneIntent(); f.hold("submitClone");
  const first = b.submitClone(intent); const duplicate = b.submitClone(intent);
  expect(available(await b.reconcileCloneAttempt({ attemptId: intent.attemptId }))).toEqual({ status: "pending" });
  expect(f.inspect().jobs).toHaveLength(0); f.settle("submitClone");
  const accepted = completed(await first); expect(completed(await duplicate)).toEqual(accepted); expect(f.inspect().jobs).toHaveLength(1);
  if (accepted.status !== "accepted") throw new Error("Expected admission");
  expect(available(await b.reconcileCloneAttempt({ attemptId: intent.attemptId }))).toEqual(accepted);
  expect(completed(await b.submitClone({ ...intent, folderName: "ignored-retry-change", url: "https://example.com/changed" }))).toEqual(accepted);
  expect(f.inspect().jobs).toHaveLength(1); expect(JSON.stringify(f.inspect())).not.toContain(intent.url);
});

test("lost acceptance before/after effects reconciles authoritatively and never authorizes blind duplicates", async () => {
  const f = createSyntheticBackend(); const b = f.backend; const before = cloneIntent();
  f.fail("submitClone", "indeterminate-before"); expect((await b.submitClone(before)).status).toBe("indeterminate");
  expect(available(await b.reconcileCloneAttempt({ attemptId: before.attemptId }))).toEqual({ status: "not-accepted" });
  f.fail("submitClone", null); expect((await b.submitClone(before)).status).toBe("rejected");
  const after = cloneIntent(); f.fail("submitClone", "indeterminate-after"); expect((await b.submitClone(after)).status).toBe("indeterminate");
  const accepted = available(await b.reconcileCloneAttempt({ attemptId: after.attemptId })); expect(accepted.status).toBe("accepted");
  if (accepted.status !== "accepted") throw new Error("Expected admission");
  expect(f.inspect().jobs).toHaveLength(1); f.fail("submitClone", null); expect(completed(await b.submitClone(after))).toEqual(accepted);
  if (accepted.status === "accepted") { f.finishClone(accepted.jobId, "cancelled"); f.expireClone(accepted.jobId); }
  expect(available(await b.reconcileCloneAttempt({ attemptId: after.attemptId }))).toEqual({ status: "expired" });
  expect((await b.submitClone(after)).status).toBe("rejected");
});

test("unknown-attempt lookup fences delayed admission, and pending expiry cannot later create work", async () => {
  const f = createSyntheticBackend(); const b = f.backend; const unseen = cloneIntent();
  expect(available(await b.reconcileCloneAttempt({ attemptId: unseen.attemptId }))).toEqual({ status: "not-accepted" });
  expect((await b.submitClone(unseen)).status).toBe("rejected"); expect(f.inspect().jobs).toHaveLength(0);
  const intent = cloneIntent(); f.hold("submitClone"); const pending = b.submitClone(intent);
  f.expireCloneAttempt(intent.attemptId); expect(available(await b.reconcileCloneAttempt({ attemptId: intent.attemptId }))).toEqual({ status: "expired" });
  f.settle("submitClone"); expect((await pending).status).toBe("rejected"); expect(f.inspect().jobs).toHaveLength(0);
});

test("attempt lookup unavailability/reset/auth changes never masquerade as not-accepted", async () => {
  const f = createSyntheticBackend(); const b = f.backend; const intent = cloneIntent(); f.hold("submitClone"); const pending = b.submitClone(intent);
  f.fail("reconcileCloneAttempt", { kind: "unavailable", message: "ignored" }); expect((await b.reconcileCloneAttempt({ attemptId: intent.attemptId })).status).toBe("unavailable");
  f.fail("reconcileCloneAttempt", null); f.reset(); expect((await pending).status).toBe("rejected");
  expect((await b.reconcileCloneAttempt({ attemptId: intent.attemptId })).status).toBe("unavailable"); expect((await b.submitClone(intent)).status).toBe("rejected");
  const next = cloneIntent(); const accepted = completed(await b.submitClone(next)); completed(await b.signOut()); completed(await b.signIn({ user: "reviewer", password: "review-only" }));
  expect((await b.reconcileCloneAttempt({ attemptId: next.attemptId })).status).toBe("unavailable");
  if (accepted.status === "accepted") { expect((await b.cancelClone(accepted.jobId)).status).toBe("rejected"); const events: B.CloneStreamEvent[] = []; b.subscribeClone({ jobId: accepted.jobId, afterEventId: 0 }, e => events.push(e)); expect(events[0]).toMatchObject({ type: "unavailable" }); }
});
