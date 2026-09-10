import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { activeTask, diagnosticReport, namedButton, credentialCreation, moreAction, toolDetail, toolOverride, settingsCommand } from './navigation';

async function evidence(page: Page, info: TestInfo, name: string) {
  const metrics = await page.locator(".mh-flow-page").evaluate(root => ({
    viewport: { width: innerWidth, height: innerHeight },
    text: (root as HTMLElement).innerText,
    groups: [...root.querySelectorAll(".mh-section")].map(el => ({ heading: el.querySelector("h2")?.textContent, height: el.getBoundingClientRect().height, y: el.getBoundingClientRect().y, actions: el.querySelectorAll("button").length })),
    readiness: [...root.querySelectorAll("[data-readiness-layer]")].map(el => ({ layer: el.getAttribute("data-readiness-layer"), text: el.textContent, height: el.getBoundingClientRect().height })),
    disclosureCount: root.querySelectorAll("details, [aria-expanded]").length,
    folderRows: [...root.querySelectorAll('.mh-list-row:has([data-flow^="folder-"])')].map(el => ({ height: el.getBoundingClientRect().height })),
  }));
  console.log(`${name}: ${JSON.stringify(metrics)}`);
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(metrics, null, 2));
  await info.attach(`${name}.json`, { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  return metrics;
}

test.beforeEach(async ({ request }) => {
  expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true);
});

// Observation ledger, deliberately not a "UX passed" test. Assertions below
// establish that the actual route/state was reached, not visual approval.
async function observe(page: Page, info: TestInfo, id: string) {
  const record = await page.evaluate(() => {
     const visible = (el: Element) => { const r = el.getBoundingClientRect(); const closed = el.closest('details:not([open])'); return r.width > 0 && r.height > 0 && !el.closest('[hidden], [inert]') && getComputedStyle(el).visibility !== 'hidden' && (!closed || closed.querySelector(':scope > summary')?.contains(el)); };
    const root = document.body;
    const controls = [...root.querySelectorAll('button, input, select, textarea, summary, [role="tab"], a')].filter(visible).map(el => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, name: el.getAttribute('aria-label') ?? el.textContent?.trim(), type: el.getAttribute('type'), width: r.width, height: r.height, y: r.y, role: el.getAttribute('role'), current: el.getAttribute('aria-current'), selected: el.getAttribute('aria-selected'), expanded: el.getAttribute('aria-expanded'), haspopup: el.getAttribute('aria-haspopup'), disabled: el.hasAttribute('disabled'), autocomplete: el.getAttribute('autocomplete'), inputmode: el.getAttribute('inputmode'), autocapitalize: el.getAttribute('autocapitalize') };
    });
    return { url: location.pathname + location.search, viewport: { width: innerWidth, height: innerHeight }, text: (root as HTMLElement).innerText, focus: { tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0,100), label: document.activeElement?.getAttribute('aria-label') }, controls, headings: [...root.querySelectorAll('h1,h2,h3')].filter(visible).map(el => el.textContent), tasks: [...document.querySelectorAll('.mh-task[role="region"], .mh-task[role="alertdialog"]')].filter(visible).map(el => ({ kind: el.getAttribute('data-task-kind'), text: (el as HTMLElement).innerText, modal: el.getAttribute('aria-modal'), focusInside: el.contains(document.activeElement) })) };
  });
  await writeFile(info.outputPath(`${id}.json`), JSON.stringify(record, null, 2));
  await page.screenshot({ path: info.outputPath(`${id}.png`) });
  console.log(`OBSERVED ${id}: ${record.controls.length} controls; ${record.controls.filter(c => c.width < 44 || c.height < 44).length} control boxes below 44px (labels may enlarge hit area); headings=${record.headings.join(' / ')}`);
}
const exactButton = namedButton;

