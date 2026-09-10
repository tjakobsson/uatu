// Diagnostic harness: real review assembly, no production changes.
import { chromium, webkit, devices } from '@playwright/test';
if (await fetch('http://127.0.0.1:4706/review/health').then(() => true).catch(() => false)) {
  throw new Error('Port 4706 is already serving; verify and stop only the owned review server before probing.');
}
const server = Bun.spawn(['bun', 'server.ts', '--port', '4706'], { cwd: import.meta.dir, stdout: 'ignore', stderr: 'inherit' });
for (let i = 0; i < 100; i++) {
  if (await fetch('http://127.0.0.1:4706/review/health').then(r => r.ok).catch(() => false)) break;
  await Bun.sleep(100);
}
const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const browserCDP = process.env.ENGINE === 'webkit' ? null : await browser.newBrowserCDPSession();
const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: 'http://127.0.0.1:4706' });
if (process.env.TRACE === 'on') await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
if (process.env.FONT === 'fallback') await page.route('**/*.woff2', route => route.abort());
const cdp = process.env.ENGINE === 'webkit' ? null : await context.newCDPSession(page);
cdp?.on('Debugger.paused', async event => {
  console.log('PAUSED', JSON.stringify(event.callFrames.map(f => ({ name: f.functionName, url: f.url, location: f.location }))));
  const frame = event.callFrames[0];
  const source = await cdp.send('Debugger.getScriptSource', { scriptId: frame.location.scriptId });
  console.log('PAUSED SOURCE', source.scriptSource.split('\n').slice(frame.location.lineNumber - 3, frame.location.lineNumber + 4).join('\n'));
});
page.setDefaultTimeout(5000);
let heartbeat = Date.now(), sampling = false;
page.on('console', message => { if (message.text().startsWith('[transition-probe]')) { heartbeat = Date.now(); console.log(message.text()); } });
const watchdog = setInterval(async () => {
  if (sampling || Date.now() - heartbeat < 3000) return;
  sampling = true;
  process.exitCode = 1;
  console.log('HEARTBEAT STALL', Date.now() - heartbeat);
  const processes = await browserCDP?.send('SystemInfo.getProcessInfo');
  for (const process of processes?.processInfo.filter(p => p.type === 'renderer') ?? []) {
    const sample = Bun.spawn(['sample', String(process.id), '1', '1', '-file', '/dev/stdout'], { stdout: 'pipe', stderr: 'ignore' });
    console.log('STALL SAMPLE', (await new Response(sample.stdout).text()).split('\n').slice(0, 160).join('\n'));
  }
}, 1000);
await page.addInitScript(({ disable, ticker }) => {
  let raf = 0, resize = 0, mutation = 0;
  const loop = () => { raf++; requestAnimationFrame(loop); }; if (ticker) requestAnimationFrame(loop);
  for (const [name, increment] of [['ResizeObserver', () => resize++], ['MutationObserver', () => mutation++]] as const) {
    const Original = window[name];
    (window as any)[name] = class extends Original {
      constructor(callback: any) { super((...args: any[]) => { increment(); if (disable !== name) callback(...args); }); }
    };
  }
  setInterval(() => {
    const root = document.querySelector('#mobile-workspace-root');
    if (!root) return;
    console.log('[transition-probe]', JSON.stringify({ now: performance.now(), timeline: document.timeline.currentTime,
      raf, resize, mutation, foreground: document.documentElement.dataset.workspaceForeground,
      visible: document.visibilityState, focus: document.hasFocus(), x: root.getBoundingClientRect().x,
      animations: root.getAnimations().map(a => ({ time: a.currentTime, start: a.startTime, pending: a.pending, state: a.playState })) }));
  }, 1000);
}, { disable: process.env.DISABLE ?? '', ticker: process.env.TICKER !== 'off' });
try {
  await context.request.post('/review/reset', { data: { scenario: 'mixed' } });
  await context.request.post('/review/control/continuity-fixture');
  await page.goto('/s/atlas/README.md');
  await page.locator('#preview').getByText('Continuity section 79', { exact: false }).first().waitFor();
  for (let round = 0; round < 12; round++) {
    for (const surface of ['files', 'chat', 'terminal']) {
      console.log('ROUND', round, surface);
      await page.waitForFunction(() => document.querySelector('#mobile-workspace-root')!.getBoundingClientRect().x === 0);
      if (await page.locator('#navigation-handle').isVisible()) await page.locator('#navigation-handle').click();
      await page.locator(`[data-tab="${surface}"]`).click();
      if (surface === 'terminal') {
        await page.locator('[data-terminal-ready="true"]').waitFor();
        await Promise.all(Array.from({ length: 100 }, () => context.request.post('/review/control/terminal-output')));
        await page.evaluate(() => window.__mobileHubReview!.terminals.at(-1)!.scrollToLine(8));
      }
      if (await page.locator('#navigation-handle').isVisible()) await page.locator('#navigation-handle').click();
      await page.locator('#navigation-hub').click();
      await page.locator('[data-action="settings"]').click();
      await page.locator('[data-action="preview-side"]').click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.locator('[data-action="return"]').click();
      await page.waitForFunction(() => document.querySelector('#mobile-workspace-root')!.getBoundingClientRect().x === 0);
    }
  }
} catch (error) {
  console.log('FAILED', String(error));
  await Promise.race([(async () => { await cdp?.send('Debugger.enable'); await cdp?.send('Debugger.pause'); })(), new Promise(resolve => setTimeout(resolve, 3000))]);
  await new Promise(resolve => setTimeout(resolve, 1000));
  process.exitCode = 1;
} finally {
  clearInterval(watchdog);
  if (process.env.TRACE === 'on') await context.tracing.stop({ path: `tests/mobile-hub-review/evidence/transition-probe-${process.env.ENGINE ?? 'chromium'}-${process.env.FONT ?? 'bundled'}-${Date.now()}.zip` }).catch(() => {});
  await browser.close(); server.kill(); await server.exited;
}
