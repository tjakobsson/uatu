import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test as baseTest } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";

const test = withEngineBrowsers(baseTest);

const LANDSCAPE = { width: 1194, height: 834 };
type Viewport = { width: number; height: number; offsetTop: number; offsetLeft: number; scale: number };

async function boot(page: Page, request: APIRequestContext) {
  await request.post("/__e2e/reset", { data: { extras: { "README.md": "# Viewport fixture\n\n" + "A paragraph of preview content.\n\n".repeat(100) } } });
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "iPad viewport", items: Array.from({ length: 30 }, (_, index) => ({
    id: `message:${index}`, type: "user_message", createdAt: index, text: `Message ${index}: ${"content ".repeat(20)}`,
  })) } }).then(response => response.json()) as { conversation: { id: string } };
  const credential = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string; enabled: boolean };
  await page.addInitScript(size => {
    localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "desktop");
    const viewport = Object.assign(new EventTarget(), { ...size, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  }, LANDSCAPE);
  await page.goto(`/?t=${encodeURIComponent(credential.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#preview h1")).toHaveText("Viewport fixture");
  await page.evaluate(() => {
    for (const [edge, value] of Object.entries({ top: 24, right: 0, bottom: 20, left: 0 })) document.documentElement.style.setProperty(`--device-safe-${edge}`, `${value}px`);
    window.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".app-shell")).toHaveCSS("padding-top", "24px");
  await openChatPanel(page);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
  await page.locator("#chat-input").fill("Keep this iPad draft");
  return credential;
}

async function viewport(page: Page, values: Partial<Viewport>) {
  await page.evaluate(next => {
    Object.assign(window.visualViewport!, next);
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  }, values);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, width: box.width };
    };
    const vv = window.visualViewport!;
    return {
      viewport: { top: vv.offsetTop, height: vv.height, bottom: vv.offsetTop + vv.height },
      shell: rect(".app-shell"), sidebar: rect(".sidebar-header"), preview: rect(".preview-header"),
      chat: rect(".chat-header"), composer: rect("#chat-composer"), send: rect("#chat-send"),
      scrollY: window.scrollY,
      shellPosition: getComputedStyle(document.querySelector(".app-shell")!).position,
      composerBottomPadding: getComputedStyle(document.querySelector("#chat-composer")!).paddingBottom,
    };
  });
}

async function expectChromeFits(page: Page) {
  await expect.poll(async () => {
    const value = await geometry(page);
    if (Math.abs(value.shell.top - value.viewport.top) > 1 || Math.abs(value.shell.height - value.viewport.height) > 1) return "workspace has not adopted the current viewport";
    const minTop = Math.max(24, value.viewport.top);
    const bottomPadding = Math.max(0, 20 - Math.max(0, LANDSCAPE.height - value.viewport.bottom));
    const maxBottom = value.viewport.bottom - bottomPadding;
    for (const [name, box] of Object.entries({ sidebar: value.sidebar, preview: value.preview, chat: value.chat, composer: value.composer, send: value.send })) {
      if (box.height < 1) return `${name} is hidden`;
      if (box.top < minTop - 1 || box.bottom > maxBottom + 1) return `${name} is outside visible work area: ${JSON.stringify(value)}`;
    }
    return "fits";
  }).toBe("fits");
  await expect(page.locator("#chat-input")).toHaveValue("Keep this iPad draft");
}

attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} iPad desktop headers and composer fit accessory-bar and software-keyboard viewports`, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: LANDSCAPE, hasTouch: true, isMobile: true });
    try {
      testInfo.annotations.push({ type: "simulation", description: "Controlled safe-area and visual-viewport measurements; native iPad blur/keyboard still require physical verification." });
      await boot(page, request);
      await page.locator("#chat-input").blur();
      await expectChromeFits(page);
      const before = await geometry(page);
      await captureScreenshot(page, testInfo, `${engine}-ipad-desktop-before-focus`);
      await page.locator("#chat-input").focus();
      await viewport(page, { height: 790, offsetTop: 0 });
      await expectChromeFits(page);
      await expect(page.locator(".app-shell")).toHaveCSS("height", "790px");
      await expect(page.locator(".app-shell")).toHaveCSS("padding-bottom", "0px");
      const accessory = await geometry(page);
      expect(accessory.composerBottomPadding).toBe("12px");
      await captureScreenshot(page, testInfo, `${engine}-ipad-desktop-accessory-bar`);
      await viewport(page, { height: 460, offsetTop: 54 });
      await expectChromeFits(page);
      await page.locator(".preview-shell").evaluate(element => { element.scrollTop = 240; });
      await expectChromeFits(page);
      const software = await geometry(page);
      expect(software.scrollY).toBe(0);
      await viewport(page, { ...LANDSCAPE, offsetTop: 0 });
      await page.locator("#chat-input").blur();
      await expectChromeFits(page);
      const restored = await geometry(page);
      expect(restored.shell).toEqual(before.shell);
      await saveEvidence(testInfo, `${engine}-ipad-desktop-geometry.json`, JSON.stringify({ before, accessory, software, restored }, null, 2));
    } finally { await browser.close(); }
  });

  test(`${engine} iPad rotation and mode switches clear desktop geometry without losing drafts`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: LANDSCAPE, hasTouch: true, isMobile: true });
    try {
      await boot(page, request);
      await page.locator("#sidebar-collapse").click();
      await expect(page.locator("#rail-ui-mode-toggle")).toBeVisible();
      expect((await page.locator("#rail-ui-mode-toggle").boundingBox())!.y).toBeGreaterThanOrEqual(24);
      await page.locator("#chat-input").blur();
      await page.setViewportSize({ width: 834, height: 1194 });
      await viewport(page, { width: 834, height: 1194 });
      await expect(page.locator(".app-shell")).toHaveCSS("position", "static");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(0);
      await page.locator(".preview").evaluate(element => { element.scrollIntoView({ block: "end" }); });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await page.locator("#rail-ui-mode-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
      expect(await page.locator("html").evaluate(element => element.style.getPropertyValue("--desktop-visual-height"))).toBe("");
      await expect(page.locator(".app-shell")).toHaveCSS("padding-top", "0px");
      await page.locator("#touch-tab-chat").click();
      await expect(page.locator("#chat-input")).toHaveValue("Keep this iPad draft");
      await viewport(page, { height: 650, offsetTop: 30 });
      await expect(page.locator("#chat-surface")).toHaveCSS("--chat-visual-height", "650px");
      await page.setViewportSize(LANDSCAPE);
      await viewport(page, { ...LANDSCAPE, offsetTop: 0 });
      await page.locator("#touch-tab-files").click();
      await page.locator("#ui-mode-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
      await expect(page.locator(".app-shell")).toHaveCSS("position", "fixed");
      await expect(page.locator(".app-shell")).toHaveCSS("padding-top", "24px");
      await openChatPanel(page);
      await expect(page.locator("#chat-input")).toHaveValue("Keep this iPad draft");
      expect(await page.locator("#chat-surface").evaluate(element => element.style.getPropertyValue("--chat-visual-height"))).toBe("");
    } finally { await browser.close(); }
  });

  test(`${engine} docked and fullscreen terminals inherit the desktop viewport once`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: LANDSCAPE, hasTouch: true, isMobile: true });
    try {
      const credential = await boot(page, request);
      test.skip(!credential.enabled, "terminal backend unavailable");
      await page.locator("#terminal-toggle").click();
      await expect(page.locator(".terminal-pane-host .xterm-screen").first()).toBeVisible();
      const preference = await page.evaluate(() => localStorage.getItem("uatu:presentation:v1:%2F:uatu:terminal-state"));
      await page.locator("#chat-input").focus();
      await viewport(page, { height: 520, offsetTop: 40 });
      await expectChromeFits(page);
      const assertTerminal = async () => {
        await expect.poll(() => page.evaluate(() => {
          const panel = document.querySelector("#terminal-panel")!.getBoundingClientRect();
          const host = document.querySelector(".terminal-pane-host")!.getBoundingClientRect();
          const grid = document.querySelector(".xterm-screen")!.getBoundingClientRect();
          const vv = window.visualViewport!;
          return panel.top >= vv.offsetTop - 1 && panel.bottom <= vv.offsetTop + vv.height + 1
            && grid.height > 30 && grid.bottom <= host.bottom + 1;
        })).toBe(true);
      };
      await assertTerminal();
      expect(await page.evaluate(() => localStorage.getItem("uatu:presentation:v1:%2F:uatu:terminal-state"))).toBe(preference);
      await page.locator("#terminal-fullscreen").click();
      await assertTerminal();
      await page.locator("#terminal-fullscreen").click();
      await page.locator("#terminal-dock-toggle").click();
      await assertTerminal();
      await viewport(page, { ...LANDSCAPE, offsetTop: 0 });
      await page.locator("#terminal-close").click();
    } finally { await browser.close(); }
  });

  test(`${engine} safe areas work with fine pointers, zoom stays browser-owned, and native titlebar remains separate`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: LANDSCAPE, hasTouch: false });
    try {
      await boot(page, request);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      await expectChromeFits(page);
      await viewport(page, { height: 417, width: 597, offsetTop: 100, scale: 2 });
      await expect(page.locator(".app-shell")).toHaveCSS("height", "834px");
      await expect(page.locator(".app-shell")).toHaveCSS("width", "1194px");
      await viewport(page, { ...LANDSCAPE, offsetTop: 0, scale: 1 });
      await page.evaluate(() => {
        document.documentElement.classList.add("uatu-desktop-host");
        document.documentElement.style.setProperty("--titlebar-inset", "64px");
      });
      await expect(page.locator(".app-shell")).toHaveCSS("position", "static");
      await expect(page.locator(".app-shell")).toHaveCSS("padding-top", "0px");
      await expect(page.locator(".preview-shell")).toHaveCSS("padding-top", "64px");
      await expect(page.locator(".chat-surface")).toHaveCSS("padding-top", "64px");
      await expect(page.locator(".preview-header")).toHaveCSS("z-index", "91");
      await page.evaluate(() => {
        const root = document.documentElement;
        root.classList.remove("uatu-desktop-host"); root.style.removeProperty("--titlebar-inset");
        for (const edge of ["top", "right", "bottom", "left"]) root.style.setProperty(`--device-safe-${edge}`, "0px");
        window.dispatchEvent(new Event("resize"));
      });
      await expect(page.locator(".app-shell")).toHaveCSS("padding-top", "0px");
      await expect(page.locator(".app-shell")).toHaveCSS("padding-bottom", "0px");
    } finally { await browser.close(); }
  });
}
