import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { mountMobileHub } from "./frontend";
import type { MobileHubBackend } from "./backend";
import { credentialPurpose } from "./credential-flows";

const originals = new Map(["window", "document", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let document: Document, dispose: (() => void) | undefined;
beforeEach(() => {
  const dom = parseHTML('<html><body><div id="hub"></div></body></html>'); document = dom.document as unknown as Document;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
  const storage = new Map<string, string>();
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
});

test("only a reviewed clone advertises unlock continuation, with a new admission attempt and unambiguous cancel", async () => {
  const model = createSyntheticBackend(); const attempts: string[] = [];
  const h = mount({ ...model.backend, submitClone: async intent => {
    attempts.push(intent.attemptId);
    return { status: "completed", value: attempts.length === 1 ? { status: "requires-unlock", credential: { id: "ssh-locked", type: "ssh" } } : { status: "accepted", jobId: "copy-job" } };
  }, subscribeClone: () => () => {} }); await h.ui.ready;
  h.ui.showDetail({ kind: "credential", id: "ssh-locked" }); await settle(); h.click("unlock");
  expect(h.region().textContent).toContain("Unlocking alone does not start a workspace or a clone job.");
  expect(h.region().querySelector('[data-action="commit-sheet"]')?.textContent).toBe("Unlock");
  h.region().querySelector<HTMLInputElement>('[name="passphrase"]')!.value = "review"; h.click("commit-sheet"); await settle();
  expect(attempts).toHaveLength(0);
  h.ui.showDetail({ kind: "clone" }); await settle();
  for (const [name, value] of Object.entries({ url: "https://github.com/review/repo.git", folderName: "copy-checkout", displayName: "Copy checkout" })) h.region().querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  h.click("review"); h.click("commit-sheet"); await settle();
  expect(h.region().textContent).toContain("continue the reviewed clone");
  expect(h.region().textContent).not.toContain("Unlocking alone");
  expect(h.region().querySelector('[data-action="commit-sheet"]')?.textContent).toBe("Unlock and continue");
  h.region().querySelector<HTMLInputElement>('[name="passphrase"]')!.value = "review"; h.click("commit-sheet"); await settle();
  expect(attempts).toHaveLength(2); expect(attempts[0]).not.toBe(attempts[1]);
  h.click("cancel");
  expect(h.region().querySelector('h2')?.textContent).toBe("Cancel clone?");
  expect(h.region().querySelector('[data-action="commit-sheet"]')?.textContent).toBe("Cancel clone");
  expect(h.region().querySelectorAll('[data-action="cancel-sheet"]')).toHaveLength(1);
  expect(h.region().querySelector('footer [data-action="cancel-sheet"]')?.textContent).toBe("Keep cloning");
});
afterEach(() => { dispose?.(); dispose = undefined; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function mount(backend: MobileHubBackend) {
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {} }); dispose = ui.destroy;
  const region = () => root.querySelector<HTMLElement>(".mh-sheet") ?? root.querySelector<HTMLElement>(".mh-flow-page")!;
  const click = (key: string) => { const button = region().querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`); if (!button) throw Error(`Missing ${key}: ${region().textContent}`); button.click(); };
  return { root, ui, region, click };
}

for (const failure of ["throw", "mismatch", "unavailable"] as const) test(`${failure} facts retain every catalog detail and one contextual retry`, async () => {
  const model = createSyntheticBackend(); let fail = true;
  const h = mount({ ...model.backend, readCredentialFacts: async target => {
    if (!fail) return model.backend.readCredentialFacts(target);
    if (failure === "throw") throw Error("offline");
    if (failure === "unavailable") return { status: "unavailable", problem: { kind: "unavailable", message: "offline" } };
    return { status: "available", value: { id: "wrong", type: "ssh", lock: { status: "known", value: "locked" }, protection: { status: "known", value: "protected" }, userId: { status: "not-applicable" } } };
  } }); await h.ui.ready;
  const catalog = await model.backend.readCredentials(); if (catalog.status !== "available") throw Error("fixture");
  expect(catalog.value).toHaveLength(5);
  for (const c of catalog.value) {
    h.ui.showDetail({ kind: "credential", id: c.id }); await settle();
    expect(h.region().querySelector("h1")?.textContent).toBe(c.name);
    expect(h.region().textContent).toContain("Purpose"); expect(h.region().textContent).toContain(credentialPurpose(c));
    const purposeLabels = { "ssh-authentication": "SSH connections", "ssh-signing": "Signing commits with SSH", "openpgp-signing": "Signing commits with OpenPGP", "https-git": "HTTPS Git connections", "github-cli": "GitHub CLI", "gitlab-cli": "GitLab CLI" };
    for (const capability of c.capabilities) expect(h.region().textContent).toContain(purposeLabels[capability]);
    expect(h.region().querySelector('[data-credential-fact="lock"] .mh-value')?.textContent).toBe(c.type === "token" ? undefined : "Unknown");
    const rows = [...h.region().querySelectorAll('[data-readiness-layer]')];
    expect(rows).toHaveLength(0);
    expect(h.region().querySelectorAll('[data-flow="retry-facts"]')).toHaveLength(1);
    expect(h.region().querySelector('[data-flow="retry-facts"]')?.textContent).toBe("Retry status check");
    expect(h.region().textContent).toContain("You can still view and manage it.");
    expect(h.region().querySelector('.mh-flow-toolbar [data-flow="retry-facts"]')).toBeNull();
    expect(h.region().querySelector(`[data-flow="${c.enabled ? "test" : "toggle"}"]`)).not.toBeNull();
    expect(h.region().querySelector('[data-flow="delete"]')).not.toBeNull();
  }
  h.ui.showDetail({ kind: "credential", id: "ssh-locked" }); await settle(); fail = false; h.click("retry-facts"); await settle();
  expect(h.region().querySelector('[data-credential-fact="lock"] .mh-value')?.textContent).toBe("Locked");
  expect(h.region().querySelector('[data-flow="retry-facts"]')).toBeNull();
});

for (const clipboardFails of [false, true]) test(`identifier copy has inline status without replacing content (clipboard failure: ${clipboardFails})`, async () => {
  let copied = "";
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { if (clipboardFails) throw Error("denied"); copied = value; } } } });
  const model = createSyntheticBackend(); const h = mount(model.backend); await h.ui.ready;
  h.ui.showDetail({ kind: "credential", id: "ssh-locked" }); await settle();
  const page = h.region(), identifier = page.querySelector('[data-flow="copy-id"]')!, status = page.querySelector('[data-identifier-status]')!;
  expect(status.getAttribute("role")).toBe("status");
  h.click("copy-id"); await settle();
  expect(h.region()).toBe(page); expect(page.querySelector('[data-flow="copy-id"]')).toBe(identifier);
  expect(page.querySelectorAll('[data-identifier-status]')).toHaveLength(1);
  expect(status.textContent).toBe(clipboardFails ? "Clipboard unavailable. Select and copy the public identifier." : "Public identifier copied.");
  expect(h.root.querySelector(".mh-sheet")).toBeNull();
  if (!clipboardFails) { const catalog = await model.backend.readCredentials(); if (catalog.status !== "available") throw Error("fixture"); const key = catalog.value.find(c => c.id === "ssh-locked"); if (key?.type !== "ssh") throw Error("fixture"); expect(copied).toBe(key.metadata.fingerprint); }
});

test("review tool rows carry known tool names without changing 14/17 credential reports", async () => {
  const model = createSyntheticBackend(); const result = await model.backend.readCredentials();
  if (result.status !== "available") throw Error("fixture");
  const ssh = result.value.filter(c => c.type === "ssh");
  expect(ssh.map(c => c.readiness.length).sort()).toEqual([14, 17]);
  const tools = await model.backend.readTools(); if (tools.status !== "available") throw Error("fixture");
  for (const tool of tools.value) {
    expect(tool.results).toHaveLength(3);
    for (const row of tool.results) { expect(row.message).toStartWith(`${tool.tool}: `); expect(row.message).toContain("simulated"); expect(row.status).toBe("ready"); }
  }
});
