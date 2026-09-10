import { expect, test, type Locator, type Page } from "@playwright/test";
import { activeTask, moreAction } from './navigation';

async function editorHeader(control: Locator, height: number) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  expect(box.y).toBeLessThan(height / 2);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}

async function lower(control: Locator, height: number) {
  await expect(control).toBeVisible();
  await expect.poll(async () => { const box = (await control.boundingBox())!; return box.y >= height / 2 && box.y + box.height <= height && box.width >= 44 && box.height >= 44; }).toBe(true);
}

// Current layout contract, independent of the historical drawer image report.
test('current preference editor fills the viewport with header Save and no modal chrome', async ({ page, request }) => {
  await request.post('/review/reset', { data: { scenario: 'mixed' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  await page.locator('[data-action="preview-side"]').click();
  const editor = activeTask(page, 'editor', 'Preview File Controls');
  await expect(editor).toBeVisible();
  await expect(editor).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.mh-root [role="dialog"], .mh-root [role="alertdialog"], .mh-backdrop, .mh-grabber')).toHaveCount(0);
  await expect.poll(async () => {
    const box = (await editor.boundingBox())!;
    return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
  }).toEqual([0, 0, 390, 844]);
  await editorHeader(editor.locator('header').getByRole('button', { name: 'Save', exact: true }), 844);
  await editorHeader(editor.locator('header').getByRole('button', { name: 'Cancel', exact: true }), 844);
  await expect(editor.locator('footer')).toHaveCount(0);
  await expect(editor.getByRole('radio')).toHaveCount(2);
  await expect(page.locator('.mh-dock')).toBeHidden();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-action="preview-side"]')).toBeFocused();
});
for (const size of [{ width: 390, height: 844, text: 100 }, { width: 390, height: 480, text: 100 }, { width: 390, height: 844, text: 200 }]) {
  test(`contextual Settings actions, top Back, scroll clearance and modal priority ${size.height}/${size.text}`, async ({ page, request }) => {
    await request.post('/review/reset', { data: { scenario: 'mixed' } });
    await page.setViewportSize(size);
    await page.goto('/');
    await page.addStyleTag({ content: `html { font-size: ${size.text}%; }` });
    const add = page.locator('[data-action="add-workspace"]');
    await expect(add).toHaveCount(1); await expect(add).toBeVisible();
    await expect(page.locator('.mh-workspace h3 button')).toHaveCount(0);
    await page.locator('[data-action="settings"]').click();
    const credential = page.locator('[data-action="add-credential"]');
    await expect(credential).toHaveCount(1); await expect(page.locator('.mh-group [data-action="add-credential"]')).toHaveCount(1);
    await expect(page.locator('[data-action="sign-out"]')).toHaveCount(0);
    await page.locator('.mh-page').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = page.locator('.mh-page main > :last-child');
    await expect.poll(async () => (await last.boundingBox())!.y + (await last.boundingBox())!.height <= (await page.locator('.mh-dock').boundingBox())!.y).toBe(true);
    await credential.click();
    const back = page.locator('[data-flow="flow-back"]');
    await expect(back).toHaveCount(1); await expect(page.locator('.mh-flow-header [data-flow="flow-back"]')).toBeVisible();
    await expect(page.locator('.mh-overview-toolbar')).toHaveCount(0);
    await back.click();
    await page.locator('[data-action="preview-side"]').click();
    const modal = activeTask(page); await expect(modal).toBeVisible();
    await expect(page.locator('.mh-page')).toHaveJSProperty('inert', true);
    await expect(page.locator('.mh-flow-page')).toHaveJSProperty('inert', true);
    await editorHeader(modal.locator('header [data-action="cancel-sheet"]'), size.height);
    await editorHeader(modal.locator('header').getByRole('button', { name: 'Save', exact: true }), size.height);
    await expect(modal).not.toHaveAttribute('aria-modal', 'true');
    expect(await modal.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0);
    await expect(credential).toHaveCount(1);
    await page.locator('[data-action="default-folder"]').click();
    const primary = page.locator('[data-flow="edit"]');
    await expect(primary).toHaveCount(1); await expect(primary).toBeVisible();
    await expect(page.locator('.mh-flow-content .mh-group [data-flow="edit"]')).toHaveCount(1);
    await expect(page.locator('[data-flow="more"]')).toHaveCount(0);
    await expect(page.locator('.mh-flow-header nav [data-flow="flow-back"]')).toBeVisible();
    await expect(page.locator('.mh-flow-toolbar')).toHaveCount(0);
    await primary.click();
    await expect(activeTask(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1);
    expect(await activeTask(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
  });
}

test('visual viewport keyboard clearance preserves contextual editor and moves modal footer', async ({ page, request }) => {
  await request.post('/review/reset', { data: { scenario: 'mixed' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?detail=default-folder');
  await expect(page.locator('[data-flow="edit"]')).toHaveCount(1);
  // Browser geometry stress, not a claim of a physical iOS software keyboard.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport!, 'height', { configurable: true, get: () => 520 });
    visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.mh-flow-content [data-flow="edit"]')).toBeVisible();
  await page.locator('[data-flow="edit"]').click();
  await editorHeader(activeTask(page).locator('header [data-action="commit-sheet"]'), 520);
  await expect(page.locator('.mh-page')).toHaveJSProperty('inert', true);
});

async function keyboard(page: Page, height?: number) {
  await page.evaluate(height => {
    if (height) Object.defineProperty(visualViewport!, 'height', { configurable: true, get: () => height });
    else Reflect.deleteProperty(visualViewport!, 'height');
    visualViewport!.dispatchEvent(new Event('resize'));
  }, height);
}

for (const size of [{ width: 390, height: 664, text: 100 }, { width: 390, height: 440, text: 100 }, { width: 844, height: 390, text: 100 }, { width: 390, height: 664, text: 200 }, { width: 390, height: 440, text: 200 }]) {
  test(`prompt single Send, nonoverlap and positive scroll viewport ${size.width}/${size.height}/${size.text}`, async ({ page, request }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await request.post('/review/reset', { data: { scenario: 'mixed' } });
    await page.setViewportSize(size); await page.goto('/clone');
    await page.addStyleTag({ content: `html { font-size: ${size.text}%; }` });
    await page.getByLabel('Remote URL', { exact: true }).fill('https://github.com/example/repo.git');
    await page.getByLabel('Checkout folder name').fill('checkout'); await page.getByLabel('Workspace display name').fill('Checkout');
    await page.locator('[data-flow="review"]').click(); await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Clone Progress', exact: true })).toBeVisible();
    const id = (await (await request.get('/review/state')).json()).model.jobs[0].id;
    await request.post('/review/control/cloneOutput', { data: [id, 'prompt'] });
    const send = page.locator('[data-flow="send"]'), response = page.getByLabel('Response to any remote prompt (always masked)');
    await expect(send).toHaveCount(1); await expect(send).toBeEnabled();
    const check = async (height: number) => {
      await lower(send, height);
      await expect.poll(async () => page.locator('.mh-flow-content').evaluate(el => el.clientHeight)).toBeGreaterThan(44);
      await expect.poll(async () => page.locator('.mh-clone-prompt').evaluate((el, height) => el.getBoundingClientRect().bottom <= height, height)).toBe(true);
      await expect.poll(async () => page.locator('.mh-flow-content').evaluate(el => el.getBoundingClientRect().bottom <= el.querySelector('.mh-clone-prompt')!.getBoundingClientRect().top)).toBe(true);
    };
    await check(size.height); const dockInitiallyHidden = await page.locator('.mh-dock').isHidden(); await response.fill('DISPOSABLE');
    const effective = Math.min(size.height, 440);
    if (size.height > 440) { await keyboard(page, effective); await check(effective); await expect(page.locator('.mh-dock')).toBeHidden(); await expect(response).toBeFocused(); }
    await keyboard(page); await check(size.height); await expect(response).toHaveValue('DISPOSABLE');
    await expect.poll(() => page.locator('.mh-dock').isHidden()).toBe(dockInitiallyHidden);
    await send.click(); await expect(response).toHaveValue('');
    expect(errors.filter(error => error.includes('ResizeObserver'))).toEqual([]);
  });
}

test('login submit and unavailable Retry have one contextual action; workspace ellipsis has no detour', async ({ page, request }) => {
  await request.post('/review/reset', { data: { scenario: 'signed-out' } });
  await page.setViewportSize({ width: 390, height: 664 }); await page.goto('/');
  const submit = page.locator('.mh-login button[type="submit"]');
  await expect(submit).toHaveCount(1); await expect(submit).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('reviewer');
  await page.getByLabel('Password', { exact: true }).fill('review-only');
  await keyboard(page, 400); await expect(submit).toHaveCount(1);
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await keyboard(page); await submit.click(); await expect(page.locator('[data-action="info:atlas"]')).toBeVisible();
  await page.locator('[data-action="info:atlas"]').click();
  await expect(page.locator('.mh-flow-page h1')).toHaveText('Atlas');
  await expect(activeTask(page)).toHaveCount(0);
  await expect(page.locator('[data-action^="manage:"]')).toHaveCount(0);
  await moreAction(page, 'Rename display name'); await expect(activeTask(page)).toBeVisible();
  await page.keyboard.press('Escape'); await page.locator('[data-flow="flow-back"]').click();
  await expect(page.locator('[data-action="info:atlas"]')).toBeFocused();
  await request.post('/review/control/fail', { data: ['readAuthentication', { kind: 'unavailable', message: 'Synthetic outage' }] });
  await page.reload();
  const retry = page.locator('[data-action="refresh"]');
  await expect(retry).toHaveCount(1); await expect(retry).toBeVisible();
  await expect(page.locator('.mh-page main [data-action="refresh"]')).toHaveCount(1);
  await request.post('/review/control/fail', { data: ['readAuthentication', null] });
  await retry.click(); await expect(page.locator('[data-action="info:atlas"]')).toBeVisible();
});
