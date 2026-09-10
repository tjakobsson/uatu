import { expect, type Page } from '@playwright/test';

/** The active task has a semantic role, not the retired drawer's dialog role. */
export function activeTask(page: Page, kind: 'editor' | 'confirmation' = 'editor', name?: string) {
  return page.getByRole(kind === 'confirmation' ? 'alertdialog' : 'region', name ? { name, exact: true } : {})
    .and(page.locator(`.mh-task[data-task-kind="${kind}"]:visible`));
}

export async function diagnosticReport(page: Page) {
  await namedButton(page, 'Check setup').click();
  const results = activeTask(page, 'editor', 'Check Results');
  await expect(results).toBeVisible();
  await expect(results.locator('[data-readiness-layer]')).toHaveCount(0);
  await namedButton(page, 'View diagnostic report').click();
  await expect(activeTask(page, 'editor', 'Diagnostic report')).toBeVisible();
}

/** Rows include their descriptive subtitle in the accessible name. */
export const namedButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:,|$)`) });

export async function credentialCreation(page: Page, type: 'ssh' | 'openpgp' | 'token', importing = false) {
  await page.locator(`[data-flow="${type}"]`).click();
  if (type !== 'token') await page.locator(`[data-flow="${type === 'openpgp' ? 'pgp' : 'ssh'}-${importing ? 'import' : 'generate'}"]`).click();
}

export async function moreAction(page: Page, name: string) {
  // Commands are direct rows now; deliberately do not emulate a More menu.
  await namedButton(page, name).click();
}

export async function toolDetail(page: Page, tool = 'git') {
  await page.locator(`[data-flow="tool-${tool}"]`).click();
  await expect(page.locator(`[data-flow="test-${tool}"]`)).toBeVisible();
}

export async function toolOverride(page: Page, tool = 'git') {
  await page.locator(`[data-flow="override-${tool}"]`).click();
  await expect(page.getByLabel('Absolute executable path')).toBeVisible();
}

/** Settings uses top navigation; frequent bottom commands must opt in. */
export async function settingsCommand(page: Page, key: string) {
  const header = page.locator('.mh-flow-page .mh-flow-header');
  const back = header.locator('[data-flow="flow-back"]');
  await back.scrollIntoViewIfNeeded();
  await expect(back).toBeVisible();
  expect((await back.boundingBox())!.y).toBeLessThan(page.viewportSize()!.height / 2);
  const command = page.locator(`.mh-flow-page [data-flow="${key}"]`);
  await expect(command).toHaveCount(1);
  await command.scrollIntoViewIfNeeded();
  await expect(command).toBeVisible();
  const box = (await command.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(page.locator('.mh-flow-page .mh-flow-toolbar')).toHaveCount(0);
}
