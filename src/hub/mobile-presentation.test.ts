import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { dashboardPage, clonePage, settingsPage, loginPage } from "./pages";
import { navigationPreferencesClientSource } from "./navigation-preferences-client";

test("all authenticated Hub documents deliver mobile navigation and parseable client code", () => {
  for (const render of [dashboardPage, clonePage, settingsPage]) {
    const { document } = parseHTML(render("test"));
    const nav = document.querySelector(".hub-mobile-nav")!;
    expect([...nav.children].map(child => child.id || child.textContent)).toEqual(["hub-return", "Hub", "Settings"]);
    expect(nav.querySelector("#hub-return")!.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector('.hub-nav a[href="/clone"]')).not.toBeNull();
    expect(document.querySelector('form[action="/logout"][method="post"]')).not.toBeNull();
    for (const script of document.querySelectorAll("script")) expect(() => new Function(script.textContent!)).not.toThrow();
  }
  expect(loginPage()).not.toContain('id="hub-return"');
});

test("Hub Settings serializes the shared preference validation and key", () => {
  const values = new Map<string, string>();
  const window = { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) }, addEventListener: () => {} };
  const client = new Function("window", `${navigationPreferencesClientSource}; return { getNavigationPreferences, setNavigationPreferences };`)(window);
  client.setNavigationPreferences({ side: "right", position: 2, autoHide: false, previewSide: "right" });
  expect(client.getNavigationPreferences()).toEqual({ side: "right", position: 1, autoHide: false, previewSide: "right" });
  expect([...values.keys()]).toEqual(["uatu:navigation:v1:hub"]);
  client.setNavigationPreferences({ side: "invalid", position: NaN });
  expect(client.getNavigationPreferences().side).toBe("right");
});

test("release minification preserves both inline client deliveries", async () => {
  for (const entry of ["./src/hub/navigation-preferences-client.ts", "./src/hub/return-navigation.ts"]) {
    const build = await Bun.build({ entrypoints: [entry], target: "bun", minify: true });
    expect(build.success).toBe(true);
    const module = await import("data:text/javascript;base64," + Buffer.from(await build.outputs[0]!.text()).toString("base64"));
    if (module.navigationPreferencesClientSource) {
      const client = new Function("window", module.navigationPreferencesClientSource + "; return getNavigationPreferences();")({
        localStorage: { getItem: () => null }, addEventListener: () => {},
      });
      expect(client.side).toBe("left");
    } else {
      const factory = new Function(`return (${module.createReturnNavigation.toString()});`)();
      expect(await factory({ storage: () => ({ getItem: () => null }), changed: () => {} }).validate()).toBeNull();
    }
  }
});
