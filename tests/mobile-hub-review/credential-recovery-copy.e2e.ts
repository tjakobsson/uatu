import { expect, test } from "@playwright/test";
import { activeTask, diagnosticReport, settingsCommand } from './navigation';

test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

test("review-authorized unlock continues exactly once and cancellation offers Keep cloning", async ({ page, request }) => {
  const attempts: string[] = [];
  page.on("request", req => { if (req.url().endsWith("/review/backend/submitClone")) attempts.push(req.postDataJSON()[0].attemptId); });
  await page.goto("/clone");
  await page.getByLabel("Remote URL").fill("git@github.com:review/copy.git");
  await page.getByLabel("Checkout folder name").fill("copy-review");
  await page.getByLabel("Workspace display name").fill("Copy review");
  await page.locator('[name="cloneCredential"]').selectOption("ssh-locked");
  await page.getByRole("button", { name: "Review clone", exact: true }).click();
  await page.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(activeTask(page)).toContainText("continue the reviewed clone");
  await expect(activeTask(page)).not.toContainText("Unlocking alone");
  await page.getByLabel("Passphrase", { exact: true }).fill("DISPOSABLE");
  await page.getByRole("button", { name: "Unlock and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0]).not.toBe(attempts[1]);
  await page.locator('[data-flow="cancel"]').click();
  await expect(activeTask(page, 'confirmation').getByRole("heading")).toHaveText("Cancel clone?");
  await expect(activeTask(page, 'confirmation').getByRole("button", { name: "Cancel clone", exact: true })).toBeVisible();
  await expect(activeTask(page, 'confirmation').locator('[data-action="cancel-sheet"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Keep cloning", exact: true }).click();
  await expect(activeTask(page, 'confirmation')).toHaveCount(0);
  const state = await (await request.get("/review/state")).json();
  expect(state.log.filter((entry: { method: string }) => entry.method === "cancelClone")).toHaveLength(0);
});

test("failed facts preserve all 17 diagnostics, safe actions and a contextual recovery", async ({ page }) => {
  await page.route("**/review/backend/readCredentialFacts", route => route.abort());
  await page.goto("/settings?detail=credential&id=ssh-locked");
  await expect(page.locator(".mh-flow-page h1")).toHaveText("Review SSH (locked)");
  await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText("Unknown");
  await expect(page.locator('[data-readiness-layer]')).toHaveCount(0);
  await diagnosticReport(page);
  await expect(activeTask(page).locator('[data-readiness-layer]')).toHaveCount(17);
  await expect(page.locator('[data-readiness-layer]').first()).toBeVisible();
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await settingsCommand(page, 'test');
  await expect(page.locator('[data-flow="test"]')).toContainText('Check setup');
  await expect(page.getByRole("button", { name: "Retry status check", exact: true })).toHaveCount(1);
  await page.unroute("**/review/backend/readCredentialFacts");
  await page.getByRole("button", { name: "Retry status check", exact: true }).click();
  await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText("locked");
  await expect(page.getByRole("button", { name: "Retry status check", exact: true })).toHaveCount(0);
  await page.locator('[data-flow="unlock"]').click();
  await expect(activeTask(page)).toContainText("Unlocking alone does not start a workspace or a clone job.");
  await expect(activeTask(page).getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
});
