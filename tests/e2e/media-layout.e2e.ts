import type { APIRequestContext, Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { workspacePath } from "./config";
import { mp4Fixture, wavFixture } from "./media-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";
import { treeRow } from "./tree-helpers";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);
test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

async function boot(page: Page, request: APIRequestContext, mode: "touch" | "desktop", audio = false) {
  await request.post("/__e2e/reset", { data: { follow: false, extras: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`row-${String(i).padStart(3, "0")}.md`, `# Row ${i}`])) } });
  await request.post("/__e2e/chat", { data: { action: "seed", title: "Media layout", items: [{ id: "hello", type: "user_message", createdAt: 1, text: "A retained conversation" }] } });
  const credential = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string; enabled: boolean };
  const filename = audio ? "media-layout.wav" : "media-layout.mp4";
  await fs.writeFile(workspacePath(filename), audio ? wavFixture(20) : mp4Fixture());
  await page.addInitScript(({ mode, size }) => {
    localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", mode);
    const viewport = Object.assign(new EventTarget(), { ...size, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  }, { mode, size: page.viewportSize()! });
  await page.goto(`/?t=${encodeURIComponent(credential.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (mode === "touch") await page.locator("#touch-tab-files").click();
  await expect(treeRow(page, filename)).toBeVisible();
  await page.locator("#files-pane-filter-recent").click();
  await page.locator("#files-query").fill(filename);
  await page.locator(`#recent-files button[data-path="${filename}"]`).click();
  await expect(page.locator(".media-preview")).toBeVisible();
  await expect(page.locator("audio, video")).toHaveCount(1);
  await expect.poll(() => page.locator("audio, video").evaluate((node: HTMLMediaElement) => Number.isFinite(node.duration) && node.duration > 2)).toBe(true);
  await page.locator(".media-preview").getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.locator("audio, video").evaluate((node: HTMLMediaElement) => !node.paused)).toBe(true);
  await page.locator("#media-dock").getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator("audio, video").evaluate((node: HTMLMediaElement) => { (window as any).__layoutMedia = node; node.currentTime = 1.25; });
  await expect.poll(() => page.locator("audio, video").evaluate((node: HTMLMediaElement) => node.currentTime)).toBeGreaterThan(1);
  return credential;
}

async function sameMedia(page: Page) {
  await expect(page.locator("audio, video")).toHaveCount(1);
  expect(await page.locator("audio, video").evaluate(node => node === (window as any).__layoutMedia)).toBe(true);
  expect(await page.locator("audio, video").evaluate((node: HTMLMediaElement) => node.currentTime)).toBeCloseTo(1.25, 1);
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector)!;
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    return { dock: rect("#media-dock"), shell: rect(".app-shell"),
      viewport: { top: visualViewport!.offsetTop, bottom: visualViewport!.height + visualViewport!.offsetTop },
      reservation: parseFloat(document.documentElement.style.getPropertyValue("--media-dock-height")) };
  });
}

async function viewport(page: Page, height: number, top = 0) {
  await page.evaluate(({ height, top }) => {
    Object.assign(window.visualViewport!, { width: innerWidth, height, offsetTop: top });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  }, { height, top });
}

