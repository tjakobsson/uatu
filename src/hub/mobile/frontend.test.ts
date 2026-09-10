import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { branchLabel, mountMobileHub, type MobileHubCallbacks } from "./frontend";
import type { CredentialFacts, Invalidation, MobileHubBackend, ReadResult, WorkspaceView } from "./backend";
import type { PublicCredentialDto } from "../credential-types";
import { DEFAULT_NAVIGATION_PLACEMENT, getNavigationPreferences, setNavigationPreferences, onNavigationPreferencesChange } from "../../shell/navigation-preferences";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let document: Document;
let active: Element | null;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  const dom = parseHTML('<html><body><div id="workspace"><button>Workspace control</button></div><div id="hub"></div></body></html>');
  document = dom.document as unknown as Document;
  active = null;
  Object.defineProperty(document, "activeElement", { get: () => active, configurable: true });
  dom.window.HTMLElement.prototype.focus = function () { active = this as unknown as Element; };
  // linkedom does not implement the native checked property used by radio groups.
  Object.defineProperty(dom.window.HTMLInputElement.prototype, "checked", { configurable: true, get() { return this.hasAttribute("checked"); }, set(checked) { if (checked) this.setAttribute("checked", ""); else this.removeAttribute("checked"); } });
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error("Storage denied"); } } });
  setNavigationPreferences({ side: "left", position: .72, previewSide: "left", autoHide: true });
});
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
});
const workspace = (id: string, running = false): WorkspaceView => ({ id, displayName: "Duplicate name", path: `/projects/${id}`, backend: "local", runtime: running ? { status: "running", shells: { status: "ready", value: [{ attached: true, label: "editor" }] } } : { status: "stopped" }, assignments: [], branch: { kind: "named", name: "feature/test" }, workspaceApiRevision: 1, credentialRestartRequired: false });
const available = <T,>(value: T): ReadResult<T> => ({ status: "available", value });
function harness(overrides: Partial<MobileHubBackend> = {}, callbackOverrides: Partial<MobileHubCallbacks> = {}) {
  let rows = [workspace("a", true), workspace("b")];
  let invalidate: (event: Invalidation) => void = () => {};
  const starts: unknown[] = [], opens: string[] = [], returns: string[] = [];
  const methods: Partial<MobileHubBackend> = {
    readAuthentication: async () => available({ status: "authenticated", identity: { user: "Reviewer", host: "synthetic.invalid", version: "test-version" } }),
    readWorkspaces: async () => available(rows), readWorkspace: async id => available(rows.find(w => w.id === id)!),
    readCredentials: async () => available([]),
    readDefaultFolder: async () => available({ configured: "/projects", configuredAvailable: true, effective: "/projects" }),
    readDevices: async () => available([]),
    subscribeInvalidation: fn => { invalidate = fn; return () => { invalidate = () => {}; }; },
    startWorkspace: async intent => { starts.push(intent); return { status: "completed", value: { status: "running", workspaceId: intent.workspaceId } }; },
    ...overrides,
  };
  const backend = new Proxy(methods, { get: (object, property) => {
    if (property in object) return Reflect.get(object, property);
    return () => { throw new Error(`Unexpected backend operation: ${String(property)}`); };
  } }) as MobileHubBackend;
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace: id => opens.push(id), returnToWorkspace: id => returns.push(id), setRoute: () => {}, ...callbackOverrides });
  cleanup = ui.destroy;
  const click = (action: string) => {
    const button = [...root.querySelectorAll<HTMLButtonElement>("[data-action]")].find(el => el.dataset.action === action);
    if (!button) throw new Error(`Missing action ${action}`);
    button.focus(); button.click();
  };
  return { root, ui, click, starts, opens, returns, invalidate: (event: Invalidation) => invalidate(event), setRows: (next: WorkspaceView[]) => { rows = next; } };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function changeSelect(root: HTMLElement, value: string) {
  root.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => {
    input.checked = input.value === value;
    if (input.checked) input.setAttribute("checked", ""); else input.removeAttribute("checked");
  });
}

