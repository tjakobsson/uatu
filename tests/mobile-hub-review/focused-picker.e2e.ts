import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { namedButton } from './navigation';

const evidence = process.env.UATU_REVIEW_PICKER_EVIDENCE ?? 'openspec/changes/restore-refined-mobile-hub-experience/review-evidence/folder-picker';
const picker = (page: Page) => page.locator('.mh-folder-picker');
const button = namedButton;
const state = async (request: APIRequestContext) => (await request.get('/review/state')).json();
async function openDefault(page: Page, path = '/synthetic') {
  await page.goto('/settings?detail=default-folder'); await page.locator('[data-flow="edit"]').click();
  await page.getByLabel('Folder path').fill(path); await button(page, 'Choose folder').click();
  await expect(picker(page)).toBeVisible();
}
function probe(page: Page) {
  const calls: { method: string; args: unknown }[] = [];
  page.on('request', r => { if (r.url().includes('/review/backend/')) calls.push({ method: r.url().split('/').at(-1)!, args: r.postDataJSON() }); });
  return calls;
}
const readsOnly = (calls: { method: string }[]) => expect(calls.filter(c => !c.method.startsWith('read') && c.method !== 'browseFolders')).toEqual([]);
test.beforeEach(async ({ request }) => { await request.post('/review/reset', { data: { scenario: 'mixed' } }); });

