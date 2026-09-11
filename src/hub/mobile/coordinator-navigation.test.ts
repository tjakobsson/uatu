import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { mountMobileCoordinator } from "./coordinator";
import { dispatchMobileHistory } from "./coordinator-context";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";

const saved = new Map<string, PropertyDescriptor | undefined>();
let destroy: (() => void) | undefined;
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => {
  destroy?.(); destroy = undefined;
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  saved.clear();
});

test.each(["browse", "review"])("browser Back from creation %s retains its draft task entry; next Back exits to Add Workspace", async nested => {
  const dom = parseHTML('<html><body><div id="hub"></div><div id="workspace"></div></body></html>');
  const location = new URL("https://example.invalid/");
  const entries: Array<{ state: any; url: string }> = [{ state: {}, url: location.href }]; let index = 0;
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: any, _: string, url: string) { entries.splice(++index); entries.push({ state, url: new URL(url, location).href }); location.href = entries[index]!.url; },
    replaceState(state: any, _: string, url?: string) { entries[index] = { state, url: url ? new URL(url, location).href : location.href }; location.href = entries[index]!.url; },
    back() { if (!index) return; index--; location.href = entries[index]!.url; dispatchMobileHistory({ state: history.state } as PopStateEvent); },
    forward() { if (index + 1 === entries.length) return; index++; location.href = entries[index]!.url; dispatchMobileHistory({ state: history.state } as PopStateEvent); },
  };
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, Event: dom.window.Event, location, history, requestAnimationFrame: (): number => 0, cancelAnimationFrame: (): void => {} })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
  const model = createSyntheticBackend(); const before = structuredClone(model.inspect());
  const root = document.getElementById("hub")!;
  const ui = mountMobileCoordinator({ hubRoot: root, workspaceRoot: document.getElementById("workspace")!, backend: model.backend, workspaceId: "atlas", basePath: "/s/atlas/", bootWorkspace: async () => {}, revealNavigation() {}, eligible: () => true }); destroy = ui.destroy;
  await ui.ready; ui.showHub("hub", true, { kind: "add-workspace" });
  const click = (key: string) => (root.querySelector(".mh-task") ?? root.querySelector(".mh-flow-page")!).querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`)!.click();
  click("create"); await settle();
  for (const [name, value] of Object.entries({ parent: "/synthetic", folderName: "draft-folder", displayName: "Draft name" })) root.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  Object.defineProperty(root.querySelector('[name="init"]')!, "checked", { configurable: true, value: true });
  click(nested === "browse" ? "browse" : "commit-sheet"); await settle();
  history.back(); await settle();
  expect(root.querySelector<HTMLInputElement>('[name="folderName"]')?.value).toBe("draft-folder");
  expect(history.state.mobileHub.task).toBe(true);
  history.back(); await settle();
  expect(root.querySelector(".mh-task")).toBeNull();
  expect(root.querySelector(".mh-flow-page h1")?.textContent).toBe("Add Workspace");
  expect(location.search).toBe("?detail=add-workspace");
  history.forward(); await settle();
  expect(root.querySelector(".mh-task")).toBeNull();
  expect(root.querySelector(".mh-flow-page h1")?.textContent).toBe("Add Workspace");
  expect(model.inspect()).toEqual(before);
});