const overviewKey = (id = "key", enabled = true): PublicCredentialDto => ({ id, type: "ssh", name: `Identity ${id}`, enabled, createdAt: "2026-01-01", capabilities: ["ssh-authentication"], metadata: { fingerprint: "public-only", publicKey: "public-only" }, assignments: [], readiness: [{ layer: "credential", status: "ready", message: "Unlocked (prose is not a fact)" }] });
const keyFacts = (id: string, lock: "locked" | "unlocked" | "unknown"): CredentialFacts => ({ id, type: "ssh", protection: { status: "known", value: "unprotected" }, lock: lock === "unknown" ? { status: "unknown" } : { status: "known", value: lock }, userId: { status: "not-applicable" } });
describe("Settings overview explicit credential facts", () => {
  test("late catalog Retry cannot cross authentication invalidation", async () => {
    let catalogs = 0;
    let finish!: (value: ReadResult<PublicCredentialDto[]>) => void;
    const h = harness({ readCredentials: async () => { if (++catalogs === 1) throw new Error("offline"); return new Promise(resolve => { finish = resolve; }); } });
    await h.ui.ready; h.ui.show("settings"); h.click("retry-credentials");
    h.invalidate({ scope: "authentication", reason: "unauthorized", generation: 100 });
    finish(available([overviewKey("old-owner")])); await settle();
    expect(h.root.textContent).toContain("Sign in required");
    expect(h.root.textContent).not.toContain("old-owner");
  });
  test("catalog Retry reads only credentials and facts and retains an open native form", async () => {
    let catalogs = 0, workspaceReads = 0;
    let finish!: (value: ReadResult<PublicCredentialDto[]>) => void;
    const h = harness({ readWorkspaces: async () => { workspaceReads++; return available([]); }, readCredentials: async () => { if (++catalogs === 1) throw new Error("offline"); return new Promise(resolve => { finish = resolve; }); }, readCredentialFacts: async target => available(keyFacts(target.id, "locked")) });
    await h.ui.ready; h.ui.show("settings");
    expect(h.root.querySelectorAll('[data-action="retry-credentials"]').length).toBe(1);
    expect(h.root.querySelector('.mh-group [data-action="add-credential"]')).not.toBeNull();
    expect(h.root.querySelector('.mh-overview-toolbar')).toBeNull();
    h.click("retry-credentials"); h.click("handle");
    const input = h.root.querySelector<HTMLInputElement>('input[data-pref="position"]')!;
    input.value = "31"; input.focus();
    const sheet = h.root.querySelector(".mh-sheet");
    finish(available([overviewKey()])); await settle();
    expect(workspaceReads).toBe(1); expect(catalogs).toBe(2);
    expect(h.root.querySelector(".mh-sheet")).toBe(sheet);
    expect(input.value).toBe("31"); expect(document.activeElement).toBe(input);
    expect(h.root.querySelector('[data-credential-id="key"] .mh-value')?.textContent).toBe("Locked");
  });
  test("concise lock values remain separate from disabled state and ignore diagnostic prose", async () => {
    const h = harness({ readCredentials: async () => available([overviewKey("locked"), overviewKey("open", false), overviewKey("unknown")]), readCredentialFacts: async target => available(keyFacts(target.id, target.id === "open" ? "unlocked" : target.id === "locked" ? "locked" : "unknown")) });
    await h.ui.ready; h.ui.show("settings"); await settle();
    expect(h.root.querySelector('[data-credential-id="locked"] .mh-value')?.textContent).toBe("Locked");
    expect(h.root.querySelector('[data-credential-id="open"] .mh-value')?.textContent).toBe("Unlocked");
    expect(h.root.querySelector('[data-credential-id="open"] .mh-row-copy small')?.textContent).toBe("SSH key · Disabled");
    expect(h.root.querySelector('[data-credential-id="unknown"] .mh-value')?.textContent).toBe("Unknown");
  });
  test("fact arrival preserves exact focused row, scroll, and a separate preference draft", async () => {
    const resolve = new Map<string, (value: ReadResult<CredentialFacts>) => void>();
    const h = harness({ readCredentials: async () => available([overviewKey("one"), overviewKey("two")]), readCredentialFacts: target => new Promise(r => { resolve.set(target.id, r); }) });
    await h.ui.ready; h.ui.show("settings"); const page = h.root.querySelector<HTMLElement>(".mh-page")!;
    const row = h.root.querySelector<HTMLElement>('[data-credential-id="one"]')!; page.scrollTop = 140; row.focus();
    resolve.get("one")!(available(keyFacts("one", "locked"))); await settle();
    expect(h.root.querySelector('[data-credential-id="one"]')).toBe(row); expect(document.activeElement).toBe(row); expect(page.scrollTop).toBe(140);
    h.click("preview-side"); changeSelect(h.root, "right"); const select = h.root.querySelector<HTMLElement>('input[value="right"]')!; select.focus();
    const modal = h.root.querySelector(".mh-sheet"); resolve.get("two")!(available(keyFacts("two", "unlocked"))); await settle();
    expect(h.root.querySelector(".mh-sheet")).toBe(modal); expect(document.activeElement).toBe(select); expect(h.root.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("right"); expect(page.scrollTop).toBe(140);
    h.click("cancel-sheet"); expect(getNavigationPreferences().previewSide).toBe("left");
  });
  test("older refresh completions cannot overwrite newer facts", async () => {
    const resolve: Array<(value: ReadResult<CredentialFacts>) => void> = [];
    const h = harness({ readCredentials: async () => available([overviewKey()]), readCredentialFacts: () => new Promise(r => { resolve.push(r); }) });
    await h.ui.ready; h.ui.show("settings"); await h.ui.refresh();
    resolve[1]!(available(keyFacts("key", "unlocked"))); await settle(); resolve[0]!(available(keyFacts("key", "locked"))); await settle();
    expect(h.root.querySelector('[data-credential-id="key"] .mh-value')?.textContent).toBe("Unlocked");
  });
  test("old-identity facts and authoritative unauthorized results cannot resurrect protected summaries", async () => {
    let user = "Alice"; let old!: (value: ReadResult<CredentialFacts>) => void;
    const h = harness({ readAuthentication: async () => available({ status: "authenticated", identity: { user, host: "hub.invalid", version: "test" } }), readCredentials: async () => available([overviewKey()]), readCredentialFacts: () => user === "Alice" ? new Promise(r => { old = r; }) : Promise.resolve(available(keyFacts("key", "unknown"))) });
    await h.ui.ready; user = "Bob"; await h.ui.refresh(); h.ui.show("settings"); old(available(keyFacts("key", "unlocked"))); await settle();
    expect(h.root.querySelector('[data-credential-id="key"] .mh-value')?.textContent).toBe("Unknown");
    h.invalidate({ scope: "authentication", generation: 1, reason: "unauthorized" }); expect(h.root.querySelector("[data-credential-id]")).toBeNull();
    expect(h.root.textContent).toContain("Sign in required");
  });
  test("unavailable or mismatched facts show Unknown instead of fabricated lock state", async () => {
    const h = harness({ readCredentials: async () => available([overviewKey("offline"), overviewKey("mismatch")]), readCredentialFacts: async target => target.id === "offline" ? { status: "unavailable", problem: { kind: "unavailable", message: "Offline" } } : available(keyFacts("another-id", "unlocked")) });
    await h.ui.ready; h.ui.show("settings"); await settle();
    expect([...h.root.querySelectorAll("[data-credential-id] .mh-value")].map(el => el.textContent)).toEqual(["Unknown", "Unknown"]);
  });
  test("an authoritative unauthorized fact read revokes the overview rather than exposing stale metadata", async () => {
    let lost = 0;
    const h = harness({ readCredentials: async () => available([overviewKey()]), readCredentialFacts: async () => ({ status: "unavailable", problem: { kind: "unauthorized", message: "Session expired" } }) }, { authenticationLost: () => { lost++; } });
    await h.ui.ready; await settle(); expect(lost).toBe(1); expect(h.root.querySelector("[data-credential-id]")).toBeNull();
    expect(h.root.textContent).toContain("Sign in required"); expect(h.root.textContent).not.toContain("synthetic.invalid");
  });
});

describe("foreground modal keyboard recovery", () => {
  const key = (name: string) => { const event = new window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: name }); document.body.dispatchEvent(event); return event; };
  test("editor leaves Tab native while Escape cancels after focus moves to body", async () => {
    const h = harness(); await h.ui.ready; h.ui.show("settings"); h.click("preview-side");
    document.body.focus(); expect(key("Tab").defaultPrevented).toBe(false); expect(document.activeElement).toBe(document.body);
    document.body.focus(); expect(key("Escape").defaultPrevented).toBe(true); expect(h.root.querySelector(".mh-sheet")).toBeNull();
    expect(document.activeElement?.getAttribute("data-action")).toBe("preview-side");
  });
  test("a hidden Hub sheet cannot consume foreground workspace keys", async () => {
    const h = harness(); await h.ui.ready; h.ui.show("settings"); h.click("preview-side"); h.root.hidden = true; h.root.inert = true;
    document.body.focus(); expect(key("Escape").defaultPrevented).toBe(false); expect(document.activeElement).toBe(document.body); expect(h.root.querySelector(".mh-sheet")).not.toBeNull();
  });
  // Native capture ordering and touch-button focus are covered by exceptional
  // browser flows; linkedom does not model capture before a stopped bubble.
});

