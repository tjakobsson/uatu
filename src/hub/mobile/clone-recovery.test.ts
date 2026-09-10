import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { createFlowEnvironment, clearSecrets, type SheetPort } from "./flow-ui";
import { createCredentialFlows } from "./credential-flows";
import { cloneAttemptStorageKey, createCloneFlow, parseCloneRecoveryHint } from "./clone-flow";
import type { MobileHubBackend, CloneSubmissionIntent } from "./backend";

const originals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let document: Document;
let storage: Map<string, string>;
let cleanups: Array<() => void>;
beforeEach(() => {
  const dom = parseHTML("<html><body></body></html>"); document = dom.document as unknown as Document; storage = new Map(); cleanups = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } } });
});
afterEach(() => { cleanups.forEach(dispose => dispose()); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

function mount(backend: MobileHubBackend) {
  let user = "reviewer", authGeneration = 0;
  const host = document.createElement("div"); host.className = "mh-root"; document.body.append(host);
  const root = document.createElement("div"); host.append(root);
  let modal: HTMLElement | null = null;
  const sheet: SheetPort = {
    close() { if (modal) { clearSecrets(modal); modal.remove(); modal = null; } },
    open(title, body, primary, cancel) {
      sheet.close(); modal = document.createElement("section"); modal.className = "mh-sheet"; modal.setAttribute("role", "dialog");
      modal.innerHTML = `<h2>${title}</h2><div class="mh-sheet-body">${body}<p class="mh-sheet-error" role="alert"></p></div><button data-action="cancel-sheet">Cancel</button>${primary ? '<button data-action="commit-sheet">Commit</button>' : ""}`; host.append(modal);
      modal.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')?.addEventListener("click", () => { void primary?.run(); });
      modal.querySelector<HTMLButtonElement>('[data-action="cancel-sheet"]')!.onclick = () => { sheet.close(); cancel?.(); };
      return modal;
    }, busy(value) { modal?.setAttribute("aria-busy", String(value)); }, error(message) { const alert = modal?.querySelector(".mh-sheet-error"); if (alert) alert.textContent = message; },
  };
  const owner = createFlowEnvironment(root, backend, sheet, {
    user: () => user,
    authContext: () => { const captured = authGeneration, capturedUser = user; return { user: capturedUser, current: () => captured === authGeneration }; },
    home: () => { clone.hide(); owner.leave(); }, navigate: () => {}, changed: () => {}, openWorkspace: () => {},
    authLost: () => { authGeneration++; clone.reset(); owner.invalidate(); },
  });
  const clone = createCloneFlow(owner.env, createCredentialFlows(owner.env).unlock, () => {});
  const show = () => { owner.begin(); clone.show(); };
  const region = () => modal ?? root;
  const click = (key: string) => { const button = region().querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`); if (!button) throw new Error(`Missing action ${key}: ${region().textContent}`); button.click(); };
  const input = (name: string) => region().querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const fill = (name: string, value: string) => { const control = input(name); if (control.tagName === "SELECT") Object.defineProperty(control, "value", { value, writable: true, configurable: true }); else control.value = value; control.dispatchEvent(new window.Event("input", { bubbles: true })); control.dispatchEvent(new window.Event("change", { bubbles: true })); };
  const destroy = () => { clone.reset(); owner.invalidate(); host.remove(); };
  cleanups.push(destroy);
  return { show, root, host, region, click, input, fill, destroy,
    changeUser(next: string) { user = next; authGeneration++; clone.reset(); owner.invalidate(); },
    transientUnavailable() { user = ""; clone.hide(); owner.leave(); },
    restoreLabel() { user = "reviewer"; },
  };
}
async function form(h: ReturnType<typeof mount>, folder = "attempt-checkout") {
  h.show(); await settle(); h.fill("url", "https://github.com/review/example.git"); h.fill("folderName", folder); h.fill("displayName", "Recovery review");
}
const commit = async (h: ReturnType<typeof mount>) => { h.click("review"); h.click("commit-sheet"); await settle(); };
const hint = (user = "reviewer") => parseCloneRecoveryHint(storage.get(cloneAttemptStorageKey(user)) ?? null);

describe("authoritative clone attempts against the synthetic server model", () => {
  test("persists an opaque attempt before dispatch; after-effect response loss reconciles the original job", async () => {
    const model = createSyntheticBackend(); const ids: string[] = [];
    const backend: MobileHubBackend = { ...model.backend, submitClone: async intent => {
      ids.push(intent.attemptId); expect(hint()?.attemptId).toBe(intent.attemptId);
      expect(JSON.stringify([...storage])).not.toContain(intent.url);
      await model.backend.submitClone(intent); throw new TypeError("Network response lost");
    } };
    const h = mount(backend); await form(h); await commit(h);
    expect(model.inspect().jobs).toHaveLength(1); expect(ids).toHaveLength(1);
    expect(h.region().textContent).toContain("Clone Progress"); expect(hint()?.jobId).toBe(model.inspect().jobs[0]!.id);
    h.destroy(); const reloaded = mount(backend); reloaded.show(); await settle();
    expect(reloaded.region().textContent).toContain("Clone Progress"); expect(ids).toHaveLength(1); expect(model.inspect().jobs).toHaveLength(1);
  });
  test("before-effect loss resolves not-accepted; only explicit review mints a new attempt", async () => {
    const model = createSyntheticBackend(); model.fail("submitClone", "indeterminate-before"); const intents: CloneSubmissionIntent[] = [];
    const h = mount({ ...model.backend, submitClone: intent => { intents.push(intent); return model.backend.submitClone(intent); } });
    await form(h); await commit(h);
    expect(model.inspect().jobs).toHaveLength(0); expect(h.region().textContent).toContain("not accepted and has been fenced"); expect(hint()).toBeNull();
    model.fail("submitClone", null); await settle(); expect(intents).toHaveLength(1);
    await commit(h); expect(intents).toHaveLength(2); expect(intents[0]!.attemptId).not.toBe(intents[1]!.attemptId); expect(model.inspect().jobs).toHaveLength(1);
    const late = await model.backend.submitClone(intents[0]!); expect(late.status).toBe("rejected"); expect(model.inspect().jobs).toHaveLength(1);
  });
  test("reload while admission is held reconciles pending, then accepted, without duplicate dispatch", async () => {
    const model = createSyntheticBackend(); model.hold("submitClone"); let submits = 0;
    const backend = { ...model.backend, submitClone: (intent: CloneSubmissionIntent) => { submits++; return model.backend.submitClone(intent); } };
    const first = mount(backend); await form(first); first.click("review"); first.click("commit-sheet"); await settle();
    expect(hint()?.attemptId).toBeDefined(); first.destroy();
    const next = mount(backend); next.show(); await settle(); expect(next.region().textContent).toContain("still pending"); expect(next.region().querySelector('[data-flow="review"]')).toBeNull();
    model.settle("submitClone"); await settle(); next.click("reconcile"); await settle();
    expect(next.region().textContent).toContain("Clone Progress"); expect(submits).toBe(1); expect(model.inspect().jobs).toHaveLength(1);
  });
  test.each(["expired", "unavailable"] as const)("%s is not a retry authorization, including after Back and reload", async state => {
    const model = createSyntheticBackend(); model.hold("submitClone"); const first = mount(model.backend); await form(first); first.click("review"); first.click("commit-sheet"); await settle();
    const id = hint()!.attemptId;
    if (state === "expired") model.expireCloneAttempt(id); else model.fail("reconcileCloneAttempt", { kind: "unavailable", message: "ignored" });
    first.destroy(); const next = mount(model.backend); next.show(); await settle();
    expect(next.region().textContent).toContain(state === "expired" ? "no longer authoritative enough" : "reconciliation is unavailable");
    expect(next.region().textContent).not.toContain("No clone has been submitted"); expect(next.region().querySelector('[data-flow="review"], [data-flow="forget-hint"]')).toBeNull();
    next.click("flow-back"); expect(hint()?.attemptId).toBe(id); next.show(); await settle(); expect(hint()?.attemptId).toBe(id);
    model.settle("submitClone"); await settle(); expect(model.snapshot().log.filter(row => row.method === "submitClone")).toHaveLength(1);
  });
  test("requires-unlock fences its id; the authorized continuation gets a fresh id", async () => {
    const model = createSyntheticBackend(); const ids: string[] = [];
    const h = mount({ ...model.backend, submitClone: intent => { ids.push(intent.attemptId); return model.backend.submitClone(intent); } });
    await form(h); h.fill("url", "ssh://git@github.com/review/example.git"); h.fill("cloneCredential", "ssh-locked"); await commit(h);
    expect(h.region().textContent).toContain("Unlock Clone Identity"); expect(hint()).toBeNull();
    h.fill("passphrase", "disposable"); h.click("commit-sheet"); await settle();
    expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]); expect(model.inspect().jobs).toHaveLength(1);
    expect(await model.backend.reconcileCloneAttempt({ attemptId: ids[0]! })).toEqual({ status: "available", value: { status: "not-accepted" } });
  });
  test("input is limited to cloning and unknown input acceptance stays blocked across reload", async () => {
    const model = createSyntheticBackend(); model.fail("sendCloneInput", "indeterminate-after");
    const h = mount(model.backend); await form(h); await commit(h); const id = model.inspect().jobs[0]!.id;
    h.fill("response", "DISPOSABLE-INPUT-SECRET"); h.click("send"); expect(h.input("response").disabled).toBe(true); expect(h.input("response").value).toBe(""); await settle();
    expect(hint()?.inputUncertain).toBe(true); expect(JSON.stringify([...storage])).not.toContain("DISPOSABLE");
    h.click("send"); expect(model.snapshot().log.filter(row => row.method === "sendCloneInput")).toHaveLength(1);
    h.destroy(); const next = mount(model.backend); next.show(); await settle(); expect(next.input("response").disabled).toBe(true); expect(next.region().textContent).toContain("Input acceptance is unknown");
    model.clonePhase(id, "registering"); next.click("send"); expect(model.snapshot().log.filter(row => row.method === "sendCloneInput")).toHaveLength(1);
  });
  test("registering and starting phases clear unsent input and disable Send without backend calls", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await form(h); h.input("start").checked = true; await commit(h); const id = model.inspect().jobs[0]!.id;
    h.fill("response", "UNSENT"); model.clonePhase(id, "registering"); expect(h.input("response").value).toBe(""); expect(h.input("response").disabled).toBe(true);
    h.click("send"); model.clonePhase(id, "starting"); h.click("send"); expect(model.snapshot().log.filter(row => row.method === "sendCloneInput")).toHaveLength(0);
  });
  test("late acceptance uses the captured user during transient unavailability", async () => {
    const model = createSyntheticBackend(), response = deferred<void>();
    const h = mount({ ...model.backend, submitClone: async intent => { const result = await model.backend.submitClone(intent); await response.promise; return result; } });
    await form(h); h.click("review"); h.click("commit-sheet"); await settle(); h.transientUnavailable(); response.resolve(); await settle();
    expect(hint("reviewer")?.jobId).toBe(model.inspect().jobs[0]!.id); expect(hint("")).toBeNull(); h.restoreLabel(); h.show(); await settle(); expect(h.region().textContent).toContain("Clone Progress");
  });
  test("a background not-accepted reconciliation updates ownership without promoting its form", async () => {
    const model = createSyntheticBackend(); model.fail("submitClone", "indeterminate-before"); model.hold("reconcileCloneAttempt");
    const h = mount(model.backend); await form(h); await commit(h); h.click("flow-back");
    expect(h.root.hidden).toBe(true); model.settle("reconcileCloneAttempt"); await settle();
    expect(h.root.hidden).toBe(true); expect(h.root.textContent).toBe(""); expect(hint()).toBeNull();
    h.show(); await settle(); expect(h.region().textContent).toContain("not accepted and has been fenced"); expect(h.input("folderName").value).toBe("attempt-checkout");
  });
  test("late acceptance cannot write a new identity's recovery hint or resurrect its old UI", async () => {
    const model = createSyntheticBackend(), response = deferred<void>();
    const h = mount({ ...model.backend, submitClone: async intent => { const result = await model.backend.submitClone(intent); await response.promise; return result; } });
    await form(h); h.click("review"); h.click("commit-sheet"); await settle(); const id = hint()!.attemptId;
    h.changeUser("another-user"); response.resolve(); await settle();
    expect(hint("another-user")).toBeNull(); expect(hint("reviewer")).toEqual({ version: 2, attemptId: id }); expect(h.root.textContent).toBe("");
  });
  test.each(["https://name:DISPOSABLE@github.com/repo", "https://github.com/repo?token=DISPOSABLE", "https://github.com/repo#DISPOSABLE", "ssh://git:DISPOSABLE@github.com/repo"])("secret-bearing URL %s is discarded before any retained draft or storage", async url => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await form(h); h.fill("url", url);
    expect(h.input("url").value).toBe(""); h.click("flow-back"); h.click("cancel-sheet"); expect(h.input("url").value).toBe("");
    expect(h.region().textContent).not.toContain("DISPOSABLE"); expect(JSON.stringify([...storage])).not.toContain("DISPOSABLE"); expect(model.inspect().jobs).toHaveLength(0);
  });
  test("storage denial stops dispatch rather than losing the required reload identity", async () => {
    const model = createSyntheticBackend(); const h = mount(model.backend); await form(h);
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: { getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } } });
    await commit(h); expect(h.region().textContent).toContain("No clone was submitted"); expect(model.snapshot().log.filter(row => row.method === "submitClone")).toHaveLength(0);
  });
  test("recovery hints cannot contain secret/form fields or malformed ids", () => {
    expect(parseCloneRecoveryHint(JSON.stringify({ version: 2, attemptId: "attempt-valid", url: "secret" }))).toBeNull();
    expect(parseCloneRecoveryHint(JSON.stringify({ version: 2, attemptId: "/host/path" }))).toBeNull();
    expect(parseCloneRecoveryHint(JSON.stringify({ version: 2, attemptId: "attempt-valid", jobId: "job-1", inputUncertain: true }))).toEqual({ version: 2, attemptId: "attempt-valid", jobId: "job-1", inputUncertain: true });
  });
});
