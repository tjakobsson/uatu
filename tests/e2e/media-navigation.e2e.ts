import { promises as fs } from "node:fs";
import { test as base, expect, showGitLogPane } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { workspacePath } from "./config";
import { wavFixture } from "./media-fixtures";
import { openTreeFile, treeRow } from "./tree-helpers";
import { captureScreenshot } from "./evidence";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);
test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: preview navigation preserves playback and cached-page recovery cannot restore it`, async ({ launchBrowser, request, serverPort }, info) => {
    await request.post("/__e2e/reset", { data: { git: true, follow: false } });
    await fs.mkdir(workspacePath("audition"), { recursive: true });
    await fs.writeFile(workspacePath("audition", "tone.wav"), wavFixture(60));
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${serverPort}` });
    try {
      const { token } = await (await request.get("/__e2e/terminal-token")).json();
      await page.goto(`/audition/tone.wav?t=${encodeURIComponent(token)}`);
      await expect(page.locator(".media-preview")).toBeVisible();
      const dock = page.locator("#media-dock");
      await expect.poll(() => page.locator("audio[src]").evaluate((element: HTMLMediaElement) => element.duration)).toBeGreaterThan(50);
      await dock.getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(() => page.locator("audio[src]").evaluate((element: HTMLMediaElement) => !element.paused && element.currentTime > 0)).toBe(true);
      await dock.getByRole("button", { name: "Loop current clip" }).click();
      await page.evaluate(() => { (window as any).__navigationAudio = document.querySelector("audio[src]"); });
      const source = await page.locator("audio[src]").getAttribute("src");
      let lastTime = await page.locator("audio[src]").evaluate((element: HTMLMediaElement) => element.currentTime);
      const assertContinues = async () => {
        await expect(page.locator("audio[src]")).toHaveCount(1);
        expect(await page.locator("audio[src]").getAttribute("src")).toBe(source);
        expect(await page.locator("audio[src]").evaluate((element: HTMLMediaElement) => element === (window as any).__navigationAudio && !element.paused)).toBe(true);
        const time = await page.locator("audio[src]").evaluate((element: HTMLMediaElement) => element.currentTime);
        expect(time).toBeGreaterThanOrEqual(lastTime - 0.05);
        lastTime = time;
      };
      await showGitLogPane(page);
      await page.locator("#git-log .commit-log a", { hasText: "add feature doc" }).click();
      await expect(page.locator(".commit-preview")).toBeVisible();
      await assertContinues();
      await page.goBack();
      await expect(page.locator("#preview-path")).toHaveText("audition/tone.wav");
      await expect(page.locator(".media-preview")).toBeVisible();
      await assertContinues();
      await expect(treeRow(page, "audition/")).toHaveAttribute("aria-expanded", "true");
      await treeRow(page, "audition/").click();
      await expect(page.locator("#preview")).toHaveClass(/empty/);
      await assertContinues();
      await openTreeFile(page, "README.md");
      await assertContinues();
      await fs.writeFile(workspacePath("README.md"), "# Document refresh during audition\n");
      await expect(page.locator("#preview")).toContainText("Document refresh during audition");
      await assertContinues();
      await captureScreenshot(page, info, `${engine}-media-independent-preview-navigation`);
      await openTreeFile(page, "audition/tone.wav");
      await assertContinues();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      await expect(page.locator("audio[src], video[src]")).toHaveCount(0);
      await expect(dock).toBeHidden();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      await expect(page.locator("audio[src], video[src]")).toHaveCount(0);
      await expect(dock).toBeHidden();
      await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(() => page.locator("audio[src]").evaluate((element: HTMLMediaElement) => !element.paused && element.currentTime > 0)).toBe(true);
      expect(await page.locator("audio[src]").evaluate(element => element !== (window as any).__navigationAudio)).toBe(true);
      await dock.getByRole("button", { name: "Close player" }).click();
      await expect(page.locator("audio[src], video[src]")).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
}