describe("mobile Hub scoped composition", () => {
  for (const reason of ["stopped", "removed"] as const) for (const operation of ["start", "open", "unlock"] as const) test(`matching ${reason} fences delayed ${operation} without follow-up navigation`, async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    const h = harness({
      startWorkspace: async () => { starts++; if (operation === "start") await held; return operation === "unlock" ? { status: "completed", value: { status: "requires-unlock", credentials: [{ id: "key", type: "ssh" }] } } : { status: "completed", value: { status: "running", workspaceId: "b" } }; },
      readWorkspace: async id => { await held; return available(workspace(id, true)); },
      unlockCredential: async () => { await held; const key = overviewKey(); if (key.type !== "ssh") throw new Error("Expected SSH fixture"); return { status: "completed", value: key }; },
    });
    await h.ui.ready;
    if (operation === "open") { h.setRows([workspace("b", true)]); await h.ui.refresh(); h.click("open:b"); }
    else { h.click("start:b"); h.click("commit-sheet"); await settle(); if (operation === "unlock") h.click("commit-sheet"); }
    h.invalidate({ scope: "workspace", workspaceId: "b", reason, generation: 1 });
    release(); await settle();
    expect(h.opens).toEqual([]); expect(starts).toBe(operation === "open" ? 0 : 1);
    expect(h.root.querySelector(".mh-sheet")).toBeNull();
  });
  test("a workspace detail read cannot restore running controls after a matching stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ readWorkspace: async id => { await gate; return available(workspace(id, true)); } });
    await h.ui.ready; h.ui.showDetail({ kind: "workspace", id: "b" });
    h.invalidate({ scope: "workspace", workspaceId: "b", reason: "stopped", generation: 1 });
    release(); await settle();
    expect(h.root.querySelector(".mh-flow-page")?.textContent).toContain("Workspace changed while loading");
    expect(h.root.querySelector('[data-flow="stop"]')).toBeNull();
  });
  test("a different authenticated user revokes old protected flows, including after transient unavailability", async () => {
    let user = "Alice", unavailable = false, lost = 0;
    const h = harness({ readAuthentication: async () => unavailable ? { status: "unavailable", problem: { kind: "unavailable", message: "Temporarily offline" } } : available({ status: "authenticated", identity: { user, host: "synthetic.invalid", version: "test" } }) }, { authenticationLost: () => { lost++; } });
    await h.ui.ready;
    h.ui.show("settings", { kind: "add-credential" });
    h.root.querySelector<HTMLButtonElement>('[data-flow="import-ssh"]')?.click();
    unavailable = true; await h.ui.refresh();
    expect(h.root.textContent).toContain("Temporarily offline");
    expect(h.root.textContent).not.toContain("Sign in required");
    expect(lost).toBe(0);
    unavailable = false; user = "Bob"; await h.ui.refresh();
    expect(lost).toBe(1);
    expect(h.root.textContent).toContain("Bob");
    expect(h.root.querySelector(".mh-flow-page")?.childElementCount).toBe(0);
    expect(h.root.querySelector(".mh-sheet")).toBeNull();
  });
  test("suspension clears a retained secret node and disables detached submit callbacks", async () => {
    let unlocks = 0;
    const h = harness({ startWorkspace: async () => ({ status: "completed", value: { status: "requires-unlock", credentials: [{ id: "key", type: "ssh" }] } }), unlockCredential: async () => { unlocks++; throw new Error("must not run"); } });
    await h.ui.ready;
    h.click("start:b"); h.click("commit-sheet"); await settle();
    const secret = h.root.querySelector<HTMLInputElement>('input[type="password"]')!;
    const commit = h.root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!;
    secret.value = "discard-me";
    h.ui.suspend(); commit.click(); await settle();
    expect(secret.value).toBe(""); expect(secret.isConnected).toBe(false); expect(unlocks).toBe(0);
  });
  test("every visual rule opts into the Hub root, including theme/material alternatives", async () => {
    const css = (await Bun.file(new URL("./styles.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{/g)) {
      const selector = match[1]!.trim();
      if (selector.startsWith("@media")) continue;
      for (const part of selector.split(",")) expect(part.trim().startsWith(".mh-root")).toBe(true);
    }
    expect(css).toContain("backdrop-filter: blur(24px)");
    expect(css).toContain("prefers-reduced-transparency");
    expect(css).toContain("forced-colors");
  });
  test("reference hierarchy uses vector folders, branch rows, circular actions and icon docks", async () => {
    const h = harness(); await h.ui.ready;
    expect(h.root.querySelector("h1")?.textContent).toBe("Workspaces");
    expect(h.root.querySelector(".mh-subtitle")?.textContent).toBe("synthetic.invalid · 1 session running");
    expect([...h.root.querySelectorAll(".mh-section > h2")].map(el => el.textContent)).toEqual(["Running1", "Ready to start1"]);
    expect(h.root.querySelectorAll('.mh-folder svg[data-icon="folder"]')).toHaveLength(2);
    expect(h.root.querySelectorAll('.mh-more svg[data-icon="more"]')).toHaveLength(2);
    expect(h.root.querySelector('.mh-status svg[data-icon="branch"]')).not.toBeNull();
    expect(h.root.querySelectorAll(".mh-dock .mh-tab svg")).toHaveLength(2);
    expect(h.root.querySelector(".mh-return")).toBeNull();
    expect(h.root.querySelector('.mh-add svg[data-icon="plus"]')).not.toBeNull();
    expect(h.starts).toEqual([]);
    expect(document.querySelector("#workspace")?.innerHTML).toBe("<button>Workspace control</button>");
  });
  test("all branch variants retain facts, including unknown and non-Git", () => {
    expect(branchLabel({ kind: "named", name: "topic" })).toBe("topic");
    expect(branchLabel({ kind: "detached", commit: "abc123" })).toBe("Detached · abc123");
    expect(branchLabel({ kind: "unborn", name: "new" })).toBe("new · no commits");
    expect(branchLabel({ kind: "non-git" })).toBe("Not a Git repository");
    expect(branchLabel({ kind: "loading" })).toBe("Loading branch…");
    expect(branchLabel({ kind: "unavailable", message: "Offline" })).toBe("Branch unavailable: Offline");
  });
  test("untrusted long labels stay text and duplicate names have distinct path labels", async () => {
    const h = harness(); h.setRows([{ ...workspace("a", true), displayName: '<img src=x onerror=alert(1)>' + "long".repeat(30) }, workspace("b")]);
    await h.ui.ready;
    expect(h.root.querySelector(".mh-workspace-copy img")).toBeNull();
    expect(h.root.querySelector('[data-action="info:b"]')?.getAttribute("aria-label")).toContain("/projects/b");
  });
  test("workspace ellipsis directly opens complete detail and Back restores its trigger", async () => {
    const h = harness(); await h.ui.ready; h.click("info:a"); await settle();
    expect(h.root.querySelector('[role="dialog"]')).toBeNull();
    expect(h.root.querySelector('.mh-flow-page')?.textContent).toContain("editor · Attached");
    expect(h.root.querySelector('.mh-flow-page')?.textContent).toContain("No credentials assigned");
    expect(h.root.querySelector<HTMLElement>(".mh-page main")?.inert).toBe(true);
    expect(h.root.querySelector('[data-action^="manage:"]')).toBeNull();
    h.root.querySelector<HTMLButtonElement>('[data-flow="flow-back"]')!.click();
    expect(document.activeElement?.getAttribute("data-action")).toBe("info:a");
  });
});

