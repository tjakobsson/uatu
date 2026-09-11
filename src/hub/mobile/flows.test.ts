import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { mountMobileHub } from "./frontend";
import { privateKeySource } from "./credential-flows";
import { assignmentIntent } from "./workspace-flows";
import { sharedUidKey } from "./flow-ui";
import { validateCloneDraft, emptyCloneDraft, cloneCredentialCompatible } from "./clone-flow";
import type { CloneStreamEvent, Invalidation, MobileHubBackend, OperationResult, ReadResult, WorkspaceView } from "./backend";
import type { PublicCredentialDto } from "../credential-types";

const descriptors = new Map(["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let document: Document, current: Element | null, cleanup: (() => void) | undefined;
let testIndex = 0;
beforeEach(() => {
  testIndex++;
  const dom = parseHTML('<html><body><div id="hub"></div></body></html>');
  document = dom.document as unknown as Document; current = null;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => current });
  dom.window.HTMLElement.prototype.focus = function () { current = this as unknown as Element; };
  const storage = new Map<string, string>();
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } } });
  const session = new Map<string, string>();
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); }, removeItem: (key: string) => { session.delete(key); } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
});
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});
const available = <T,>(value: T): ReadResult<T> => ({ status: "available", value });
const completed = <T,>(value: T): OperationResult<T> => ({ status: "completed", value });
const w = (id = "a", running = false): WorkspaceView => ({ id, displayName: `Workspace ${id}`, path: `/projects/${id}`, backend: "local", runtime: running ? { status: "running", shells: { status: "ready", value: [] } } : { status: "stopped" }, branch: { kind: "named", name: "topic" }, assignments: [], workspaceApiRevision: 1, credentialRestartRequired: false });
const ssh = (): PublicCredentialDto => ({ id: "ssh", type: "ssh", name: "SSH identity", enabled: true, createdAt: "2026-01-01T00:00:00Z", capabilities: ["ssh-authentication", "ssh-signing"], metadata: { publicKey: "ssh-ed25519 synthetic", fingerprint: "SHA256:synthetic" }, assignments: [], readiness: [{ layer: "credential", status: "ready", message: "Available" }] });
const pgp = (): PublicCredentialDto => ({ id: "pgp", type: "openpgp", name: "Signing identity", enabled: true, createdAt: "2026-01-01T00:00:00Z", capabilities: ["openpgp-signing"], metadata: { publicKey: "PUBLIC", fingerprint: "PGP:SYNTHETIC" }, assignments: [], readiness: [] });
const token = (): PublicCredentialDto => ({ id: "token", type: "token", name: "Provider identity", enabled: true, createdAt: "2026-01-01T00:00:00Z", capabilities: ["https-git", "github-cli"], metadata: { host: "git.example.invalid" }, assignments: [], readiness: [] });
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const facts = (root: ParentNode) => [...root.querySelectorAll("dt")].map(dt => [dt.textContent, dt.nextElementSibling?.textContent]);
function harness(overrides: Partial<MobileHubBackend> = {}) {
  const calls: Array<{ operation: string; args: unknown[] }> = [], opens: string[] = [];
  let invalidate: (event: Invalidation) => void = () => {};
  let stream: (event: CloneStreamEvent) => void = () => {};
  const methods: Partial<MobileHubBackend> = {
    readAuthentication: async () => available({ status: "authenticated", identity: { user: `reviewer-${testIndex}`, host: "hub.invalid", version: "test" } }),
    readCredentials: async () => available([ssh(), pgp(), token()]), readWorkspaces: async () => available([w()]), readWorkspace: async id => available(w(id)),
    readCredentialFacts: async target => available(target.type === "token" ? { ...target, type: "token", protection: { status: "not-applicable" }, lock: { status: "not-applicable" }, userId: { status: "not-applicable" } } : target.type === "ssh" ? { ...target, type: "ssh", protection: { status: "unknown" }, lock: { status: "unknown" }, userId: { status: "not-applicable" } } : { ...target, type: "openpgp", protection: { status: "unknown" }, lock: { status: "unknown" }, userId: { status: "unknown" } }),
    readToolConfiguration: async tool => available({ tool, savedOverride: { status: "known", value: null } }),
    reconcileCloneAttempt: async () => ({ status: "unavailable", problem: { kind: "unavailable", message: "Attempt reconciliation unavailable" } }),
    readDevices: async () => available([{ handle: "other", deviceLabel: "Other phone", issuedAt: Date.UTC(2026, 0, 1), current: false }, { handle: "current", deviceLabel: "This phone", issuedAt: Date.UTC(2026, 0, 2), current: true }]),
    readDefaultFolder: async () => available({ configured: "/projects", configuredAvailable: true, effective: "/projects" }),
    readTools: async () => available([{ tool: "git", path: "/usr/bin/git", version: "2", results: [{ layer: "binary", status: "ready", message: "Binary available" }], guidance: null }]),
    browseFolders: async path => available(path === "/" ? { path: "/", parent: null, directories: [{ name: "projects", git: false, registration: { status: "unregistered" } }] } : path === "/projects/a" ? { path, parent: "/projects", directories: [] } : { path: "/projects", parent: "/", directories: [{ name: "a", git: true, registration: { status: "unregistered" } }] }),
    subscribeInvalidation: fn => { invalidate = fn; return () => {}; },
    subscribeClone: (_intent, fn) => { stream = fn; return () => {}; },
    ...overrides,
  };
  const backend = new Proxy(methods, { get: (object, key) => (...args: unknown[]) => {
    calls.push({ operation: String(key), args });
    const method = Reflect.get(object, key); if (!method) throw new Error(`Unhandled backend operation ${String(key)}`);
    return method(...args);
  } }) as MobileHubBackend;
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace: id => opens.push(id), returnToWorkspace: id => opens.push(id), setRoute: () => {} }); cleanup = ui.destroy;
  const region = () => root.querySelector<HTMLElement>(".mh-sheet") ?? root.querySelector<HTMLElement>(".mh-flow-page:not([hidden])") ?? root;
  const click = (key: string) => {
    const button = [...region().querySelectorAll<HTMLButtonElement>("button")].find(b => b.dataset.flow === key || b.dataset.action === key);
    if (!button) throw new Error(`Missing flow action ${key} in ${region().textContent}`);
    button.focus(); button.click();
  };
  const input = (name: string) => region().querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  // Follow the visible hierarchy; do not dispatch hidden commands directly.
  const chooseKey = (type: "ssh" | "pgp", operation: "generate" | "import") => { click(type === "ssh" ? "ssh" : "openpgp"); click(`${type}-${operation}`); };
  const set = (name: string, value: string) => {
    const element = input(name); if (!element) throw new Error(`Missing input ${name}`);
    if (element.tagName === "SELECT") Object.defineProperty(element, "value", { configurable: true, writable: true, value }); else element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  return { root, ui, click, chooseKey, input, set, calls, opens, region, invalidate: (e: Invalidation) => invalidate(e), stream: (e: CloneStreamEvent) => stream(e), mutations: (name: string) => calls.filter(c => c.operation === name) };
}

test("Create Workspace keeps one prominent configure command after canceling its editor", async () => {
  const h = harness(); await h.ui.ready;
  h.ui.showDetail({ kind: "add-workspace" }); await settle();
  h.click("create"); await settle(); h.click("cancel-sheet");
  expect(h.region().querySelectorAll('[data-flow="edit"]')).toHaveLength(1);
  expect(h.region().querySelector('[data-flow="edit"]')?.textContent).toBe("Configure new workspace");
  expect(h.region().querySelector('[data-flow="edit"]')?.classList.contains("mh-commit")).toBe(true);
  expect(h.region().querySelectorAll(".mh-commit")).toHaveLength(1);
  expect(h.region().querySelector("input")).toBeNull();
  h.click("edit");
  expect(h.input("parent").value).toBe("/projects");
  expect(h.region().querySelector('[data-flow="browse"]')?.classList.contains("mh-commit")).toBe(false);
  expect(h.calls.some(call => /^(create|configure)/.test(call.operation))).toBe(false);
});