test('AUDIT H01 login pending and rate-limit', async ({ page, request }, info) => {
  await request.post('/review/reset', { data: { scenario: 'signed-out' } });
  await page.goto('/'); await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await observe(page, info, 'H01-login');
  await request.post('/review/control/hold', { data: ['signIn'] });
  await page.getByLabel('Username', { exact: true }).fill('reviewer'); await page.getByLabel('Password', { exact: true }).fill('review-only');
  await exactButton(page, 'Sign in').click(); await expect(exactButton(page, 'Signing in…')).toBeDisabled(); await observe(page, info, 'H01-pending');
  await request.post('/review/control/settle', { data: ['signIn', true] });
  await expect(page.locator('.mh-login [role="alert"]')).not.toBeEmpty(); await observe(page, info, 'H01-error');
});

test('AUDIT H02 H03 H04 dashboard and workspace actions', async ({ page, request }, info) => {
  await page.goto('/'); await expect(page.locator('[data-action="info:atlas"]')).toBeVisible(); await observe(page, info, 'H02-H03-mixed');
  await page.locator('[data-action="info:atlas"]').click(); await expect(page.locator('.mh-flow-page')).toContainText('Stable ID: atlas'); await observe(page, info, 'H04-ellipsis-information');
  await expect(exactButton(page, 'Rename display name')).toBeVisible(); await observe(page, info, 'H04-actions');
  await exactButton(page, 'Rename display name').click(); await observe(page, info, 'H04-rename'); await exactButton(page, 'Cancel').click(); await observe(page, info, 'H04-rename-cancel');
  for (const scenario of ['empty', 'all-running', 'all-stopped', 'branches']) {
    await request.post('/review/reset', { data: { scenario } }); await page.goto('/'); await expect(page.locator('#mobile-hub-root h1')).toHaveText('Workspaces'); await observe(page, info, `H02-${scenario}`);
  }
});

test('AUDIT S01 S02 S03 S10 settings identity chooser and preferences', async ({ page }, info) => {
  await page.goto('/settings'); await expect(page.locator('[data-action="preview-side"]')).toBeVisible(); await observe(page, info, 'S01-S03-overview');
  const actions = await page.locator('[data-action]').evaluateAll(els => els.map(el => ({ action: el.getAttribute('data-action'), text: el.textContent })));
  console.log('SETTINGS ACTIONS', JSON.stringify(actions));
  for (const action of ['identity', 'preview-side', 'handle', 'auto-hide']) {
    const trigger = page.locator(`[data-action="${action}"]`);
    await expect(trigger).toBeVisible();
    await trigger.click(); await expect(activeTask(page)).toBeVisible(); await observe(page, info, action === 'identity' ? 'S02-identity' : `S10-${action}`);
    await page.keyboard.press('Tab'); await observe(page, info, `S10-${action}-tab`);
    await page.keyboard.press('Escape'); await expect(activeTask(page)).toHaveCount(0);
  }
  await page.goto('/settings?detail=add-credential'); await expect(exactButton(page, 'SSH key')).toBeVisible(); await observe(page, info, 'S03-chooser');
  for (const name of ['Generate SSH key', 'Import SSH key', 'Generate OpenPGP key', 'Import OpenPGP key', 'Add token']) {
    await page.goto('/settings?detail=add-credential');
    await credentialCreation(page, name.includes('SSH') ? 'ssh' : name.includes('OpenPGP') ? 'openpgp' : 'token', name.startsWith('Import'));
    await observe(page, info, `S03-${name.replaceAll(' ', '-')}`); await page.keyboard.press('Escape');
  }
});

