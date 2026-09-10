import { expect, test } from "bun:test";
import { chromium, webkit } from "@playwright/test";

// Real markup/CSS before app.js arrives: no server, network or timer-based boot.
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: cold navigation stays noninteractive before its owner is ready`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const html = await Bun.file(new URL("../../src/index.html", import.meta.url)).text();
      const css = await Bun.file(new URL("../../src/styles.css", import.meta.url)).text();
      await page.route("**/*", route => route.abort());
      await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, ""), { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: css });
      await page.evaluate(() => {
        document.documentElement.dataset.uiMode = "touch";
        document.documentElement.dataset.activeTab = "files";
      });
      const snapshot = await page.evaluate(() => {
        const controls = ["navigation-handle", "touch-tab-bar"].map(id => document.getElementById(id)!);
        return controls.map(element => ({
          visible: getComputedStyle(element).visibility,
          inert: element.inert,
        }));
      });
      expect(snapshot).toEqual([{ visible: "hidden", inert: true }, { visible: "hidden", inert: true }]);
      // A failed import leaves the same safe presentation, not a partial selector.
      expect(await page.locator("html").getAttribute("data-active-tab")).toBe("files");
      const build = await Bun.build({ entrypoints: [new URL("../../src/shell/tab-bar.ts", import.meta.url).pathname], target: "browser" });
      expect(build.success).toBe(true);
      const source = await build.outputs[0]!.text();
      await page.evaluate(async source => {
        const owner = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        (window as any).navigationOwner = owner;
        owner.initTabBar();
        owner.setActiveTab("files");
      }, source);
      expect(await page.locator("#touch-tab-bar").evaluate(element => {
        if (!(element instanceof HTMLElement)) throw new Error("Expected HTML navigation");
        return element.inert;
      })).toBe(true);
      expect(await page.locator("#touch-tab-bar").evaluate(element => getComputedStyle(element).visibility)).toBe("hidden");
      await page.evaluate(() => (window as any).navigationOwner.navigationWorkspaceReady());
      expect(await page.locator("#touch-tab-bar").evaluate(element => {
        if (!(element instanceof HTMLElement)) throw new Error("Expected HTML navigation");
        return element.inert;
      })).toBe(false);
      expect(await page.locator("#touch-tab-bar").evaluate(element => getComputedStyle(element).visibility)).toBe("visible");
      expect(await page.locator("#navigation-handle").evaluate(element => getComputedStyle(element).visibility)).toBe("hidden");
      const bounds = await page.locator("#touch-tab-bar").boundingBox();
      expect(bounds!.width).toBeGreaterThan(350);
      expect(bounds!.x).toBeGreaterThan(0);
      expect(await page.locator("html").getAttribute("data-active-tab")).toBe("files");
    } finally {
      await browser.close();
    }
  }, 30000);
}
