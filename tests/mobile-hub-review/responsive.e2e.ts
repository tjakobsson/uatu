/** Discovery evidence, never approved goldens. Run: bun tests/mobile-hub-review/responsive.e2e.ts */
import { chromium, webkit, devices, expect as baseExpect, type Page } from "@playwright/test";
import { startReviewServer } from "./server";
import { activeTask, namedButton, credentialCreation } from './navigation';

// Playwright imports every *.e2e.ts during discovery under Node. The extended
// Bun evidence runner must have no launch/file effects merely from that import.
export async function captureResponsiveEvidence() {
const base = "openspec/changes/restore-refined-mobile-hub-experience/review-evidence/responsive";
// Discovery checks readiness, not response latency; retain failures separately.
const expect = baseExpect.configure({ timeout: 30000 });
const out = process.env.RESPONSIVE_PREFLIGHT ? `${base}/preflight` : base;
// Preserve previous discovery, including failures, before any evidence overwrite.
if (await Bun.file(`${out}/results.json`).exists()) {
  const prior = await Bun.file(`${out}/results.json`).json();
  const archive = `${out}/history/${prior.capturedAt.replace(/[:.]/g, '-')}`;
  for await (const name of new Bun.Glob('*').scan({ cwd: out, onlyFiles: true })) {
    await Bun.write(`${archive}/${name}`, Bun.file(`${out}/${name}`));
  }
}
const rows: { scenario: string; status: string; details?: unknown }[] = [];
const closeConnections = process.env.RESPONSIVE_CLOSE_CONNECTIONS !== '0';
const provenance = { browsers: {} as Record<string, string>, bun: Bun.version, closeConnections, sourceHashes: Object.fromEntries(await Promise.all(['src/hub/mobile/styles.css', 'tests/mobile-hub-review/responsive.e2e.ts', 'tests/mobile-hub-review/responsive-server.ts'].map(async path => [path, new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')])) ) };
const sizes = [[320, 740], [390, 844], [844, 390], [820, 1180]] as const;
async function scale(page: Page, factor: number) {
  // Explicit reference text stress policy, NOT native OS Dynamic Type or browser zoom.
  await page.evaluate(factor => {
    const elements = [...document.querySelectorAll<HTMLElement>(".mh-root, .mh-root *, #touch-tab-bar *, #navigation-handle *, #preview-file-navigation *")];
    for (const e of elements) if (e.dataset.reviewFont !== undefined) e.style.fontSize = e.dataset.reviewFont;
    const sizes = elements.map(e => ({ e, size: parseFloat(getComputedStyle(e).fontSize) }));
    for (const { e, size } of sizes) { e.dataset.reviewFont ??= e.style.fontSize; e.style.fontSize = `${size * factor}px`; }
  }, factor);
}
async function audit(page: Page, scenario: string, factor: number, screenshot = false) {
  await scale(page, factor); await page.waitForTimeout(350);
  const details = await page.evaluate(() => {
    const root = document.querySelector('.mh-sheet') ?? (document.querySelector('.mh-root')?.closest('[inert]') ? document.querySelector('#touch-tab-bar') : document.querySelector('.mh-root:not([hidden])'));
    const issues: unknown[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push({ kind: 'document overflow', width: document.documentElement.scrollWidth, viewport: innerWidth });
    for (const e of root?.querySelectorAll<HTMLElement>('button,input:not([type=hidden]),select,textarea,a[href]') ?? []) {
      const target = e.matches('input[type=checkbox],input[type=radio]') ? e.closest('label') ?? e : e;
      const r = target.getBoundingClientRect(); if (!r.width || !r.height || e.closest('[inert]') || getComputedStyle(e).visibility === 'hidden') continue;
      const selector = e.id ? `#${e.id}` : `${e.tagName}.${e.className} ${e.getAttribute('data-flow') ?? e.getAttribute('data-action') ?? e.textContent?.trim().slice(0, 60)}`;
      if (r.width < 43.5 || r.height < 43.5) issues.push({ kind: 'target under 44', selector, width: r.width, height: r.height });
      if (r.left < -1 || r.right > innerWidth + 1) issues.push({ kind: 'horizontal clipping', selector, x: r.x, width: r.width });
    }
    const selects = [...(root?.querySelectorAll('select') ?? [])].map(e => { const r = e.getBoundingClientRect(); return { label: e.getAttribute('aria-label') ?? e.closest('label')?.textContent?.slice(0, 80), width: r.width, height: r.height, appearance: getComputedStyle(e).appearance }; });
    return { issues, selects, viewport: [innerWidth, innerHeight], rootFont: root && getComputedStyle(root).fontFamily };
  });
  rows.push({ scenario, status: details.issues.length ? 'FAIL' : 'PASS', details });
  if (screenshot) await page.screenshot({ path: `${out}/${scenario}.png`, scale: 'css' });
  if (await page.locator('.mh-sheet').count()) {
    const footer = page.locator('.mh-task[data-task-kind="editor"] header button, .mh-task[data-task-kind="confirmation"] footer button').last();
    if (await footer.count()) {
      await footer.scrollIntoViewIfNeeded(); const r = await footer.boundingBox();
      rows.push({ scenario: `${scenario}-footer`, status: r && r.y >= 0 && r.y + r.height <= page.viewportSize()!.height + 1 ? 'PASS' : 'FAIL', details: r });
    }
    await page.locator('.mh-sheet button,.mh-sheet input,.mh-sheet select').first().focus();
    const escaped: string[] = [];
    for (let i = 0; i < 18; i++) { await page.keyboard.press('Tab'); const outside = await page.evaluate(() => document.activeElement?.closest('.mh-sheet') ? null : document.activeElement?.outerHTML.slice(0, 200)); if (outside) escaped.push(outside); }
    rows.push({ scenario: `${scenario}-focus-trap`, status: escaped.length ? 'FAIL' : 'PASS', details: escaped });
  }
}
async function isolatedServer() {
  const child = Bun.spawn(['bun', 'tests/mobile-hub-review/responsive-server.ts'], { stdout: 'pipe', stderr: 'inherit' });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const next = await reader.read();
    if (next.done) throw new Error('Responsive mock server exited before announcing its OS-assigned port');
    text += new TextDecoder().decode(next.value);
  }
  const { url } = JSON.parse(text.split('\n')[0]!);
  return { url: url as string, async stop() { child.kill('SIGTERM'); await child.exited; reader.releaseLock(); } };
}
const server = process.env.RESPONSIVE_SAME_PROCESS ? await startReviewServer({ port: 0 }) : await isolatedServer();
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch();
    provenance.browsers[engineName] = browser.version();
    try {
      for (const [width, height] of sizes) for (const theme of ['light', 'dark'] as const) for (const factor of [1, 2]) {
        const id = `${engineName}-${width}x${height}-${theme}-${factor * 100}`;
        if (process.env.RESPONSIVE_PREFLIGHT && !['webkit-320x740-light-100', 'chromium-844x390-dark-200'].includes(id)) continue;
        // Keep real HTTP/SSE protocols while opting out of socket reuse. This
        // reduced transient stalls in A/B runs, but is NOT a proven root-cause fix.
        // Set RESPONSIVE_CLOSE_CONNECTIONS=0 to exercise persistent connections.
        const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height }, colorScheme: theme, baseURL: server.url, serviceWorkers: 'block', ...(closeConnections ? { extraHTTPHeaders: { Connection: 'close' } } : {}) });
        const page = await context.newPage(); page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
        const pending = new Set<string>();
        const network: unknown[] = [];
        page.on('request', request => pending.add(request.url()));
        page.on('response', response => network.push({ url: response.url(), status: response.status(), timing: response.request().timing() }));
        page.on('requestfinished', request => pending.delete(request.url()));
        page.on('requestfailed', request => pending.delete(request.url()));
        const button = (name: string) => namedButton(page, name);
        const check = (state: string, image = false) => audit(page, `${id}-${state}`, factor, image);
        try {
          await context.request.post('/review/reset', { data: { scenario: 'signed-out' } }); await page.goto('/');
          await check('login'); await page.getByLabel('Username', { exact: true }).fill('reviewer'); await page.getByLabel('Password', { exact: true }).fill('wrong-disposable'); await button('Sign in').click();
          await expect(page.getByLabel('Password', { exact: true })).toHaveValue(''); await check('login-error');
          await page.getByLabel('Password', { exact: true }).fill('review-only'); await button('Sign in').click(); await expect(page.locator('[data-action="open:atlas"]')).toBeVisible(); await check('hub');
          await page.locator('[data-action="open:atlas"]').click(); await expect(page.locator('#preview')).toContainText('Synthetic review document');
          const before = await page.locator('#preview').evaluate(e => getComputedStyle(e).fontSize); await check('workspace');
          rows.push({ scenario: `${id}-interior-font-isolation`, status: before === await page.locator('#preview').evaluate(e => getComputedStyle(e).fontSize) ? 'PASS' : 'FAIL' });
          await page.locator('#navigation-hub').click(); await page.locator('[data-action="settings"]').click(); await check('settings');
          await page.locator('[data-action="preview-side"]').click();
          await expect(activeTask(page).getByRole('radio')).toHaveCount(2);
          await expect(activeTask(page).locator('select')).toHaveCount(0);
          await page.getByRole('radio', { name: 'Right', exact: true }).check();
          await check('preference', width === 320 && factor === 2); await activeTask(page).getByRole('button', { name: 'Save', exact: true }).click();
          await expect(page.locator('[data-action="preview-side"]')).toContainText('Right');
          await page.locator('[data-action="return"]').click(); await expect(page.locator('#preview')).toBeVisible();
          rows.push({ scenario: `${id}-journey-return`, status: 'PASS' });
          await page.goto('/settings?detail=add-credential'); await credentialCreation(page, 'token'); await check('credential', width === 320 && factor === 2);
          await page.getByLabel('Name', { exact: true }).fill('Review token'); await page.getByLabel('Provider host').fill('github.com'); await page.getByLabel('Token', { exact: true }).fill('DISPOSABLE');
          await page.getByLabel('Token', { exact: true }).focus(); await page.setViewportSize({ width, height: Math.max(260, height - 300) });
          // Viewport resizing is not a keyboard API and does not itself promise
          // native auto-scroll. Explicitly test that the focused field is reachable.
          await page.getByLabel('Token', { exact: true }).scrollIntoViewIfNeeded();
          const inputReachability = await page.getByLabel('Token', { exact: true }).evaluate(e => {
            const input = e.getBoundingClientRect(), body = document.querySelector('.mh-task .mh-sheet-body')!.getBoundingClientRect(), header = document.querySelector('.mh-task header')!.getBoundingClientRect();
            return { input: { y: input.y, bottom: input.bottom, height: input.height }, headerBottom: header.bottom, bodyBottom: body.bottom, reachable: input.top >= header.bottom - 1 && input.bottom <= body.bottom + 1 };
          });
          rows.push({ scenario: `${id}-keyboard-input-reachable`, status: inputReachability.reachable ? 'PASS' : 'FAIL', details: inputReachability });
          await check('keyboard-viewport', width === 320 && factor === 2 && theme === 'light'); await page.setViewportSize({ width, height });
          await context.request.post('/review/control/hold', { data: ['createToken'] }); await button('Add').click(); await context.request.post('/review/control/settle', { data: ['createToken', true] }); await expect(activeTask(page)).toContainText('Synthetic operation failed'); await check('credential-error'); await button('Cancel').click();
          await page.goto('/settings?detail=assignments'); await page.locator('[data-flow="workspace-atlas"]').click(); await page.locator('[data-flow="new-atlas"]').click(); await check('assignment', engineName === 'webkit' && width === 320 && factor === 1 && theme === 'light'); await page.getByRole('combobox', { name: 'Authentication', exact: true }).selectOption('token-github'); await page.getByLabel('Authentication host').fill('github.com'); await button('Review').click(); await check('assignment-review'); await button('Back to edit').click();
          await page.goto('/?detail=add-workspace'); await button('Create workspace').click(); await check('onboard', width === 844 && factor === 2);
          await page.getByLabel('New folder name').fill('responsive-review'); await page.getByLabel('Workspace display name').fill('Responsive review'); await page.getByLabel('Create the folder and initialize Git').check();
          await context.request.post('/review/control/setOnboardingFault', { data: ['register-failed'] }); await button('Review').click(); await check('onboard-review'); await button('Add stopped').click(); await expect(page.getByRole('heading', { name: 'Configuration needs attention' })).toBeVisible(); await check('onboard-error'); await button('Inspect retained folder').click(); await check('onboard-recovery');
        } catch (error) {
          const probes = await Promise.all([...pending].filter(url => url.includes('/api/document?')).map(async url => { const start = performance.now(); try { const response = await context.request.get(url, { timeout: 5000 }); return { url, status: response.status(), elapsed: performance.now() - start }; } catch (error) { return { url, error: String(error) }; } }));
          rows.push({ scenario: `${id}-journey-interrupted`, status: 'FAIL', details: { error: String(error), pending: [...pending], probes, network, document: await page.evaluate(() => ({ readyState: document.readyState, url: location.href, heading: document.querySelector('h1')?.textContent })).catch(() => null) } });
        }
        finally {
          for (const state of ['login', 'login-error', 'hub', 'workspace', 'interior-font-isolation', 'settings', 'preference', 'journey-return', 'credential', 'keyboard-viewport', 'credential-error', 'assignment', 'assignment-review', 'onboard', 'onboard-review', 'onboard-error', 'onboard-recovery']) {
            if (!rows.some(r => r.scenario === `${id}-${state}`)) rows.push({ scenario: `${id}-${state}`, status: 'UNTESTED', details: 'Earlier journey interruption; not treated as passing.' });
          }
          await context.close();
        }
      }
      const page = await browser.newPage({ ...devices['iPhone 13'], baseURL: server.url });
      await page.goto('/');
      for (const [label, media, query] of [ ['reduced-motion', { reducedMotion: 'reduce' }, '(prefers-reduced-motion: reduce)'], ['forced-colors', { forcedColors: 'active' }, '(forced-colors: active)'], ['contrast', { contrast: 'more' }, '(prefers-contrast: more)'] ] as const) {
        await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none', contrast: 'no-preference', ...media }); const supported = await page.evaluate(q => matchMedia(q).matches, query);
        rows.push({ scenario: `${engineName}-${label}-API`, status: supported ? 'PASS' : 'UNSUPPORTED', details: { browser: browser.version(), query } });
        if (supported) await audit(page, `${engineName}-${label}`, 1, true);
      }
      if (engineName === 'chromium') {
        await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none', contrast: 'no-preference' });
        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
        const matched = await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
        const material = await page.locator('.mh-dock').evaluate(e => ({ blur: getComputedStyle(e).backdropFilter, background: getComputedStyle(e).backgroundColor }));
        rows.push({ scenario: `${engineName}-reduced-transparency-API`, status: matched && material.blur === 'none' ? 'PASS' : 'FAIL', details: { matched, material, browser: browser.version(), method: 'CDP Emulation.setEmulatedMedia' } });
        await audit(page, `${engineName}-reduced-transparency`, 1, true); await session.detach();
      } else rows.push({ scenario: `${engineName}-reduced-transparency`, status: 'UNSUPPORTED', details: 'No WebKit CDP session or Playwright reducedTransparency emulation option; not emulated.' });
      await page.close();
    } finally { await browser.close(); }
  }
} finally {
  await server.stop();
  await Bun.write(`${out}/results.json`, JSON.stringify({ capturedAt: new Date().toISOString(), provenance, policy: 'Synthetic protocol only; scoped font-size stress, not OS text scaling. Keyboard is focus + viewport reduction, not physical keyboard. Discovery assertions are failures, not accepted goldens.', rows }, null, 2));
  await Bun.write(`${out}/scenarios.md`, '# Responsive discovery scenario table\n\n| Scenario | Result |\n| --- | --- |\n' + rows.map(r => `| ${r.scenario} | ${r.status} |`).join('\n') + '\n');
}
console.info(JSON.stringify(rows.reduce((sum, r) => ({ ...sum, [r.status]: (sum[r.status] ?? 0) + 1 }), {} as Record<string, number>)));
if (rows.some(r => r.status === 'FAIL')) process.exitCode = 1;
}
if (import.meta.main) await captureResponsiveEvidence();