test('default nested/up selection returns canonical draft once, writes only on Save', async ({ page, request }, info) => {
  // Synthetic backend setup, not a picker interaction.
  expect((await (await request.post('/review/backend/createFolder', { data: [{ parent: '/synthetic/group', name: 'child' }] })).json()).status).toBe('completed');
  const calls = probe(page); await openDefault(page);
  await expect(button(page, 'Choose')).toBeEnabled();
  await page.screenshot({ path: `${evidence}/${info.project.name}-normal.png` });
  await expect(page.getByRole('navigation', { name: 'Hub navigation' })).toHaveCount(0);
  await picker(page).getByRole('button', { name: 'group', exact: true }).click();
  await picker(page).getByRole('button', { name: 'child', exact: true }).click();
  await expect(picker(page).locator('h1')).toHaveAttribute('title', '/synthetic/group/child');
  await expect(picker(page).getByRole('heading', { name: 'No subfolders' })).toBeVisible();
  await expect(picker(page)).toContainText('Files aren’t shown here. Tap Choose to use this folder.');
  await expect(picker(page).locator('.mh-empty-state button')).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/${info.project.name}-empty.png` });
  await picker(page).getByRole('button', { name: 'Parent folder: /synthetic/group', exact: true }).click();
  await expect(picker(page).locator('h1')).toHaveText('group');
  await button(page, 'Choose').click();
  await expect(page.getByLabel('Folder path')).toHaveValue('/synthetic/group'); readsOnly(calls);
  await button(page, 'Save').click();
  await expect.poll(async () => (await state(request)).model.defaultFolder.configured).toBe('/synthetic/group');
  expect(calls.filter(c => c.method === 'setDefaultFolder')).toEqual([{ method: 'setDefaultFolder', args: ['/synthetic/group'] }]);
  await info.attach('readonly-and-save-probe', { body: JSON.stringify(calls, null, 2), contentType: 'application/json' });
});

test('failed read disables Choose, Retry and last-valid recover, Cancel restores draft', async ({ page, request }, info) => {
  const calls = probe(page); await openDefault(page);
  await expect(button(page, 'Choose')).toBeEnabled();
  await request.post('/review/control/hold', { data: ['browseFolders'] });
  await picker(page).getByRole('button', { name: 'denied', exact: true }).click();
  await expect(button(page, 'Choose')).toBeDisabled(); await expect(button(page, 'Cancel')).toBeEnabled();
  await request.post('/review/control/settle', { data: ['browseFolders', false] });
  await expect(picker(page).getByRole('alert')).toBeVisible(); await expect(button(page, 'Choose')).toBeDisabled();
  await page.screenshot({ path: `${evidence}/${info.project.name}-error.png` });
  await button(page, 'Retry').click(); await expect(picker(page).getByRole('alert')).toBeVisible();
  await picker(page).getByRole('button', { name: 'Return to folder: /synthetic', exact: true }).click();
  await expect(button(page, 'Choose')).toBeEnabled();
  await button(page, 'Cancel').click(); await expect(page.getByLabel('Folder path')).toHaveValue('/synthetic');
  readsOnly(calls); expect((await state(request)).log).toEqual([]);
  await info.attach('readonly-probe', { body: JSON.stringify(calls, null, 2), contentType: 'application/json' });
});

test('Create parent picker preserves fields; Existing and management stay separate', async ({ page, request }) => {
  const calls = probe(page); await page.goto('/?detail=add-workspace'); await button(page, 'Create workspace').click();
  await page.getByLabel('New folder name').fill('draft-folder'); await page.getByLabel('Workspace display name').fill('Draft name');
  await page.getByLabel('Create the folder and initialize Git').check();
  await button(page, 'Browse elsewhere').click(); await button(page, 'Cancel').click();
  await expect(page.getByLabel('New folder name')).toHaveValue('draft-folder');
  await button(page, 'Browse elsewhere').click(); await picker(page).getByRole('button', { name: 'existing', exact: true }).click(); await button(page, 'Choose').click();
  await expect(page.getByLabel('Parent folder')).toHaveValue('/synthetic/existing');
  await expect(page.getByLabel('Workspace display name')).toHaveValue('Draft name'); await expect(page.getByLabel('New folder name')).toHaveValue('draft-folder');
  await expect(page.getByLabel('Create the folder and initialize Git')).toBeChecked();
  await page.goto('/?detail=add-workspace'); await button(page, 'Existing folder').click();
  await picker(page).getByRole('button', { name: 'existing', exact: true }).click();
  await expect(page.getByLabel('Workspace display name')).toHaveCount(0);
  await button(page, 'Choose').click(); await expect(page.getByLabel('Workspace display name')).toHaveValue('existing');
  await page.goto('/?detail=add-workspace'); await button(page, 'Manage folders').click();
  await expect(page).toHaveURL(/detail=folders/); await expect(picker(page)).toHaveCount(0);
  await expect(button(page, 'Configure this folder')).toBeVisible();
  for (const name of ['Browse elsewhere', 'Create empty folder', 'Create workspace here', 'Rename folder', 'Remove empty folder']) await expect(button(page, name)).toBeVisible();
  readsOnly(calls); expect((await state(request)).log).toEqual([]);
});

test('actual CSS long list keeps header fixed and full 300-character path readable', async ({ page, request }, info) => {
  // Backend writes below are fixture setup only, before the interaction probe starts.
  let path = '/synthetic';
  for (let i = 0; i < 5; i++) {
    const name = `${i}-${'long'.repeat(14)}`;
    const result = await request.post('/review/backend/createFolder', { data: [{ parent: path, name }] });
    expect((await result.json()).status).toBe('completed'); path += `/${name}`;
  }
  for (let i = 0; i < 24; i++) expect((await (await request.post('/review/backend/createFolder', { data: [{ parent: path, name: `folder-${String(i).padStart(2, '0')}` }] })).json()).status).toBe('completed');
  const setupLog = (await state(request)).log; const calls = probe(page); await openDefault(page, path);
  await expect(button(page, 'Choose')).toBeEnabled(); expect(path.length).toBeGreaterThanOrEqual(300);
  await expect(picker(page).locator('h1')).toHaveAttribute('title', path);
  await expect(picker(page).locator('.mh-folder-location code')).toHaveText(path);
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const body = picker(page).locator('.mh-sheet-body'); await body.evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `${evidence}/${info.project.name}-${viewport.width}-normal.png` });
    const header = picker(page).locator(':scope > header'); const before = await header.boundingBox();
    expect(await picker(page).locator('.mh-folder-location code').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(before);
    for (const name of ['Cancel', 'Choose']) { const control = button(page, name); await expect(control).toBeInViewport(); const box = await control.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: `${evidence}/${info.project.name}-${viewport.width}-scrolled.png` });
  }
  readsOnly(calls); expect((await state(request)).log).toEqual(setupLog);
  await info.attach('fixture-setup-separated-readonly-probe', { body: JSON.stringify({ fixtureWrites: setupLog.length, pickerCalls: calls }, null, 2), contentType: 'application/json' });
});
