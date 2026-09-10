/** Read/interaction smoke of the already-owned review instance. No launcher or
 * production effects. Pass a verified review origin, never a live Hub origin. */
import { chromium, webkit, devices, expect } from "@playwright/test";
import { activeTask } from './navigation';

const origin = process.argv[2] ?? "http://127.0.0.1:4703";
const health = await fetch(`${origin}/review/health`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
if (health.backend !== "synthetic" || health.assembly !== "same-document-mobile") throw new Error("Refusing non-review target");
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, serviceWorkers: "block", baseURL: origin });
    const page = await context.newPage();
    await page.goto("/review/controller");
    await expect(page.locator("h1")).toContainText("Mock backend");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
    await page.locator('[data-action="open:atlas"]').click();
    await expect(page.locator("#preview")).toContainText("Synthetic review document");
    await page.locator('[data-tab="terminal"]').click();
    await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
    await page.locator("#navigation-hub").click();
    await page.locator('[data-action="settings"]').click();
    await page.locator('[data-action="preview-side"]').click();
    await expect(activeTask(page, 'editor', 'Preview File Controls')).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator('[data-action="return"]').click();
    await expect(page.locator("#mobile-hub-root")).toBeHidden();
    await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
    const evidence = await context.request.get("/review/evidence");
    expect(evidence.ok()).toBe(true);
    console.info(JSON.stringify({ browser: name, origin, fingerprint: health.version.fingerprint, result: "PASS", checked: ["controller", "dashboard", "workspace HTTP/SSE", "real terminal WebSocket", "Settings sheet", "same-document Return", "evidence"] }));
  } finally { await browser.close(); }
}
