/** HISTORICAL drawer-era discovery runner (not approved screenshot goldens).
 * Incompatible with current full-page editor geometry. Do not regenerate this
 * report as a current baseline; task-layout.e2e.ts covers current task layout.
 * Run: bun tests/mobile-hub-review/visual.e2e.ts
 * Uses the existing synthetic server on an OS-assigned port; always stops it.
 */
import { chromium, webkit, devices, expect, type Page } from "@playwright/test";
import { startReviewServer } from "./server";
import { corpus, terminalId } from "./protocols";
import { createReviewPersonalState } from "./transport";
import { checkHubGeometry, checkSheetGeometry, checkWorkspaceChrome } from "./visual-checks";
import { activeTask } from './navigation';

const evidenceRoot = "openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual";
const out = `${evidenceRoot}/review-ready`;
const originals = "design/hub-mobile/screenshots-refined";
const selectors = [".mh-brand", ".mh-root h1", ".mh-subtitle", ".mh-section", ".mh-group", ".mh-workspace", ".mh-workspace h3", ".mh-folder", ".mh-more svg", ".mh-primary", ".mh-dock", ".mh-tab", ".mh-return", ".mh-identity", ".mh-destination", ".mh-tile", ".mh-sheet", ".mh-sheet header", ".mh-field", ".mh-preference-choices input[type=radio]", ".mh-preference-choices label", ".mh-value", ".mh-sheet footer", ".mh-backdrop", "#touch-tab-bar", ".touch-tab", ".touch-tab-label", "#navigation-handle", "#navigation-handle span", "#preview-file-navigation", ".preview-nav-pill", ".preview-nav-alert"];
async function metrics(page: Page) {
  return page.evaluate(selectors => Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].filter(e => e.getBoundingClientRect().width > 0).map(e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return { x: r.x, y: r.y, width: r.width, height: r.height, font: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor, radius: s.borderRadius, blur: s.backdropFilter || s.getPropertyValue("-webkit-backdrop-filter"), shadow: s.boxShadow, stroke: s.strokeWidth, icons: e.querySelectorAll("svg").length };
  })])), selectors);
}
async function structural(page: Page) {
  return page.evaluate(() => {
    const title = document.querySelector<HTMLElement>(".mh-root h1")!, dock = document.querySelector<HTMLElement>(".mh-dock")!;
    const style = getComputedStyle(dock);
    return { icons: [...dock.querySelectorAll(".mh-tab")].every(tab => [...tab.querySelectorAll("svg")].some(svg => svg.getBoundingClientRect().width >= 20 && getComputedStyle(svg).visibility !== "hidden")), hierarchy: parseFloat(getComputedStyle(title).fontSize) >= 32 && +getComputedStyle(title).fontWeight >= 700, material: (style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter")).includes("blur") && style.boxShadow !== "none" && style.backgroundColor.includes("0.76") };
  });
}
async function compare(page: Page, actual: Buffer, reference: string, prefix: string) {
  const source = Buffer.from(await Bun.file(`${originals}/${reference}.png`).arrayBuffer());
  const result = await page.evaluate(async ({ a, r }) => {
    const load = (src: string) => new Promise<HTMLImageElement>(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = src; });
    const [actual, reference] = await Promise.all([load(a), load(r)]);
    const canvas = (width = 390) => { const c = document.createElement("canvas"); c.width = width; c.height = 844; return c; };
    const normalized = canvas(), current = canvas();
    normalized.getContext("2d")!.drawImage(reference, 0, 0, 390, 844); current.getContext("2d")!.drawImage(actual, 0, 0, 390, 844);
    const side = canvas(780); side.getContext("2d")!.drawImage(normalized, 0, 0); side.getContext("2d")!.drawImage(current, 390, 0);
    const overlay = canvas(), context = overlay.getContext("2d")!; context.drawImage(normalized, 0, 0); context.globalAlpha = .5; context.drawImage(current, 0, 0);
    const diff = canvas(), dc = diff.getContext("2d")!, image = dc.createImageData(390, 844), x = normalized.getContext("2d")!.getImageData(0, 0, 390, 844).data, y = current.getContext("2d")!.getImageData(0, 0, 390, 844).data;
    let sum = 0, changed = 0;
    for (let i = 0; i < x.length; i += 4) { let max = 0; for (let c = 0; c < 3; c++) { const delta = Math.abs(x[i+c]! - y[i+c]!); sum += delta; max = Math.max(max, delta); image.data[i+c] = delta; } image.data[i+3] = 255; if (max > 16) changed++; }
    dc.putImageData(image, 0, 0);
    return { normalized: normalized.toDataURL(), side: side.toDataURL(), overlay: overlay.toDataURL(), diff: diff.toDataURL(), meanAbsoluteChannelError: sum / (390 * 844 * 3), pixelsOver16Percent: changed / (390 * 844) * 100 };
  }, { a: `data:image/png;base64,${actual.toString("base64")}`, r: `data:image/png;base64,${source.toString("base64")}` });
  for (const kind of ["normalized", "side", "overlay", "diff"] as const) await Bun.write(`${out}/${prefix}-${kind}.png`, Buffer.from(result[kind].split(",")[1]!, "base64"));
  return { reference, referenceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"), meanAbsoluteChannelError: result.meanAbsoluteChannelError, pixelsOver16Percent: result.pixelsOver16Percent };
}
export async function captureVisualDiscovery() {
  if (process.env.MOBILE_HUB_HISTORICAL_DRAWER_REPORT !== '1') throw new Error('Historical drawer report is incompatible with full-page Settings. Use task-layout.e2e.ts for current layout; do not overwrite historical evidence.');
  const hash = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
  const preserved: Record<string, string> = {};
  for (const root of [evidenceRoot, originals]) for await (const path of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
    if (root === evidenceRoot && path.startsWith("review-ready/")) continue;
    preserved[`${root}/${path}`] = await hash(`${root}/${path}`);
  }
  const sourceHashes = Object.fromEntries(await Promise.all(["src/hub/mobile/styles.css", "src/hub/mobile/frontend.ts", "src/hub/mobile/coordinator.ts", "src/shell/tab-bar.ts", "src/shell/navigation-preferences.ts", "src/preview/file-navigation.css", "src/styles.css", "src/index.html", "tests/mobile-hub-review/visual.e2e.ts", "tests/mobile-hub-review/visual-checks.ts"].map(async path => [path, await hash(path)])));
  const server = await startReviewServer({ port: 0 });
  const originalDocs = structuredClone(corpus.roots[0]!.docs);
  const originalGeneratedAt = corpus.generatedAt;
  try {
    for (const [name, engine] of Object.entries({ chromium, webkit })) {
      const browser = await engine.launch();
      try {
        const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, colorScheme: "light", serviceWorkers: "block", baseURL: server.url });
        const page = await context.newPage();
        const pageErrors: string[] = [], interactionDeviations: unknown[] = [], httpErrors: Array<{ status: number; path: string; expected: boolean }> = [];
        let injectingIndexFailure = false;
        page.on("pageerror", error => pageErrors.push(error.message));
        page.on("requestfailed", request => console.info("visual transport", new URL(request.url()).pathname, request.failure()?.errorText));
        page.on("response", response => { if (response.status() >= 400) {
          const url = new URL(response.url());
          httpErrors.push({ status: response.status(), path: url.pathname + url.search, expected: injectingIndexFailure && response.status() === 503 && url.pathname === "/s/atlas/api/state" });
        } });
        await context.request.post("/review/reset", { data: { scenario: "mixed" } });
        for (const folderName of ["design-kit", "api-sandbox"]) {
          const created = await server.synthetic.backend.createWorkspace({ parent: "/synthetic", folderName, displayName: folderName, authentication: [], signing: null, start: false, gitInitConsent: "confirmed" });
          expect(created.status).toBe("completed");
        }
        // Match reference density through synthetic service state, never DOM masks.
        const credentials = await server.synthetic.backend.readCredentials();
        if (credentials.status !== "available") throw new Error("Synthetic credential catalog unavailable");
        for (const credential of credentials.value) {
          const deleted = await server.synthetic.backend.deleteCredential({ target: { id: credential.id, type: credential.type }, confirm: true, unassign: true, stop: "ask" });
          expect(deleted.status).toBe("completed");
        }
        const generated = await server.synthetic.backend.generateSsh({ name: "Review identity", capabilities: ["ssh-authentication"], passphrase: "DISPOSABLE-SYNTHETIC-ONLY" });
        if (generated.status !== "completed") throw new Error("Synthetic review identity was not generated");
        const reviewIdentity = { id: generated.value.id, type: "ssh" as const };
        // Explicit test-backend fact control, never a label/DOM-derived state.
        server.synthetic.setKeyState(reviewIdentity.id, "unprotected");
        const identityFacts = await server.synthetic.backend.readCredentialFacts(reviewIdentity);
        expect(identityFacts).toMatchObject({ status: "available", value: { protection: { status: "known", value: "unprotected" }, lock: { status: "known", value: "unlocked" } } });
        const records: Record<string, unknown> = { provenance: { capturedAt: new Date().toISOString(), browser: name, browserVersion: browser.version(), bunVersion: Bun.version, viewport: { width: 390, height: 844 }, screenshotScale: "css", deviceDescriptor: "iPhone 13 (viewport explicitly overridden)", sourceHashes, approval: "awaiting user review; no actual images are approved goldens" } };
        records.fixture = { credentialName: "Review identity", credentialFacts: identityFacts, workspaceDensity: { running: 1, ready: 3 }, substitutions: "Current UatuCode branding; synthetic identity/paths/text; current real workspace interiors. No DOM masking." };
        const capture = async (state: string, reference: string) => {
          console.info(`capturing ${name}/${state}`);
          const normalPreview = !["preview-timeout", "preview-index-error"].includes(state) && await page.locator("#preview-file-navigation").isVisible();
          if (normalPreview) {
            // Keep normal visual states fresh through the real recovery owner.
            // The synthetic SSE has no heartbeat; screenshot wall time must not
            // silently turn a boundary/material capture into an index failure.
            corpus.generatedAt++; await page.evaluate(() => window.dispatchEvent(new Event("online")));
            await expect(page.locator(".preview-nav-alert")).toBeHidden();
          }
          await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350);
          expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([390, 844]);
          const measured = await metrics(page);
          const actual = await page.screenshot({ path: `${out}/${name}-${state}-actual.png`, scale: "css", animations: "disabled" });
          records[state] = { metrics: measured, comparison: await compare(page, actual, reference, `${name}-${state}`) };
          if (normalPreview) await expect(page.locator(".preview-nav-alert")).toBeHidden();
        };
        const extension = async (state: string) => {
          await page.waitForTimeout(350);
          await page.screenshot({ path: `${out}/${name}-${state}-actual.png`, scale: "css", animations: "disabled" });
          records[state] = { extension: true, metrics: await metrics(page) };
        };
        await page.goto("/", { waitUntil: "domcontentloaded" }); await expect(page.locator(".mh-workspace")).toHaveCount(4);
        await checkHubGeometry(page);
        await capture("hub", "01-hub");
        const baseline = await structural(page); expect(Object.values(baseline)).toEqual([true, true, true]);
        const mutations: Record<string, unknown> = { baseline };
        for (const [key, css] of Object.entries({ icons: ".mh-dock svg{display:none!important}", hierarchy: ".mh-root h1{font-size:17px!important;font-weight:400!important}", material: ".mh-dock{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important;background:#fff!important}" })) {
          const style = await page.addStyleTag({ content: css }); const check = await structural(page); expect(check[key as keyof typeof check]).toBe(false); mutations[key] = check; await style.evaluate(e => e.parentNode?.removeChild(e));
        }
        records.mutationDetection = mutations;
        await page.locator('[data-action="open:atlas"]').click(); await expect(page.locator("#preview")).toContainText("Synthetic review document");
        await capture("preview-expanded", "04-preview-expanded");
        await checkWorkspaceChrome(page, true, false);
        await page.locator("#navigation-close").click(); await capture("preview-collapsed", "02-preview-collapsed");
        await checkWorkspaceChrome(page, false, false);
        await page.locator("#navigation-handle").click(); await page.locator('[data-tab="terminal"]').click(); await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
        await capture("terminal-expanded", "10-terminal-expanded");
        await checkWorkspaceChrome(page, true, true);
        await page.locator("#navigation-close").click(); await capture("terminal-collapsed", "09-terminal-collapsed");
        await checkWorkspaceChrome(page, false, true);
        await page.locator("#navigation-handle").focus(); await page.keyboard.press("ArrowRight");
        await capture("terminal-collapsed-right", "09-terminal-collapsed"); await checkWorkspaceChrome(page, false, true);
        await page.locator("#navigation-handle").click(); await capture("terminal-expanded-right-handle", "10-terminal-expanded");
        await checkWorkspaceChrome(page, true, true);
        await page.locator("#navigation-close").click(); await page.locator("#navigation-handle").focus(); await page.keyboard.press("ArrowLeft");
        await page.locator("#navigation-handle").click(); await page.locator("#navigation-hub").click(); await capture("visited-return", "08-return-hub");
        await page.locator('[data-action="settings"]').click();
        const credentialRow = page.locator(".mh-destination").filter({ hasText: "Review identity" });
        await expect(credentialRow).toHaveCount(1); await expect(credentialRow.locator(".mh-value")).toHaveText("Unlocked");
        await capture("settings", "15-return-in-settings");
        // Match by visible value, independent of the action dispatch spelling.
        const seconds = page.locator(".mh-value").filter({ hasText: "7 seconds" });
        expect(await seconds.evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(25);
        await page.locator('[data-action="preview-side"]').click(); await expect(activeTask(page, 'editor', 'Preview File Controls')).toBeVisible(); await capture("preview-side-sheet", "22-preview-side-setting");
        await checkSheetGeometry(page);
        await page.getByRole('radio', { name: 'Right', exact: true }).check(); await activeTask(page).getByRole("button", { name: "Save", exact: true }).click();
        await page.locator('[data-action="return"]').click();
        // This capture targets the settled state, not the 240ms reveal midpoint.
        await page.waitForTimeout(350); await checkWorkspaceChrome(page, true, true);
        const previewHit = () => page.locator('[data-tab="preview"]').evaluate(e => { const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { receivesPointer: !!hit && e.contains(hit), hit: hit?.className, button: { x: r.x, y: r.y, width: r.width, height: r.height } }; });
        try { await expect.poll(async () => (await previewHit()).receivesPointer, { timeout: 2000 }).toBe(true); }
        catch {
          interactionDeviations.push({ state: "Return from Settings to Terminal", ...(await previewHit()), continuation: "Fresh canonical document load for remaining visual states; retained pointer flow NOT passed" });
          await extension("return-terminal-pointer-blocked");
        }
        if ((await previewHit()).receivesPointer) await page.locator('[data-tab="preview"]').click();
        else { await page.goto("/s/atlas/README.md", { waitUntil: "domcontentloaded" }); await expect(page.locator("#preview")).toContainText("Synthetic review document", { timeout: 15_000 }); }
        await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
        // Refresh the mock stream after the long Hub detour. The review server's
        // Bun default idle timeout is not a production SSE heartbeat contract.
        corpus.generatedAt++; await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(page.locator(".preview-nav-alert")).toBeHidden();
        await page.locator("#navigation-close").click();
        await capture("preview-single-right", "25-preview-single-file");
        await expect(page.locator(".preview-nav-arrow:visible")).toHaveCount(0);
        const single = (await page.locator(".preview-nav-pill").boundingBox())!; expect(single.x + single.width).toBe(378);

        // Test-owned protocol fixtures only: actual corpus/selection/load owners
        // render every state. No DOM painting, fake client, or host file mutation.
        const siblings = structuredClone(corpus);
        siblings.roots[0]!.docs.push(...["SECOND", "THIRD"].map((name, i) => ({ ...siblings.roots[0]!.docs[0]!, id: `visual-${i + 2}`, name: `${name}.md`, relativePath: `${name}.md` })));
        // Retain the real synthetic SSE connection (a closed one-shot SSE reply
        // would correctly mark the corpus unavailable). Restore after each run.
        corpus.roots[0]!.docs = siblings.roots[0]!.docs;
        corpus.generatedAt++;
        const personal = createReviewPersonalState(siblings.roots[0]!.docs.map(doc => doc.relativePath), terminalId);
        await page.route("**/s/atlas/api/personal-state", async route => {
          if (route.request().method() === "GET") await route.fulfill({ json: personal.read() });
          else if (route.request().method() === "PATCH" && personal.patch(route.request().postDataJSON())) await route.fulfill({ json: personal.read() });
          else await route.fulfill({ status: 400, body: "Invalid visual fixture personal state" });
        });
        let holdThird = false, releaseThird = () => {};
        await page.route("**/s/atlas/api/document?**", async route => {
          const id = new URL(route.request().url()).searchParams.get("id");
          if (id === "readme") { await route.continue(); return; }
          if (id === "visual-3" && holdThird) await new Promise<void>(resolve => { releaseThird = resolve; });
          const doc = siblings.roots[0]!.docs.find(doc => doc.id === id);
          if (!doc) { await route.fulfill({ status: 404, body: "Unknown visual fixture" }); return; }
          await route.fulfill({ json: { id, title: `Synthetic ${doc.name}`, path: doc.relativePath, kind: "markdown", view: "rendered", language: "markdown", html: `<h1>Synthetic ${doc.name}</h1><p>Protocol fixture; no live workspace was read.</p>` } });
        });
        await page.goto("/s/atlas/README.md", { waitUntil: "domcontentloaded" }); await expect(page.locator("#preview-file-navigation")).toHaveAttribute("aria-busy", "false");
        await page.locator("#navigation-close").click();
        await expect(page.getByRole("button", { name: "Previous file (first file)", exact: true })).toBeDisabled();
        await capture("preview-first-right", "20-preview-image-first");
        await page.getByRole("button", { name: "Next file", exact: true }).click(); await expect(page.locator("#preview-path")).toHaveText("SECOND.md");
        await capture("preview-middle-right", "21-preview-image-next");
        await page.locator("#navigation-handle").click(); await capture("preview-controls-right-expanded", "23-preview-controls-right");
        await page.locator("#navigation-close").click();
        await page.getByRole("button", { name: "Next file", exact: true }).click(); await expect(page.locator("#preview-path")).toHaveText("THIRD.md");
        await expect(page.getByRole("button", { name: "Next file (last file)", exact: true })).toBeDisabled();
        await capture("preview-last-right", "24-preview-image-last");
        await page.locator("#navigation-handle").dispatchEvent("contextmenu");
        await page.getByRole('radio', { name: 'Left', exact: true }).check(); await page.keyboard.press("Escape");
        await capture("preview-last-left", "24-preview-image-last");
        await page.getByRole("button", { name: "Previous file", exact: true }).click(); await expect(page.locator("#preview-path")).toHaveText("SECOND.md");
        // Advance the installed browser clock, not the server's idle SSE clock.
        // The current synthetic stream has no heartbeat for a real 10s wait.
        await page.clock.install();
        holdThird = true; await page.getByRole("button", { name: "Next file", exact: true }).click();
        await expect(page.locator(".preview-nav-alert")).toContainText("Loading selected file");
        await page.clock.fastForward(10_100);
        await expect(page.locator(".preview-nav-alert")).toContainText("timed out", { timeout: 15_000 });
        await capture("preview-timeout", "27-preview-navigation-timeout");
        expect(await page.locator(".preview-nav-arrow[data-boundary='true']").count()).toBe(0);
        holdThird = false; releaseThird(); corpus.generatedAt++; await page.locator(".preview-nav-retry").click();
        await expect(page.locator(".preview-nav-alert")).toBeHidden();
        const timeoutRecovery = await page.locator(".preview-nav-alert").isVisible() ? await page.locator(".preview-nav-alert").innerText() : "recovered";
        await page.goto("/s/atlas/README.md", { waitUntil: "domcontentloaded" }); await expect(page.locator("#preview")).toContainText("Synthetic review document"); await expect(page.locator(".preview-nav-alert")).toBeHidden();
        await page.locator("#navigation-close").click();
        const failState = (route: import("@playwright/test").Route) => route.fulfill({ status: 503, body: "Synthetic visual index failure" });
        const failEvents = (route: import("@playwright/test").Route) => route.abort();
        injectingIndexFailure = true;
        await page.route("**/s/atlas/api/state**", failState); await page.route("**/s/atlas/api/events**", failEvents);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(page.locator(".preview-nav-alert")).toContainText("File index unavailable");
        await capture("preview-index-error", "26-preview-index-error");
        await expect(page.getByRole("button", { name: "Back to Files" })).toBeEnabled();
        expect(await page.locator(".preview-nav-arrow[data-boundary='true']").count()).toBe(0);
        const alert = (await page.locator(".preview-nav-alert").boundingBox())!, pill = (await page.locator(".preview-nav-pill").boundingBox())!;
        expect(alert.y + alert.height).toBeLessThan(pill.y);
        await page.unroute("**/s/atlas/api/state**", failState); await page.unroute("**/s/atlas/api/events**", failEvents);
        injectingIndexFailure = false;
        corpus.generatedAt++; await page.locator(".preview-nav-retry").click(); await expect(page.locator(".preview-nav-alert")).toBeHidden();
        const indexRecovery = await page.locator(".preview-nav-alert").isVisible() ? await page.locator(".preview-nav-alert").innerText() : "recovered";
        await page.goto("/s/atlas/README.md", { waitUntil: "domcontentloaded" }); await expect(page.locator("#preview")).toContainText("Synthetic review document");
        await page.locator('[data-tab="files"]').click(); await page.locator("#navigation-close").click();
        await capture("files-collapsed", "05-files-collapsed");
        await page.locator("#navigation-handle").click(); await page.locator('[data-tab="chat"]').click();
        await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toHaveValue("review:conversation-1");
        await capture("chat-expanded", "07-chat-expanded");
        await page.locator("#navigation-close").click(); await capture("chat-collapsed", "06-chat-collapsed");
        await page.locator("#navigation-handle").click(); await page.locator('[data-tab="preview"]').click();
        await page.emulateMedia({ colorScheme: "dark" });
        await capture("dark-preview-expanded", "dark-expanded");
        await page.locator("#navigation-close").click(); await capture("dark-preview-collapsed", "dark-collapsed");
        await page.locator("#navigation-handle").click();
        await page.locator('[data-tab="terminal"]').click(); await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
        await page.emulateMedia({ colorScheme: "dark" });
        await capture("dark-terminal-expanded", "dark-terminal-expanded");
        await checkWorkspaceChrome(page, true, true);
        await page.locator("#navigation-close").click(); await capture("dark-terminal-collapsed", "dark-terminal-collapsed");
        await checkWorkspaceChrome(page, false, true);
        await page.emulateMedia({ colorScheme: "light", contrast: "more" });
        await page.locator("#navigation-handle").click(); await page.locator('[data-tab="preview"]').click();
        await extension("contrast-more-preview");
        expect(await page.locator(".preview-nav-pill").evaluate(e => getComputedStyle(e).backdropFilter)).toBe("none");
        await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
        const forcedColorsSupported = await page.evaluate(() => matchMedia("(forced-colors: active)").matches);
        if (forcedColorsSupported) {
          await extension("forced-colors-preview");
          expect(await page.locator(".preview-nav-pill").evaluate(e => getComputedStyle(e).boxShadow)).toBe("none");
        }
        await page.emulateMedia({ forcedColors: "none" });
        await page.locator("#navigation-hub").click(); await page.locator('[data-action="settings"]').click();
        // The archived enlargement policy doubles Hub/chrome font sizes, not the
        // current workspace interiors. Apply that policy only for this stress check.
        const enlarged = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mh-root, .mh-root *")].map(e => ({ selector: e, size: parseFloat(getComputedStyle(e).fontSize) })).map(({ selector, size }) => { selector.style.fontSize = `${size * 2}px`; return size; }));
        expect(enlarged.length).toBeGreaterThan(10);
        const enlargedValue = page.locator(".mh-value").filter({ hasText: "7 seconds" });
        expect(await enlargedValue.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
        await page.locator(".mh-root, .mh-root *").evaluateAll(elements => { for (const e of elements) (e as HTMLElement).style.removeProperty("font-size"); });
        await page.locator('[data-action="preview-side"]').click();
        // Snapshot all baseline sizes before changing inherited fonts, so a
        // newly-mounted footer is doubled once, not doubled again via its parent.
        await page.locator(".mh-root").evaluate(root => {
          const rows = [root, ...root.querySelectorAll<HTMLElement>("*")].map(e => ({ e: e as HTMLElement, size: parseFloat(getComputedStyle(e).fontSize) }));
          for (const { e, size } of rows) e.style.fontSize = `${size * 2}px`;
        });
        const enlargedChoices = activeTask(page).getByRole('radio');
        await expect(enlargedChoices).toHaveCount(2);
        for (const choice of await enlargedChoices.all()) {
          const geometry = await choice.locator('..').evaluate(e => {
            const r = e.getBoundingClientRect();
            return { height: r.height, fits: e.scrollWidth <= e.clientWidth + 1 };
          });
          expect(geometry.height).toBeGreaterThanOrEqual(44);
          expect(geometry.fits).toBe(true);
        }
        for (const button of await page.locator(".mh-sheet footer button").all()) { const r = (await button.boundingBox())!; expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.width).toBeLessThanOrEqual(390); expect(r.y + r.height).toBeLessThanOrEqual(844); }
        await extension("enlarged-sheet");
        records.regressionChecks = { hubGeometry: "passed", sheetGeometry: "passed", selectorsAnd44pxTargets: "passed", material: "passed", leftRightAndBoundaries: "passed", timeoutAndIndexErrorPresentation: "passed", syntheticRecovery: { timeoutRecovery, indexRecovery } };
        records.accessibilityChecks = { contrastMore: "passed", forcedColors: forcedColorsSupported ? "passed" : "not emulated by this engine", enlargedValueAndField: "passed" };
        const missing = (await (await context.request.get("/review/state")).json()).missing;
        records.errors = { pageErrors, httpErrors, interactionDeviations, missingSyntheticContracts: missing };
        expect(pageErrors).toEqual([]); expect(httpErrors.filter(error => !error.expected)).toEqual([]); expect(missing).toEqual([]);
        await Bun.write(`${out}/${name}-measurements.json`, JSON.stringify(records, null, 2) + "\n");
        console.info(`${name}: ${Object.values(records).filter(value => (value as { comparison?: unknown }).comparison).length} states captured; geometry/material/boundary checks passed; all 3 deliberate mutations rejected`);
      } finally { corpus.roots[0]!.docs = structuredClone(originalDocs); corpus.generatedAt = originalGeneratedAt; await browser.close(); }
    }
  } finally { server.stop(); }
  for (const [path, sha256] of Object.entries(preserved)) expect(await hash(path), `Retained evidence changed: ${path}`).toBe(sha256);
  await Bun.write(`${out}/preservation.json`, JSON.stringify({ status: "unchanged", fileCount: Object.keys(preserved).length, sha256: preserved }, null, 2) + "\n");
}
if (import.meta.main) await captureVisualDiscovery();
