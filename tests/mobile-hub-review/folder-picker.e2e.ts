import { expect, test } from "@playwright/test";
import { activeTask } from './navigation';

test("folder picker has one 44px parent control and Cancel returning the typed default", async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: "mixed" } });
  await page.goto("/settings?detail=default-folder");
  await page.locator('[data-flow="edit"]').click();
  const path = page.getByLabel("Folder path");
  await path.fill("/synthetic");
  await page.getByRole("button", { name: "Choose folder", exact: true }).click();
  await expect(page.getByRole("region", { name: "Choose Folder", exact: true })).toBeVisible();
  const child = page.locator('[data-flow="folder-0"]');
  await child.click();
  const up = page.locator('nav[aria-label="Parent folder"] [data-flow="up"]');
  const back = page.locator('.mh-folder-picker > header').getByRole('button', { name: 'Cancel', exact: true });
  await expect(up).toHaveCount(1); await expect(up).toBeVisible();
  await expect(back).toHaveCount(1); await expect(back).toHaveText("Cancel");
  await expect(up).toHaveAttribute('aria-label', 'Parent folder: /synthetic');
  for (const control of [up, back]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44); expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  await back.click();
  await expect(activeTask(page, 'editor', 'Default Folder').getByRole("heading", { name: "Default Folder", exact: true })).toBeVisible();
  await expect(path).toHaveValue("/synthetic");
});
