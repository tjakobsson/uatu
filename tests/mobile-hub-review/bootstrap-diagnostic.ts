/** Bounded, test-only bootstrap/clone transport diagnostic. No credentials logged.
 * bun tests/mobile-hub-review/bootstrap-diagnostic.ts [--close]
 */
import { chromium, webkit, devices, expect, type Request as BrowserRequest } from '@playwright/test';

const stamp = () => Math.round(performance.now());
const emit = (event: string, data: object = {}) => console.log(JSON.stringify({ t: stamp(), wall: Date.now(), event, ...data }));
if (process.argv.includes('--server')) {
  const original = Bun.serve.bind(Bun);
  Bun.serve = ((options: any) => {
    const handle = options.fetch;
    options.fetch = async function(request: Request, ...args: any[]) {
      const start = stamp(), path = new URL(request.url).pathname;
      emit('server-start', { path, method: request.method });
      const response = await handle.call(this, request, ...args);
      emit('server-end', { path, status: response?.status, ms: stamp() - start });
      return response;
    };
    return original(options);
  }) as typeof Bun.serve;
  const { startReviewServer } = await import('./server');
  const server = await startReviewServer({ port: 4710 });
  emit('listening');
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
} else {
  const child = Bun.spawn(['bun', import.meta.path, '--server'], { stdout: 'inherit', stderr: 'inherit' });
  const deadline = setTimeout(() => { emit('hard-deadline'); child.kill(); process.exit(2); }, 75_000);
  const origin = 'http://127.0.0.1:4710';
  let failed = false;
  try {
    for (let n = 0; ; n++) {
      try { const response = await fetch(origin + '/review/health', { signal: AbortSignal.timeout(500) }); await response.text(); if (response.ok) break; } catch {}
      if (n === 50) throw new Error('server not ready');
      await Bun.sleep(100);
    }
    for (const [name, engine] of Object.entries({ chromium, webkit })) {
      if (process.argv.includes('--webkit') && name !== 'webkit') continue;
      emit('launch-start', { name });
      const browser = await engine.launch({ timeout: 10000 });
      emit('launch-end', { name });
      const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: origin, serviceWorkers: 'block', ...(process.argv.includes('--close') ? { extraHTTPHeaders: { Connection: 'close' } } : {}) });
      const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(8000);
      emit('blank-baseline', { name, ...await page.evaluate(() => new Promise<{ frames: number; elapsed: number }>(resolve => {
        const start = performance.now(); let frames = 0, done = false;
        const frame = () => { frames++; if (!done) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
        setTimeout(() => { done = true; resolve({ frames, elapsed: performance.now() - start }); }, 500);
      })) });
      if (process.argv.includes('--blank-only')) { await browser.close(); continue; }
      const starts = new Map<BrowserRequest, number>();
      page.on('request', r => { starts.set(r, stamp()); emit('browser-start', { name, path: new URL(r.url()).pathname }); });
      page.on('response', r => emit('browser-headers', { name, path: new URL(r.url()).pathname, status: r.status(), ms: stamp() - starts.get(r.request())! }));
      page.on('requestfinished', r => emit('browser-end', { name, path: new URL(r.url()).pathname, ms: stamp() - starts.get(r)! }));
      page.on('requestfailed', r => emit('browser-failed', { name, path: new URL(r.url()).pathname, error: r.failure()?.errorText }));
      page.on('pageerror', e => emit('pageerror', { name, error: e.message }));
      await page.addInitScript(() => {
        const w = window as any;
        w.__diagnostic = { frames: 0, last: 0, maxGap: 0, init: performance.now() };
        const frame = (now: number) => { const d = w.__diagnostic; if (d.last) d.maxGap = Math.max(d.maxGap, now - d.last); d.last = now; d.frames++; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      });
      try {
        for (const path of ['/review/reset', '/review/backend/readAuthentication', '/review/backend/readWorkspaces']) {
          const start = stamp();
          const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(path.endsWith('reset') ? { scenario: 'mixed' } : []), signal: AbortSignal.timeout(3000) });
          await response.text(); emit('direct-http', { name, path, status: response.status, ms: stamp() - start });
        }
        if (!process.argv.includes('--clone-only')) {
        await page.goto('/s/atlas/README.md', { waitUntil: 'domcontentloaded' });
        try { await expect(page.locator('#preview')).toContainText('Synthetic review document', { timeout: 5000 }); emit('preview-pass', { name }); }
        catch (error) { failed = true; emit('preview-failed', { name, error: String(error) }); }
        emit('preview-snapshot', { name, ...await page.evaluate(() => ({ heartbeat: (window as any).__diagnostic, bootCount: window.__mobileHubReview?.bootCount })) });
        }
        await page.goto('/clone', { waitUntil: 'domcontentloaded' });
        await page.getByLabel('Remote URL').fill('https://github.com/review/diagnostic.git');
        await page.getByLabel('Checkout folder name').fill('diagnostic-review');
        await page.getByLabel('Workspace display name').fill('Diagnostic review');
        await page.getByRole('button', { name: 'Review clone', exact: true }).click();
        await page.getByRole('button', { name: 'Clone', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Clone Progress', exact: true })).toBeVisible({ timeout: 5000 });
        emit('clone-pass', { name });
      } catch (error) { failed = true; emit('scenario-failed', { name, error: String(error) }); }
      finally {
        let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([page.evaluate(() => ({ heartbeat: (window as any).__diagnostic, bootCount: window.__mobileHubReview?.bootCount, preview: document.querySelector('#preview')?.textContent?.slice(0, 150), ready: document.readyState })).then(data => emit('browser-snapshot', { name, ...data })), new Promise<void>(resolve => { snapshotTimer = setTimeout(() => { emit('snapshot-deadline', { name }); resolve(); }, 1500); })]);
        clearTimeout(snapshotTimer);
        emit('close-start', { name });
        await browser.close();
        emit('close-end', { name });
      }
    }
  } finally { child.kill(); await child.exited; clearTimeout(deadline); }
  process.exitCode = failed ? 1 : 0;
}