for (const [id, route, ready] of [
  ['S04', 'credential&id=ssh-locked', 'Delete credential'], ['S05', 'credential&id=pgp-locked', 'Delete credential'], ['S06', 'credential&id=token-github', 'Delete credential'], ['S07', 'tools', 'Recheck installed tools'], ['S08', 'assignments', 'Add authentication host'], ['S09', 'default-folder', 'Current Folder'], ['S11', 'devices', 'Revoke session'], ['S12', 'security', 'Sign out'],
] as const) test(`AUDIT ${id} detail`, async ({ page }, info) => {
  await page.goto(`/settings?detail=${route}`);
  await expect(page.locator('.mh-flow-page')).toBeVisible();
  await expect(page.locator('.mh-flow-page')).not.toContainText('Loading');
  await expect(page.locator('.mh-flow-header nav [data-flow="flow-back"]')).toBeVisible();
  await expect(page.locator('.mh-flow-toolbar')).toHaveCount(0);
  if (['S07', 'S08', 'S09', 'S11', 'S12'].includes(id)) await expect(page.locator('.mh-flow-page [data-flow="more"]')).toHaveCount(0);
  await observe(page, info, `${id}-detail`);
  if (['S04','S05'].includes(id)) { await exactButton(page, 'Unlock').click(); await observe(page, info, `${id}-unlock`); await exactButton(page, 'Cancel').click(); await observe(page, info, `${id}-cancel`); }
  if (id === 'S06') { await moreAction(page, 'Delete credential'); await observe(page, info, 'S06-delete-confirm'); await exactButton(page, 'Cancel').click(); }
  if (id === 'S07') { await toolDetail(page); await observe(page, info, 'S07-selected-tool'); await toolOverride(page); await expect(page.getByLabel('Absolute executable path')).toBeVisible(); await observe(page, info, 'S07-override'); await exactButton(page, 'Cancel').click(); }
  if (id === 'S08') { await page.locator('[data-flow="workspace-atlas"]').click(); await page.locator('[data-flow="new-atlas"]').click(); await observe(page, info, 'S08-assignment-form'); await page.getByRole('combobox', { name: 'Authentication', exact: true }).selectOption('token-github'); await page.getByLabel('Authentication host').fill('github.com'); await exactButton(page,'Review').click(); await observe(page, info, 'S08-review'); await exactButton(page, 'Back to edit').click(); await observe(page, info, 'S08-back-to-edit'); }
  if (id === 'S09') { await page.locator('[data-flow="edit"]').click(); await page.getByLabel('Folder path').fill('relative'); await exactButton(page, 'Save').click(); await observe(page, info, 'S09-invalid'); await exactButton(page, 'Cancel').click(); }
  if (id === 'S11') { await page.locator('[data-flow="device-1"]').click(); await exactButton(page, ready).click(); await observe(page, info, 'S11-revoke-confirm'); await exactButton(page, 'Cancel').click(); }
});

test('AUDIT A01 A02 A03 folder browse and create states', async ({ page, request }, info) => {
  await page.goto('/?detail=add-workspace'); await expect(exactButton(page, 'Existing folder')).toBeVisible(); await observe(page, info, 'A01-entry');
  await exactButton(page, 'Existing folder').click(); await expect(page.locator('[data-flow="folder-0"]')).toBeVisible(); await observe(page, info, 'A02-browse');
  await moreAction(page, 'Current folder options'); await expect(activeTask(page)).toBeVisible(); await observe(page, info, 'A03-folder-actions'); await exactButton(page, 'Back').click();
  await moreAction(page, 'Create empty folder'); await observe(page, info, 'A03-empty-create'); await exactButton(page, 'Create folder').click(); await observe(page, info, 'A03-empty-invalid'); await exactButton(page, 'Cancel').click();
  await page.locator('[data-flow="folder-1"]').click(); await expect(page.locator('.mh-flow-page')).toContainText('unavailable'); await observe(page, info, 'A02-denied');
  await page.goto('/?detail=add-workspace'); await exactButton(page, 'Create workspace').click(); await expect(activeTask(page)).toBeVisible(); await observe(page, info, 'A03-workspace-create'); await exactButton(page, 'Cancel').click(); await observe(page, info, 'A03-create-cancel');
});