describe("stable Return and explicit workspace intents", () => {
  test("authentication outage keeps the sole Retry with its error", async () => {
    const h = harness({ readAuthentication: async () => ({ status: "unavailable", problem: { kind: "unavailable", message: "Synthetic outage" } }) });
    await h.ui.ready;
    expect(h.root.querySelectorAll('[data-action="refresh"]')).toHaveLength(1);
    expect(h.root.querySelector('main [data-action="refresh"]')).not.toBeNull();
    expect(h.root.querySelector('.mh-overview-toolbar')).toBeNull();
    expect(h.root.querySelector('[role="alert"]')?.textContent).toContain("Synthetic outage");
  });
  test("native login retains one contextual submit within its form", async () => {
    const h = harness({ readAuthentication: async () => available({ status: "signed-out" }) }); await h.ui.ready;
    expect(h.root.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(h.root.querySelector('.mh-login button[type="submit"]')).not.toBeNull();
    expect(h.root.querySelector('.mh-overview-toolbar')).toBeNull();
  });
  test("management B and Settings never retarget A; renamed/stopped/missing status is truthful", async () => {
    const h = harness(); await h.ui.ready; h.ui.setReturnTarget(workspace("a", true));
    h.click("info:b"); await settle(); h.root.querySelector<HTMLButtonElement>('[data-flow="flow-back"]')!.click(); h.click("settings");
    expect(h.root.querySelector(".mh-return small")?.textContent).toBe("Return to");
    h.click("return"); expect(h.returns).toEqual(["a"]);
    h.setRows([{ ...workspace("a", true), displayName: "Renamed" }, workspace("b")]); await h.ui.refresh();
    expect(h.root.querySelector(".mh-return strong")?.textContent).toBe("Renamed");
    h.setRows([workspace("a"), workspace("b")]); await h.ui.refresh();
    expect(h.root.querySelector<HTMLButtonElement>(".mh-return")?.disabled).toBe(true);
    h.setRows([workspace("b")]); await h.ui.refresh();
    expect(h.root.querySelector<HTMLButtonElement>(".mh-return")?.disabled).toBe(true);
    expect(h.starts).toEqual([]);
  });
  test("unassigned Start cancels without effects, confirms once, then navigates actual result", async () => {
    const h = harness(); await h.ui.ready; h.click("start:b");
    expect(h.starts).toEqual([]); h.click("cancel-sheet"); expect(h.starts).toEqual([]);
    h.click("start:b"); h.click("commit-sheet"); await settle();
    expect(h.starts).toEqual([{ workspaceId: "b", unassigned: "confirmed-without-credentials" }]);
    expect(h.opens).toEqual(["b"]);
  });
  test("Open revalidates and never starts a stopped workspace", async () => {
    const h = harness({ readWorkspace: async () => available(workspace("a")) }); await h.ui.ready;
    h.click("open:a"); await settle();
    expect(h.opens).toEqual([]); expect(h.starts).toEqual([]);
    expect(h.root.querySelector(".mh-sheet-error")?.textContent).toContain("has stopped");
  });
  test("assigned credentials skip unassigned confirmation and unlock with cleared masked input", async () => {
    let calls = 0;
    const unlocks: unknown[] = [];
    const h = harness({
      startWorkspace: async intent => ++calls === 1
        ? { status: "completed", value: { status: "requires-unlock", credentials: [{ type: "ssh", id: "key-a" }] } }
        : { status: "completed", value: { status: "running", workspaceId: intent.workspaceId } },
      unlockCredential: async intent => { unlocks.push(intent); return { status: "rejected", problem: { kind: "invalid-input", message: "Incorrect passphrase" } }; },
    });
    h.setRows([{ ...workspace("b"), assignments: [{ workspaceId: "b", credentialId: "key-a", role: "signing" }] }]);
    await h.ui.ready; h.click("start:b"); await settle();
    expect(calls).toBe(1); expect(h.root.textContent).not.toContain("Start without credentials?");
    const input = h.root.querySelector<HTMLInputElement>("[data-secret]")!;
    expect(input.type).toBe("password"); input.value = "synthetic-secret";
    h.click("commit-sheet"); expect(input.value).toBe(""); await settle();
    expect(unlocks).toEqual([{ target: { type: "ssh", id: "key-a" }, passphrase: "synthetic-secret" }]);
    expect(h.root.querySelector(".mh-sheet-error")?.textContent).toBe("Incorrect passphrase");
    expect(calls).toBe(1); expect(h.opens).toEqual([]);
    h.click("cancel-sheet"); expect(h.root.querySelector("[data-secret]")).toBeNull();
  });
  test("indeterminate start blocks blind retry and requires status reconciliation", async () => {
    let calls = 0;
    const h = harness({ startWorkspace: async () => { calls++; return { status: "indeterminate", message: "Connection lost." }; } });
    await h.ui.ready; h.click("start:b"); h.click("commit-sheet"); await settle();
    expect(h.root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')?.disabled).toBe(true);
    expect(h.root.querySelector(".mh-sheet-error")?.textContent).toContain("Check workspace status");
    h.click("check-start-status"); await settle(); expect(calls).toBe(1);
    expect(h.root.querySelector('[data-action="start:b"]')).not.toBeNull();
  });
  test("changing view during pending Open does not let its completion hijack Settings", async () => {
    let resolve!: (value: ReadResult<WorkspaceView>) => void;
    const h = harness({ readWorkspace: () => new Promise(r => { resolve = r; }) }); await h.ui.ready;
    h.click("open:a"); h.ui.show("settings"); resolve(available(workspace("a", true))); await settle();
    expect(h.opens).toEqual([]); expect(h.root.querySelector("h1")?.textContent).toBe("Settings");
  });
  test("a failed refresh removes actionable stale running status and Return", async () => {
    let failed = false;
    const h = harness({ readWorkspaces: async () => failed ? { status: "unavailable", problem: { kind: "unavailable", message: "Workspace catalog offline" } } : available([workspace("a", true)]) });
    await h.ui.ready; h.ui.setReturnTarget(workspace("a", true)); failed = true; await h.ui.refresh();
    expect(h.root.querySelector('[data-action="open:a"]')).toBeNull();
    expect(h.root.querySelector<HTMLButtonElement>(".mh-return")?.disabled).toBe(true);
    expect(h.root.querySelector('[role="alert"]')?.textContent).toContain("Workspace catalog offline");
  });
  test("auth invalidation discards delayed successful start and removes protected content", async () => {
    let resolve!: (value: Awaited<ReturnType<MobileHubBackend["startWorkspace"]>>) => void;
    const h = harness({ startWorkspace: () => new Promise(r => { resolve = r; }) }); await h.ui.ready;
    h.ui.setReturnTarget(workspace("a", true)); h.click("start:b"); h.click("commit-sheet");
    h.invalidate({ scope: "authentication", generation: 1, reason: "unauthorized" });
    resolve({ status: "completed", value: { status: "running", workspaceId: "b" } }); await settle();
    expect(h.opens).toEqual([]); expect(h.root.textContent).not.toContain("synthetic.invalid");
    expect(h.root.querySelector(".mh-dock")).toBeNull();
    expect(h.root.textContent).toContain("Sign in required");
  });
});

describe("Settings and browser-owned preference sheets", () => {
  test("overview is grouped destinations rather than inline forms", async () => {
    const h = harness(); await h.ui.ready; h.click("settings");
    expect(h.root.querySelector(".mh-identity strong")?.textContent).toBe("Reviewer");
    expect([...h.root.querySelectorAll(".mh-section > h2")].map(el => el.textContent)).toEqual(["Credentials", "Workspaces", "Account", "More settings"]);
    expect(h.root.querySelector("input,select")).toBeNull();
    h.click("add-credential");
    expect(h.root.querySelector<HTMLButtonElement>('[data-action="add-credential"]')?.disabled).toBe(false);
    expect(h.root.querySelector(".mh-flow-page h1")?.textContent).toBe("Add Credential");
    expect(h.root.querySelector('[role="dialog"]')).toBeNull();
  });
  test("Preview draft cancel and Done use existing owner, even when storage throws", async () => {
    const h = harness(); await h.ui.ready; h.click("settings"); h.click("preview-side");
    expect(h.root.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("left");
    changeSelect(h.root, "right"); h.click("cancel-sheet");
    expect(getNavigationPreferences().previewSide).toBe("left");
    h.click("preview-side"); changeSelect(h.root, "right"); h.click("commit-sheet");
    expect(getNavigationPreferences()).toEqual({ side: "left", position: .72, previewSide: "right", autoHide: true });
    expect(h.root.querySelector('[data-action="preview-side"] .mh-value')?.textContent).toBe("Right");
    expect(document.activeElement?.getAttribute("data-action")).toBe("preview-side");
  });
  test("full-page editor cancels drafts, has no backdrop, and leaves Tab native while blocking the underlying dock", async () => {
    const h = harness(); await h.ui.ready; h.click("settings"); h.click("preview-side");
    changeSelect(h.root, "right"); h.click("hub");
    expect(h.root.querySelector("h1")?.textContent).toBe("Settings");
    const escape = new window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(escape, "key", { value: "Escape" });
    h.root.querySelector('input[type="radio"]')!.dispatchEvent(escape);
    expect(getNavigationPreferences().previewSide).toBe("left"); expect(h.root.querySelector('[role="dialog"]')).toBeNull();
    h.click("preview-side"); changeSelect(h.root, "right");
    expect(h.root.querySelector(".mh-backdrop, [aria-modal]")).toBeNull();
    h.click("cancel-sheet");
    expect(getNavigationPreferences().previewSide).toBe("left");
    h.click("preview-side");
    const last = h.root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!; last.focus();
    const tab = new window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(tab, "key", { value: "Tab" }); last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });
  test("preference notification does not overwrite open draft; commit patches only edited fields", async () => {
    const h = harness(); await h.ui.ready; h.click("settings"); h.click("preview-side");
    const select = h.root.querySelector('input[value="right"]'); changeSelect(h.root, "right");
    setNavigationPreferences({ autoHide: false, side: "right" });
    expect(h.root.querySelector('input[value="right"]')).toBe(select);
    h.click("commit-sheet");
    expect(getNavigationPreferences()).toEqual({ previewSide: "right", autoHide: false, side: "right", position: .72 });
  });
  test("catalog refresh preserves the exact sheet input and draft", async () => {
    const h = harness(); await h.ui.ready; h.click("settings"); h.click("preview-side");
    const select = h.root.querySelector('input[value="right"]'); changeSelect(h.root, "right");
    await h.ui.refresh(); expect(h.root.querySelector('input[value="right"]')).toBe(select);
    expect(h.root.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("right");
    h.click("cancel-sheet"); expect(getNavigationPreferences().previewSide).toBe("left");
    expect(document.activeElement?.getAttribute("data-action")).toBe("preview-side");
  });
  test("handle and dismissal sheets initialize current values and cancel/reset honestly", async () => {
    const h = harness(); await h.ui.ready; setNavigationPreferences({ side: "right", position: .2, autoHide: false }); h.click("settings"); h.click("handle");
    expect(h.root.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("right");
    expect(h.root.querySelector<HTMLInputElement>('[data-pref="position"]')?.value).toBe("20");
    changeSelect(h.root, "right"); h.click("reset-handle");
    expect(h.root.querySelector<HTMLInputElement>('input[value="left"]')?.checked).toBe(true);
    expect(h.root.querySelector<HTMLInputElement>('[data-pref="position"]')?.value).toBe(String(DEFAULT_NAVIGATION_PLACEMENT.position * 100));
    h.click("cancel-sheet"); expect(getNavigationPreferences().position).toBe(.2);
    h.click("auto-hide"); expect(h.root.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("false");
    changeSelect(h.root, "true"); h.click("commit-sheet");
    expect(getNavigationPreferences()).toEqual({ side: "right", position: .2, autoHide: true, previewSide: "left" });
    h.click("handle"); changeSelect(h.root, "left");
    h.root.querySelector<HTMLInputElement>('[data-pref="position"]')!.value = "45";
    h.click("commit-sheet"); expect(getNavigationPreferences().position).toBe(.45);
    expect(getNavigationPreferences().side).toBe("left");
    h.click("handle"); changeSelect(h.root, "right"); h.click("reset-handle"); h.click("commit-sheet");
    expect(getNavigationPreferences()).toEqual({ ...DEFAULT_NAVIGATION_PLACEMENT, autoHide: true, previewSide: "left" });
  });
  for (const position of [.723456, .72, .7373, DEFAULT_NAVIGATION_PLACEMENT.position]) {
    test(`handle no-op Done and side-only edits retain exact ratio ${position}`, async () => {
      const h = harness(); await h.ui.ready;
      const saved = { side: "right" as const, position, autoHide: false, previewSide: "right" as const };
      setNavigationPreferences(saved);
      let changes = 0;
      const unsubscribe = onNavigationPreferencesChange(() => changes++);
      try {
        h.click("settings"); h.click("handle");
        expect(h.root.querySelector('[data-pref="position"]')?.getAttribute("step")).toBe("any");
        h.click("commit-sheet");
        expect(getNavigationPreferences()).toEqual(saved);
        expect(changes).toBe(0);
        h.click("handle"); changeSelect(h.root, "left"); h.click("commit-sheet");
        expect(getNavigationPreferences()).toEqual({ ...saved, side: "left" });
        expect(changes).toBe(1);
      } finally { unsubscribe(); }
    });
  }
});
