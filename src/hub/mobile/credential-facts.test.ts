import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { mountMobileHub } from "./frontend";
import { credentialFactSummary, credentialPrimaryAction, readOnlyPurposes, supportsRole } from "./credential-flows";
import { cloneCredentialCompatible } from "./clone-flow";
import type { MobileHubBackend } from "./backend";

const originals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let document: Document, dispose: (() => void) | undefined;
beforeEach(() => {
  const dom = parseHTML('<html><body><div id="hub"></div></body></html>'); document = dom.document as unknown as Document;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window }); Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
});
afterEach(() => { dispose?.(); dispose = undefined; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function mount(backend: MobileHubBackend) {
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace: () => {}, returnToWorkspace: () => {}, setRoute: () => {} }); dispose = ui.destroy;
  const region = () => root.querySelector<HTMLElement>(".mh-sheet") ?? root.querySelector<HTMLElement>(".mh-flow-page")!;
  const click = (key: string) => { const button = region().querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`); if (!button) throw Error(`Missing ${key}: ${region().textContent}`); button.click(); };
  const input = (name: string) => region().querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  return { root, ui, region, click, input };
}

describe("explicit credential and tool facts", () => {
  test("saved purposes are semantic read-only labels and only show supported uses", () => {
    const cases = [
      ["ssh-authentication", "Git access", "SSH"], ["ssh-signing", "Commit signing", "SSH"],
      ["openpgp-signing", "Commit signing", "OpenPGP"], ["https-git", "Git access", "HTTPS"],
      ["github-cli", "GitHub CLI", "Authentication"], ["gitlab-cli", "GitLab CLI", "Authentication"],
    ] as const;
    for (const [cap, label, value] of cases) {
      const { document } = parseHTML(readOnlyPurposes({ capabilities: [cap] }));
      expect([...document.querySelectorAll("dt")].map(el => el.textContent)).toEqual([label]);
      expect([...document.querySelectorAll("dd")].map(el => el.textContent)).toEqual([value]);
      expect(document.querySelector("input, select, textarea, button, [role=checkbox], [role=switch], [role=textbox]")).toBeNull();
    }
  });
  test("known unlocked keys omit Unlock; unknown keys retain applicable operations", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await h.ui.ready;
    h.ui.showDetail({ kind: "credential", id: "ssh-open" }); await settle();
    expect(h.region().querySelector('[data-flow="unlock"]')).toBeNull();
    expect(h.region().querySelector('[data-flow="lock"]')).not.toBeNull();
    model.setCredentialFactsUnknown("ssh-open", true);
    h.ui.showDetail({ kind: "credential", id: "ssh-open" }); await settle();
    expect(h.region().querySelector('[data-flow="unlock"]')).not.toBeNull();
    expect(h.region().querySelector('[data-flow="lock"]')).not.toBeNull();
  });
  test("explicit credential checks open concise results and every original 14/17 report row", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await h.ui.ready;
    for (const id of ["ssh-open", "ssh-locked"]) {
      h.ui.showDetail({ kind: "credential", id }); await settle();
      expect(h.region().querySelector('details, [data-readiness-layer], [data-flow="diagnostics"]')).toBeNull();
      h.click("test"); await settle();
       expect(h.region().textContent).toContain("Check Results");
       const labels = [...h.region().querySelectorAll("dt")].map(el => el.textContent);
       expect(labels).toContain("Subject"); expect(labels).toContain("Git access");
       expect(labels).toContain("Result"); expect(labels).toContain("Scope");
       expect(h.region().textContent).toContain("Remote permissions have not been checked.");
      expect(h.region().querySelector('[data-readiness-layer]')).toBeNull();
      const expected = await model.backend.testCredential({ id, type: "ssh" });
      if (expected.status !== "completed") throw Error("fixture");
      expect([14, 17]).toContain(expected.value.length);
      h.click("diagnostics");
      const rows = [...h.region().querySelectorAll('[data-readiness-layer]')].map(row => ({ layer: row.getAttribute("data-readiness-layer"), status: row.getAttribute("data-readiness-status"), message: row.querySelector("small")?.textContent }));
      const sort = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
      expect(rows.sort(sort)).toEqual([...expected.value].sort(sort));
      expect(h.region().querySelector('details, [data-tool]')).toBeNull();
    }
  });
  test("all five credential creation forms have one footer submit and one cancellation path", async () => {
    const h = mount(createSyntheticBackend().backend); await h.ui.ready;
    for (const [type, operation, label] of [["ssh", "ssh-generate", "Generate"], ["ssh", "ssh-import", "Import"], ["openpgp", "pgp-generate", "Generate"], ["openpgp", "pgp-import", "Import"], ["token", "token", "Add"]] as const) {
      h.ui.showDetail({ kind: "add-credential" }); h.click(type);
      if (type !== "token") h.click(operation);
      const sheet = h.region();
      expect(sheet.getAttribute("data-task-kind")).toBe("editor");
      expect(sheet.querySelector("details")).toBeNull();
      expect(sheet.querySelectorAll('[data-action="commit-sheet"]')).toHaveLength(1);
      expect(sheet.querySelector('[data-action="commit-sheet"]')?.textContent).toBe(label);
      expect(sheet.querySelectorAll('[data-action="cancel-sheet"]')).toHaveLength(1);
      expect(sheet.querySelector('[data-action="cancel-sheet"]')?.textContent).toBe("Cancel");
      expect(sheet.querySelectorAll('[data-flow="flow-back"], .mh-sheet-body button')).toHaveLength(0);
      for (const input of sheet.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[name="userId"], [name="host"], [name="username"], [name="token"], [name="passphrase"], [name="paste"]')) {
        expect(input.closest("label")?.textContent?.trim().length).toBeGreaterThan(0);
        expect(input.getAttribute("autocorrect")).toBe("off");
        expect(input.getAttribute("autocapitalize")).toBe("none");
        expect(input.getAttribute("inputmode")).toBe(input.name === "host" ? "url" : "text");
      }
      h.click("cancel-sheet"); expect(h.root.querySelector(".mh-sheet")).toBeNull();
    }
  });
  test("primary selection requires explicit lock state, with Enable taking precedence", () => {
    const unknown = { id: "ssh", type: "ssh", protection: { status: "unknown" }, lock: { status: "unknown" }, userId: { status: "not-applicable" } } as const;
    expect(credentialPrimaryAction({ type: "ssh", enabled: true }, unknown)).toBe("test");
    const locked = { ...unknown, lock: { status: "known", value: "locked" } } as const;
    expect(credentialPrimaryAction({ type: "ssh", enabled: true }, locked)).toBe("unlock");
    expect(credentialPrimaryAction({ type: "ssh", enabled: false }, locked)).toBe("toggle");
    expect(credentialPrimaryAction({ type: "token", enabled: true }, locked)).toBe("test");
  });
  test("credential commands are direct grouped rows, without menus or diagnostics", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await h.ui.ready;
    for (const id of ["ssh-locked", "pgp-locked", "token-github"]) {
      h.ui.showDetail({ kind: "credential", id }); await settle();
      const primary = id === "token-github" ? "test" : "unlock";
      expect(h.region().querySelectorAll(`[data-flow="${primary}"]`)).toHaveLength(1);
      expect(h.region().querySelector(`.mh-flow-toolbar [data-flow="${primary}"]`)).toBeNull();
      expect(h.region().querySelectorAll('[data-flow="flow-back"]')).toHaveLength(1);
      expect(h.region().querySelector('[data-flow="more"], details, [data-readiness-layer]')).toBeNull();
      for (const key of ["delete", "toggle", "test", "defaults"]) expect(h.region().querySelectorAll(`[data-flow="${key}"]`)).toHaveLength(1);
      const actions = [...h.region().querySelectorAll("[data-flow]")];
      expect(actions.at(-1)?.getAttribute("data-flow")).toBe("delete");
      expect(h.region().querySelector('[data-flow="lock"]')).toBeNull();
      expect(h.region().querySelector('[data-flow="public"]') !== null).toBe(id !== "token-github");
    }
  });
  test("lock and protection are independent and never inferred from misleading diagnostic prose", async () => {
    const model = createSyntheticBackend(); await model.backend.lockSsh({ id: "ssh-open", type: "ssh" });
    const h = mount({ ...model.backend, readCredentials: async () => {
      const result = await model.backend.readCredentials();
      if (result.status === "available") result.value = result.value.map(c => ({ ...c, readiness: [{ layer: "credential", status: "ready", message: "Unlocked protected identity (misleading prose)" }] }));
      return result;
    } }); await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "ssh-open" }); await settle();
    expect(h.region().querySelector('[data-credential-fact="lock"] dd')?.textContent).toBe("Locked");
    expect(h.region().querySelector('[data-credential-fact="protection"] dd')?.textContent).toBe("Not set");
    expect(h.region().querySelector('.mh-readiness-summary')).toBeNull();
    expect(h.region().textContent).toContain("Git access");
    expect(credentialFactSummary({ id: "ssh-open", type: "ssh", protection: { status: "known", value: "unprotected" }, lock: { status: "known", value: "locked" }, userId: { status: "not-applicable" } })).toBe("Availability: Locked · Passphrase: Not set");
  });
  test("OpenPGP user ID comes from facts, not public-key comments or the display name", async () => {
    const model = createSyntheticBackend(); model.setOpenPgpUserId("pgp-locked", "Explicit user <fact@mock.invalid>");
    const h = mount({ ...model.backend, readCredentials: async () => {
      const result = await model.backend.readCredentials();
      if (result.status === "available") result.value = result.value.map(c => c.type === "openpgp" ? { ...c, name: "Misleading person", metadata: { ...c.metadata, publicKey: "Comment: Another identity" } } : c);
      return result;
    } }); await h.ui.ready; h.ui.showDetail({ kind: "credential", id: "pgp-locked" }); await settle();
    expect(h.region().querySelector('[data-credential-fact="userId"] dd')?.textContent).toBe("Explicit user <fact@mock.invalid>");
    model.setCredentialFactsUnknown("pgp-locked", true); h.ui.showDetail({ kind: "credential", id: "pgp-locked" }); await settle();
    for (const name of ["lock", "protection", "userId"]) expect(h.region().querySelector(`[data-credential-fact="${name}"] dd`)?.textContent).toBe("Unknown");
    h.ui.showDetail({ kind: "credential", id: "token-github" }); await settle();
    expect(h.region().querySelector('[data-credential-fact="lock"]')).toBeNull();
    expect(h.region().querySelector('[data-flow="unlock"], [data-flow="lock"]')).toBeNull();
  });
  test("known saved override initializes exactly, separate from detected effective path", async () => {
    const model = createSyntheticBackend(); await model.backend.setToolOverride({ tool: "git", path: "/synthetic/saved/git" });
    const h = mount({ ...model.backend, readTools: async () => {
      const result = await model.backend.readTools(); if (result.status === "available") result.value = result.value.map(t => ({ ...t, path: "/synthetic/detected/git" })); return result;
    } }); await h.ui.ready; h.ui.showDetail({ kind: "tools" }); await settle(); h.click("tool-git"); h.click("override-git"); await settle();
    expect(h.region().querySelectorAll('[data-action="commit-sheet"]')).toHaveLength(1);
    expect(h.region().querySelector('[data-action="commit-sheet"]')?.textContent).toBe("Save");
    expect(h.region().querySelectorAll('[data-action="cancel-sheet"]')).toHaveLength(1);
    expect(h.region().querySelectorAll('[data-flow="clear"]')).toHaveLength(1);
    expect(h.region().querySelector('[data-flow="flow-back"]')).toBeNull();
    expect(h.input("path").value).toBe("/synthetic/saved/git"); expect(h.region().textContent).toContain("Detected path: /synthetic/detected/git");
    h.click("cancel-sheet"); model.setToolConfigurationUnknown("git", true); h.click("override-git"); await settle();
    expect(h.input("path").value).toBe(""); expect(h.region().textContent).toContain("Saved override: Unknown");
    h.click("cancel-sheet"); model.setToolConfigurationUnknown("git", false); await model.backend.setToolOverride({ tool: "git", path: null }); h.click("override-git"); await settle();
    expect(h.input("path").value).toBe(""); expect(h.region().textContent).toContain("No saved override");
  });
  test("automatic discovery is only a draft until Save; Cancel never mutates", async () => {
    const model = createSyntheticBackend(); await model.backend.setToolOverride({ tool: "git", path: "/synthetic/custom/git" });
    const calls: Array<string | null> = [];
    const h = mount({ ...model.backend, setToolOverride: async intent => { calls.push(intent.path); return model.backend.setToolOverride(intent); } });
    await h.ui.ready; h.ui.showDetail({ kind: "tools" }); await settle();
    expect(h.region().querySelectorAll('[data-flow^="tool-"]')).toHaveLength(9);
    expect(h.region().textContent).toContain("Git repositories");
    h.click("tool-git");
    expect(h.region().querySelector('[data-flow="more"]')).toBeNull();
    expect(h.region().querySelector('[data-flow="test-git"]')?.textContent).toContain("Recheck git setup");
    expect(h.region().textContent).toContain("Reprobe installed tools");
    h.click("override-git"); await settle(); h.click("clear");
    expect(calls).toEqual([]); expect(h.region().textContent).toContain("Automatic discovery will be used when you save.");
    h.click("cancel-sheet"); expect(calls).toEqual([]);
    h.click("override-git"); await settle(); expect(h.input("path").value).toBe("/synthetic/custom/git");
    h.click("clear"); h.click("commit-sheet"); await settle(); expect(calls).toEqual([null]);
  });
  test("tool purposes use explicit IDs; unknown saved settings require an explicit choice", async () => {
    const model = createSyntheticBackend(); model.setToolConfigurationUnknown("git", true);
    const calls: Array<string | null> = [];
    const h = mount({ ...model.backend, setToolOverride: async intent => { calls.push(intent.path); return model.backend.setToolOverride(intent); } });
    await h.ui.ready; h.ui.showDetail({ kind: "tools" }); await settle();
    for (const purpose of ["Git repositories", "Remote SSH connections", "Holds unlocked SSH keys", "Loads SSH keys into the agent", "Creates, inspects and signs with SSH keys", "OpenPGP signing", "Manages OpenPGP background services", "GitHub CLI", "GitLab CLI"]) expect(h.region().textContent).toContain(purpose);
    expect(h.region().textContent).not.toContain("/synthetic/bin");
    h.click("tool-git");
    expect(h.region().querySelectorAll('[data-readiness-layer]')).toHaveLength(0);
    expect([...h.region().querySelectorAll("dt")].find(el => el.textContent === "Version")?.nextElementSibling?.textContent).toBe("synthetic-1");
    h.click("override-git"); await settle(); h.click("commit-sheet"); await settle();
    expect(calls).toEqual([]); expect(h.region().textContent).toContain("Executable path is required");
    h.click("clear"); h.click("commit-sheet"); await settle(); expect(calls).toEqual([null]);
  });
  test("tool diagnostics are available only after an explicit recheck and report action", async () => {
    const model = createSyntheticBackend(); let tested = 0;
    const h = mount({ ...model.backend, testTool: async tool => { tested++; return model.backend.testTool(tool); } });
    await h.ui.ready; h.ui.showDetail({ kind: "tools" }); await settle(); h.click("tool-git");
    expect(tested).toBe(0);
    expect(h.region().querySelector('details, [data-readiness-layer], [data-flow="diagnostics"]')).toBeNull();
    h.click("test-git"); await settle();
    expect(tested).toBe(1); expect(h.region().textContent).toContain("Check Results");
    const facts = Object.fromEntries([...h.region().querySelectorAll("dt")].map(el => [el.textContent, el.nextElementSibling?.textContent]));
    expect(facts.Subject).toBe("git"); expect(facts.Use).toBe("Git repositories");
    expect(facts.Result).toBe("Ready on this Hub"); expect(facts.Scope).toContain("Local setup only");
    expect(h.region().querySelector('[data-readiness-layer]')).toBeNull();
    h.click("diagnostics");
    expect(h.region().querySelectorAll('[data-readiness-layer]')).toHaveLength(3);
    expect(h.region().querySelector("details")).toBeNull();
  });
  test("held tool Save owns the sheet, blocks double-submit and reports failure in that sheet", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await h.ui.ready; h.ui.showDetail({ kind: "tools" }); await settle(); h.click("tool-git"); h.click("override-git"); await settle();
    h.input("path").value = "/synthetic/custom/git"; model.hold("setToolOverride"); h.click("commit-sheet");
    expect(h.region().getAttribute("aria-busy")).toBe("true"); expect(h.input("path").disabled).toBe(true);
    expect(h.region().querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')?.disabled).toBe(true);
    h.click("commit-sheet"); expect(model.snapshot().pending).toContainEqual({ method: "setToolOverride", count: 1 });
    model.settle("setToolOverride", true); await settle();
    expect(h.region().querySelector(".mh-sheet-error")?.textContent).toContain("Synthetic operation failed");
    expect(h.input("path").value).toBe("/synthetic/custom/git"); expect(h.input("path").disabled).toBe(false);
    expect(h.root.querySelector(".mh-flow-error")?.textContent).toBe("");
  });
  test("late override facts cannot open an old tool sheet after drilling into another tool", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await h.ui.ready;
    h.ui.showDetail({ kind: "tools" }); await settle(); h.click("tool-git");
    model.hold("readToolConfiguration"); h.click("override-git");
    h.click("flow-back"); await settle(); h.click("tool-ssh");
    model.settle("readToolConfiguration"); await settle();
    expect(h.root.querySelector(".mh-sheet")).toBeNull();
    expect(h.region().querySelector("h1")?.textContent).toBe("ssh");
  });
  test("provider-CLI-only token can be retained in assignments/onboarding but is never a clone identity", async () => {
    const model = createSyntheticBackend(); const created = await model.backend.createToken({ name: "CLI only", host: "github.com", token: "DISPOSABLE", capabilities: ["github-cli"] });
    if (created.status !== "completed") throw Error("fixture creation failed"); const c = created.value;
    expect(supportsRole(c, "authentication")).toBe(true); expect(cloneCredentialCompatible(c, "https://github.com/review/repo")).toBe(false);
    const h = mount(model.backend); await h.ui.ready; h.ui.showDetail({ kind: "assignments" }); await settle(); h.click("workspace-notes"); await settle(); h.click("new-notes");
    expect(h.region().querySelector(`[name="authentication"] option[value="${c.id}"]`)).not.toBeNull();
    Object.defineProperty(h.input("authentication"), "value", { value: c.id, writable: true, configurable: true }); h.input("host").value = "github.com";
    h.click("commit-sheet"); await settle(); h.click("commit-sheet"); await settle();
    expect(model.inspect().workspaces.find(w => w.id === "notes")?.assignments).toContainEqual({ workspaceId: "notes", credentialId: c.id, role: "authentication", host: "github.com" });
    h.ui.showDetail({ kind: "clone" }); await settle();
    expect(h.region().querySelector(`[name="authentication"] option[value="${c.id}"]`)).not.toBeNull();
    expect(h.region().querySelector(`[name="cloneCredential"] option[value="${c.id}"]`)).toBeNull();
    h.ui.showDetail({ kind: "add-workspace" }); h.click("create"); await settle();
    expect(h.region().querySelector(`[name="authentication"] option[value="${c.id}"]`)).not.toBeNull();
  });
});
