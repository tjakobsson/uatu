import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { createFlowEnvironment, clearSecrets, type SheetPort } from "./flow-ui";
import { createCloneFlow, cloneAttemptStorageKey } from "./clone-flow";
import type { CloneStreamEvent, MobileHubBackend } from "./backend";

const originals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let document: Document, storage: Map<string, string>;
beforeEach(() => {
  const dom = parseHTML("<html><body></body></html>"); document = dom.document as unknown as Document; storage = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
});
afterEach(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
async function harness() {
  const root = document.createElement("div"); document.body.append(root);
  let modal: HTMLElement | null = null, receive!: (event: CloneStreamEvent) => void;
  let cancel!: (result: Awaited<ReturnType<MobileHubBackend["cancelClone"]>>) => void;
  let input!: (result: Awaited<ReturnType<MobileHubBackend["sendCloneInput"]>>) => void;
  const sheet: SheetPort = {
    close() { if (modal) { clearSecrets(modal); modal.remove(); modal = null; } },
    open(title, body, primary, back) {
      sheet.close(); modal = document.createElement("section"); modal.innerHTML = `<h2>${title}</h2>${body}<button data-action="cancel-sheet">Cancel</button><button data-action="commit-sheet">Commit</button>`; document.body.append(modal);
      modal.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!.onclick = () => { void primary?.run(); };
      modal.querySelector<HTMLButtonElement>('[data-action="cancel-sheet"]')!.onclick = () => { sheet.close(); back?.(); };
      return modal;
    }, busy() {}, error() {},
  };
  const backend: MobileHubBackend = { ...createSyntheticBackend().backend,
    submitClone: async () => ({ status: "completed", value: { status: "accepted", jobId: "job-identity" } }),
    subscribeClone: (_, next) => { receive = next; return () => {}; },
    cancelClone: () => new Promise(resolve => { cancel = resolve; }),
    sendCloneInput: () => new Promise(resolve => { input = resolve; }),
  };
  const owner = createFlowEnvironment(root, backend, sheet, { user: () => "reviewer", home() {}, navigate() {}, changed() {}, openWorkspace() {}, authLost: () => owner.invalidate() });
  const clone = createCloneFlow(owner.env, () => {}, () => {});
  const click = (key: string) => {
    const button = (modal ?? root).querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`);
    if (!button) throw Error(`Missing ${key}`); button.click();
  };
  owner.begin(); clone.show(); await settle();
  for (const [name, value] of Object.entries({ url: "https://github.com/review/repo.git", folderName: "checkout", displayName: "Checkout" })) root.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  click("review"); click("commit-sheet"); await settle();
  receive({ type: "job-event", event: { id: 1, type: "phase", data: { phase: "cloning" } } });
  return { root, click, receive: (event: CloneStreamEvent) => receive(event), cancel: () => cancel({ status: "completed", value: { status: "terminal" } }), input: () => input({ status: "completed", value: { status: "accepted" } }), modal: () => modal };
}

test("completion during held cancel preserves status/output/result nodes and exposes outcome actions", async () => {
  const h = await harness();
  const status = h.root.querySelector("[data-clone-status]"), output = h.root.querySelector(".mh-clone-output"), result = h.root.querySelector("[data-clone-result]"), toolbar = h.root.querySelector(".mh-flow-toolbar"), more = h.root.querySelector('[data-flow="more"]');
  h.click("cancel"); h.click("commit-sheet");
  expect(status?.textContent).toContain("Waiting for the terminal result");
  const secret = h.root.querySelector<HTMLInputElement>('[name="response"]')!; secret.value = "DISPOSABLE";
  h.receive({ type: "job-event", event: { id: 2, type: "result", data: { status: "succeeded", workspaceId: "new", target: "/checkout", running: true } } });
  for (const [selector, node] of [["[data-clone-status]", status], [".mh-clone-output", output], ["[data-clone-result]", result], [".mh-flow-toolbar", toolbar], ['[data-flow="more"]', more]] as const) expect(h.root.querySelector(selector)).toBe(node);
  expect(status?.textContent).toContain("registered and running"); expect(secret.value).toBe(""); expect(secret.isConnected).toBe(false);
  expect(h.root.querySelectorAll('.mh-flow-content [data-flow="open"]')).toHaveLength(1);
  h.cancel(); await settle(); expect(status?.textContent).toContain("registered and running");
  expect(storage.has(cloneAttemptStorageKey("reviewer"))).toBe(false);
  expect(h.root.querySelector('[data-flow="cancel"], [data-flow="more"]')).toBeNull(); expect(h.root.querySelector('[data-flow="inspect"]')).not.toBeNull();
});

test("unavailable then terminal updates one recovery primary in place; late input does not restore hints", async () => {
  const h = await harness();
  const status = h.root.querySelector("[data-clone-status]");
  h.root.querySelector<HTMLInputElement>('[name="response"]')!.value = "DISPOSABLE"; h.click("send");
  h.receive({ type: "unavailable", reason: "not-found-or-expired", message: "Not retained" });
  const primary = h.root.querySelector('[data-clone-primary]'); expect(primary?.getAttribute("data-flow")).toBe("reconcile");
  h.receive({ type: "job-event", event: { id: 2, type: "result", data: { status: "register-failed", target: "/checkout", error: "Conflict" } } });
  expect(h.root.querySelector("[data-clone-status]")).toBe(status); expect(h.root.querySelector('[data-clone-primary]')).toBe(primary);
  expect(primary?.getAttribute("data-flow")).toBe("folder"); expect(h.root.querySelectorAll('[data-flow="folder"]')).toHaveLength(1);
  h.input(); await settle(); expect(storage.has(cloneAttemptStorageKey("reviewer"))).toBe(false);
  expect(h.root.querySelectorAll('[data-flow="folder"]')).toHaveLength(1); expect(h.root.querySelector('[data-flow="edit"]')).not.toBeNull();
});
