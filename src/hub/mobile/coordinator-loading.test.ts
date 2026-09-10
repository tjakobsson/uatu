import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { mountMobileCoordinator } from "./coordinator";
import { workspaceInitialUrl, workspaceForeground, writeMobileHistory } from "./coordinator-context";
import { isHubAvailable, invalidateAuthenticatedHubContext } from "../../shell/hub-nav";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";

const saved = new Map<string, PropertyDescriptor | undefined>();
let destroy: (() => void) | undefined;
function install(key: string, value: unknown) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterEach(() => {
  destroy?.(); destroy = undefined;
  invalidateAuthenticatedHubContext();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness() {
  const dom = parseHTML('<html><body><div id="workspace"><span>0 files</span></div><div id="hub"></div></body></html>');
  install("window", dom.window); install("document", dom.document);
  install("Event", dom.window.Event);
  const location = new URL("https://example.invalid/s/atlas/?file=README.md#saved");
  const assigned: string[] = [];
  Object.assign(location, { assign: (url: string) => assigned.push(url) });
  install("location", location);
  const history = { state: {}, pushState(state: object, _: string, url: string) { this.state = state; location.href = new URL(url, location).href; }, replaceState(state: object, _: string, url: string) { this.pushState(state, _, url); } };
  install("history", history);
  install("requestAnimationFrame", () => 0); install("cancelAnimationFrame", () => {});
  dom.window.HTMLElement.prototype.focus = () => {};
  let resolve!: () => void, reject!: (reason: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  let boots = 0, reveals = 0;
  const workspaceRoot = document.getElementById("workspace")!;
  const hubRoot = document.getElementById("hub")!;
  const synthetic = createSyntheticBackend();
  synthetic.reset("all-running");
  const backend = synthetic.backend;
  const coordinator = mountMobileCoordinator({ workspaceRoot, hubRoot, backend, workspaceId: "atlas", basePath: "/s/atlas/", eligible: () => true,
    bootWorkspace: () => { boots++; expect(isHubAvailable()).toBe(true); return pending; }, revealNavigation: () => { reveals++; } });
  destroy = coordinator.destroy;
  return { coordinator, backend, workspaceRoot, location, assigned, resolve, reject, boots: () => boots, reveals: () => reveals,
    loader: () => document.querySelector<HTMLElement>(".mh-coordinator-loading")! };
}

test("direct cold boot has one reachable Back; abandoned boot never promotes Settings; return reuses it", async () => {
  const h = harness();
  expect(h.loader().hidden).toBe(false);
  expect(h.workspaceRoot.inert).toBe(true);
  expect(workspaceForeground()).toBe(false);
  expect(h.workspaceRoot.hasAttribute("data-workspace-loading")).toBe(true);
  await settle();
  expect(h.boots()).toBe(1);
  h.loader().querySelector<HTMLButtonElement>("button")!.click();
  expect(h.location.pathname).toBe("/");
  expect(h.loader().hidden).toBe(true);
  h.coordinator.showHub("settings");
  expect(workspaceInitialUrl().pathname + workspaceInitialUrl().search + workspaceInitialUrl().hash).toBe("/s/atlas/?file=README.md#saved");
  h.resolve(); await settle();
  expect(h.location.pathname).toBe("/settings");
  expect(h.workspaceRoot.inert).toBe(true);
  expect(h.reveals()).toBe(0);
  expect(await h.coordinator.openWorkspace("atlas")).toBe(true);
  expect(h.boots()).toBe(1);
  expect(h.workspaceRoot.inert).toBe(false);
  expect(workspaceForeground()).toBe(true);
  expect(h.location.pathname + h.location.search + h.location.hash).toBe("/s/atlas/?file=README.md#saved");
  expect(h.reveals()).toBe(1);
});

test("failed boot returns to Hub; explicit Open reloads without a duplicate boot", async () => {
  const h = harness(); await settle();
  h.reject(new Error("Import failed")); await settle();
  expect(h.location.pathname).toBe("/");
  expect(h.workspaceRoot.inert).toBe(true);
  expect(h.loader().hidden).toBe(true);
  expect(await h.coordinator.openWorkspace("atlas")).toBe(false);
  expect(h.assigned).toEqual(["/s/atlas/?file=README.md#saved"]);
  expect(h.boots()).toBe(1);
});

test("switch to another workspace is a document navigation, not a second resident boot", async () => {
  const h = harness(); await settle();
  h.coordinator.showHub("hub");
  // The synthetic second running workspace is selected by its real backend identity.
  const rows = await h.backend.readWorkspaces();
  if (rows.status !== "available") throw new Error("Synthetic workspaces unavailable");
  const other = rows.value.find(row => row.id !== "atlas" && row.runtime.status === "running")!;
  expect(other).toBeDefined();
  expect(await h.coordinator.openWorkspace(other.id)).toBe(false);
  expect(h.assigned).toEqual([`/s/${other.id}/`]);
  expect(h.boots()).toBe(1);
  h.resolve(); await settle();
});

test("failure after Back stays on Settings and remembers that the singleton requires explicit reload", async () => {
  const h = harness(); await settle();
  h.coordinator.showHub("settings");
  h.reject(new Error("Late import failure")); await settle();
  expect(h.location.pathname).toBe("/settings");
  expect(h.loader().hidden).toBe(true);
  expect(h.reveals()).toBe(0);
  expect(await h.coordinator.openWorkspace("atlas")).toBe(false);
  expect(h.assigned).toEqual(["/s/atlas/?file=README.md#saved"]);
  expect(h.boots()).toBe(1);
});

test("ready activation uses its current intent and commits history retained during noninteractive loading", async () => {
  const h = harness(); await settle();
  expect(workspaceForeground()).toBe(false);
  writeMobileHistory({ documentId: "doc" }, "/s/atlas/guide.md#saved", true);
  h.resolve(); await settle();
  expect(workspaceForeground()).toBe(true);
  expect(h.location.pathname + h.location.hash).toBe("/s/atlas/guide.md#saved");
  expect(h.loader().hidden).toBe(true);
  expect(h.reveals()).toBe(1);
});

test("Stop during loading abandons the resident intent without revoking authenticated Hub availability", async () => {
  const h = harness(); await settle();
  expect(isHubAvailable()).toBe(true);
  await h.backend.stopWorkspace("atlas"); await settle();
  expect(h.loader().hidden).toBe(true);
  expect(h.location.pathname).toBe("/");
  expect(isHubAvailable()).toBe(true);
  h.resolve(); await settle();
  expect(workspaceForeground()).toBe(false);
  expect(h.reveals()).toBe(0);
  await h.backend.signOut(); await settle();
  expect(isHubAvailable()).toBe(false);
});

test("ready activation does not restore query parameters removed by native boot URL cleanup", async () => {
  const h = harness(); await settle();
  h.location.search = "";
  h.resolve(); await settle();
  expect(workspaceForeground()).toBe(true);
  expect(h.location.pathname + h.location.search + h.location.hash).toBe("/s/atlas/#saved");
});
