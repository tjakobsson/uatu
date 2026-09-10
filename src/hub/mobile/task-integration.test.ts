import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { mountMobileHub } from "./frontend";
import { mobileHubPath } from "./coordinator";
import { createTaskHistory } from "./task-history";

const originals = new Map(["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let document: Document, cleanup: (() => void) | undefined;
beforeEach(() => {
  const dom = parseHTML('<html><body><div id="hub"></div></body></html>'); document = dom.document as unknown as Document;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window }); Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
});
afterEach(() => { cleanup?.(); cleanup = undefined; for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

test("coordinated Stop survives real model workspace/catalog invalidations and renders the disabled credential", async () => {
  const model = createSyntheticBackend(); model.reset("credentials");
  const events: string[] = []; model.backend.subscribeInvalidation(event => events.push(event.scope));
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, model.backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {} }); cleanup = ui.destroy;
  await ui.ready; ui.show("settings", { kind: "credential", id: "token-github" }); await settle();
  const click = (key: string) => root.querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`)!.click();
  click("toggle"); click("commit-sheet"); await settle();
  expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain("Stop and continue");
  click("commit-sheet"); await settle();
  expect(events).toContain("workspace"); expect(events).toContain("catalog");
  expect(model.inspect().credentials.find(c => c.id === "token-github")?.enabled).toBe(false);
  expect(root.querySelector(".mh-task")).toBeNull();
  expect(root.querySelector(".mh-flow-page")?.textContent).toContain("Disabled");
  expect(root.querySelector<HTMLButtonElement>('[data-flow="toggle"]')?.textContent).toContain("Enable");
});

test("leaving for another destination during a pending command clears secrets and revokes stale success", async () => {
  const model = createSyntheticBackend(); model.reset("credentials"); model.hold("unlockCredential");
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, model.backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {} }); cleanup = ui.destroy;
  await ui.ready; ui.show("settings", { kind: "credential", id: "ssh-locked" }); await settle();
  root.querySelector<HTMLButtonElement>('[data-flow="unlock"]')!.click();
  const input = root.querySelector<HTMLInputElement>('input[type="password"]')!; input.value = "synthetic-test-passphrase";
  root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!.click(); await settle();
  ui.suspend();
  expect(input.value).toBe(""); expect(input.isConnected).toBe(false);
  ui.show("settings"); root.querySelector<HTMLButtonElement>('[data-action="preview-side"]')!.click();
  const next = root.querySelector(".mh-task"); model.settle("unlockCredential"); await settle();
  expect(root.querySelector(".mh-task")).toBe(next); expect(next?.textContent).toContain("Preview File Controls");
});

test.each([false, true])("same-context Back cannot reopen Create after dispatch; retained failure=%s", async failed => {
  const model = createSyntheticBackend(); if (failed) model.setOnboardingFault("register-failed");
  let release!: () => void, effect!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), effected = new Promise<void>(resolve => { effect = resolve; });
  const backend = { ...model.backend, createWorkspace: async (intent: Parameters<typeof model.backend.createWorkspace>[0]) => {
    calls++; const result = await model.backend.createWorkspace(intent); effect(); await gate; return result;
  } };
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {} }); cleanup = ui.destroy;
  await ui.ready; ui.show("settings", { kind: "add-workspace" }); await settle();
  const click = (key: string) => root.querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`)!.click();
  click("create"); await settle();
  for (const [name, value] of Object.entries({ parent: "/synthetic", folderName: "pending-create", displayName: "Pending create" })) root.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  Object.defineProperty(root.querySelector('[name="init"]')!, "checked", { configurable: true, value: true });
  click("commit-sheet"); click("commit-sheet"); await effected; await settle();
  const review = root.querySelector(".mh-task")!;
  expect(review.getAttribute("aria-busy")).toBe("true");
  expect(ui.cancelTaskFromHistory()).toBe("blocked");
  expect(root.querySelector(".mh-task")).toBe(review); expect(root.querySelector('[name="folderName"]')).toBeNull();
  click("commit-sheet"); expect(calls).toBe(1);
  release(); await settle();
  expect(root.querySelector(".mh-task")).toBeNull();
  expect(root.querySelector(".mh-flow-page h1")?.textContent).toBe(failed ? "Configuration needs attention" : "Workspace configured");
  expect(root.querySelector(".mh-flow-page")?.textContent).toContain("/synthetic/pending-create");
  expect(calls).toBe(1);
});

