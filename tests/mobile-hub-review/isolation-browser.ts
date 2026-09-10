import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, webkit, type Page } from "@playwright/test";
import { loginPage, dashboardPage, settingsPage, clonePage, stoppedSessionPage } from "../../src/hub/pages";
import { evidence, sha } from "./isolation-audit";

/** Decode via the installed browser; no pixel library installation or golden updates. */
export async function pixels(page: Page, a: Uint8Array, b: Uint8Array) {
  return page.evaluate(async ([left, right]) => {
    const decode = async (src: string) => { const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data }; };
    const a = await decode(left!), b = await decode(right!);
    if (a.width !== b.width || a.height !== b.height) return { comparable: false, dimensions: [[a.width, a.height], [b.width, b.height]] };
    let changedPixels = 0, maximumChannelDelta = 0;
    for (let i = 0; i < a.data.length; i += 4) { let changed = false; for (let c = 0; c < 3; c++) { const delta = Math.abs(a.data[i + c]! - b.data[i + c]!); maximumChannelDelta = Math.max(maximumChannelDelta, delta); changed ||= delta > 0; } if (changed) changedPixels++; }
    return { comparable: true, width: a.width, height: a.height, changedPixels, changedFraction: changedPixels / (a.width * a.height), maximumChannelDelta };
  }, [a, b].map(bytes => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`));
}

if (import.meta.main) {
  const html = new Map([["/login", loginPage()], ["/", dashboardPage("baseline")], ["/settings", settingsPage("baseline")], ["/clone", clonePage("baseline")], ["/stopped", stoppedSessionPage("a", true, "Shared workspace")]]);
  const state = { version: "design/hub-mobile-navigation@0ba1dad", workspaces: [
    { id: "a", displayName: "Shared workspace", path: "/private/tmp/uatu-hm-J6ow2s/workspace-a", running: true, shells: [], credentialAssignments: { authentication: ["Baseline SSH"], signing: ["Baseline SSH"] } },
    { id: "b", displayName: "Shared workspace", path: "/private/tmp/uatu-hm-J6ow2s/workspace-b", running: false, credentialAssignments: { authentication: ["Baseline github-cli"], signing: ["Baseline OpenPGP"] } },
  ] };
  const api = new Map<string, unknown>([["/api/hub/state", state], ["/api/hub/credentials", { credentials: [] }], ["/api/hub/credential-tools", { tools: [] }], ["/api/hub/sessions", { sessions: [] }], ["/api/hub/settings/workspace-defaults", { configured: null, effective: "/synthetic/home", configuredAvailable: false }], ["/api/hub/browse", { path: "/synthetic/home", parent: null, dirs: [] }]]);
  const results: unknown[] = [];
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "light", serviceWorkers: "block" });
      try {
        const unknown: string[] = [], errors: string[] = [], mutations: string[] = [];
        await context.route("**/*", async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.origin !== "http://isolation.invalid") { unknown.push(req.url()); return route.abort(); }
          if (req.method() !== "GET") { mutations.push(`${req.method()} ${url.pathname}`); return route.fulfill({ status: 405, body: "No mutations in read-only evidence" }); }
          if (html.has(url.pathname)) return route.fulfill({ contentType: "text/html", body: html.get(url.pathname)! });
          if (url.pathname === "/manifest.webmanifest") return route.fulfill({ contentType: "application/manifest+json", body: await readFile("src/assets/manifest.webmanifest") });
          if (url.pathname === "/hub-assets/mono.woff2") return route.fulfill({ contentType: "font/woff2", body: await readFile("src/assets/fonts/HackNerdFontMono-Regular.woff2") });
          if (api.has(url.pathname)) return route.fulfill({ json: api.get(url.pathname) });
          unknown.push(url.pathname); return route.fulfill({ status: 404, body: "Unknown synthetic read" });
        });
        const page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", e => errors.push(e.message));
        for (const [path, name] of [["/login", "login"], ["/", "dashboard-a-running-b-stopped"], ["/settings", "settings"], ["/clone", "clone"], ["/stopped", "workspace-a-stopped"]]) {
          await page.goto(`http://isolation.invalid${path}`);
          await page.evaluate(() => document.fonts.ready);
          if (path === "/") await page.locator('#sessions a[href="/s/a/"]').waitFor();
          assert.equal(await page.locator("#mobile-hub-root, .mh-coordinator-frame").count(), 0);
          assert.equal(await page.locator("html").getAttribute("data-workspace-foreground"), null);
          const padding = () => page.locator("main").evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
          const before = await padding();
          const capture = await page.screenshot({ fullPage: true, animations: "disabled" });
          await writeFile(new URL(`${engine.name()}-desktop-${name}.png`, evidence), capture);
          const baseline = await readFile(`tests/e2e/hub-mobile-baselines/desktop-${name}.png`);
          const comparison = await pixels(page, baseline, capture);
          await page.evaluate(() => document.documentElement.style.setProperty("--titlebar-inset", "72px"));
          assert.equal(await padding() - before, 72, `${name}: native titlebar inset must add exactly 72 CSS px`);
          await writeFile(new URL(`${engine.name()}-native-${name}.png`, evidence), await page.screenshot({ fullPage: true, animations: "disabled" }));
          results.push({ browser: engine.name(), version: browser.version(), path, name, htmlSha256: sha(html.get(path!)!), styleSha256: sha([...html.get(path!)!.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n")), nativeInsetDelta: 72, comparison });
        }
        await page.goto("http://isolation.invalid/");
        await page.evaluate(() => { (window as any).__oldDocument = true; window.addEventListener("keydown", () => { throw new Error("Old document listener leaked"); }); });
        await Promise.all([page.waitForURL("**/settings"), page.locator('.hub-nav a[href="/settings"]').click()]);
        assert.equal(await page.evaluate(() => (window as any).__oldDocument), undefined);
        await page.locator("#workspace-defaults-parent").fill("/synthetic/typed");
        await page.keyboard.press("Control+f"); await page.keyboard.press("Escape");
        assert.equal(await page.locator("#mobile-workspace-root, #find-bar").count(), 0);
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []); assert.deepEqual(unknown, []);
        results.push({ browser: engine.name(), fullDocumentNavigation: "PASS", staleGlobalListener: "not invoked after document replacement", errors, mutations, unknown });
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }
  await writeFile(new URL("desktop-results.json", evidence), JSON.stringify(results, null, 2) + "\n");
  console.info("PASS: actual Hub page generators, desktop/native inset, full-document navigation; pixel differences recorded without blessing.");
}
