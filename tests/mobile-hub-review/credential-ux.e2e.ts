import { expect, test, type Page } from "@playwright/test";
import { activeTask, diagnosticReport, settingsCommand } from './navigation';

test.beforeEach(async ({ request }) => {
  expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true);
});
async function lowerPrimary(page: Page, key: string) {
  await settingsCommand(page, key);
}

test("17 retained credential diagnostics collapse without hiding the blocker or lower Unlock", async ({ page }, info) => {
  await page.goto("/settings?detail=credential&id=ssh-locked");
  await expect(page.locator('[data-readiness-layer], .mh-flow-page details')).toHaveCount(0);
  await lowerPrimary(page, "unlock");
  await diagnosticReport(page);
  const rows = activeTask(page, 'editor', 'Diagnostic report').locator('[data-readiness-layer]');
  await expect(rows).toHaveCount(17);
  await expect(rows.first()).toBeVisible();
  const before = await rows.evaluateAll(els => els.map(el => ({ layer: el.getAttribute('data-readiness-layer'), status: el.getAttribute('data-readiness-status'), message: el.querySelector('small')?.textContent })));
  expect(before.some(row => row.status === 'unavailable' && /locked/i.test(row.message ?? ''))).toBe(true);
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('[data-readiness-layer]')).toHaveCount(0);
  await diagnosticReport(page);
  expect(await rows.evaluateAll(els => els.map(el => ({ layer: el.getAttribute('data-readiness-layer'), status: el.getAttribute('data-readiness-status'), message: el.querySelector('small')?.textContent })))).toEqual(before);
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await lowerPrimary(page, "unlock");
  await info.attach("readiness-metrics", { body: JSON.stringify({ rows: before }), contentType: "application/json" });
});

test("nine compact named tools drill into facts, diagnostics, Test and contextual override", async ({ page }, info) => {
  await page.goto("/settings?detail=tools");
  const rows = page.locator('.mh-flow-page [data-flow^="tool-"]');
  await expect(rows).toHaveCount(9);
  const metrics = await rows.evaluateAll(els => els.map(el => ({ name: el.querySelector("strong")?.textContent, height: el.getBoundingClientRect().height, text: el.textContent })));
  console.log(`Tool row heights: ${metrics.map(row => `${row.name}=${row.height}`).join(", ")}`);
  expect(metrics.map(m => m.name)).toEqual(["ssh", "ssh-agent", "ssh-add", "ssh-keygen", "gpg", "gpgconf", "git", "gh", "glab"]);
  for (const row of metrics) expect(row.height).toBeLessThanOrEqual(88);
  await expect(page.locator('.mh-flow-page [data-readiness-layer]')).toHaveCount(0);
  await page.locator('[data-flow="tool-git"]').click();
  await expect(page.locator('.mh-flow-page h1')).toHaveText("git");
  await expect(page.locator('.mh-flow-page')).toContainText("Executable location");
  await lowerPrimary(page, "test-git");
  await expect(page.locator('[data-flow="override-git"]')).toHaveCount(1);
  await expect(page.locator('[data-flow="more"]')).toHaveCount(0);
  await page.locator('[data-flow="override-git"]').click();
  await expect(page.getByLabel("Absolute executable path")).toHaveValue("");
  await expect(activeTask(page)).toContainText("No saved override");
  await expect(page.getByLabel("Absolute executable path")).toHaveAttribute("autocorrect", "off");
  await page.getByLabel("Absolute executable path").fill("relative");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(activeTask(page).getByRole("alert")).toContainText("absolute path");
  await info.attach("tool-row-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
});

test("scoped key choices and write-only token retain validation and clearing", async ({ page }) => {
  await page.goto("/settings?detail=add-credential");
  await expect(page.locator('.mh-flow-page .mh-list-row')).toHaveCount(3);
  await page.locator('[data-flow="ssh"]').click();
  await expect(page.locator('.mh-flow-page .mh-list-row')).toHaveCount(2);
  await page.locator('[data-flow="ssh-import"]').click();
  await expect(page.getByLabel("Private key file (preferred)")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator('[data-flow="flow-back"]').click();
  await page.locator('[data-flow="token"]').click();
  await page.getByLabel("Token", { exact: true }).fill("DISPOSABLE_SECRET");
  await expect(page.getByLabel("Token", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(activeTask(page).getByRole("alert")).toContainText("Name is required");
  await expect(page.getByLabel("Token", { exact: true })).toHaveValue("");
});

test("Unlock and tool Test keep pending, failure and cancel ownership after moving actions", async ({ page, request }) => {
  await page.goto("/settings?detail=credential&id=ssh-locked");
  await page.locator('[data-flow="unlock"]').click();
  await page.getByLabel("Passphrase", { exact: true }).fill("DISPOSABLE");
  await request.post("/review/control/hold", { data: ["unlockCredential"] });
  const commit = activeTask(page).getByRole("button", { name: "Unlock", exact: true });
  await commit.click();
  await expect(commit).toBeDisabled();
  await expect(page.getByLabel("Passphrase", { exact: true })).toHaveValue("");
  await request.post("/review/control/settle", { data: ["unlockCredential", true] });
  await expect(activeTask(page).getByRole("alert")).toContainText("Synthetic operation failed");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await lowerPrimary(page, "unlock");
  await page.goto("/settings?detail=tools");
  await page.locator('[data-flow="tool-git"]').click();
  await request.post("/review/control/hold", { data: ["testTool"] });
  await page.locator('[data-flow="test-git"]').click();
  await expect(page.locator('[data-flow="test-git"]')).toBeDisabled();
  await request.post("/review/control/settle", { data: ["testTool", true] });
  await expect(page.locator('.mh-flow-error')).toContainText("Synthetic operation failed");
  await lowerPrimary(page, "test-git");
});