async function dockFits(page: Page) {
  await expect.poll(async () => {
    const m = await metrics(page);
    return m.dock.top >= m.viewport.top - 1 && m.dock.bottom <= m.viewport.bottom + 1
      && Math.abs(m.reservation - m.dock.height) < 1;
  }).toBe(true);
  expect(await page.locator("#media-dock").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
}

for (const engine of ["chromium", "webkit"] as const) {
  for (const shape of [
    { name: "320 phone", size: { width: 320, height: 740 }, mode: "touch" as const },
    { name: "iPad", size: { width: 834, height: 1194 }, mode: "touch" as const },
    { name: "desktop", size: { width: 1280, height: 900 }, mode: "desktop" as const },
  ]) {
    test(`${engine} ${shape.name}: measured video dock, rotation, modes, last row and same element`, async ({ launchBrowser, request, baseURL }, testInfo) => {
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL, viewport: shape.size, hasTouch: true, isMobile: true });
      try {
        await boot(page, request, shape.mode);
        await dockFits(page);
        const slider = page.locator('#media-dock input[type="range"]');
        await expect.poll(() => slider.inputValue().then(Number)).toBeGreaterThan(1);
        await slider.focus();
        await slider.evaluate(node => { (window as any).__layoutSlider = node; });
        await page.locator("video").evaluate(node => { for (let i = 0; i < 5; i++) node.dispatchEvent(new Event("timeupdate")); });
        await expect(slider).toBeFocused();
        expect(await slider.evaluate(node => node === (window as any).__layoutSlider)).toBe(true);
        await slider.press("ArrowRight");
        await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(1.25);
        await slider.blur();
        await page.locator("video").evaluate((node: HTMLVideoElement) => { node.currentTime = 1.25; });
        if (shape.mode === "desktop") {
          await expect.poll(async () => {
            const m = await metrics(page);
            return Math.abs(m.shell.bottom - m.dock.top) < 1;
          }).toBe(true);
        }
        await page.locator("#media-dock").getByRole("button", { name: "Expand video", exact: true }).click();
        await expect(page.locator("#media-dock video")).toHaveCount(1);
        await expect(page.locator("#media-dock video")).toBeVisible();
        await dockFits(page); await sameMedia(page);
        const expanded = await metrics(page);
        await page.locator("#media-dock").getByRole("button", { name: "Compact video", exact: true }).click();
        await expect.poll(async () => (await metrics(page)).dock.height).toBeLessThan(expanded.dock.height);
        if (shape.mode === "touch") {
          await page.locator("#media-dock").getByRole("button", { name: "Play", exact: true }).click();
          await page.locator("#touch-tab-files").click();
          await expect(page.locator("#media-dock video")).toHaveCount(1);
          await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => !node.paused && node.currentTime > 1.4)).toBe(true);
          await page.locator("#media-dock").getByRole("button", { name: "Pause", exact: true }).click();
          await page.locator("video").evaluate((node: HTMLVideoElement) => { node.currentTime = 1.25; });
        }
        await page.locator("#files-pane-filter-recent").click();
        await page.locator("#files-query-clear").click();
        const recent = page.locator("#recent-files");
        await recent.evaluate(node => { node.scrollTop = node.scrollHeight; });
        const last = recent.locator("button[data-path]").last();
        await expect(last).toBeVisible();
        await expect.poll(async () => {
          const row = await last.boundingBox(); const dock = await page.locator("#media-dock").boundingBox();
          return !!row && !!dock && row.y + row.height <= dock.y + 1;
        }).toBe(true);
        await sameMedia(page);
        await page.setViewportSize({ width: shape.size.height, height: shape.size.width });
        await viewport(page, shape.size.width);
        await dockFits(page); await sameMedia(page);
        // Exercise the real mode control rather than changing the CSS stamp.
        await page.locator("#ui-mode-toggle").click();
        await expect(page.locator("html")).toHaveAttribute("data-ui-mode", shape.mode === "touch" ? "desktop" : "touch");
        await dockFits(page); await sameMedia(page);
        await page.setViewportSize(shape.size); await viewport(page, shape.size.height);
        await dockFits(page); await sameMedia(page);
        await captureScreenshot(page, testInfo, `${engine}-${shape.name.replaceAll(" ", "-")}-dock`);
        await saveEvidence(testInfo, `${engine}-${shape.name.replaceAll(" ", "-")}-geometry.json`, JSON.stringify({ expanded, final: await metrics(page) }, null, 2));
        await page.locator("#media-dock").getByRole("button", { name: "Close player" }).click();
        await expect(page.locator("#media-dock")).toBeHidden();
        await expect(page.locator("audio, video")).toHaveCount(0);
      } finally { await browser.close(); }
    });
  }

  test(`${engine}: safe areas, keyboard, Chat composer and attached terminal reserve the audio dock separately`, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    if (engine === "chromium") await page.context().grantPermissions(["local-network-access"]);
    const diagnostics: string[] = [];
    page.on("console", message => { if (message.type() === "error") diagnostics.push(message.text().replace(/\?t=[^'"\s]+/g, "?[credentials]")); });
    page.on("websocket", socket => {
      socket.on("socketerror", error => diagnostics.push(`WebSocket error: ${error}`));
      socket.on("close", () => diagnostics.push("WebSocket closed"));
    });
    try {
      // Replace env() in bundled assets, as in the existing Chat layout suite.
      await page.route("**/*", async route => {
        if (!["stylesheet", "script", "document"].includes(route.request().resourceType())) return route.fallback();
        const response = await route.fetch();
        if (!/css|javascript|html/.test(response.headers()["content-type"] ?? "")) return route.fulfill({ response });
        const body = (await response.text()).replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*(,[^()]*(\([^()]*\))?[^()]*)?\)/g, (_match, edge) => edge === "bottom" ? "34px" : edge === "top" ? "24px" : "0px");
        await route.fulfill({ response, body });
      });
      const credential = await boot(page, request, "touch", true);
      await page.locator("#touch-tab-chat").click();
      await expect(page.locator("#chat-composer")).toBeVisible();
      await dockFits(page);
      const normal = await metrics(page);
      expect(normal.dock.bottom).toBeCloseTo(844 - 90, 0);
      await page.locator("#chat-input").fill("A draft while auditioning");
      await viewport(page, 500, 30);
      await dockFits(page);
      await expect.poll(async () => {
        const composer = (await page.locator("#chat-composer").boundingBox())!;
        const dock = (await page.locator("#media-dock").boundingBox())!;
        return composer.y >= 30 && composer.y + composer.height <= dock.y + 1;
      }).toBe(true);
      await expect(page.locator("#chat-input")).toHaveValue("A draft while auditioning");
      await sameMedia(page);
      await page.locator("#chat-input").blur(); await viewport(page, 844);
      await page.locator("#touch-tab-files").click();
      if (credential.enabled) {
        await page.locator("#touch-tab-terminal").click();
        await expect(page.locator(".terminal-pane[data-state='ready']")).toBeVisible();
        const session = await page.locator(".terminal-pane").first().getAttribute("data-session-id");
        await viewport(page, 500, 30);
        await expect.poll(async () => {
          const terminal = (await page.locator("#terminal-panel").boundingBox())!;
          const dock = (await page.locator("#media-dock").boundingBox())!;
          return terminal.y >= 30 && Math.abs(terminal.y + terminal.height - dock.y) < 2;
        }).toBe(true);
        await expect(page.locator(".terminal-pane[data-state='ready']")).toBeVisible();
        expect(await page.locator(".terminal-pane").first().getAttribute("data-session-id")).toBe(session);
        const terminal = page.locator(".xterm-screen").first();
        const box = (await terminal.boundingBox())!;
        expect(box.height).toBeGreaterThan(20);
        expect(box.y + box.height).toBeLessThanOrEqual((await page.locator("#media-dock").boundingBox())!.y + 1);
      } else testInfo.annotations.push({ type: "terminal", description: "PTY backend unavailable" });
      await sameMedia(page); await dockFits(page);
      await captureScreenshot(page, testInfo, `${engine}-media-keyboard`);
      await saveEvidence(testInfo, `${engine}-media-keyboard.json`, JSON.stringify({ normal, keyboard: await metrics(page), terminal: credential.enabled }, null, 2));
    } finally {
      await saveEvidence(testInfo, `${engine}-terminal-diagnostics.txt`, diagnostics.join("\n"));
      await browser.close();
    }
  });
}