describe("folder picker current read failures", () => {
  for (const caller of ["default-folder", "add-workspace"] as const) for (const thrown of [false, true]) for (const retry of [false, true]) {
    test(`${caller} restores its editor draft after ${thrown ? "thrown" : "denied"} folder read${retry ? " and Retry" : ""}`, async () => {
      const h = harness({ browseFolders: async () => {
        if (thrown) throw new Error("Denied");
        return { status: "unavailable", problem: { kind: "unavailable", message: "Denied folder" } };
      } }); await h.ui.ready;
      h.ui.showDetail({ kind: caller }); await settle();
      if (caller === "default-folder") { h.click("edit"); h.set("path", "/typed-draft"); }
      else { h.click("create"); await settle(); h.set("parent", "/typed-draft"); h.set("folderName", "new-folder"); h.set("displayName", "My draft"); }
      h.click("browse"); await settle();
      expect(h.region().querySelector(".mh-folder-error")).not.toBeNull();
      if (retry) { h.click("retry"); await settle(); }
      h.click("cancel-sheet");
      expect(h.input(caller === "default-folder" ? "path" : "parent")?.value).toBe("/typed-draft");
      if (caller === "add-workspace") { expect(h.input("folderName").value).toBe("new-folder"); expect(h.input("displayName").value).toBe("My draft"); }
    });
  }
});

describe("credential flow validation and security", () => {
  test("private key chooses exactly one source and checks 1 MiB before reading", () => {
    let reads = 0;
    const oversized = { name: "key", size: 1024 * 1024 + 1, text: () => { reads++; return Promise.resolve("secret"); } } as File;
    expect(() => privateKeySource(oversized, "")).toThrow("1 MiB"); expect(reads).toBe(0);
    expect(() => privateKeySource(undefined, "")).toThrow("exactly one");
    const file = new File(["synthetic"], "key"); expect(() => privateKeySource(file, "paste")).toThrow("exactly one");
    expect(privateKeySource(file, "")).toEqual({ kind: "file", file }); expect(privateKeySource(undefined, "paste")).toEqual({ kind: "paste", text: "paste" });
  });
  test("SSH generation submits selected purposes with masked and eagerly cleared passphrase", async () => {
    let resolve!: (result: OperationResult<PublicCredentialDto & { type: "ssh" }>) => void;
    const h = harness({ generateSsh: () => new Promise(r => { resolve = r; }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-credential" }); h.chooseKey("ssh", "generate"); h.set("name", "New SSH"); h.set("passphrase", "test-secret");
    expect(h.input("passphrase").type).toBe("password"); h.click("commit-sheet");
    expect(h.input("passphrase").value).toBe("");
    expect(h.mutations("generateSsh")[0]?.args).toEqual([{ name: "New SSH", passphrase: "test-secret", capabilities: ["ssh-authentication"] }]);
    resolve({ status: "rejected", problem: { kind: "unavailable", message: "SSH tool missing" } }); await settle();
    expect(h.region().textContent).toContain("SSH tool missing"); expect(h.input("name").value).toBe("New SSH");
  });
  test("import validation failure clears both sources and does not call backend", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "add-credential" }); h.chooseKey("ssh", "import"); h.set("name", "Imported"); h.set("paste", "secret-key"); h.set("passphrase", "secret-passphrase");
    Object.defineProperty(h.input("file"), "files", { value: [new File(["key"], "key")] });
    h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("exactly one"); expect(h.input("paste").value).toBe(""); expect(h.input("passphrase").value).toBe(""); expect(h.mutations("importSsh")).toHaveLength(0);
  });
  test("OpenPGP and token details expose only applicable operations", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "pgp" }); await settle();
    expect(h.region().querySelector('details, [data-readiness-layer], [data-flow="more"]')).toBeNull();
    expect(h.region().querySelector('[data-flow="unlock"]')).not.toBeNull(); expect(h.region().querySelector('[data-flow="lock"]')).toBeNull();
    h.ui.showDetail({ kind: "credential", id: "token" }); await settle();
    expect(h.region().textContent).toContain("git.example.invalid");
    expect(h.region().querySelector('details, [data-readiness-layer], [data-flow="more"]')).toBeNull();
    expect(h.region().querySelector('[data-flow="unlock"], [data-flow="public"], [data-flow="lock"]')).toBeNull();
    expect(h.region().querySelector('input[type="password"]')).toBeNull();
  });
  for (const type of ["ssh", "openpgp"] as const) for (const lock of ["locked", "unlocked"] as const) test(`${type} ${lock} has only state-appropriate direct key actions`, async () => {
    const id = type === "ssh" ? "ssh" : "pgp";
    const h = harness({ readCredentialFacts: async () => available(type === "ssh"
      ? { id, type, protection: { status: "known", value: "protected" }, lock: { status: "known", value: lock }, userId: { status: "not-applicable" } }
      : { id, type, protection: { status: "known", value: "protected" }, lock: { status: "known", value: lock }, userId: { status: "unknown" } }) });
    await h.ui.ready; h.ui.showDetail({ kind: "credential", id }); await settle();
    expect(h.region().querySelector('details, [data-flow="more"], [data-readiness-layer]')).toBeNull();
    expect(h.region().querySelectorAll('[data-flow="unlock"]')).toHaveLength(lock === "locked" ? 1 : 0);
    expect(h.region().querySelectorAll('[data-flow="lock"]')).toHaveLength(type === "ssh" && lock === "unlocked" ? 1 : 0);
    for (const key of ["public", "test", "defaults", "toggle", "delete"]) expect(h.region().querySelectorAll(`[data-flow="${key}"]`)).toHaveLength(1);
  });
  test("OpenPGP generation/import and provider token creation carry exact supported intent", async () => {
    const h = harness({ generateOpenPgp: async () => completed(pgp() as PublicCredentialDto & { type: "openpgp" }), importOpenPgp: async () => completed(pgp() as PublicCredentialDto & { type: "openpgp" }), createToken: async () => completed(token() as PublicCredentialDto & { type: "token" }) });
    await h.ui.ready; h.ui.showDetail({ kind: "add-credential" }); h.chooseKey("pgp", "generate"); h.set("name", "Signer"); h.set("userId", "Signer <signer@example.invalid>"); h.set("passphrase", "disposable"); h.click("commit-sheet"); await settle();
    expect(h.mutations("generateOpenPgp")[0]?.args).toEqual([{ name: "Signer", userId: "Signer <signer@example.invalid>", passphrase: "disposable" }]);
    h.ui.showDetail({ kind: "add-credential" }); h.chooseKey("pgp", "import"); h.set("name", "Imported signer"); h.set("paste", "synthetic-private-key"); h.click("commit-sheet"); await settle();
    expect(h.mutations("importOpenPgp")[0]?.args).toEqual([{ name: "Imported signer", source: { kind: "paste", text: "synthetic-private-key" } }]);
    h.ui.showDetail({ kind: "add-credential" }); h.click("token"); h.set("name", "Provider"); h.set("host", "git.example.invalid"); h.set("username", "git-user"); h.set("token", "synthetic-token");
    h.region().querySelector<HTMLInputElement>('[name="cap"][value="github-cli"]')!.setAttribute("checked", "");
    h.click("commit-sheet"); await settle();
    expect(h.mutations("createToken")[0]?.args).toEqual([{ name: "Provider", host: "git.example.invalid", username: "git-user", token: "synthetic-token", capabilities: ["https-git", "github-cli"] }]);
    expect(h.root.textContent).not.toContain("synthetic-token");
  });
  test("public-key reads and readiness tests render authoritative public data and layers", async () => {
    let checks = 0;
    const h = harness({ readPublicKey: async () => available({ id: "ssh", type: "ssh", publicKey: "ssh-ed25519 public-only", fingerprint: "SHA256:public" }), testCredential: async () => { checks++; return completed([{ layer: "binary", status: "ready", message: "Binary found" }, { layer: "runtime", status: "unavailable", message: "Agent unavailable" }]); } });
    await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "ssh" }); await settle(); h.click("public"); await settle();
    expect(h.region().querySelector(".mh-public-key")?.textContent).toBe("ssh-ed25519 public-only"); expect(h.region().querySelector('[data-flow="download"]')).not.toBeNull(); h.click("cancel-sheet"); h.click("test"); await settle();
    expect(h.region().querySelector('[data-readiness-layer]')).toBeNull(); h.click("diagnostics");
    expect(h.region().querySelector('[data-readiness-layer="runtime"] small')?.textContent).toBe("Agent unavailable");
    expect(h.region().querySelector('[data-readiness-layer="runtime"]')?.getAttribute("data-readiness-status")).toBe("unavailable");
    expect(h.region().querySelector('[data-readiness-layer="binary"]')?.getAttribute("data-readiness-status")).toBe("ready");
    expect(h.region().querySelector('[data-readiness-layer="binary"] small')?.textContent).toBe("Binary found");
    h.click("cancel-sheet");
    expect(h.region().textContent).toContain("Check Results");
    expect(h.region().querySelector('[data-readiness-layer]')).toBeNull();
    expect(checks).toBe(1);
    h.click("cancel-sheet");
    expect(h.region().querySelector('[data-flow="test"]')).not.toBeNull();
    expect(checks).toBe(1);
  });
  test("a delayed public-key response cannot open a modal over the foreground workspace", async () => {
    let resolve!: (value: Awaited<ReturnType<MobileHubBackend["readPublicKey"]>>) => void;
    const h = harness({ readPublicKey: () => new Promise(r => { resolve = r; }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "credential", id: "ssh" }); await settle(); h.click("public"); h.root.hidden = true; h.root.inert = true;
    resolve(available({ id: "ssh", type: "ssh", publicKey: "public-only", fingerprint: "public" })); await settle();
    expect(h.root.querySelector(".mh-sheet")).toBeNull();
  });
  test("provider disable asks before stop consent and cancellation leaves mutation at ask", async () => {
    const h = harness({ disableCredential: async intent => intent.stop === "ask" ? completed({ status: "needs-stop", workspaceIds: ["a"] }) : completed({ status: "completed", value: token() }) });
    await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "token" }); await settle(); h.click("toggle");
    expect(h.region().getAttribute("role")).toBe("alertdialog");
    expect(h.region().textContent).toContain("Current assignment rows do not identify"); h.click("cancel-sheet"); expect(h.mutations("disableCredential")).toHaveLength(0);
    h.click("toggle"); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("terminates their shells"); h.click("cancel-sheet");
    expect(h.mutations("disableCredential").map(c => c.args[0])).toEqual([{ target: { id: "token", type: "token" }, stop: "ask" }]);
  });
  test("delete assignment consent is explicit and failed stop never executes another catalog operation", async () => {
    const c = { ...token(), assignments: [{ workspaceId: "a", credentialId: "token", role: "authentication" as const, host: "git.example.invalid" }] };
    const h = harness({ readCredentials: async () => available([c]), deleteCredential: async intent => intent.stop === "ask" ? completed({ status: "needs-stop", workspaceIds: ["a"] }) : { status: "rejected", problem: { kind: "unavailable", message: "Stop failed; catalog unchanged" } } });
    await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "token" }); await settle();
    expect(h.region().querySelectorAll('[data-flow="delete"]')).toHaveLength(1);
    expect(h.region().querySelector('[data-flow="delete"]')?.classList.contains("mh-destructive")).toBe(true);
    h.click("delete"); h.click("commit-sheet"); await settle();
    expect(h.mutations("deleteCredential")).toHaveLength(0); h.input("unassign").checked = true; h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("catalog unchanged");
    expect(h.mutations("deleteCredential").map(c => (c.args[0] as { stop: string }).stop)).toEqual(["ask", "stop-dependent-workspaces"]);
  });
  test("tool override does not mislabel detected path as saved override and rejects relative paths", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "tools" }); await settle(); h.click("tool-git"); h.click("override-git"); await settle();
    expect(h.input("path").value).toBe(""); expect(h.region().textContent).toContain("No saved override");
    h.set("path", "git"); h.click("commit-sheet"); await settle(); expect(h.region().textContent).toContain("absolute path"); expect(h.mutations("setToolOverride")).toHaveLength(0);
  });
  test("SSH lock and disabled-token enable invoke only their supported named operations", async () => {
    const h = harness({ lockSsh: async () => completed(ssh() as PublicCredentialDto & { type: "ssh" }), enableCredential: async () => completed(token()), readCredentials: async () => available([ssh(), { ...token(), enabled: false }]) });
    await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "ssh" }); await settle(); h.click("lock"); await settle();
    expect(h.mutations("lockSsh")[0]?.args).toEqual([{ id: "ssh", type: "ssh" }]); h.ui.showDetail({ kind: "credential", id: "token" }); await settle(); h.click("toggle"); await settle();
    expect(h.mutations("enableCredential")[0]?.args).toEqual([{ id: "token", type: "token" }]);
  });
  test("shared-UID key matches existing per-user UTF8/base64url owner", () => {
    expect(sharedUidKey("å@example.invalid")).toBe(`uatu.hub.notice.shared-uid-v1:${Buffer.from("å@example.invalid").toString("base64url")}`);
  });
  test("shared-UID dismissal in Settings applies to Clone for the same authenticated user", async () => {
    const h = harness(); await h.ui.ready; h.ui.show("settings"); expect(h.root.querySelector("[data-shared-uid]")).not.toBeNull(); h.click("dismiss-advisory");
    h.ui.showDetail({ kind: "clone" }); await settle(); expect(h.region().querySelector("[data-shared-uid]")).toBeNull();
  });
});

