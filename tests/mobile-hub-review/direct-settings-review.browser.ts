import { chromium, webkit, expect, type Browser } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { startReviewServer } from "./server";

const output = new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/direct-settings/current/", import.meta.url).pathname;

/** Evidence runner only: actual product bundle, isolated synthetic backend, no live services. */
export async function runDirectSettingsReview() {
  await mkdir(output, { recursive: true });
  const server = await startReviewServer({ port: 0 });
  const report: any = { capturedAt: new Date().toISOString(), viewport: { width: 390, height: 844 }, scale: "css", fixture: "mixed synthetic credentials; no real keys/providers/PTY", keyboard: "Static browser viewport; no physical software keyboard claimed", screenshotScope: "Viewport screenshots; nested scrolling is not expanded by fullPage. Credential actions are reached by real scrolling, not DOM/CSS hiding.", engines: [] };
  try {
    report.frontend = (await (await fetch(`${server.url}/review/health`)).json()).version;
    for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]] as const) {
      const result: any = { engine: name, checks: [], captures: [] }; report.engines.push(result);
      if (process.env.ENGINE && process.env.ENGINE !== name) { result.status = "not selected for this follow-up; unverified"; continue; }
      if (!existsSync(engine.executablePath())) { result.status = "not installed; not attempted"; continue; }
      let browser: Browser | undefined;
      try {
        browser = await engine.launch({ headless: true, timeout: 15000 });
        result.version = browser.version();
        const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: "reduce", colorScheme: "light" });
        await context.addInitScript(() => localStorage.setItem("uatu:ui-mode", "touch"));
        const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
        const reset = await context.request.post(`${server.url}/review/reset`, { data: { scenario: "mixed" } });
        if (!reset.ok()) throw new Error("Synthetic reset failed");
        const check = async (label: string, action: () => Promise<unknown>) => { try { await action(); result.checks.push({ label, pass: true }); } catch (error) { result.checks.push({ label, pass: false, error: String(error) }); } };
        const shot = async (label: string) => { await page.screenshot({ path: `${output}${name}-${label}.png`, scale: "css", timeout: 10000 }); result.captures.push(`${name}-${label}.png`); };
        await page.goto(`${server.url}/settings?detail=credential&id=ssh-open`, { waitUntil: "domcontentloaded" });
        const detail = page.locator(".mh-flow-page");
        await expect(detail).toBeVisible();
        await check("Default direct actions present", async () => { for (const action of ["public", "lock", "defaults", "test", "toggle", "delete"]) await expect(detail.locator(`[data-flow="${action}"]`)).toHaveCount(1); });
        result.defaultText = await detail.innerText();
        await check("No More, troubleshooting, details or raw diagnostics by default", async () => { await expect(detail.locator('details, [data-flow="more"], [data-readiness-layer]')).toHaveCount(0); await expect(detail).not.toContainText(/Troubleshooting|View diagnostic report/); await expect(page.getByRole("region", { name: "Check Results", exact: true })).toHaveCount(0); });
        await detail.locator('[data-flow="delete"]').scrollIntoViewIfNeeded();
        await shot("credential-actions");
        await detail.locator('[data-flow="delete"]').click();
        const confirmation = page.getByRole("alertdialog");
        await check("Delete confirmation centered alertdialog", async () => { await expect(confirmation).toBeVisible(); const box = await confirmation.boundingBox(); expect(Math.abs(box!.y + box!.height / 2 - 422)).toBeLessThan(3); });
        await shot("delete-confirmation");
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        await detail.locator('[data-flow="test"]').click();
        const results = page.getByRole("region", { name: "Check Results", exact: true });
        await check("Check results appear on request only", async () => { await expect(results).toBeVisible(); await expect(results.locator('[data-readiness-layer]')).toHaveCount(0); });
        await results.getByRole("button", { name: /View diagnostic report/ }).click();
        const rows = page.getByRole("region", { name: "Diagnostic report", exact: true }).locator('[data-readiness-layer]');
        await check("Diagnostic report exposes all 14 rows", async () => { await expect(rows).toHaveCount(14); for (const row of await rows.all()) { await row.scrollIntoViewIfNeeded(); await expect(row).toBeVisible(); await expect(row.locator("small")).not.toBeEmpty(); } });
        result.diagnostics = await rows.evaluateAll(elements => elements.map(el => ({ layer: el.getAttribute("data-readiness-layer"), status: el.getAttribute("data-readiness-status"), text: (el as HTMLElement).innerText })));
        await page.goto(`${server.url}/settings?detail=credential&id=ssh-locked`, { waitUntil: "domcontentloaded" });
        await page.locator('.mh-flow-page [data-flow="unlock"]').click();
        const editor = page.locator(".mh-editor");
        await check("Unlock full page with header Cancel/Unlock and no modal chrome", async () => { await expect(editor.locator("header").getByRole("button", { name: "Cancel", exact: true })).toBeVisible(); await expect(editor.locator("header").getByRole("button", { name: "Unlock", exact: true })).toBeVisible(); await expect(page.locator('.mh-root [aria-modal="true"], .mh-backdrop, .mh-grabber')).toHaveCount(0); const box = await editor.boundingBox(); expect(box!.height).toBe(844); expect(box!.width).toBe(390); });
        await check("Unlock fields fit viewport", async () => { const field = editor.getByLabel("Passphrase", { exact: true }); await expect(field).toHaveAttribute("type", "password"); const box = await field.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.y + box!.height).toBeLessThanOrEqual(844); });
        await check("Input keyboard focus stays inside the field", async () => { const field = editor.getByLabel("Passphrase", { exact: true }); await field.focus(); expect(await field.evaluate(input => parseFloat(getComputedStyle(input).outlineOffset))).toBeLessThan(0); });
        await shot("unlock-fullpage");
        await page.goto(`${server.url}/settings`, { waitUntil: "domcontentloaded" });
        await page.locator('[data-action="preview-side"]').click();
        await check("Preferences full page Save/Cancel", async () => { await expect(editor.locator("header").getByRole("button", { name: "Save", exact: true })).toBeVisible(); await expect(editor.locator("header").getByRole("button", { name: "Cancel", exact: true })).toBeVisible(); expect((await editor.boundingBox())!.height).toBe(844); await expect(page.locator('.mh-root [aria-modal="true"], .mh-backdrop, .mh-grabber')).toHaveCount(0); });
        await shot("preferences-fullpage");
        result.status = "completed";
      } catch (error) { result.status = "failed/stalled; no retry"; result.error = String(error); }
      finally { if (browser) await browser.close(); await Bun.write(`${output}report.json`, JSON.stringify(report, null, 2)); }
    }
  } finally { server.stop(); await Bun.write(`${output}report.json`, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report.engines.map((e: any) => ({ engine: e.engine, status: e.status, passes: e.checks.filter((c: any) => c.pass).length, failures: e.checks.filter((c: any) => !c.pass).length, captures: e.captures })), null, 2));
}

if (import.meta.main) await runDirectSettingsReview();