test('AUDIT A04 A05 A06 A07 clone review progress and recovery', async ({ page, request }, info) => {
  await page.goto('/clone'); await expect(page.getByLabel('Remote URL')).toBeVisible(); await observe(page, info, 'A04-form');
  await page.getByLabel('Remote URL').fill('https://github.com/review/audit.git'); await page.getByLabel('Checkout folder name').fill('ios-audit'); await page.getByLabel('Workspace display name').fill('iOS audit');
  await exactButton(page, 'Review clone').click(); await observe(page, info, 'A05-review'); await exactButton(page, 'Back to edit').click(); await observe(page, info, 'A05-back');
  await exactButton(page, 'Review clone').click(); await exactButton(page, 'Clone').click(); await expect(page.getByRole('heading', { name: 'Clone Progress' })).toBeVisible(); await observe(page, info, 'A06-progress');
  const state = await (await request.get('/review/state')).json(); const id = state.model.jobs[0].id;
  await request.post('/review/control/cloneOutput', { data: [id, 'prompt'] }); await expect(exactButton(page, 'Send response')).toBeEnabled(); await observe(page, info, 'A06-prompt');
  await request.post('/review/control/finishClone', { data: [id, 'register-failed'] }); await expect(page.locator('[data-clone-status]')).toContainText('could not be registered'); await observe(page, info, 'A07-retained-checkout');
});

test('AUDIT H05 W01 W02 W03 actual workspace and return', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.goto('/'); await page.locator('[data-action="open:atlas"]').click(); await expect(page.locator('#preview')).toContainText('Synthetic review document');
  for (const surface of ['files', 'preview', 'chat', 'terminal']) {
    await expect.poll(() => page.locator('#mobile-workspace-root').evaluate(el => el.getBoundingClientRect().x)).toBe(0);
    if (await page.locator('#navigation-handle').isVisible()) await page.locator('#navigation-handle').click();
    await page.locator(`[data-tab="${surface}"]`).click();
    if (surface === 'terminal') await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
    await observe(page, info, `W01-${surface}`);
    if (surface === 'preview') await observe(page, info, 'W03-preview-navigation');
  }
  if (await page.locator('#navigation-handle').isVisible()) await page.locator('#navigation-handle').click();
  await observe(page, info, 'W02-expanded'); await page.locator('#navigation-hub').click(); await expect(page.locator('#mobile-hub-root h1')).toHaveText('Workspaces'); await observe(page, info, 'H05-return-hub');
  await page.locator('#mobile-hub-root [data-action="settings"]').click(); await observe(page, info, 'H05-return-settings');
  await page.locator('#mobile-hub-root [data-action="return"]').click(); await expect(page.locator('#mobile-hub-root')).toBeHidden(); await observe(page, info, 'H05-returned-terminal');
});

test('AUDIT key pending error cancel and recovery states', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const control = async (name: string, args: unknown[]) => expect((await request.post(`/review/control/${name}`, { data: args })).ok()).toBe(true);
  await page.goto('/settings?detail=credential&id=ssh-locked'); await exactButton(page, 'Unlock').click(); await page.getByLabel('Passphrase', { exact: true }).fill('DISPOSABLE');
  await control('hold', ['unlockCredential']); await activeTask(page).getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(activeTask(page).getByRole('button', { name: 'Unlock', exact: true })).toBeDisabled(); await observe(page, info, 'S04-unlock-pending');
  await control('settle', ['unlockCredential', true]); await expect(activeTask(page).getByRole('alert')).not.toBeEmpty(); await observe(page, info, 'S04-unlock-error'); await exactButton(page, 'Cancel').click();
  await control('setToolState', ['git', 'missing']); await page.goto('/settings?detail=tools'); await toolDetail(page); await page.locator('[data-flow="test-git"]').click(); await expect(activeTask(page, 'editor', 'Check Results')).toContainText('Synthetic binary not found'); await observe(page, info, 'S07-missing-git'); await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await control('hold', ['testTool']); await page.locator('[data-flow="test-git"]').click(); await expect(page.locator('[data-flow="test-git"]')).toBeDisabled(); await observe(page, info, 'S07-test-pending');
  await control('settle', ['testTool', true]); await expect(page.locator('.mh-flow-error')).not.toBeEmpty(); await observe(page, info, 'S07-test-error');
  await page.goto('/settings'); await page.locator('[data-action="security"]').click(); await control('hold', ['signOut']); await exactButton(page, 'Sign out').click(); await observe(page, info, 'S12-signout-confirm');
  await activeTask(page, 'confirmation').getByRole('button', { name: 'Sign out', exact: true }).click(); await observe(page, info, 'S12-signout-pending'); await control('settle', ['signOut', true]); await expect(activeTask(page, 'confirmation').getByRole('alert')).not.toBeEmpty(); await observe(page, info, 'S12-signout-error'); await page.keyboard.press('Escape'); await observe(page, info, 'S12-signout-cancel-focus');
  await control('setToolState', ['git', 'ready']); await page.goto('/clone'); await page.getByLabel('Remote URL').fill('git@github.com:review/audit.git'); await page.getByLabel('Checkout folder name').fill('cancel-audit'); await page.getByLabel('Workspace display name').fill('Cancel audit'); await page.getByLabel('One-time clone credential').selectOption('ssh-locked');
  await exactButton(page, 'Unlock selected clone identity').click(); await observe(page, info, 'A05-unlock'); await exactButton(page, 'Cancel').click(); await observe(page, info, 'A05-unlock-cancel');
  await page.getByLabel('One-time clone credential').selectOption(''); await exactButton(page, 'Review clone').click(); await exactButton(page, 'Clone').click(); await expect(page.getByRole('heading', { name: 'Clone Progress' })).toBeVisible();
  const id = (await (await request.get('/review/state')).json()).model.jobs[0].id;
  await control('disconnectClone', [id]); await observe(page, info, 'A06-disconnect-requested-not-proven');
  await control('finishClone', [id, 'cancelled']); await page.reload(); await expect(page.getByRole('heading', { name: 'Clone Progress' })).toBeVisible(); await observe(page, info, 'A07-cancelled');
});