describe("assignment, workspace and account flows", () => {
  test("Add authentication host cannot alter signing and reviews host replacement before applying", async () => {
    const workspace = { ...w(), assignments: [{ workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "git.example.invalid" }, { workspaceId: "a", credentialId: "pgp", role: "signing" as const }] };
    const h = harness({ readWorkspaces: async () => available([workspace]), assignWorkspace: async () => completed([]) }); await h.ui.ready;
    h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-a"); await settle();
    expect(h.region().textContent).toContain("Edit workspace credentials"); h.click("new-a");
    expect(h.region().textContent).toContain("Add authentication host"); expect(h.region().querySelector('[name="signing"]')).toBeNull();
    h.set("authentication", "token"); h.set("host", "git.example.invalid"); h.click("commit-sheet"); await settle();
    expect(facts(h.region())).toContainEqual(["Change on apply", "Replace credential"]); expect(h.mutations("assignWorkspace")).toHaveLength(0);
    h.click("cancel-sheet"); expect(h.input("authentication").value).toBe("token"); expect(h.region().querySelector('[name="signing"]')).toBeNull();
    h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.mutations("assignWorkspace")[0]?.args).toEqual([{ workspaceId: "a", mode: "assign-new", selection: { authentication: { credentialId: "token", host: "git.example.invalid" } } }]);
  });
  test("signing row opens removal confirmation directly and cancel does not remove", async () => {
    const workspace = { ...w(), assignments: [{ workspaceId: "a", credentialId: "pgp", role: "signing" as const }] };
    const h = harness({ readWorkspaces: async () => available([workspace]) }); await h.ui.ready;
    h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-a"); await settle();
    expect(h.region().textContent).toContain("Remove signing assignment"); h.click("remove-a-0"); expect(h.region().textContent).toContain("Remove assignment?");
    expect(h.mutations("removeAssignment")).toHaveLength(0); h.click("cancel-sheet"); expect(h.mutations("removeAssignment")).toHaveLength(0);
  });
  test("dual role current edit computes no-op and changes only requested roles/hosts", () => {
    const workspace = { ...w(), assignments: [{ workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "git.invalid" }, { workspaceId: "a", credentialId: "pgp", role: "signing" as const }] };
    expect(assignmentIntent(workspace, "edit-current", { authentication: "ssh", host: "git.invalid", signing: "pgp" })).toBeNull();
    expect(assignmentIntent(workspace, "assign-new", { authentication: "token", host: "other.invalid", signing: "ssh" })).toEqual({ workspaceId: "a", mode: "assign-new", selection: { authentication: { credentialId: "token", host: "other.invalid" }, signing: { credentialId: "ssh" } } });
    expect(assignmentIntent(workspace, "edit-current", { authentication: "", host: "", signing: "ssh" })?.selection).toEqual({ signing: { credentialId: "ssh" } });
  });
  test("assignment Review/back preserves both roles and host; cancel makes no mutation", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-a"); await settle(); h.click("edit-a");
    expect(h.input("host").disabled).toBe(true); h.set("authentication", "ssh"); expect(h.input("host").disabled).toBe(false); h.set("host", "git.invalid"); h.set("signing", "pgp"); h.click("commit-sheet"); await settle();
    expect(facts(h.region())).toContainEqual(["Host", "git.invalid"]); expect(facts(h.region())).toContainEqual(["After applying", "Signing identity"]); expect(h.region().querySelector('[data-flow="back"]')).toBeNull(); h.click("cancel-sheet");
    expect(h.input("authentication").value).toBe("ssh"); expect(h.input("signing").value).toBe("pgp"); expect(h.input("host").value).toBe("git.invalid"); h.click("cancel-sheet");
    expect(h.mutations("assignWorkspace")).toHaveLength(0);
  });
  test("current assignments initialize truthfully, no-op performs no operation, Apply is dual-role", async () => {
    const workspace = { ...w(), assignments: [{ workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "old.invalid" }, { workspaceId: "a", credentialId: "pgp", role: "signing" as const }] };
    const h = harness({ readWorkspaces: async () => available([workspace]), assignWorkspace: async () => completed([]) }); await h.ui.ready; h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-a"); await settle(); h.click("edit-a");
    expect(h.input("authentication").value).toBe("ssh"); expect(h.input("host").value).toBe("old.invalid"); expect(h.input("signing").value).toBe("pgp"); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("No changes"); expect(h.mutations("assignWorkspace")).toHaveLength(0);
    h.set("authentication", "token"); h.set("host", "git.example.invalid"); h.set("signing", "ssh"); h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.mutations("assignWorkspace")[0]?.args).toEqual([{ workspaceId: "a", mode: "edit-current", selection: { authentication: { credentialId: "token", host: "git.example.invalid" }, signing: { credentialId: "ssh" } } }]);
  });
  test("review canonicalizes only explicit input, preserves draft and replaces a canonical existing host only on Apply", async () => {
    const workspace = { ...w(), assignments: [{ workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "git.example.invalid" }, { workspaceId: "a", credentialId: "pgp", role: "signing" as const }] };
    const h = harness({ readWorkspaces: async () => available([workspace]), assignWorkspace: async () => completed([]) }); await h.ui.ready;
    h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-a"); await settle(); h.click("edit-a");
    expect(h.input("host").value).toBe("git.example.invalid"); expect(h.mutations("assignWorkspace")).toHaveLength(0);
    h.set("host", "Git.Example.Invalid."); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("No changes"); expect(h.mutations("assignWorkspace")).toHaveLength(0);
    h.set("authentication", "token"); h.set("host", "https://Git.Example.Invalid/"); h.set("signing", ""); h.click("commit-sheet"); await settle();
    expect(h.region().querySelector("h1")?.textContent).toBe("Review changes");
    expect(facts(h.region())).toContainEqual(["Current", "SSH identity"]); expect(facts(h.region())).toContainEqual(["After applying", "Provider identity"]);
    expect(facts(h.region())).toContainEqual(["Change on apply", "Replace credential"]); expect(facts(h.region())).toContainEqual(["Change on apply", "Keep current"]);
    expect(facts(h.region())).toContainEqual(["After applying", "Signing identity"]);
    expect(h.region().querySelector('[data-action="commit-sheet"]')?.textContent).toBe("Apply and replace"); expect(h.mutations("assignWorkspace")).toHaveLength(0);
    h.click("cancel-sheet"); expect(h.input("host").value).toBe("https://Git.Example.Invalid/"); expect(h.input("signing").value).toBe("");
    h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.mutations("assignWorkspace").map(c => c.args)).toEqual([[{ workspaceId: "a", mode: "edit-current", selection: { authentication: { credentialId: "token", host: "git.example.invalid" } } }]]);
  });
  test("changing authentication host adds without removing the previous host and leaves unselected signing unchanged", async () => {
    const workspace = { ...w(), assignments: [{ workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "old.invalid" }, { workspaceId: "a", credentialId: "pgp", role: "signing" as const }] };
    const h = harness({ readWorkspaces: async () => available([workspace]), assignWorkspace: async () => completed([]) }); await h.ui.ready;
    h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-a"); await settle(); h.click("edit-auth-a-0");
    h.set("host", "https://New.Invalid/"); h.set("signing", ""); h.click("commit-sheet"); await settle();
    const rows = facts(h.region()); expect(rows).toContainEqual(["Host", "old.invalid"]); expect(rows).toContainEqual(["Host", "new.invalid"]);
    expect(rows).toContainEqual(["After applying", "SSH identity"]); expect(rows).toContainEqual(["After applying", "Signing identity"]);
    expect(h.region().textContent).toContain("Existing hosts will stay unchanged."); expect(h.region().querySelector('[data-action="commit-sheet"]')?.textContent).toBe("Apply");
    expect(h.mutations("assignWorkspace")).toHaveLength(0); h.click("commit-sheet"); await settle();
    expect(h.mutations("assignWorkspace")[0]?.args).toEqual([{ workspaceId: "a", mode: "edit-current", selection: { authentication: { credentialId: "ssh", host: "new.invalid" } } }]);
    expect(h.mutations("removeAssignment")).toHaveLength(0); expect(workspace.assignments).toHaveLength(2);
  });
  test("workspace identity and assignment facts are labeled without duplicate name headings or lost host actions", async () => {
    const workspace = { ...w(), displayName: "Atlas", assignments: [{ workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "one.invalid" }, { workspaceId: "a", credentialId: "ssh", role: "authentication" as const, host: "two.invalid" }, { workspaceId: "a", credentialId: "ssh", role: "signing" as const }] };
    const h = harness({ readWorkspaces: async () => available([workspace]), readWorkspace: async () => available(workspace) }); await h.ui.ready;
    h.ui.showDetail({ kind: "workspace", id: "a" }); await settle();
    expect(facts(h.region())).toContainEqual(["Folder", "/projects/a"]); expect(facts(h.region())).toContainEqual(["Status", "stopped"]);
    expect([...h.region().querySelectorAll("h1,h2")].filter(el => el.textContent === "Atlas")).toHaveLength(1);
    expect(facts(h.region())).toContainEqual(["Host", "two.invalid"]); expect(facts(h.region())).toContainEqual(["Credential", "SSH identity"]);
    h.click("assign"); await settle();
    expect([...h.region().querySelectorAll("h1,h2")].filter(el => el.textContent === "Atlas")).toHaveLength(1);
    for (const key of ["edit-auth-a-0", "edit-auth-a-1", "remove-a-0", "remove-a-1", "remove-a-2", "edit-a", "new-a"]) expect(h.region().querySelectorAll(`[data-flow="${key}"]`)).toHaveLength(1);
  });
  test("Devices has one Settings navigation entry, not a second Security command; same-name sessions remain distinct", async () => {
    const h = harness({ readDevices: async () => available([{ handle: "one", deviceLabel: "Phone", issuedAt: 1, current: false }, { handle: "two", deviceLabel: "Phone", issuedAt: 2, current: true }]) }); await h.ui.ready;
    h.ui.show("settings"); await settle(); expect(h.root.querySelectorAll('[data-action="devices"]')).toHaveLength(1);
    h.ui.showDetail({ kind: "security" }); await settle(); expect(h.region().querySelector('[data-flow="devices"]')).toBeNull();
    expect(h.region().querySelectorAll('[data-flow="signout"]')).toHaveLength(1); expect(h.region().querySelector("[data-shared-uid]")).toBeNull();
    expect(h.region().textContent).toContain("Shared Hub account policy"); expect(h.region().textContent).toContain("Login and sessions");
    h.ui.showDetail({ kind: "devices" }); await settle(); expect(h.region().querySelectorAll('[data-flow^="device-"]')).toHaveLength(2);
  });
  test("Stop and Forget confirmation produce distinct effects and named outcomes", async () => {
    let running = true;
    const h = harness({ readWorkspace: async () => available(w("a", running)), stopWorkspace: async () => { running = false; return completed({ status: "stopped" }); }, forgetWorkspace: async () => completed({ status: "forgotten" }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "workspace", id: "a" }); await settle(); h.click("stop"); h.click("commit-sheet"); await settle(); h.click("cancel-sheet"); await settle();
    expect(h.mutations("forgetWorkspace")).toHaveLength(0); h.click("forget"); expect(h.region().textContent).toContain("not files on disk"); h.click("commit-sheet"); await settle();
    expect(h.mutations("stopWorkspace")[0]?.args).toEqual(["a"]); expect(h.mutations("forgetWorkspace")[0]?.args).toEqual(["a"]); expect(h.region().textContent).toContain("files were not deleted");
  });
  test("workspace rename affects display name only and Stop/Forget remain separate", async () => {
    const h = harness({ renameWorkspace: async intent => completed({ ...w(), displayName: intent.displayName }), readWorkspace: async () => available(w("a", true)) }); await h.ui.ready;
    h.ui.showDetail({ kind: "workspace", id: "a" }); await settle();
    expect(h.region().querySelector('[data-flow="more"], [data-flow="forget"]')).toBeNull(); h.click("rename"); h.set("name", "Renamed"); h.click("commit-sheet"); await settle();
    expect(h.mutations("renameWorkspace")[0]?.args).toEqual([{ workspaceId: "a", displayName: "Renamed" }]);
    h.click("stop"); expect(h.region().textContent).toContain("shells will be terminated"); h.click("cancel-sheet"); expect(h.mutations("stopWorkspace")).toHaveLength(0);
  });
  test("device labels use issued time and current revoke invalidates protected content", async () => {
    const h = harness({ revokeDevice: async handle => completed({ status: "revoked", current: handle === "current" }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "devices" }); await settle(); expect(h.region().textContent).toContain("Issued"); expect(h.region().textContent).not.toContain("Last active");
    h.click("device-1"); expect(h.region().textContent).toContain("Revoke session?"); expect(h.region().textContent).toContain("does not stop workspaces"); expect(h.mutations("revokeDevice")).toHaveLength(0); h.click("cancel-sheet"); expect(h.mutations("revokeDevice")).toHaveLength(0); h.click("device-1"); h.click("commit-sheet"); await settle(); expect(h.root.textContent).toContain("Sign in required"); expect(h.root.textContent).not.toContain("hub.invalid");
  });
  test("default folder fallback is explicit; Hub home is a cancellable draft saved as null", async () => {
    const h = harness({ readDefaultFolder: async () => available({ configured: "/missing", configuredAvailable: false, effective: "/home/reviewer" }), setDefaultFolder: async () => completed({ configured: null, configuredAvailable: false, effective: "/home/reviewer" }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "default-folder" }); await settle(); expect(h.region().textContent).toContain("Saved Folder/missing"); expect(h.region().textContent).toContain("Currently Using/home/reviewer"); expect(h.region().querySelector('[data-flow="more"]')).toBeNull();
    h.click("edit"); h.click("use-home"); expect(h.region().querySelector('.mh-destructive')).toBeNull(); expect(h.mutations("setDefaultFolder")).toHaveLength(0);
    h.click("cancel-sheet"); expect(h.region().querySelector("input")).toBeNull(); h.click("edit"); expect(h.input("path").value).toBe("/missing");
    h.click("use-home"); h.click("commit-sheet"); await settle(); expect(h.mutations("setDefaultFolder")[0]?.args).toEqual([null]);
  });
  test("unset Default Folder has one grouped editor, top Back, current home path and no Clear", async () => {
    const h = harness({ readDefaultFolder: async () => available({ configured: null, configuredAvailable: false, effective: "/home/reviewer" }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "default-folder" }); await settle();
    expect(h.region().querySelectorAll('.mh-group [data-flow="edit"]')).toHaveLength(1);
    expect(h.region().querySelector('.mh-flow-header [data-flow="flow-back"]')).not.toBeNull();
    expect(h.region().querySelector('.mh-flow-toolbar, [data-flow="clear"], [data-flow="more"]')).toBeNull();
    expect(h.region().textContent).toContain("Shared by everyone using this Hub. Existing workspaces aren’t moved.");
    expect(h.region().textContent).toContain("Hub home folder"); expect(h.region().textContent).not.toContain("Currently Using");
    h.click("edit"); expect(h.input("path").value).toBe("/home/reviewer");
    expect(h.region().querySelector('[data-flow="use-home"]')).toBeNull();
    expect(h.region().querySelectorAll('[data-flow="browse"]')).toHaveLength(1);
    h.click("cancel-sheet"); expect(h.mutations("setDefaultFolder")).toHaveLength(0);
  });
});

describe("onboarding and clone lifecycle", () => {
  test("technical inputs preserve saved paths, explain disabled hosts, and do not alter human display-name input policy", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "clone" }); await settle();
    expect(h.input("dest").value).toBe("/projects");
    for (const name of ["url", "dest", "folderName", "host"]) {
      expect(h.input(name).getAttribute("autocapitalize")).toBe("none"); expect(h.input(name).getAttribute("autocorrect")).toBe("off");
    }
    expect(h.input("displayName").getAttribute("autocapitalize")).toBeNull();
    expect(h.input("host").disabled).toBe(true); expect(h.input("host").placeholder).toBe("Select a credential first");
    expect(h.input("host").getAttribute("aria-description")).toContain("Choose a Git authentication credential first");
    expect(h.mutations("submitClone")).toHaveLength(0);
  });
  test("clone review separates one-time identity from named credentials after setup with semantic path and start facts", async () => {
    const h = harness({ submitClone: async () => completed({ status: "accepted", jobId: "job" }) }); await h.ui.ready; h.ui.showDetail({ kind: "clone" }); await settle();
    h.set("url", "git@git.example.invalid:org/repo.git"); h.set("folderName", "checkout"); h.set("displayName", "Readable name"); h.set("cloneCredential", "ssh"); h.set("authentication", "token"); h.set("host", "Git.Example.Invalid."); h.set("signing", "pgp");
    expect(h.mutations("submitClone")).toHaveLength(0); h.click("review"); await settle();
    const rows = facts(h.region()); expect(rows).toContainEqual(["Display name", "Readable name"]); expect(rows).toContainEqual(["Parent folder", "/projects"]); expect(rows).toContainEqual(["Checkout path", "/projects/checkout"]);
    expect(rows).toContainEqual(["Credential", "Provider identity"]); expect(rows).toContainEqual(["Credential", "Signing identity"]); expect(rows).toContainEqual(["Host", "git.example.invalid"]);
    expect(h.region().textContent).toContain("One-time clone identitySSH identity"); expect(h.region().textContent).toContain("Git authentication after setup"); expect(h.mutations("submitClone")).toHaveLength(0);
    h.click("commit-sheet"); await settle();
    const intent = h.mutations("submitClone")[0]?.args[0] as Record<string, unknown>;
    expect(intent).toEqual({ attemptId: expect.any(String), url: "git@git.example.invalid:org/repo.git", dest: "/projects", folderName: "checkout", displayName: "Readable name", credentialId: "ssh", retainedAuthentication: [{ credentialId: "token", host: "git.example.invalid" }], signing: "pgp", start: false });
    h.stream({ type: "job-event", event: { id: 1, type: "result", data: { status: "start-failed", target: "/projects/checkout", workspaceId: "opaque-id", error: "Start unavailable" } } }); await settle();
    expect(facts(h.region())).toContainEqual(["Checkout location", "/projects/checkout"]); expect(h.region().querySelector("[data-clone-primary].mh-commit")).toBeNull();
  });
  test("folder commands have one current-context home and child rows stay compact", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "add-workspace" }); h.click("folders"); await settle();
    for (const key of ["choose", "elsewhere", "create", "workspace", "rename", "remove"]) expect(h.region().querySelectorAll(`[data-flow="${key}"]`)).toHaveLength(1);
    expect(h.region().querySelector('[data-flow="more"], [data-flow^="more-"], details')).toBeNull();
    expect(h.region().querySelectorAll('[data-flow="folder-0"]')).toHaveLength(1);
    h.click("folder-0"); await settle();
    expect(h.region().querySelector('nav[aria-label="Folder location"]')?.textContent).toContain("/projects/a");
    h.click("rename"); await settle(); expect(h.input("name").value).toBe("a");
    expect(h.mutations("renameFolder")).toHaveLength(0);
  });
  test("clone optional configuration stays visible without an accordion", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "clone" }); await settle();
    expect(h.region().querySelector("details, summary")).toBeNull();
    for (const name of ["authentication", "host", "signing", "start"]) expect(h.region().querySelector(`[name="${name}"]`)).not.toBeNull();
  });
  test("Default Folder picker returns to its typed editor from a child; Up is only hierarchy navigation", async () => {
    const h = harness(); await h.ui.ready;
    h.ui.showDetail({ kind: "default-folder" }); await settle();
    expect(h.region().querySelector('[data-flow="more"]')).toBeNull(); expect(h.region().querySelector('[data-flow="browse"]')).toBeNull();
    h.click("edit"); h.set("path", "/typed-draft");
    expect(h.region().querySelectorAll('[data-flow="browse"]')).toHaveLength(1);
    h.click("browse"); await settle(); h.click("folder-0"); await settle();
    expect(h.region().querySelectorAll('[data-flow="up"]')).toHaveLength(1);
    expect(h.region().querySelector('.mh-folder-parent [data-flow="up"]')?.textContent).toBe("projects");
    expect(h.region().querySelector('.mh-folder-parent [data-flow="up"]')?.getAttribute("aria-label")).toBe("Parent folder: /projects");
    expect(h.region().querySelectorAll('header [data-action="cancel-sheet"]')).toHaveLength(1);
    expect(h.region().querySelector('[data-action="cancel-sheet"]')?.textContent).toBe("Cancel");
    h.click("up"); await settle(); expect(h.region().textContent).toContain("/projects");
    h.click("folder-0"); await settle(); h.click("cancel-sheet");
    expect(h.region().querySelector("h1, h2")?.textContent).toBe("Default Folder");
    expect(h.input("path").value).toBe("/typed-draft");
    expect(h.mutations("setDefaultFolder")).toHaveLength(0);
    h.click("cancel-sheet"); expect(h.region().querySelector("h1")?.textContent).toBe("Default Folder");
  });
  test("Create picker cancellation preserves even incomplete configuration without operations or secrets", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "add-workspace" }); h.click("create"); await settle();
    h.set("parent", "/typed-parent"); h.set("folderName", "unfinished/"); h.set("displayName", "Draft name");
    h.set("authentication", "ssh"); h.set("host", ""); h.set("signing", "pgp"); h.input("start").checked = true; h.input("init").checked = true;
    expect(h.region().querySelector('input[type="password"], textarea[data-secret]')).toBeNull();
    h.click("browse"); await settle(); h.click("folder-0"); await settle(); h.click("cancel-sheet");
    expect(h.input("parent").value).toBe("/typed-parent"); expect(h.input("folderName").value).toBe("unfinished/"); expect(h.input("displayName").value).toBe("Draft name");
    expect(h.input("authentication").value).toBe("ssh"); expect(h.input("host").value).toBe(""); expect(h.input("signing").value).toBe("pgp");
    expect(h.input("start").hasAttribute("checked")).toBe(true); expect(h.input("init").hasAttribute("checked")).toBe(true);
    expect(h.mutations("createWorkspace")).toHaveLength(0); expect(h.mutations("createFolder")).toHaveLength(0);
  });
  test("cancel while folders load rejects the late listing and keeps the caller draft", async () => {
    let resolve!: (value: Awaited<ReturnType<MobileHubBackend["browseFolders"]>>) => void;
    const h = harness({ browseFolders: () => new Promise(r => { resolve = r; }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "default-folder" }); await settle(); h.click("edit"); h.set("path", "/draft"); h.click("browse"); h.click("cancel-sheet");
    resolve(available({ path: "/late", parent: "/", directories: [] })); await settle();
    expect(h.input("path").value).toBe("/draft"); h.click("cancel-sheet");
    expect(h.region().querySelector("h1")?.textContent).toBe("Default Folder"); expect(h.region().textContent).not.toContain("/late");
  });
  test("late browse failure cannot replace the restored editor", async () => {
    let reject!: (error: Error) => void;
    const h = harness({ browseFolders: () => new Promise((_resolve, fail) => { reject = fail; }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "default-folder" }); await settle(); h.click("edit"); h.set("path", "/draft"); h.click("browse"); h.click("cancel-sheet");
    reject(new Error("Late failure")); await settle(); expect(h.input("path").value).toBe("/draft");
    h.click("cancel-sheet"); expect(h.region().querySelector("h1")?.textContent).toBe("Default Folder");
  });
  test("management keeps elsewhere and empty-folder transitions; Existing Cancel returns Add Workspace", async () => {
    const h = harness({ createFolder: async () => completed({ path: "/projects/a" }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-workspace" }); h.click("folders"); await settle();
    h.click("elsewhere"); h.set("path", "/projects"); h.click("commit-sheet"); await settle();
    h.click("create"); h.set("name", "a"); h.click("commit-sheet"); await settle(); h.click("flow-back");
    expect(h.region().querySelector("h1")?.textContent).toBe("Add Workspace"); expect(h.mutations("setDefaultFolder")).toHaveLength(0); expect(h.mutations("createWorkspace")).toHaveLength(0);
    h.ui.showDetail({ kind: "add-workspace" }); h.click("existing"); await settle(); h.click("folder-0"); await settle(); h.click("cancel-sheet");
    expect(h.region().querySelector("h1")?.textContent).toBe("Add Workspace");
  });
  test("creating a workspace requires explicit Git init and preserves separate names", async () => {
    const h = harness({ createWorkspace: async () => completed({ status: "configured", result: { entry: { id: "new", path: "/projects/folder", displayName: "Display", backend: "local" }, created: true, alreadyRegistered: false, createdFolder: true, started: false, startError: "Start unavailable" } }) });
    await h.ui.ready; h.ui.showDetail({ kind: "add-workspace" }); h.click("create"); await settle(); h.set("folderName", "folder"); h.set("displayName", "Display"); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("Confirm folder creation"); expect(h.mutations("createWorkspace")).toHaveLength(0);
    h.input("init").checked = true; h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.mutations("createWorkspace")[0]?.args).toEqual([{ parent: "/projects", folderName: "folder", displayName: "Display", authentication: [], signing: null, start: false, gitInitConsent: "confirmed" }]);
    expect(h.region().textContent).toContain("configured workspace remains available");
  });
  test("new workspace fields and review use role labels and catalog names, preserving drafts on Back", async () => {
    const h = harness(); await h.ui.ready; h.ui.showDetail({ kind: "add-workspace" }); h.click("create"); await settle();
    expect(h.region().textContent).toContain("Git authentication"); expect(h.region().textContent).toContain("Commit signing"); expect(h.region().textContent).not.toContain("Retained signing");
    h.set("folderName", "folder"); h.set("displayName", "Display"); h.set("authentication", "token"); h.set("host", "git.example.invalid"); h.set("signing", "pgp"); h.input("init").checked = true;
    h.click("commit-sheet"); await settle(); expect(facts(h.region())).toContainEqual(["Host", "git.example.invalid"]); expect(facts(h.region())).toContainEqual(["Credential", "Provider identity"]); expect(facts(h.region())).toContainEqual(["Credential", "Signing identity"]);
    expect(facts(h.region())).toContainEqual(["Display name", "Display"]); expect(facts(h.region())).toContainEqual(["Parent folder", "/projects"]); expect(facts(h.region())).toContainEqual(["Folder path", "/projects/folder"]); expect(facts(h.region())).toContainEqual(["Git initialization", "Authorized"]); expect(h.mutations("createWorkspace")).toHaveLength(0);
    h.click("cancel-sheet"); expect(h.input("authentication").value).toBe("token"); expect(h.input("signing").value).toBe("pgp"); h.click("cancel-sheet"); expect(h.mutations("createWorkspace")).toHaveLength(0);
  });
  test("empty folder creation is not workspace creation and collision stays contextual", async () => {
    const h = harness({ createFolder: async () => ({ status: "rejected", problem: { kind: "conflict", message: "Folder already exists" } }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-workspace" }); h.click("folders"); await settle(); h.click("create"); h.set("name", "collision"); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("Folder already exists"); expect(h.mutations("createWorkspace")).toHaveLength(0); expect(h.mutations("createFolder")[0]?.args).toEqual([{ parent: "/projects", name: "collision" }]);
  });
  test("existing folder config, multiple retained hosts, and initialization intent remain distinct", async () => {
    const h = harness({ readWorkspaces: async () => available([]), configureExisting: async () => completed({ status: "configured", result: { entry: w(), created: true, alreadyRegistered: false, createdFolder: false, started: false, startError: null } }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-workspace" }); h.click("existing"); await settle(); h.click("folder-0"); await settle(); h.click("choose"); await settle();
    h.set("displayName", "Existing Display"); h.set("authentication", "ssh"); h.set("host", "one.invalid"); h.click("add-auth-host");
    const rows = h.region().querySelectorAll<HTMLElement>("[data-auth-row]");
    Object.defineProperty(rows[1]!.querySelector("select"), "value", { writable: true, value: "token" }); rows[1]!.querySelector<HTMLInputElement>('[name="host"]')!.value = "git.example.invalid";
    h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.mutations("configureExisting")[0]?.args).toEqual([{ path: "/projects/a", displayName: "Existing Display", authentication: [{ credentialId: "ssh", host: "one.invalid" }, { credentialId: "token", host: "git.example.invalid" }], signing: null, init: false, start: false }]);
  });
  test("nested folder rename exposes affected registrations and uses ask then explicit stop consent", async () => {
    const h = harness({ renameFolder: async intent => intent.stop === "ask" ? completed({ status: "needs-stop", workspaceIds: ["a"] }) : completed({ status: "completed", value: { path: "/renamed", workspaceIds: ["a"] } }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-workspace" }); h.click("folders"); await settle(); h.click("rename"); await settle();
    expect(h.region().textContent).toContain("Workspace a"); h.set("name", "renamed"); h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.mutations("renameFolder")).toHaveLength(1); h.click("commit-sheet"); await settle();
    expect(h.mutations("renameFolder").map(c => c.args[0])).toEqual([{ path: "/projects", name: "renamed", stop: "ask" }, { path: "/projects", name: "renamed", stop: "stop-dependent-workspaces" }]);
  });
  test("onboarding partial failure reports retained folder and committed registration without duplicate creation", async () => {
    const h = harness({ createWorkspace: async () => completed({ status: "failed", code: "recovery-required", message: "Journal requires recovery", retainedPath: "/projects/new", committedEntry: w("new") }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-workspace" }); h.click("create"); await settle(); h.set("folderName", "new"); h.set("displayName", "New"); h.input("init").checked = true; h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(h.region().querySelector("dt")?.closest("dl")?.textContent).toContain("/projects/new"); expect(h.region().textContent).toContain("Registration committed"); expect(h.mutations("createWorkspace")).toHaveLength(1);
  });
  test("clone validates separate identity, destination and credential-free remote URL", () => {
    expect(() => validateCloneDraft({ ...emptyCloneDraft(), url: "https://user:secret@git.invalid/repo", dest: "/projects", folderName: "repo", displayName: "Repo" })).toThrow("embed credentials");
    const valid = { ...emptyCloneDraft(), url: "git@git.invalid:team/repo", dest: "/projects", folderName: "checkout", displayName: "Display" };
    expect(validateCloneDraft(valid)).toEqual(valid);
    expect(cloneCredentialCompatible(ssh(), "git+ssh://git@host.invalid/repo")).toBe(true);
    expect(cloneCredentialCompatible(ssh(), "git@[::1]:repo")).toBe(true);
    expect(cloneCredentialCompatible(token(), "https://git.example.invalid/team/repo")).toBe(true);
    expect(cloneCredentialCompatible(token(), "https://another.invalid/team/repo")).toBe(false);
    expect(cloneCredentialCompatible(token(), "http://git.example.invalid/team/repo")).toBe(false);
  });
  async function cloneForm(h: ReturnType<typeof harness>) {
    h.ui.showDetail({ kind: "clone" }); await settle(); h.set("url", "git@git.invalid:team/repo"); h.set("folderName", "checkout"); h.set("displayName", "Display");
  }
  test("separate clone unlock never submits; Settings detour preserves non-secret form", async () => {
    const h = harness({ unlockCredential: async () => completed(ssh() as PublicCredentialDto & { type: "ssh" }) }); await h.ui.ready; await cloneForm(h); h.set("cloneCredential", "ssh"); h.click("unlock"); h.set("passphrase", "synthetic-passphrase"); h.click("commit-sheet"); await settle();
    expect(h.mutations("submitClone")).toHaveLength(0); h.ui.show("settings"); h.ui.showDetail({ kind: "clone" }); await settle(); expect(h.input("url").value).toBe("git@git.invalid:team/repo"); expect(h.input("displayName").value).toBe("Display");
  });
  test("authorized clone unlock continues once and reconnect uses same job/event cursor", async () => {
    let submissions = 0;
    const h = harness({ submitClone: async () => ++submissions === 1 ? completed({ status: "requires-unlock", credential: { type: "ssh", id: "ssh" } }) : completed({ status: "accepted", jobId: "job-1" }), unlockCredential: async () => completed(ssh() as PublicCredentialDto & { type: "ssh" }) });
    await h.ui.ready; await cloneForm(h); h.set("cloneCredential", "ssh"); h.click("review"); h.click("commit-sheet"); await settle();
    h.set("passphrase", "synthetic"); h.click("commit-sheet"); await settle(); expect(submissions).toBe(2);
    h.stream({ type: "job-event", event: { id: 3, type: "output", data: { output: "Cloning synthetic repository\n" } } });
    h.ui.show("settings"); h.stream({ type: "job-event", event: { id: 4, type: "phase", data: { phase: "registering" } } }); h.ui.showDetail({ kind: "clone" }); await settle();
    expect(h.region().textContent).toContain("registering"); h.click("reconnect");
    expect(h.mutations("subscribeClone").at(-1)?.args[0]).toEqual({ jobId: "job-1", afterEventId: 4 }); expect(submissions).toBe(2);
  });
  test("all remote responses are masked/cleared, cancel ack waits for terminal result", async () => {
    const h = harness({ submitClone: async () => completed({ status: "accepted", jobId: "job-2" }), sendCloneInput: async () => completed({ status: "accepted" }), cancelClone: async () => completed({ status: "cancelled" }) });
    await h.ui.ready; await cloneForm(h); h.click("review"); h.click("commit-sheet"); await settle();
    h.stream({ type: "job-event", event: { id: 1, type: "phase", data: { phase: "cloning" } } });
    h.set("response", "synthetic-prompt-answer"); expect(h.input("response").type).toBe("password"); h.click("send"); expect(h.input("response").value).toBe(""); await settle();
    h.click("cancel"); h.click("commit-sheet"); await settle(); expect(h.region().textContent).toContain("Waiting for the terminal result");
    h.stream({ type: "job-event", event: { id: 2, type: "result", data: { status: "succeeded", workspaceId: "new", target: "/projects/checkout", running: false } } });
    expect(h.region().textContent).toContain("registered stopped"); expect(h.region().querySelector('[data-flow="open"]')).toBeNull(); expect(h.opens).toHaveLength(0);
  });
  test("indeterminate acceptance has no blind retry; partial outcomes name retained state", async () => {
    const h = harness({ submitClone: async () => ({ status: "indeterminate", message: "Disconnected during acceptance" }) }); await h.ui.ready; await cloneForm(h); h.click("review"); h.click("commit-sheet"); await settle();
    expect(h.region().textContent).toContain("reconciliation is unavailable"); expect(h.region().querySelector('[data-flow="review"]')).toBeNull(); expect(h.mutations("submitClone")).toHaveLength(1);
  });
  test("pending clone acceptance survives Settings navigation without losing the accepted job", async () => {
    let resolve!: (result: Awaited<ReturnType<MobileHubBackend["submitClone"]>>) => void;
    const h = harness({ submitClone: () => new Promise(r => { resolve = r; }) }); await h.ui.ready; await cloneForm(h); h.click("review"); h.click("commit-sheet");
    h.ui.show("settings"); resolve(completed({ status: "accepted", jobId: "accepted-in-background" })); await settle();
    expect(h.mutations("subscribeClone")[0]?.args[0]).toEqual({ jobId: "accepted-in-background", afterEventId: 0 });
    h.ui.showDetail({ kind: "clone" }); await settle(); expect(h.region().textContent).toContain("accepted-in-background"); expect(h.mutations("submitClone")).toHaveLength(1);
  });
  test("a fresh frontend reconnects an accepted per-user job hint without restoring secrets or submitting again", async () => {
    const first = harness({ submitClone: async () => completed({ status: "accepted", jobId: "resumable-job" }) }); await first.ui.ready; await cloneForm(first); first.click("review"); first.click("commit-sheet"); await settle(); first.ui.destroy();
    const second = harness({ reconcileCloneAttempt: async () => available({ status: "accepted", jobId: "resumable-job" }) }); await second.ui.ready; second.ui.showDetail({ kind: "clone" }); await settle();
    expect(second.mutations("subscribeClone")[0]?.args[0]).toEqual({ jobId: "resumable-job", afterEventId: 0 }); expect(second.mutations("submitClone")).toHaveLength(0);
    expect(second.region().textContent).toContain("resumable-job"); expect(second.input("response").value).toBe("");
  });
  test("expired/restarted clone jobs are not called failures or authorized as new submissions", async () => {
    const h = harness({ submitClone: async () => completed({ status: "accepted", jobId: "expired-job" }), reconcileCloneAttempt: async () => available({ status: "expired" }) }); await h.ui.ready; await cloneForm(h); h.click("review"); h.click("commit-sheet"); await settle();
    h.stream({ type: "unavailable", reason: "not-found-or-expired", message: "Job is no longer retained" });
    expect(h.region().textContent).toContain("not proof the checkout failed"); expect(h.region().querySelector('[name="response"]')).toBeNull(); h.click("reconcile"); await settle();
    expect(h.region().textContent).toContain("no longer authoritative enough"); expect(h.region().querySelector('[data-flow="review"]')).toBeNull(); expect(h.mutations("cancelClone")).toHaveLength(0); expect(h.mutations("submitClone")).toHaveLength(1);
  });
  test("a clone unlock requirement arriving behind the workspace does not seize foreground", async () => {
    let resolve!: (result: Awaited<ReturnType<MobileHubBackend["submitClone"]>>) => void;
    const h = harness({ submitClone: () => new Promise(r => { resolve = r; }) }); await h.ui.ready; await cloneForm(h); h.click("review"); h.click("commit-sheet");
    h.root.hidden = true; h.root.inert = true; resolve(completed({ status: "requires-unlock", credential: { id: "ssh", type: "ssh" } })); await settle();
    expect(h.root.querySelector(".mh-sheet")).toBeNull(); expect(h.mutations("unlockCredential")).toHaveLength(0);
    h.root.hidden = false; h.root.inert = false; h.ui.showDetail({ kind: "clone" }); await settle(); expect(h.region().textContent).toContain("needs unlocking");
  });
  test.each(["clone-failed", "register-failed", "start-failed", "cleanup-failed", "cancelled", "timed-out"] as const)("clone terminal %s is presented explicitly without invented running status", async status => {
    const h = harness({ submitClone: async () => completed({ status: "accepted", jobId: "terminal-job" }) }); await h.ui.ready; await cloneForm(h); h.click("review"); h.click("commit-sheet"); await settle();
    const data = status === "cancelled" || status === "timed-out" ? { status, target: "/projects/checkout", reason: "inactivity" as const } : { status, target: "/projects/checkout", error: "Synthetic failure", workspaceId: status === "start-failed" ? "registered" : undefined };
    h.stream({ type: "job-event", event: { id: 1, type: "result", data } });
    expect(h.region().textContent).toContain(status === "start-failed" ? "remains stopped" : status === "register-failed" ? "could not be registered" : status === "cleanup-failed" ? "Cleanup failed" : status === "clone-failed" ? "Clone failed" : status === "timed-out" ? "timed out" : "cancelled");
    expect(h.region().querySelector('[data-flow="open"]')).toBeNull(); expect(h.opens).toHaveLength(0);
  });
  test("dirty clone exit offers Keep editing and Discard without backend cancellation", async () => {
    const h = harness(); await h.ui.ready; await cloneForm(h); h.click("flow-back");
    expect(h.region().textContent).toContain("Discard clone draft?"); h.click("cancel-sheet"); expect(h.input("folderName").value).toBe("checkout");
    h.click("flow-back"); h.click("commit-sheet"); await settle(); expect(h.mutations("cancelClone")).toHaveLength(0); expect(h.mutations("submitClone")).toHaveLength(0);
  });
});

describe("authentication flow", () => {
  test("all named destinations are product views, not disabled placeholders", async () => {
    const h = harness(); await h.ui.ready;
    for (const kind of ["add-credential", "tools", "assignments", "default-folder", "devices", "security", "add-workspace", "clone"] as const) {
      h.ui.showDetail({ kind }); await settle();
      expect(h.region().querySelector("h1")?.textContent).not.toBe("Information unavailable");
      expect(h.region().textContent).not.toContain("not connected in this frontend assembly");
    }
  });
  test("login masks/clears password and rate limiting never auto-submits or discloses metadata", async () => {
    const h = harness({ readAuthentication: async () => available({ status: "signed-out" }), signIn: async () => ({ status: "rejected", problem: { kind: "rate-limited", message: "Too many attempts", retryAfterSeconds: 60 } }) }); await h.ui.ready;
    h.set("user", "user"); h.set("password", "synthetic-password");
    h.root.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
    expect(h.input("password").value).toBe(""); expect(h.root.textContent).toContain("Retry after 60 seconds");
    expect(h.root.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true); expect(h.root.textContent).not.toContain("hub.invalid");
    expect(h.mutations("signIn")).toHaveLength(1); expect(h.mutations("readWorkspaces")).toHaveLength(0);
  });
  test("pending credential operation cannot resurrect protected flow after auth invalidation", async () => {
    let resolve!: (value: OperationResult<PublicCredentialDto & { type: "ssh" }>) => void;
    const h = harness({ generateSsh: () => new Promise(r => { resolve = r; }) }); await h.ui.ready; h.ui.showDetail({ kind: "add-credential" }); h.chooseKey("ssh", "generate"); h.set("name", "Key"); h.set("passphrase", "secret"); h.click("commit-sheet");
    h.invalidate({ scope: "authentication", generation: 1, reason: "unauthorized" }); resolve(completed(ssh() as PublicCredentialDto & { type: "ssh" })); await settle();
    expect(h.root.querySelector(".mh-flow-page")?.hasAttribute("hidden")).toBe(true); expect(h.root.textContent).toContain("Sign in required"); expect(h.root.textContent).not.toContain("SSH identity");
  });
  test("cancel and authentication-unavailable recovery clear secret nodes without exposing stale detail", async () => {
    let unavailable = false;
    const h = harness({ readAuthentication: async () => unavailable ? { status: "unavailable", problem: { kind: "unavailable", message: "Authentication connection unavailable" } } : available({ status: "authenticated", identity: { user: "user", host: "hub.invalid", version: "test" } }) }); await h.ui.ready;
    h.ui.showDetail({ kind: "add-credential" }); h.chooseKey("ssh", "generate"); h.set("passphrase", "secret-before-cancel"); const cancelled = h.input("passphrase"); h.click("cancel-sheet"); expect(cancelled.value).toBe("");
    h.click("ssh-generate"); h.set("passphrase", "secret-before-loss"); const oldInput = h.input("passphrase"); unavailable = true; await h.ui.refresh();
    expect(oldInput.value).toBe(""); expect(h.root.querySelector(".mh-sheet")).toBeNull(); expect(h.root.querySelector(".mh-flow-page")?.hasAttribute("hidden")).toBe(true); expect(h.root.textContent).toContain("Authentication connection unavailable");
  });
  test("successful sign-in reads authenticated state without navigating a forged return URL", async () => {
    let authenticated = false;
    const h = harness({ readAuthentication: async () => available(authenticated ? { status: "authenticated", identity: { user: "user", host: "hub.invalid", version: "test" } } : { status: "signed-out" }), signIn: async () => { authenticated = true; return completed({ user: "user", host: "hub.invalid", version: "test" }); } }); await h.ui.ready;
    h.set("user", "user"); h.set("password", "synthetic-password"); h.root.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
    expect(h.root.textContent).toContain("Workspaces"); expect(h.opens).toHaveLength(0); expect(h.root.querySelector('input[type="password"]')).toBeNull();
  });
  test("browser bundle contains product frontend but no server runtime or fixture dependency", async () => {
    const result = await Bun.build({ entrypoints: [new URL("./frontend.ts", import.meta.url).pathname], target: "browser" });
    expect(result.success).toBe(true);
    const bundle = await result.outputs[0]!.text();
    expect(bundle).not.toContain("node:fs"); expect(bundle).not.toContain("tests/mobile-hub-review"); expect(bundle).not.toContain("synthetic-private-key");
  });
});
