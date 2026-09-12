import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

// Current product bundle, typed synthetic backend, fresh disposable preferences.
const output = new URL(process.env.READABILITY_OUTPUT ?? "./results/artifacts/readability/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const started = Date.now();
if (!process.env.READABILITY_URL) {
  const { startReviewServer } = await import("./server");
  const server = await startReviewServer({ port: 0 });
  server.synthetic.reset("mixed");
  const seeded = await server.synthetic.backend.assignWorkspace({ workspaceId: "atlas", mode: "assign-new", selection: { authentication: { credentialId: "ssh-open", host: "github.com" } } });
  if (seeded.status !== "completed") { server.stop(); throw new Error(`Assignment fixture failed: ${JSON.stringify(seeded)}`); }
  try { const child = Bun.spawn(["node", import.meta.filename], { env: { ...process.env, READABILITY_URL: server.url }, stdout: "inherit", stderr: "inherit" }); await child.exited; }
  finally { server.stop(); }
  process.exit(0);
}
const server = { url: process.env.READABILITY_URL, stop() {} };
const report: any = { beforeCheckpoint: "c259efb", beforeImages: "Not captured; no before/after visual parity claim", viewport: { width: 390, height: 844 }, scale: "css", captures: [], checks: [], limitations: "Chromium emulation only; no physical device/software keyboard, Apple certification, or whole-matrix claim. No private attachments copied." };
let browser;
try {
  report.health = await (await fetch(`${server.url}/review/health`)).json();
  browser = await chromium.launch({ headless: true, timeout: 15000 });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: "light", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("uatu:ui-mode", "touch"));
  const page = await Promise.race([context.newPage(), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("newPage exceeded 15 seconds")), 15000); timer.unref(); })]); page.setDefaultTimeout(5000);
  const assignmentWrites: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/review/backend/assignWorkspace")) assignmentWrites.push(request.url()); });
  const check = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); report.checks.push({ name, pass: true }); } catch (error) { report.checks.push({ name, pass: false, error: String(error) }); } };
  const shot = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}${name}.png`, scale: "css", timeout: 10000 });
    const metrics = await page.locator(".mh-root").evaluate(root => ({
      viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
      active: { tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute("name") },
      rows: [...root.querySelectorAll("dt, dd, h1, h2, input, select, [role=switch], .mh-advisory")].map(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { tag: el.tagName, text: el.textContent?.trim(), name: el.getAttribute("name"), x: r.x, y: r.y, width: r.width, height: r.height, font: s.fontSize, color: s.color, background: s.backgroundColor }; }),
    }));
    report.captures.push({ file: `${name}.png`, metrics });
  };
  await page.goto(`${server.url}/settings`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-action="devices"]')).toHaveCount(1);
  await shot("01-settings-fresh");
  await check("Single Devices entry", () => expect(page.locator('[data-action="devices"]')).toHaveCount(1));
  await page.goto(`${server.url}/settings?detail=credential&id=ssh-open`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".mh-flow-page")).toContainText("Used for");
  await shot("02-credential-purpose");
  await check("Credential information uses dt/dd", async () => { expect(await page.locator(".mh-flow-page dt").count()).toBeGreaterThan(0); expect(await page.locator(".mh-flow-page dd").count()).toBeGreaterThan(0); });
  await page.goto(`${server.url}/settings?detail=assignments`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-flow="workspace-atlas"]').click();
  await expect(page.locator('[data-flow="edit-atlas"]')).toBeVisible();
  await shot("03-workspace-assignment-summary");
  await page.locator('[data-flow="edit-atlas"]').click();
  await expect(page.locator('.mh-task h1')).toHaveText("Edit workspace credentials");
  await shot("04-edit-first-entry");
  await check("First entry does not focus input/select", async () => { expect(await page.evaluate(() => ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""))).toBe(false); });
  // Actual editing intent: replace this host's credential, inspecting normalized spelling.
  await page.getByRole("combobox", { name: "Git authentication credential", exact: true }).selectOption("ssh-locked");
  await page.getByLabel("Authentication host", { exact: true }).fill("  GITHUB.COM  ");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator('.mh-task h1')).toHaveText("Review changes");
  await page.locator('.mh-task').getByText("github.com", { exact: true }).scrollIntoViewIfNeeded();
  await shot("05-review-changes");
  await check("Review normalizes host and labels before/after", async () => { await expect(page.locator('.mh-task')).toContainText("github.com"); await expect(page.locator('.mh-task')).not.toContainText("GITHUB.COM"); expect(await page.locator('.mh-task dt').filter({ hasText: /^Current$/ }).count()).toBeGreaterThan(0); expect(await page.locator('.mh-task dt').filter({ hasText: /^After applying$/ }).count()).toBeGreaterThan(0); });
  await check("Prospective change is neutral and next steps are labeled", async () => {
    const task = page.locator('.mh-task');
    await expect(task).toContainText("Change on apply"); await expect(task).toContainText("Replace credential");
    await expect(task).toContainText("What happens next");
    report.reviewText = await task.innerText();
    const proposed = task.locator('dt').filter({ hasText: /^Change on apply$/ });
    report.proposedStyles = await proposed.evaluateAll(rows => rows.map(row => { const parent = row.parentElement!, style = getComputedStyle(parent); return { text: parent.textContent, className: parent.className, color: style.color, border: style.borderLeftColor }; }));
    await expect(task.locator('.mh-info-positive')).toHaveCount(0);
  });
  await page.getByRole("button", { name: "Back to edit", exact: true }).click();
  await check("Back preserves typed host and Review does not apply", async () => { await expect(page.getByLabel("Authentication host", { exact: true })).toHaveValue("  GITHUB.COM  "); expect(assignmentWrites).toEqual([]); });
  await page.goto(`${server.url}/clone`, { waitUntil: "domcontentloaded" });
  const start = page.getByRole("switch", { name: "Start after configuration", exact: true });
  await start.check({ timeout: 15000 });
  await start.scrollIntoViewIfNeeded();
  await shot("06-clone-start-and-empty-host");
  await check("Start draft checked; empty host disabled", async () => { await expect(start).toBeChecked(); const host = page.getByLabel("Authentication host", { exact: true }); await expect(host).toBeDisabled(); await expect(host).toHaveValue(""); });
  await check("Short placeholder retains full accessible reason", async () => { const host = page.getByLabel("Authentication host", { exact: true }); await expect(host).toHaveAttribute("placeholder", "Select a credential first"); await expect(host).toHaveAttribute("aria-description", /Choose a Git authentication credential first/); report.hostField = await host.evaluate(el => ({ placeholder: el.getAttribute("placeholder"), description: el.getAttribute("aria-description"), width: el.getBoundingClientRect().width })); });
  report.navigation = await page.locator('.mh-root').evaluate(root => [...root.querySelectorAll('[aria-current], [aria-selected]')].map(el => ({ text: el.textContent, current: el.getAttribute('aria-current'), selected: el.getAttribute('aria-selected') })));
  report.status = "captured";
} catch (error) { report.status = "failed"; report.error = String(error); }
finally { await browser?.close(); server.stop(); report.elapsedMs = Date.now() - started; await writeFile(`${output}capture-report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ status: report.status, error: report.error, checks: report.checks, captures: report.captures.map((c: any) => c.file), elapsedMs: report.elapsedMs }, null, 2));