test("RED folder browsing offers compact primary disclosure, not per-folder action cards", async ({ page }, info) => {
  await page.goto("/?detail=add-workspace");
  await exactButton(page, 'Existing folder').click();
  await expect(page.locator('[data-flow="folder-0"]')).toBeVisible();
  const metrics = await evidence(page, info, "A02-folder-cards");
  // An audit acceptance budget, not an Apple-prescribed maximum: two lines plus
  // a >=44px primary hit area fit in 88px. Secondary actions remain contextual.
  const cards = metrics.folderRows;
  expect(cards.length).toBe(6);
  expect.soft(Math.max(...cards.map(g => g.height)), "Folder rows should fit a compact two-line 88px budget").toBeLessThanOrEqual(88);
  expect.soft(await page.getByRole("button", { name: "Folder actions", exact: true }).count(), "Repeated labeled management actions belong behind a contextual affordance").toBe(0);
  const entries = page.locator('[data-flow^="folder-"]');
  const groups = await entries.evaluateAll(els => new Set(els.map(el => el.closest('.mh-group'))).size);
  expect.soft(groups, "Folder hierarchy targets belong to one unified list group").toBe(1);
  expect.soft(await page.getByRole('button', { name: 'Browse folder', exact: true }).count(), "The named folder row itself is the primary hierarchy target").toBe(0);
});

test("RED credential readiness provides tool context and progressive diagnostics", async ({ page }, info) => {
  await page.goto("/settings?detail=credential&id=ssh-locked");
  await expect(page.locator('[data-readiness-layer]')).toHaveCount(0);
  await settingsCommand(page, 'unlock');
  await diagnosticReport(page);
  const rows = activeTask(page).locator('[data-readiness-layer]');
  expect(await activeTask(page).locator('[data-readiness-layer="binary"]').count()).toBeGreaterThan(1);
  await expect(activeTask(page).locator('[data-readiness-layer="binary"]').first()).toBeVisible();
  // ReadinessResult carries no tool identity. Do not fabricate a mapping from
  // row order; retain anonymous credential diagnostics and expose named tools
  // through the existing tool-readiness destination.
  await expect(rows).toHaveCount(17);
  await info.attach('all-17-diagnostics', { body: JSON.stringify(await rows.allTextContents()), contentType: 'application/json' });
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('[data-readiness-layer]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Review SSH (locked)', exact: true })).toBeVisible();
});
