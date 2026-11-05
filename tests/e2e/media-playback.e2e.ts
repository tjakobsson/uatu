import { test as base, expect, type Page, type APIRequestContext } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { promises as fs } from "node:fs";
import { workspacePath } from "./config";
import { wavFixture, mp4Fixture, truncatedMediaFixture } from "./media-fixtures";
import { treeRow } from "./tree-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);
test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });
async function seed(request: APIRequestContext) {
  await request.post("/__e2e/reset", { data: { follow: false } });
  // These are completed decoding fixtures, not producer-in-progress cases.
  await Promise.all(([
    ["tone-a.wav", wavFixture()], ["tone-b.wav", wavFixture()],
    ["clip.mp4", mp4Fixture()], ["incomplete.wav", truncatedMediaFixture()],
  ] as const).map(async ([name, bytes]) => {
    const temporary = workspacePath(`.fixture-${name}.tmp`);
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, workspacePath(name));
  }));
  await expect.poll(async () => {
    const state = await (await request.get("/api/state")).json();
    if (state.discovery.status !== "ready") return 0;
    return state.roots.flatMap((root: any) => root.docs).filter((doc: any) =>
      ["tone-a.wav", "tone-b.wav", "clip.mp4", "incomplete.wav"].includes(doc.relativePath)).length;
  }).toBe(4);
}
async function open(page: Page, path = "tone-a.wav") {
  const { token } = await (await page.request.get("/__e2e/terminal-token")).json();
  await page.goto(`/${path}?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#preview-path")).toHaveText(path);
  await expect(page.locator(".media-preview")).toBeVisible();
}
const dock = (page: Page) => page.locator("#media-dock");
const native = (page: Page) => page.locator("audio, video");
async function selectRecent(page: Page, path: string) {
  await page.locator("#files-pane-filter-recent").click();
  await page.locator(`#recent-files .recent-file-open[data-path="${path}"]`).click();
}
async function ready(page: Page) {
  await expect.poll(() => native(page).evaluate((element: HTMLMediaElement) => ({ duration: element.duration, error: element.error?.message, src: element.currentSrc }))).toMatchObject({ duration: expect.any(Number), error: undefined });
  await expect.poll(() => native(page).evaluate((element: HTMLMediaElement) => element.duration)).toBeGreaterThan(3);
}
async function playing(page: Page) {
  await expect.poll(() => native(page).evaluate((element: HTMLMediaElement) => !element.paused && element.currentTime > 0)).toBe(true);
}
for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: direct, restored, and history media previews stay paused and share one source`, async ({ launchBrowser, request, serverPort }, info) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    const documentRequests: string[] = [];
    const mediaRequests: string[] = [];
    page.on("request", request => {
      if (request.url().includes("/api/document?")) documentRequests.push(request.url());
      if (request.url().includes("/api/media?")) mediaRequests.push(request.url());
    });
    await open(page); await ready(page);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.paused && e.currentTime === 0)).toBe(true);
    expect(documentRequests).toEqual([]);
    await page.reload(); await ready(page);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.paused && e.currentTime === 0)).toBe(true);
    await page.evaluate(() => { (window as any).__mediaElement = document.querySelector("audio"); });
    await dock(page).getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
    const before = mediaRequests.length;
    await selectRecent(page, "tone-b.wav");
    await expect(page.locator("#preview-path")).toHaveText("tone-b.wav");
    await expect(page.locator(".media-preview")).toContainText("Press Play");
    expect(mediaRequests).toHaveLength(before);
    const positionBeforeReturn = await native(page).evaluate((e: HTMLMediaElement) => e.currentTime);
    await page.goBack(); await expect(page.locator("#preview-path")).toHaveText("tone-a.wav");
    expect(await native(page).evaluate((e: HTMLMediaElement) => e === (window as any).__mediaElement && !e.paused)).toBe(true);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.currentTime)).toBeGreaterThanOrEqual(positionBeforeReturn);
    await page.goForward(); await expect(page.locator("#preview-path")).toHaveText("tone-b.wav");
    await dock(page).getByRole("button", { name: "Close player" }).click();
    await expect(dock(page)).toBeHidden(); await expect(native(page)).toHaveCount(0);
    await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
    await expect(dock(page)).toContainText("tone-b.wav");
    await captureScreenshot(page, info, `${engine}-media-preview`);
    // Root arrival restores only the saved preview, never the audition.
    await expect.poll(async () => (await (await request.get("/api/personal-state")).json()).documentPath).toBe("tone-b.wav");
    await page.goto("/"); await expect(page.locator("#preview-path")).toHaveText("tone-b.wav"); await ready(page);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.paused && e.currentTime === 0)).toBe(true);
    await browser.close();
  });

  test(`${engine}: document refreshes do not reinsert or pause a parked player`, async ({ launchBrowser, request, serverPort }) => {
    await seed(request);
    await fs.writeFile(workspacePath("tone-a.wav"), wavFixture(30));
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page); await ready(page);
    await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
    await selectRecent(page, "README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator("#preview")).toContainText("This is a sample README");
    await page.evaluate(() => {
      const element = document.querySelector("audio")!;
      (window as any).__mediaElement = element;
      (window as any).__mediaMoves = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node === element || node.contains(element)) (window as any).__mediaMoves++;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const position = await native(page).evaluate((e: HTMLMediaElement) => e.currentTime);
    await fs.writeFile(workspacePath("README.md"), "# Refreshed during playback\n\nNo player remount.\n");
    await expect(page.locator("#preview")).toContainText("No player remount.");
    expect(await page.evaluate(() => (window as any).__mediaMoves)).toBe(0);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e === (window as any).__mediaElement && !e.paused)).toBe(true);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.currentTime)).toBeGreaterThan(position);
    await selectRecent(page, "tone-a.wav");
    expect(await native(page).evaluate((e: HTMLMediaElement) => e === (window as any).__mediaElement && !e.paused)).toBe(true);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.currentTime)).toBeGreaterThan(position);
    await browser.close();
  });

  test(`${engine}: Play on a restored paused preview disables Follow and synchronizes its toggle`, async ({ launchBrowser, request, serverPort }) => {
    await seed(request);
    const saved = await request.patch("/api/personal-state", { data: { documentPath: "tone-a.wav", follow: true } });
    expect(saved.ok()).toBe(true);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    // Keep the initial Follow catch-up from navigating away between the
    // paused-root assertion and this explicit preview gesture.
    let releaseLive!: () => void;
    const liveGate = new Promise<void>(resolve => { releaseLive = resolve; });
    await page.route(/\/api\/hub\/live(?:\?|$)/, async route => { await liveGate; await route.continue(); });
    const { token } = await (await request.get("/__e2e/terminal-token")).json();
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await expect(page.locator("#preview-path")).toHaveText("tone-a.wav"); await ready(page);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.paused && e.currentTime === 0)).toBe(true);
    await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click();
    releaseLive(); await playing(page);
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await (await request.get("/api/personal-state")).json()).follow).toBe(false);
    await browser.close();
  });

  test(`${engine}: native WAV decodes, seeks, loops only current clip, survives tabs, and Close releases`, async ({ launchBrowser, request, serverPort }, info) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, viewport: { width: 390, height: 844 }, hasTouch: true });
    await open(page); await ready(page);
    await page.evaluate(() => { document.documentElement.dataset.uiMode = "touch"; (window as any).__mediaElement = document.querySelector("audio"); });
    await dock(page).getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
    await dock(page).getByRole("button", { name: "Loop current clip" }).click();
    const seek = dock(page).getByRole("slider", { name: "Playback position" });
    await seek.fill("3.7"); await seek.dispatchEvent("input");
    await expect.poll(() => native(page).evaluate((e: HTMLMediaElement) => e.currentTime)).toBeLessThan(2);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.loop && !e.paused)).toBe(true);
    for (const tab of ["files", "chat", "terminal", "preview"]) {
      await page.locator(`[data-tab="${tab}"]`).click();
      expect(await native(page).evaluate(e => e === (window as any).__mediaElement)).toBe(true);
      expect(await native(page).evaluate((e: HTMLMediaElement) => !e.paused)).toBe(true);
      await expect(native(page)).toHaveCount(1);
    }
    await dock(page).getByRole("button", { name: "Loop current clip" }).click();
    await seek.fill("3.8"); await seek.dispatchEvent("input");
    await expect.poll(() => native(page).evaluate((e: HTMLMediaElement) => e.ended)).toBe(true);
    await expect(dock(page)).toContainText("tone-a.wav");
    await captureScreenshot(page, info, `${engine}-native-audio-tabs`);
    await dock(page).getByRole("button", { name: "Close player" }).click();
    await expect(native(page)).toHaveCount(0);
    expect(await page.evaluate(() => { const e = (window as any).__mediaElement as HTMLMediaElement; return e.paused && !e.hasAttribute("src"); })).toBe(true);
    await expect(dock(page)).toBeHidden();
    await browser.close();
  });

  test(`${engine}: H264 video decodes, seeks, expands the same element and requests fullscreen when supported`, async ({ launchBrowser, request, serverPort }, info) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page, "clip.mp4");
    const support = await native(page).evaluate((e: HTMLMediaElement) => e.canPlayType('video/mp4; codecs="avc1.42000b"'));
    if (!support) {
      await expect(page.locator(".media-preview [role=status]")).toContainText("Playback unavailable");
      expect(await native(page).evaluate((e: HTMLMediaElement) => e.error?.code)).toBe(4);
      await expect(page.locator(".media-preview").getByRole("link", { name: "Download" })).toBeVisible();
      await saveEvidence(info, `${engine}-video-codec.txt`, "Browser reports no H264 Baseline decoder; native MEDIA_ERR_SRC_NOT_SUPPORTED and download fallback verified.");
    } else {
      await ready(page);
      expect(await native(page).evaluate((e: HTMLVideoElement) => e.videoWidth)).toBe(32);
      await page.evaluate(() => { (window as any).__video = document.querySelector("video"); });
      await dock(page).getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
      await dock(page).getByRole("slider", { name: "Playback position" }).fill("1.5");
      await dock(page).getByRole("slider").dispatchEvent("input");
      await dock(page).getByRole("button", { name: "Expand video" }).click();
      expect(await native(page).evaluate((e: HTMLMediaElement) => e === (window as any).__video && e.currentTime >= 1.4)).toBe(true);
      await expect(native(page)).toHaveCount(1);
      expect(await native(page).evaluate((e: HTMLMediaElement) => !e.paused)).toBe(true);
      const fullscreen = dock(page).getByRole("button", { name: "Fullscreen video" });
      if (await fullscreen.isVisible()) {
        await fullscreen.click();
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement || !!(document.querySelector("video") as any)?.webkitDisplayingFullscreen || document.querySelector("#media-dock [role=status]")?.textContent?.includes("Fullscreen unavailable"))).toBeTruthy();
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
      }
      await captureScreenshot(page, info, `${engine}-native-h264`);
      await saveEvidence(info, `${engine}-video-codec.txt`, `H264 Baseline canPlayType=${support}; actual videoWidth=32, native play and seek verified.`);
    }
    await dock(page).getByRole("button", { name: "Close player" }).click(); await expect(native(page)).toHaveCount(0);
    await browser.close();
  });

  test(`${engine}: active revisions require paused Reload, unrelated writes preserve time, deletion releases`, async ({ launchBrowser, request, serverPort }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page); await ready(page);
    await dock(page).getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
    await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
    await dock(page).getByRole("slider").fill("1.5"); await dock(page).getByRole("slider").dispatchEvent("input");
    await page.evaluate(() => { (window as any).__mediaElement = document.querySelector("audio"); });
    await fs.writeFile(workspacePath("unrelated.txt"), "unrelated update"); await expect(treeRow(page, "unrelated.txt")).toBeVisible();
    expect(await native(page).evaluate((e: HTMLMediaElement) => e === (window as any).__mediaElement && Math.abs(e.currentTime - 1.5) < .2)).toBe(true);
    await dock(page).getByRole("button", { name: "Loop current clip" }).click();
    await fs.writeFile(workspacePath("tone-a.wav"), wavFixture(5));
    // A write notice can describe an intermediate producer revision. Wait for
    // the final written metadata in both the index and client before Reload.
    const written = new Date(Date.now() + 3000);
    await fs.utimes(workspacePath("tone-a.wav"), written, written);
    let writtenRevision = 0;
    await expect.poll(async () => {
      const state = await (await request.get("/api/state")).json();
      const doc = state.roots.flatMap((root: any) => root.docs).find((doc: any) => doc.relativePath === "tone-a.wav");
      if (!doc || Math.abs(doc.mtimeMs - written.getTime()) > 1) return false;
      writtenRevision = doc.revision; return true;
    }).toBe(true);
    await expect.poll(async () => {
      const href = await page.locator(".media-preview").getByRole("link", { name: "Download" }).getAttribute("href");
      return href ? Number(new URL(href, page.url()).searchParams.get("revision")) : -1;
    }).toBeGreaterThanOrEqual(writtenRevision);
    await expect(dock(page)).toContainText("New render available");
    await expect(dock(page).getByRole("button", { name: "Loop current clip" })).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => !(window as any).__mediaElement.hasAttribute("src"))).toBe(true);
    await dock(page).getByRole("button", { name: "Reload", exact: true }).click(); await ready(page);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e !== (window as any).__mediaElement && e.paused && e.currentTime === 0 && e.duration === 5)).toBe(true);
    const href = await page.locator(".media-preview").getByRole("link", { name: "Download" }).getAttribute("href");
    expect(new URL(href!, page.url()).searchParams.get("revision")).toBe(await native(page).evaluate((e: HTMLMediaElement) => new URL(e.src).searchParams.get("revision")));
    const download = await page.request.get(href!);
    expect(download.status()).toBe(200); expect(await download.body()).toEqual(wavFixture(5));
    await fs.rm(workspacePath("tone-a.wav")); await expect(dock(page)).toContainText("no longer available");
    await expect(native(page)).toHaveCount(0);
    await browser.close();
  });

  test(`${engine}: truncated media and rejected Play retain identity and explicit retry without automatic attempts`, async ({ launchBrowser, request, serverPort }, info) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page, "incomplete.wav");
    await expect(page.locator(".media-preview [role=status]")).toContainText("Playback unavailable");
    await expect(page.locator(".media-preview").getByRole("link", { name: "Download" })).toBeVisible();
    await expect(page.locator(".media-preview").getByRole("button", { name: "Retry" })).toBeVisible();
    await captureScreenshot(page, info, `${engine}-truncated-fallback`);
    const failedElement = await native(page).elementHandle();
    await page.locator(".media-preview").getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".media-preview [role=status]")).toContainText("Playback unavailable");
    expect(await failedElement!.evaluate(e => e.hasAttribute("src"))).toBe(false);
    expect(await native(page).evaluate((e: HTMLMediaElement) => e.paused && e.currentTime === 0)).toBe(true);
    await selectRecent(page, "tone-a.wav");
    await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click(); await ready(page);
    await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
    await native(page).evaluate(e => { (window as any).__attempts = 0; e.play = () => { (window as any).__attempts++; return Promise.reject(new DOMException("User gesture denied", "NotAllowedError")); }; });
    await dock(page).getByRole("button", { name: "Play", exact: true }).click();
    await expect(dock(page)).toContainText("Press Play to retry");
    expect(await page.evaluate(() => (window as any).__attempts)).toBe(1);
    await dock(page).getByRole("button", { name: "Play", exact: true }).click();
    expect(await page.evaluate(() => (window as any).__attempts)).toBe(2);
    await browser.close();
  });

  test(`${engine}: captured audition order skips deleted entries and ignores later arrivals and filter changes`, async ({ launchBrowser, request, serverPort }) => {
    await seed(request);
    await fs.writeFile(workspacePath("tone-c.wav"), wavFixture());
    for (const [i, name] of ["tone-a.wav", "tone-b.wav", "tone-c.wav"].entries()) {
      const date = new Date(Date.now() - i * 10000); await fs.utimes(workspacePath(name), date, date);
    }
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page);
    await page.locator("#files-pane-filter-recent").click(); await page.locator("#files-query").fill("tone-");
    await page.getByRole("button", { name: "Play tone-a.wav", exact: true }).click(); await playing(page);
    await expect(dock(page).getByRole("button", { name: "Previous clip" })).toBeDisabled();
    await fs.rm(workspacePath("tone-b.wav"));
    await expect(page.getByRole("button", { name: "Play tone-b.wav", exact: true })).toHaveCount(0);
    await fs.writeFile(workspacePath("tone-new.wav"), wavFixture());
    await expect(page.getByRole("button", { name: "Play tone-new.wav", exact: true })).toBeVisible();
    await page.locator("#files-query").fill("README");
    await dock(page).getByRole("button", { name: "Next clip" }).click();
    await expect(dock(page)).toContainText("tone-c.wav"); await playing(page);
    await expect(dock(page).getByRole("button", { name: "Next clip" })).toBeDisabled();
    await dock(page).getByRole("button", { name: "Previous clip" }).click();
    await expect(dock(page)).toContainText("tone-a.wav");
    await expect(dock(page).getByRole("button", { name: "Previous clip" })).toBeDisabled();
    await expect(native(page)).toHaveCount(1);
    await browser.close();
  });

  test(`${engine}: exposure exclusion stops an active source and hides its download`, async ({ launchBrowser, request, serverPort }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page); await ready(page);
    await dock(page).getByRole("button", { name: "Play", exact: true }).click(); await playing(page);
    await fs.writeFile(workspacePath(".uatu.json"), JSON.stringify({ ignore: { exclude: ["tone-a.wav"] } }));
    await expect(dock(page)).toContainText("no longer available");
    await expect(native(page)).toHaveCount(0);
    await expect(page.locator(".media-preview").getByRole("link", { name: "Download" })).toBeHidden();
    await expect(dock(page).getByRole("button", { name: "Play", exact: true })).toBeDisabled();
    await browser.close();
  });

  test(`${engine}: closed and inactive previews keep latest permitted download links without fetching or reopening playback`, async ({ launchBrowser, request, serverPort }) => {
    await seed(request);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    await open(page); await ready(page);
    const link = page.locator(".media-preview").getByRole("link", { name: "Download" });
    const initial = await link.getAttribute("href");
    await dock(page).getByRole("button", { name: "Close player" }).click();
    let mediaRequests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/api/media")) mediaRequests++; });
    await fs.writeFile(workspacePath("tone-a.wav"), wavFixture(6));
    await expect(link).not.toHaveAttribute("href", initial!);
    const latest = await link.getAttribute("href");
    await expect(dock(page)).toBeHidden(); await expect(native(page)).toHaveCount(0);
    expect(mediaRequests).toBe(0);
    const download = await page.request.get(latest!);
    expect(download.status()).toBe(200); expect(await download.body()).toEqual(wavFixture(6));
    await page.locator("#files-pane-filter-recent").click();
    await page.getByRole("button", { name: "Play tone-b.wav", exact: true }).click(); await playing(page);
    await expect(page.locator("#preview-path")).toHaveText("tone-a.wav");
    const count = mediaRequests;
    await fs.writeFile(workspacePath("tone-a.wav"), wavFixture(7));
    await expect(link).not.toHaveAttribute("href", latest!);
    const inactiveDownload = await page.request.get((await link.getAttribute("href"))!);
    expect(inactiveDownload.status()).toBe(200); expect(await inactiveDownload.body()).toEqual(wavFixture(7));
    expect(mediaRequests).toBe(count);
    await expect(dock(page)).toContainText("tone-b.wav");
    await expect(native(page)).toHaveCount(1);
    await fs.writeFile(workspacePath(".uatu.json"), JSON.stringify({ ignore: { exclude: ["tone-a.wav"] } }));
    await expect(link).toBeHidden();
    await expect(dock(page)).toContainText("tone-b.wav");
    await browser.close();
  });
}
