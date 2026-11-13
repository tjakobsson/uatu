import { promises as fs } from "node:fs";
import type { Page } from "@playwright/test";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { workspacePath } from "./config";
import { wavFixture, mp4Fixture } from "./media-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";
import { afterAnimationFrames } from "./sync-helpers";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);
test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

const files = { a: "build/renders/render-a.wav", b: "build/renders/render-b.wav", video: "build/renders/render-video.mp4" };
const filename = (page: Page, path: string) => page.locator(`#recent-files .recent-file-open[data-path="${path}"]`);
const playRow = (page: Page, path: string) => page.getByRole("button", { name: `Play ${path}`, exact: true });
const native = (page: Page) => page.locator("audio[src], video[src]");
const dock = (page: Page) => page.locator("#media-dock");

async function typeFilter(page: Page, value: string): Promise<void> {
  await page.getByRole("button", { name: "Files options", exact: true }).click();
  await page.getByRole("combobox", { name: "File types" }).selectOption(value);
  await page.getByRole("button", { name: "Files options", exact: true }).click();
}

async function playingPath(page: Page, path: string): Promise<void> {
  await expect(native(page)).toHaveCount(1);
  await expect.poll(() => native(page).evaluate((element: HTMLMediaElement) => ({
    path: new URL(element.currentSrc || element.src).searchParams.get("path"),
    playing: !element.paused && element.currentTime > 0,
  }))).toEqual({ path, playing: true });
}

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: ignored generated media workflow remains responsive across Files, Preview, Chat and explicit Reload`, async ({ launchBrowser, request, serverPort }, info) => {
    test.setTimeout(90_000);
    await request.post("/__e2e/reset", { data: { git: true, follow: false, extras: { ".gitignore": "build/\n" } } });
    await request.post("/__e2e/chat", { data: { action: "seed", title: "Media workflow", items: [] } });
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}`, viewport: { width: 390, height: 844 }, hasTouch: true });
    const requests: string[] = [];
    let streams = 0;
    page.on("request", outgoing => {
      const path = new URL(outgoing.url()).pathname;
      if (path.endsWith("/api/media")) requests.push(outgoing.url());
      if (path === "/api/hub/live") streams++;
    });
    await page.addInitScript(() => {
      (window as any).__workflowWrites = {};
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener("live", event => {
            const frame = JSON.parse((event as MessageEvent).data);
            if (frame.topic !== "document" || frame.event?.kind !== "data") return;
            const update = frame.event.data;
            for (const doc of [...(update.upserts ?? []), ...(update.roots ?? []).flatMap((root: any) => root.docs ?? [])]) {
              (window as any).__workflowWrites[doc.relativePath] = doc.mtimeMs;
              if (doc.relativePath.endsWith("render-b.wav")) console.debug(`[media-workflow] document revision=${doc.revision} mtime=${doc.mtimeMs}`);
            }
          });
        }
      };
    });
    try {
      const { token } = await (await request.get("/__e2e/terminal-token")).json();
      await page.goto(`/README.md?t=${encodeURIComponent(token)}`);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      await page.evaluate(() => { document.documentElement.dataset.uiMode = "touch"; });
      await page.locator('[data-tab="files"]').click();
      await page.locator("#files-pane-filter-recent").click();
      await page.locator("#files-query").fill("render-");
      const beforeListing = requests.length;
      await fs.mkdir(workspacePath("build", "renders"), { recursive: true });
      const written = Date.now() + 3000;
      for (const [index, path] of Object.values(files).entries()) {
        await fs.writeFile(workspacePath(...path.split("/")), path.endsWith(".mp4") ? mp4Fixture() : wavFixture(12));
        const time = new Date(written - index * 1000);
        await fs.utimes(workspacePath(...path.split("/")), time, time);
      }
      await expect(page.locator("#document-count")).toHaveText("3");
      await expect(filename(page, files.a)).toBeVisible();
      expect(requests).toHaveLength(beforeListing);
      await expect.poll(async () => {
        const state = await (await request.get("/api/state")).json();
        return state.roots.flatMap((root: any) => root.docs).filter((doc: any) => Object.values(files).includes(doc.relativePath)).map((doc: any) => doc.gitIgnoreStatus);
      }).toEqual(["ignored", "ignored", "ignored"]);

      await typeFilter(page, "audio");
      await expect(page.locator("#document-count")).toHaveText("2");
      await filename(page, files.a).tap();
      await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
      await expect(page.locator("#preview-path")).toHaveText(files.a);
      expect(await native(page).evaluate((element: HTMLMediaElement) => element.paused)).toBe(true);
      await page.locator('[data-tab="files"]').click();
      await filename(page, files.b).tap();
      await expect(page.locator("#preview-path")).toHaveText(files.b);
      await expect(page.locator(".media-preview")).toContainText("Press Play");
      await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click();
      await playingPath(page, files.b);
      await page.locator('[data-tab="files"]').click();
      const previewUrl = page.url();
      await playRow(page, files.a).tap(); await playingPath(page, files.a);
      await playRow(page, files.b).tap(); await playingPath(page, files.b);
      expect(page.url()).toBe(previewUrl);
      await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
      await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
      await captureScreenshot(page, info, `${engine}-generated-media-files`);

      await typeFilter(page, "video");
      await expect(page.locator("#document-count")).toHaveText("1");
      await filename(page, files.video).tap();
      await expect(page.locator("#preview-path")).toHaveText(files.video);
      await playingPath(page, files.b);
      const videoSupport = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42000b"'));
      if (videoSupport) {
        await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click();
        await playingPath(page, files.video);
        expect(await native(page).evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(32);
      }
      await page.locator('[data-tab="files"]').click();
      await typeFilter(page, "audio");
      await playRow(page, files.b).tap(); await playingPath(page, files.b);
      await dock(page).getByRole("button", { name: "Loop current clip" }).click();
      await page.evaluate(() => { (window as any).__workflowElement = document.querySelector("audio[src]"); });
      const oldSource = await native(page).getAttribute("src");
      const comparisonUrl = page.url();
      await page.locator('[data-tab="chat"]').click();
      await expect(page.locator("#chat-input")).toBeVisible();
      await page.locator("#chat-input").fill("Compare the two audio renders.");
      await page.locator("#chat-send").click();
      await expect(page.locator("#chat-timeline")).toContainText("Compare the two audio renders.");
      await playingPath(page, files.b);
      expect(await native(page).evaluate(element => element === (window as any).__workflowElement)).toBe(true);
      await captureScreenshot(page, info, `${engine}-generated-media-chat`);

      await fs.writeFile(workspacePath("README.md"), "# Unrelated live update\n");
      const control = await request.get("/api/state"); expect(control.ok()).toBe(true);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      expect(await native(page).getAttribute("src")).toBe(oldSource);
      const newer = new Date(Date.now() + 6000);
      await fs.writeFile(workspacePath(...files.b.split("/")), wavFixture(10));
      await fs.utimes(workspacePath(...files.b.split("/")), newer, newer);
      await expect.poll(() => page.evaluate(path => (window as any).__workflowWrites[path], files.b)).toBeCloseTo(newer.getTime(), 0);
      await expect(dock(page)).toContainText("New render available");
      await expect(dock(page).getByRole("button", { name: "Loop current clip" })).toHaveAttribute("aria-pressed", "false");
      await page.evaluate(() => {
        for (const type of ["mousedown", "mouseup", "click", "focusout"]) document.addEventListener(type, event => {
          const button = document.querySelector<HTMLButtonElement>("#media-dock .media-dock-status button");
          const src = document.querySelector<HTMLMediaElement>("audio[src], video[src]")?.src;
          console.debug(`[media-workflow] ${type} target=${(event.target as HTMLElement).tagName} active=${document.activeElement?.id} reloadTop=${button?.getBoundingClientRect().top} sourceRevision=${src ? new URL(src).searchParams.get("revision") : "none"}`);
        }, true);
      });
      // Keep the press held across layout frames. A blur on mousedown used to
      // restore the tab bar, move Reload by its height and lose the click.
      const composer = page.locator("#chat-input");
      await composer.focus();
      await expect(composer).toBeFocused();
      const reload = dock(page).getByRole("button", { name: "Reload", exact: true });
      const bounds = (await reload.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      try {
        await afterAnimationFrames(page, 2);
        await expect(composer).toBeFocused();
        expect((await reload.boundingBox())!.y).toBe(bounds.y);
      } finally { await page.mouse.up(); }
      await expect(composer).not.toBeFocused();
      await expect(native(page)).toHaveCount(1);
      await expect.poll(() => native(page).evaluate((element: HTMLMediaElement) => element.duration)).toBeGreaterThan(9);
      expect(await native(page).evaluate((element: HTMLMediaElement) => element.paused && element.currentTime === 0)).toBe(true);
      expect(await native(page).getAttribute("src")).not.toBe(oldSource);
      await expect(page.locator("html")).toHaveAttribute("data-active-tab", "chat");
      expect(page.url()).toBe(comparisonUrl);
      await dock(page).getByRole("button", { name: "Play", exact: true }).tap(); await playingPath(page, files.b);
      await page.locator('[data-tab="files"]').click();
      await expect(page.locator("#document-count")).toHaveText("2");
      await captureScreenshot(page, info, `${engine}-generated-media-reloaded`);
      expect(streams).toBe(1);
      await saveEvidence(info, `${engine}-media-workflow.json`, JSON.stringify({ engine, generatedOutputs: files, videoSupport, mediaRequests: requests.length, liveStreams: streams, ignoredOutputs: 3, reloadPausedAtZero: true }, null, 2));
      await dock(page).getByRole("button", { name: "Close player" }).click();
      await expect(native(page)).toHaveCount(0); await expect(dock(page)).toBeHidden();
    } finally {
      await browser.close();
    }
  });
}
