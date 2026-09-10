import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { mountMobileHub } from "./frontend";
import { cloneAttemptStorageKey, cloneUrlProblem, parseCloneRecoveryHint } from "./clone-flow";
import type { MobileHubBackend } from "./backend";

const originals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let document: Document, storage: Map<string, string>, writes: string[], cleanup: (() => void) | undefined;
beforeEach(() => {
  const dom = parseHTML('<html><body><div id="hub"></div></body></html>'); document = dom.document as unknown as Document; storage = new Map(); writes = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window }); Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(value); storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); },
  } });
});
afterEach(() => { cleanup?.(); cleanup = undefined; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const hint = () => parseCloneRecoveryHint(storage.get(cloneAttemptStorageKey("reviewer")) ?? null);
async function mount(backend: MobileHubBackend) {
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace: () => {}, returnToWorkspace: () => {}, setRoute: () => {} }); cleanup = ui.destroy;
  await ui.ready; ui.show("settings", { kind: "clone" }); await settle();
  const region = () => root.querySelector<HTMLElement>(".mh-sheet") ?? root.querySelector<HTMLElement>(".mh-flow-page")!;
  const click = (key: string) => { const el = region().querySelector<HTMLButtonElement>(`[data-action="${key}"], [data-flow="${key}"]`); if (!el) throw Error(`Missing ${key}: ${region().textContent}`); el.click(); };
  const input = (name: string) => region().querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const fill = (name: string, value: string) => { input(name).value = value; input(name).dispatchEvent(new window.Event("input", { bubbles: true })); };
  fill("url", "https://github.com/review/monotonic.git"); fill("folderName", "monotonic-checkout"); fill("displayName", "Monotonic review");
  return { ui, root, region, input, fill, click, submit() { click("review"); click("commit-sheet"); } };
}

describe("clone admission snapshots are monotonic", () => {
  test.each(["pending", "unavailable", "throw"] as const)("an old %s reconciliation cannot replace later accepted progress", async snapshotKind => {
    const model = createSyntheticBackend(); model.hold("submitClone");
    if (snapshotKind !== "pending") model.fail("reconcileCloneAttempt", { kind: "unavailable", message: "ignored" });
    const captured = deferred<Awaited<ReturnType<MobileHubBackend["reconcileCloneAttempt"]>>>(), release = deferred<void>();
    let subscriptions = 0;
    const h = await mount({ ...model.backend,
      reconcileCloneAttempt: async intent => {
        const response = await model.backend.reconcileCloneAttempt(intent); captured.resolve(response);
        await release.promise; if (snapshotKind === "throw") throw new TypeError("Delayed read response lost"); return response;
      },
      subscribeClone: (intent, listener) => { subscriptions++; return model.backend.subscribeClone(intent, listener); },
    });
    h.submit(); await settle(); h.click("reconcile");
    const old = await captured.promise;
    expect(old.status === "available" ? old.value.status : old.status).toBe(snapshotKind === "pending" ? "pending" : "unavailable");
    model.settle("submitClone"); await settle();
    expect(h.region().querySelector("h1")?.textContent).toBe("Clone Progress"); const status = h.region().querySelector("[data-clone-status]");
    h.fill("response", "DISPOSABLE-UNSENT"); const responseInput = h.input("response");
    const acceptedHint = hint(); const writeCount = writes.length;
    release.resolve(); await settle();
    expect(h.region().querySelector("h1")?.textContent).toBe("Clone Progress");
    expect(h.region().querySelector("[data-clone-status]") === status).toBe(true);
    expect(responseInput.isConnected).toBe(true); expect(responseInput.value).toBe("DISPOSABLE-UNSENT");
    expect(hint()).toEqual(acceptedHint); expect(writes).toHaveLength(writeCount); expect(subscriptions).toBe(1);
    expect(model.inspect().jobs).toHaveLength(1); expect(model.snapshot().log.filter(row => row.method === "submitClone")).toHaveLength(1);
  });

  test.each(["accepted", "indeterminate", "throw"] as const)("a delayed original %s response cannot resurrect a terminal hint after reconciliation accepted it", async responseKind => {
    const model = createSyntheticBackend(), effectComplete = deferred<void>(), release = deferred<void>(); let subscriptions = 0;
    const h = await mount({ ...model.backend,
      submitClone: async intent => {
        const response = await model.backend.submitClone(intent); effectComplete.resolve(); await release.promise;
        if (responseKind === "throw") throw new TypeError("Original response lost after effect");
        return responseKind === "indeterminate" ? { status: "indeterminate", message: "Original response uncertain" } : response;
      },
      subscribeClone: (intent, listener) => { subscriptions++; return model.backend.subscribeClone(intent, listener); },
    });
    h.submit(); await effectComplete.promise; await settle();
    const id = model.inspect().jobs[0]!.id; h.click("reconcile"); await settle();
    expect(hint()?.jobId).toBe(id); model.finishClone(id, "succeeded"); await settle();
    const terminalNode = h.region().querySelector("[data-clone-status]");
    expect(terminalNode?.textContent).toContain("registered stopped"); expect(hint()).toBeNull(); const writeCount = writes.length;
    release.resolve(); await settle();
    expect(hint()).toBeNull(); expect(writes).toHaveLength(writeCount);
    expect(h.region().querySelector("[data-clone-status]") === terminalNode).toBe(true);
    expect(h.region().textContent).toContain("registered stopped"); expect(subscriptions).toBe(1); expect(model.inspect().jobs).toHaveLength(1);
  });
});

describe("SSH userinfo inspection does not depend on URL parsing", () => {
  test("parser-stripped controls cannot disguise malformed password-bearing authority", async () => {
    const h = await mount(createSyntheticBackend().backend);
    for (const url of ["\tssh://git:DISPOSABLE@host:bad/repo", "ss\th://git:DISPOSABLE@", "\u0001ssh://git:DISPOSABLE@"]) {
      const original = h.input("url"); h.fill("url", url); expect(original.value).toBe("");
    }
    expect(cloneUrlProblem("ssh://git@")).toBeNull();
  });
  test.each(["ssh://git:DISPOSABLE@github.com:notaport/repo", "ssh://git:DISPOSABLE@", "git+ssh://git:DISPOSABLE@host:bad/repo"])("discards malformed password-bearing URI %s on the original node and through Settings", async url => {
    const model = createSyntheticBackend(), h = await mount(model.backend); const original = h.input("url"); h.fill("url", url);
    expect(original.value).toBe(""); expect(h.region().textContent).not.toContain("DISPOSABLE");
    h.ui.show("settings"); expect(original.value).toBe(""); expect(original.isConnected).toBe(false);
    h.ui.showDetail({ kind: "clone" }); await settle(); expect(h.input("url").value).toBe("");
    expect(JSON.stringify([...storage])).not.toContain("DISPOSABLE"); expect(model.snapshot().log.filter(row => row.method === "submitClone")).toHaveLength(0);
  });
  test.each(["ssh://git@github.com/repo", "ssh://git@github.com:2222/repo", "ssh://git@[::1]:2222/repo", "git@github.com:review/repo", "git@[::1]:review/repo"])("preserves legitimate remote %s", async url => {
    expect(cloneUrlProblem(url)).toBeNull(); const h = await mount(createSyntheticBackend().backend); h.fill("url", url);
    h.ui.show("settings"); h.ui.showDetail({ kind: "clone" }); await settle(); expect(h.input("url").value).toBe(url);
  });
});
