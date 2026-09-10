import { afterEach, expect, test } from "bun:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let instance = 0;
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
async function harness(saved: unknown = null, denied = false) {
  let current = JSON.stringify(saved);
  const writes: Array<{ key: string; value: string }> = [];
  let storageChanged = (_event: unknown) => {};
  const storage = {
    getItem: (_key: string) => { if (denied) throw new Error("Storage denied"); return current; },
    setItem: (key: string, value: string) => { if (denied) throw new Error("Storage denied"); writes.push({ key, value }); current = value; },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, addEventListener: (type: string, listener: (e: unknown) => void) => { if (type === "storage") storageChanged = listener; } } });
  // Independent module lifetimes model independent devices, without a product
  // reset-for-tests API or interference with other preference-owner tests.
  const owner = await import(`./navigation-preferences.ts?placement-test=${++instance}`) as typeof import("./navigation-preferences");
  return { owner, writes, external(value: unknown) { current = JSON.stringify(value); storageChanged({ key: null, storageArea: storage }); } };
}

test("fresh default calibrates only placement, without persisting on read", async () => {
  const h = await harness();
  expect(h.owner.DEFAULT_NAVIGATION_PLACEMENT).toEqual({ side: "left", position: 73.73 / 100 });
  expect(h.owner.getNavigationPreferences()).toEqual({ side: "left", position: 73.73 / 100, autoHide: true, previewSide: "left" });
  expect(8 + (844 - 16 - 44) * h.owner.DEFAULT_NAVIGATION_PLACEMENT.position + 2).toBeCloseTo(588.0432, 4);
  expect(h.writes).toEqual([]);
});
for (const side of ["left", "right"] as const) {
  test(`valid saved ${side} ratios retain exact values and are never migrated`, async () => {
    for (const position of [0, .1, .72, .721234, .7373, .98, 1]) {
      const saved = { side, position, autoHide: false, previewSide: "right" as const };
      const h = await harness(saved);
      expect(h.owner.getNavigationPreferences()).toEqual(saved);
      h.owner.confirmNavigationHubScope();
      expect(h.owner.getNavigationPreferences()).toEqual(saved);
      expect(h.writes).toEqual([]);
    }
  });
}
test("explicit reset changes only placement and retains the existing serialized shape", async () => {
  const h = await harness({ side: "right", position: .72, autoHide: false, previewSide: "right" });
  h.owner.setNavigationPreferences(h.owner.DEFAULT_NAVIGATION_PLACEMENT);
  expect(h.owner.getNavigationPreferences()).toEqual({ side: "left", position: 73.73 / 100, autoHide: false, previewSide: "right" });
  expect(Object.keys(JSON.parse(h.writes[0]!.value)).sort()).toEqual(["autoHide", "position", "previewSide", "side"]);
  expect(h.writes).toHaveLength(1);
});
test("missing/invalid placement uses the new default; storage events preserve valid saved placement", async () => {
  const h = await harness({ side: "right", position: "invalid", autoHide: false });
  expect(h.owner.getNavigationPreferences()).toEqual({ side: "right", position: 73.73 / 100, autoHide: false, previewSide: "left" });
  h.external({ side: "left", position: .72, autoHide: true, previewSide: "right" });
  expect(h.owner.getNavigationPreferences().position).toBe(.72);
  expect(h.writes).toEqual([]);
});
test("storage denial keeps fresh/reset defaults usable in memory", async () => {
  const h = await harness(null, true);
  expect(h.owner.getNavigationPreferences().position).toBe(73.73 / 100);
  h.owner.setNavigationPreferences({ side: "right", position: .72 });
  expect(h.owner.getNavigationPreferences().position).toBe(.72);
  h.owner.setNavigationPreferences(h.owner.DEFAULT_NAVIGATION_PLACEMENT);
  expect(h.owner.getNavigationPreferences().position).toBe(73.73 / 100);
});
