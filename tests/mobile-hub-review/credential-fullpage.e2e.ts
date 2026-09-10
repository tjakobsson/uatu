import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true);
});

test("credential actions stay direct; key editors are full pages and deletion is a confirmation", async ({ page }, info) => {
  await page.goto("/settings?detail=credential&id=ssh-locked");
  const settings = page.locator(".mh-flow-page");
  await expect(settings.locator('details, [data-flow="more"], [data-readiness-layer]')).toHaveCount(0);
  for (const action of ["public", "defaults", "test", "toggle", "delete", "unlock"]) await expect(settings.locator(`[data-flow="${action}"]`)).toBeVisible();
  await expect(settings.locator('[data-flow="lock"]')).toHaveCount(0);
  await settings.locator('[data-flow="unlock"]').click();
  const unlock = page.getByRole("region", { name: "Unlock credential", exact: true });
  await expect(unlock).toHaveAttribute("data-task-kind", "editor");
  await expect(unlock.getByLabel("Passphrase", { exact: true })).toHaveAttribute("type", "password");
  await info.attach("unlock-full-page", { body: await page.screenshot(), contentType: "image/png" });
  await unlock.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings.locator('[data-flow="public"]').click();
  const publicKey = page.getByRole("region", { name: "Public key", exact: true });
  await expect(publicKey).toHaveAttribute("data-task-kind", "editor");
  await expect(publicKey.locator(".mh-public-key")).toBeVisible();
  await publicKey.getByRole("button", { name: "Back", exact: true }).click();
  await expect(settings.locator('[data-flow="delete"]')).toHaveClass(/mh-destructive/);
  await settings.locator('[data-flow="delete"]').click();
  await expect(page.getByRole("alertdialog", { name: "Delete credential?", exact: true })).toHaveAttribute("data-task-kind", "confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  for (const [id, canUnlock, canLock] of [["ssh-open", false, true], ["pgp-locked", true, false], ["token-github", false, false]] as const) {
    await page.goto(`/settings?detail=credential&id=${id}`);
    await expect(settings.locator('[data-flow="test"]')).toBeVisible();
    await expect(settings.locator('[data-flow="unlock"]')).toHaveCount(canUnlock ? 1 : 0);
    await expect(settings.locator('[data-flow="lock"]')).toHaveCount(canLock ? 1 : 0);
  }
});

test("explicit Check Results lead to all 14 and 17 original diagnostic rows", async ({ page }, info) => {
  for (const [id, count] of [["ssh-open", 14], ["ssh-locked", 17]] as const) {
    await page.goto(`/settings?detail=credential&id=${id}`);
    await expect(page.locator('.mh-flow-page [data-flow="test"]')).toBeVisible();
    await expect(page.locator('.mh-flow-page details, .mh-flow-page [data-readiness-layer]')).toHaveCount(0);
    await page.locator('.mh-flow-page [data-flow="test"]').click();
    const results = page.getByRole("region", { name: "Check Results", exact: true });
    await expect(results).toHaveAttribute("data-task-kind", "editor");
    await expect(results.locator('[data-readiness-layer], details')).toHaveCount(0);
    await expect(results).not.toContainText(/\d+ ready/i);
    if (count === 17) await info.attach("check-results-full-page", { body: await page.screenshot(), contentType: "image/png" });
    await results.getByRole("button", { name: /View diagnostic report/ }).click();
    const report = page.getByRole("region", { name: "Diagnostic report", exact: true });
    await expect(report).toHaveAttribute("data-task-kind", "editor");
    await expect(report.locator('[data-readiness-layer]')).toHaveCount(count);
    await expect(report.locator('details, [data-tool]')).toHaveCount(0);
    for (const row of await report.locator('[data-readiness-layer]').all()) {
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-readiness-status", /ready|unavailable|not-applicable/);
      await expect(row.locator("small")).not.toBeEmpty();
    }
  }
});
