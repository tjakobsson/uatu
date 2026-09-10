import { expect, test } from "@playwright/test";
import { activeTask, diagnosticReport } from './navigation';

test.beforeEach(async ({ request }) => {
  expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true);
});

test("direct credential purpose keeps all 14 named diagnostics behind Troubleshooting", async ({ page, request }, info) => {
  await page.goto("/settings?detail=credential&id=ssh-open");
  const flow = page.locator(".mh-flow-page");
  const section = flow.locator(".mh-section").filter({ has: page.getByRole("heading", { name: "Purpose", exact: true }) });
  await expect(section).toContainText("SSH connections");
  // ssh-open is authentication-only: do not invent a signing capability.
  await expect(section).not.toContainText("Signing commits");
  await expect(flow.locator('[data-readiness-layer], details, .mh-readiness-summary')).toHaveCount(0);
  await expect(flow.locator(".mh-flow-toolbar")).toHaveCount(0);
  await expect(flow.locator('.mh-flow-header [data-flow="flow-back"]')).toBeVisible();
  await diagnosticReport(page);
  const rows = activeTask(page, 'editor', 'Diagnostic report').locator("[data-readiness-layer]");
  await expect(rows).toHaveCount(14);
  await expect(rows.first()).toBeVisible();
  const raw = await rows.evaluateAll(els => els.map(el => ({ layer: el.getAttribute("data-readiness-layer"), status: el.getAttribute("data-readiness-status"), message: el.querySelector("small")?.textContent })));
  expect(raw.filter(row => ["binary", "version", "runtime"].includes(row.layer!))).toHaveLength(12);
  for (const row of raw.filter(row => ["binary", "version", "runtime"].includes(row.layer!))) {
    expect(row.message).toMatch(/\bsimulated\b/i);
    expect(row.message).toMatch(/ssh(?:-agent|-add|-keygen)?/);
  }
  await page.screenshot({ path: info.outputPath("credential-current.png"), timeout: 5_000 });
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await diagnosticReport(page);
  for (const row of await rows.all()) await expect(row).toBeVisible();
  expect(await rows.evaluateAll(els => els.map(el => ({ layer: el.getAttribute("data-readiness-layer"), status: el.getAttribute("data-readiness-status"), message: el.querySelector("small")?.textContent })))).toEqual(raw);
  await info.attach("all-14-diagnostics", { body: JSON.stringify(raw), contentType: "application/json" });
  expect((await (await request.get("/review/state")).json()).missing).toEqual([]);
});

test("nine purpose-led tools and git automatic discovery cancel/save ownership", async ({ page, request }, info) => {
  const saved = "/synthetic/saved/git";
  expect((await request.post("/review/backend/setToolOverride", { data: [{ tool: "git", path: saved }] })).ok()).toBe(true);
  const writes: unknown[] = [];
  page.on("request", req => { if (req.url().endsWith("/review/backend/setToolOverride")) writes.push(req.postDataJSON()); });
  await page.goto("/settings?detail=tools");
  const flow = page.locator(".mh-flow-page");
  const rows = flow.locator('[data-flow^="tool-"]');
  await expect(rows).toHaveCount(9);
  expect(await rows.locator("strong").allTextContents()).toEqual(["ssh", "ssh-agent", "ssh-add", "ssh-keygen", "gpg", "gpgconf", "git", "gh", "glab"]);
  const purposes = ["Remote SSH connections", "Holds unlocked SSH keys", "Loads SSH keys into the agent", "Creates, inspects and signs with SSH keys", "OpenPGP signing", "Manages OpenPGP background services", "Git repositories", "GitHub CLI", "GitLab CLI"];
  for (let i = 0; i < purposes.length; i++) await expect(rows.nth(i)).toContainText(purposes[i]!);
  await page.screenshot({ path: info.outputPath("tools-current.png"), timeout: 5_000 });
  await flow.locator('[data-flow="tool-git"]').click();
  await expect(flow.locator("h1")).toHaveText("git");
  await expect(flow).toContainText("Reprobe installed tools and local services; no remote access tests");
  await expect(flow.locator('[data-flow="more"], .mh-flow-toolbar')).toHaveCount(0);
  await expect(flow.locator('.mh-flow-header [data-flow="flow-back"]')).toBeVisible();
  await flow.getByRole("button", { name: /^Recheck git setup/ }).click();
  await expect(activeTask(page, 'editor', 'Check Results')).toBeVisible();
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(flow.locator('[data-flow="test-git"]')).toBeEnabled();
  const open = () => flow.getByRole("button", { name: /Executable location/ }).click();
  await open();
  const dialog = activeTask(page);
  const path = dialog.getByLabel("Absolute executable path");
  await expect(path).toHaveValue(saved);
  await dialog.getByRole("button", { name: "Use automatic discovery", exact: true }).click();
  await expect(path).toHaveValue("");
  await expect(dialog).toContainText("Automatic discovery will be used when you save.");
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await open();
  await expect(path).toHaveValue(saved);
  await dialog.getByRole("button", { name: "Use automatic discovery", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([[{ tool: "git", path: null }]]);
  const configuration = await (await request.post("/review/backend/readToolConfiguration", { data: ["git"] })).json();
  expect(configuration.value.savedOverride).toEqual({ status: "known", value: null });
  expect((await (await request.get("/review/state")).json()).missing).toEqual([]);
});
