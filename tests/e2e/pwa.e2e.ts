import { expect, test } from "@playwright/test";

// Real-browser sanity for the PWA install path. The integration tests
// confirm the assets serve with the right shape; this test confirms that
// the runtime injection in app.ts wires the manifest into the live DOM
// and that the service worker registers at site root scope.
//
// Note: Chrome's "is this installable" heuristic itself isn't asserted
// here — that's a Chrome-internal decision based on the manifest, the SW,
// the icons, and user-facing engagement signals. We assert the parts uatu
// owns; if those are right and Chromium changes its heuristic, we're not
// the ones who broke.

test.beforeEach(async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await page.goto("/");
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("PWA install surface", () => {
  test("manifest link is present in <head>", async ({ page }) => {
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBe("/manifest.webmanifest");
  });

  test("manifest is reachable and well-typed", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/manifest+json");
    const body = await response.json();
    expect(body.display).toBe("standalone");
    expect(body.start_url).toBe("/");
    expect(Array.isArray(body.icons)).toBe(true);
    const sizes = (body.icons as Array<{ sizes: string }>).map(icon => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  test("service worker is reachable at /sw.js with the right headers", async ({ request }) => {
    const response = await request.get("/sw.js");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/javascript");
    expect(response.headers()["service-worker-allowed"]).toBe("/");
    // Cache-Control must NOT cache — when uatu upgrades and ships a new
    // worker, the new bytes have to reach existing tabs on the next reload.
    expect(response.headers()["cache-control"]).toContain("no-cache");
  });

  test("service worker registers and takes control", async ({ page }) => {
    // app.ts registers `/sw.js` after window.load. Wait for it; the
    // controller becomes non-null once the SW activates and claims clients.
    const controllerScript = await page.waitForFunction(
      () => Boolean(navigator.serviceWorker.controller),
      undefined,
      { timeout: 10_000 },
    );
    expect(await controllerScript.jsonValue()).toBe(true);

    const scriptUrl = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
    expect(scriptUrl).toMatch(/\/sw\.js$/);
  });

  test("icon assets are reachable as PNGs", async ({ request }) => {
    for (const path of ["/assets/icon-192.png", "/assets/icon-512.png"]) {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("image/png");
    }
  });

  test("theme-color meta is set to the brand navy", async ({ page }) => {
    const themeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
    expect(themeColor).toBe("#0a1c38");
  });
});