test("same-context Back cannot reopen Assignment Apply after its effect while the response is pending", async () => {
  const model = createSyntheticBackend(); let release!: () => void, effect!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), effected = new Promise<void>(resolve => { effect = resolve; });
  const backend = { ...model.backend, assignWorkspace: async (intent: Parameters<typeof model.backend.assignWorkspace>[0]) => { calls++; const result = await model.backend.assignWorkspace(intent); effect(); await gate; return result; } };
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {} }); cleanup = ui.destroy;
  await ui.ready; ui.show("settings", { kind: "assignments" }); await settle();
  const click = (key: string) => root.querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`)!.click();
  click("workspace-atlas"); await settle(); click("edit-atlas");
  Object.defineProperty(root.querySelector('[name="authentication"]')!, "value", { configurable: true, value: "token-github" });
  root.querySelector<HTMLInputElement>('[name="host"]')!.value = "github.com";
  click("commit-sheet"); click("commit-sheet"); await effected; await settle();
  const review = root.querySelector(".mh-task"); expect(ui.cancelTaskFromHistory()).toBe("blocked");
  expect(root.querySelector(".mh-task")).toBe(review); click("commit-sheet"); expect(calls).toBe(1);
  release(); await settle();
  expect(root.querySelector(".mh-task")).toBeNull(); expect(root.querySelector(".mh-flow-page")?.textContent).toContain("github.com"); expect(calls).toBe(1);
});

test("credential Save closes then navigates without an asynchronous Back overriding the result or serializing secrets", async () => {
  const model = createSyntheticBackend();
  const entries: Array<{ state: any; url: string }> = [{ state: {}, url: "/settings" }, { state: { mobileHub: { route: "settings" } }, url: "/settings?detail=add-credential" }];
  let backs = 0;
  const history = { get state() { return entries.at(-1)!.state; }, pushState(state: any, _title: string, url: string) { entries.push({ state, url }); }, replaceState(state: any, _title: string, url: string) { entries[entries.length - 1] = { state, url }; }, back() { backs++; } };
  const tasks = createTaskHistory(history, () => entries.at(-1)!.url);
  const root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, model.backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {}, taskChanged(open) { if (open) tasks.open({ route: "settings" }); else tasks.close(); }, detailChanged(detail) { tasks.write({ mobileHub: { route: "settings" } }, mobileHubPath("settings", detail), false); } }); cleanup = () => { tasks.destroy(); ui.destroy(); };
  await ui.ready; ui.show("settings", { kind: "add-credential" }); await settle();
  root.querySelector<HTMLButtonElement>('[data-flow="token"]')!.click();
  for (const [name, value] of Object.entries({ name: "New identity", host: "github.com", token: "SECRET-NEVER-IN-HISTORY" })) root.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  const capability = root.querySelector<HTMLInputElement>('[name="cap"]')!; Object.defineProperty(capability, "checked", { configurable: true, value: true });
  root.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]')!.click(); await settle();
  expect(backs).toBe(0); expect(entries).toHaveLength(3);
  expect(entries.at(-1)!.url).toMatch(/detail=credential&id=/);
  expect(JSON.stringify(entries)).not.toContain("SECRET-NEVER-IN-HISTORY"); expect(JSON.stringify(entries)).not.toContain("New identity");
  expect(root.querySelector(".mh-task")).toBeNull(); expect(root.querySelector(".mh-flow-page h1")?.textContent).toBe("New identity");
});

test("Editor → Review → Back to edit preserves the assignment draft in one workflow entry", async () => {
  const model = createSyntheticBackend();
  const entries: Array<{ state: any; url: string }> = [{ state: {}, url: "/settings" }, { state: { mobileHub: { route: "settings" } }, url: "/settings?detail=assignments" }];
  let backs = 0;
  const history = { get state() { return entries.at(-1)!.state; }, pushState(state: any, _title: string, url: string) { entries.push({ state, url }); }, replaceState(state: any, _title: string, url: string) { entries[entries.length - 1] = { state, url }; }, back() { backs++; } };
  const tasks = createTaskHistory(history, () => entries.at(-1)!.url), root = document.querySelector<HTMLElement>("#hub")!;
  const ui = mountMobileHub(root, model.backend, { navigateWorkspace() {}, returnToWorkspace() {}, setRoute() {}, taskChanged(open) { if (open) tasks.open({ route: "settings" }); else tasks.close(); } }); cleanup = () => { tasks.destroy(); ui.destroy(); };
  await ui.ready; ui.show("settings", { kind: "assignments" }); await settle();
  const click = (key: string) => root.querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`)!.click();
  click("workspace-atlas"); await settle(); click("edit-atlas");
  const select = root.querySelector<HTMLSelectElement>('[name="authentication"]')!;
  Object.defineProperty(select, "value", { value: "token-github", configurable: true });
  root.querySelector<HTMLInputElement>('[name="host"]')!.value = "github.com";
  click("commit-sheet");
  expect(root.querySelector(".mh-task h1")?.textContent).toBe("Review workspace credentials");
  expect(entries).toHaveLength(3); expect(root.querySelector('[data-action="cancel-sheet"]')?.textContent).toBe("Back to edit");
  click("cancel-sheet"); await settle();
  expect(root.querySelector(".mh-task h1")?.textContent).toBe("Edit workspace credentials");
  expect(root.querySelector<HTMLSelectElement>('[name="authentication"]')!.value).toBe("token-github");
  expect(root.querySelector<HTMLInputElement>('[name="host"]')!.value).toBe("github.com");
  expect(backs).toBe(0); expect(entries).toHaveLength(3); expect(JSON.stringify(entries)).not.toContain("github.com");
});
