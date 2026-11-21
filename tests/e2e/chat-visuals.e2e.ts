import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { frames, position, settleScroll } from "./chat-shell-helpers";
import { workspacePath } from "./config";
import { expect, test } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";

const browserTest = withEngineBrowsers(test);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1100" viewBox="0 0 600 1100"><rect width="600" height="1100" fill="white"/><rect x="40" y="40" width="520" height="180" rx="16" fill="#eee" stroke="#888"/><text x="300" y="140" text-anchor="middle" font-size="28" fill="#111">Agent result &amp; review</text><path d="M300 240V330M285 315L300 330L315 315" stroke="#555" fill="none" stroke-width="4"/><rect x="40" y="360" width="520" height="680" rx="16" fill="#f5f5f5" stroke="#888"/><text x="300" y="700" text-anchor="middle" font-size="28" fill="#111">Readable inline</text></svg>\n';

async function control(request: APIRequestContext, data: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function boot(page: Page, request: APIRequestContext): Promise<string> {
  await request.post("/__e2e/reset");
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") {
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-surface")).toBeVisible();
  } else await openChatPanel(page);
  const select = page.locator("#chat-conversation-select");
  const previous = await select.inputValue();
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(select).not.toHaveValue(previous);
  return select.inputValue();
}

async function publish(request: APIRequestContext, conversationId: string, id: string, markdown: string, completed = false): Promise<void> {
  await control(request, { action: "item", conversationId, item: { id, type: "assistant_message", createdAt: Date.now(), markdown, ...(completed ? { completedAt: Date.now() } : {}) } });
}

test.describe("agent inline visuals", () => {
  for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
    test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.name === "mobile", isMobile: viewport.name === "mobile" });
    test(`${viewport.name}: SVG streams inline, preserves source, and enlarges`, async ({ page, request }, testInfo) => {
      const conversationId = await boot(page, request);
      await control(request, { action: "status", conversationId, status: "running" });
      const id = `svg-${viewport.name}-${randomUUID()}`;
      await publish(request, conversationId, id, "Here is the architecture.\n\n```svg\n" + SVG);
      const visual = page.locator("#chat-items .chat-visual");
      await expect(visual).toContainText("Generating image…");
      await expect(visual.locator("img")).toHaveCount(0);
       // A possible closing fence at EOF can still become a label line.
       // Terminate it before expecting a streaming capture.
       const markdown = `Here is the architecture.\n\n\`\`\`svg\n${SVG}\`\`\`\n`;
      await publish(request, conversationId, id, markdown);
      const image = visual.locator("img");
      await expect(image).toHaveCount(1);
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(600);
      const size = await image.boundingBox();
      const content = await page.locator("#chat-items .chat-assistant-content").boundingBox();
      expect(size!.width).toBeLessThanOrEqual(content!.width + 1);
      expect(size!.height / size!.width).toBeCloseTo(1100 / 600, 1);
      await visual.getByRole("button", { name: "Source", exact: true }).click();
      await expect(visual.locator(".chat-visual-source code")).toHaveText(SVG);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await visual.getByRole("button", { name: "Copy source", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SVG);
      // Text deltas must not replace the inspected, already-captured image.
      await publish(request, conversationId, id, markdown + "\n\nPlease review the result.");
      await expect(visual.locator(".chat-visual-source")).toBeVisible();
      await visual.getByRole("button", { name: "Preview", exact: true }).click();
      await image.click();
      await expect(page.locator("#chat-image-viewer")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#chat-image-viewer")).not.toBeVisible();
      await visual.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-inline-svg.png`) });
    });
    test(`${viewport.name}: viewBox-only SVG has visible inline and enlarged dimensions`, async ({ page, request }) => {
      const conversationId = await boot(page, request);
      // Agents commonly omit width/height. Intrinsic decoding alone does not
      // catch a shrink-to-fit wrapper collapsing this valid image to 0 × 0.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 430"><rect width="800" height="430" fill="white"/><text x="40" y="80" font-size="32">How curl works</text></svg>';
      await publish(request, conversationId, `viewbox-only-${viewport.name}`, `\`\`\`svg\n${svg}\n\`\`\``, true);
      const image = page.locator("#chat-items .chat-visual img");
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      const inline = await image.evaluate(element => {
        const { width, height } = element.getBoundingClientRect(); return { width, height };
      });
      expect(inline.width).toBeGreaterThan(0);
      expect(inline.height).toBeGreaterThan(0);
      expect(inline.width / inline.height).toBeCloseTo(800 / 430, 1);
      const content = await page.locator("#chat-items .chat-assistant-content").boundingBox();
      expect(inline.width).toBeLessThanOrEqual(content!.width + 1);
      await image.click();
      const enlarged = page.locator("#chat-image-viewer img");
      await expect.poll(() => enlarged.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      const size = await enlarged.boundingBox();
      expect(size!.width).toBeGreaterThanOrEqual(Math.min(inline.width, viewport.width * 0.9) - 1);
      expect(size!.width / size!.height).toBeCloseTo(800 / 430, 1);
      await page.keyboard.press("Escape");
    });
    test(`${viewport.name}: delayed image decoding and streaming preserve an earlier reading anchor until Latest is requested`, async ({ page, request }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const conversationId = await boot(page, request);
      const imageId = `above-reader-${randomUUID()}`;
      await fs.writeFile(workspacePath("delayed.svg"), SVG);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route(/\/api\/chat\/visuals\/[0-9a-f]{64}$/, async route => {
        await gate;
        await route.continue();
      });
      try {
        await control(request, { action: "status", conversationId, status: "running" });
        const requested = page.waitForRequest(request => /\/api\/chat\/visuals\/[0-9a-f]{64}$/.test(new URL(request.url()).pathname));
        const markdown = "![Delayed diagram](./delayed.svg)";
        await publish(request, conversationId, imageId, markdown);
        await requested;
        // Distant-body layout skipping would otherwise defer the height
        // change. Keep this row laid out to exercise the reading contract.
        await page.locator(`[data-chat-item-id="${imageId}"]`).evaluate(element => { element.style.contentVisibility = "visible"; });
        for (let i = 0; i < 20; i++) await publish(request, conversationId, `reading-${i}`,
          `Earlier message ${i}\n\n${"A deterministic line of transcript context. ".repeat(12)}`);
        const timeline = page.locator("#chat-timeline");
        await expect(page.locator('[data-chat-item-id="reading-19"]')).toBeAttached();
        await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
        if (viewport.name === "mobile") {
          // Enter the reading surface with native input before synthesizing
          // the swipe. Synthetic events alone cannot dismiss composer focus.
          await timeline.tap();
          await expect(page.locator("#chat-input")).not.toBeFocused();
          await frames(page);
          await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
        }
        const image = page.locator(`[data-chat-item-id="${imageId}"] img`).first();
        expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(0);
        // Use the same deterministic input-intent pattern as the existing
        // coordinated-follow tests; touch movement is synthesized, not a device swipe.
        await timeline.evaluate(el => {
          let lastTouch: Touch | undefined;
          if (navigator.maxTouchPoints) {
            const rect = el.getBoundingClientRect();
            for (const [name, offset] of [["touchstart", 0], ["touchmove", 4]] as const) {
              lastTouch = new Touch({ identifier: 1, target: el,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 + offset });
              el.dispatchEvent(new TouchEvent(name, { bubbles: true, cancelable: true,
                touches: [lastTouch], targetTouches: [lastTouch], changedTouches: [lastTouch] }));
            }
          } else el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -4 }));
          const row = el.querySelector<HTMLElement>('[data-chat-item-id="reading-8"]')!;
          el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 60;
          if (lastTouch) el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true,
            touches: [], targetTouches: [], changedTouches: [lastTouch] }));
        });
        await settleScroll(timeline); await frames(page);
        const anchorOffset = () => timeline.evaluate(el => el.querySelector('[data-chat-item-id="reading-8"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top);
        const offset = await anchorOffset();
        const beforeDecode = await position(timeline);
        const beforeExtent = await timeline.evaluate(element => element.scrollHeight);
        const stableAnchor = async () => {
          await frames(page);
          await expect.poll(async () => Math.abs(await anchorOffset() - offset)).toBeLessThan(2);
          expect((await position(timeline)).bottom).toBeGreaterThan(100);
        };
        release();
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(600);
        await stableAnchor();
        expect(await timeline.evaluate(element => element.scrollHeight) - beforeExtent).toBeGreaterThan(100);
        expect((await position(timeline)).top - beforeDecode.top).toBeGreaterThan(100);
        await publish(request, conversationId, imageId, `${markdown}\n\n\`\`\`svg\n${SVG}`);
        await expect(page.locator(`[data-chat-item-id="${imageId}"]`)).toContainText("Generating image…");
        await stableAnchor();
        await publish(request, conversationId, imageId, `${markdown}\n\n\`\`\`svg\n${SVG}\`\`\`\n`);
        const streamed = page.locator(`[data-chat-item-id="${imageId}"] img`).nth(1);
        // An offscreen lazy image need not load. Request its actual decode
        // explicitly so this phase tests intrinsic layout rather than timing.
        await streamed.evaluate((element: HTMLImageElement) => { element.loading = "eager"; });
        await expect.poll(() => streamed.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(600);
        await stableAnchor();
        await publish(request, conversationId, "reading-19", "New output arrives below the earlier reading position.");
        await expect(page.locator('[data-chat-item-id="reading-19"]')).toContainText("New output arrives");
        await stableAnchor();
        await expect(page.locator("#chat-latest")).toBeVisible();
        if (viewport.name === "mobile") await page.locator("#chat-latest").tap();
        else await page.locator("#chat-latest").click();
        await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
        await publish(request, conversationId, "after-latest", "Following resumes only after the explicit Latest action.");
        await expect(page.locator('[data-chat-item-id="after-latest"]')).toBeAttached();
        await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
        expect(errors).toEqual([]);
      } finally { release(); }
    });
    });
  }

  test("SVG comments preserve the real root, decoded preview and exact source", async ({ page, request }) => {
    const conversationId = await boot(page, request);
    const source = '<!-- <svg xmlns="http://evil.test"/> --><svg viewBox="0 0 260 80"><text x="10" y="40">A<!--comment-->B</text></svg><!--after-->\n';
    await publish(request, conversationId, "commented-svg", `\`\`\`svg\n${source}\`\`\``, true);
    const visual = page.locator('[data-chat-item-id="commented-svg"] .chat-visual');
    const image = visual.locator("img");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const preview = await page.request.get((await image.getAttribute("src"))!);
    expect(preview.ok()).toBe(true);
    expect(await preview.text()).toBe(source.replace('<svg viewBox=', '<svg xmlns="http://www.w3.org/2000/svg" viewBox='));
    await visual.getByRole("button", { name: "Source", exact: true }).click();
    await expect(visual.locator(".chat-visual-source code")).toHaveText(source);
  });
  test("PNG/JPEG/local SVG snapshots survive source changes and reload; external embeds never request", async ({ page, request }) => {
    const conversationId = await boot(page, request);
    const files = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext("2d")!; context.fillStyle = "#f5f5f5"; context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#111"; context.font = "28px sans-serif"; context.fillText("Screenshot ready for review", 40, 180);
      return { png: canvas.toDataURL("image/png").split(",")[1]!, jpeg: canvas.toDataURL("image/jpeg").split(",")[1]! };
    });
    await fs.mkdir(workspacePath("images"), { recursive: true });
    await fs.writeFile(workspacePath("images", "result.png"), Buffer.from(files.png, "base64"));
    await fs.writeFile(workspacePath("images", "result.jpg"), Buffer.from(files.jpeg, "base64"));
    await fs.writeFile(workspacePath("images", "diagram.svg"), SVG);
    const externalRequests: string[] = [];
    page.on("request", req => { if (req.url().includes("external-image.invalid")) externalRequests.push(req.url()); });
    const markdown = '![PNG](images/result.png)\n\n![JPEG](images/result.jpg)\n\n![Diagram](images/diagram.svg)\n\n![Remote](https://external-image.invalid/track.svg)\n\n<pre><img src="https://external-image.invalid/pre.png"></pre>';
    await publish(request, conversationId, "local-formats", markdown, true);
    const images = page.locator("#chat-items .chat-visual img");
    await expect(images).toHaveCount(3);
    await expect.poll(() => images.evaluateAll(elements => elements.every(element => (element as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const sources = await images.evaluateAll(elements => elements.map(element => element.getAttribute("src")));
    await fs.writeFile(workspacePath("images", "result.png"), "overwritten");
    await fs.unlink(workspacePath("images", "result.jpg"));
    await fs.writeFile(workspacePath("images", "diagram.svg"), "<svg>changed</svg>");
    await page.reload(); await openChatPanel(page);
    await expect(images).toHaveCount(3);
    await expect.poll(() => images.evaluateAll(elements => elements.every(element => (element as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await images.evaluateAll(elements => elements.map(element => element.getAttribute("src")))).toEqual(sources);
    const svg = page.locator("#chat-items .chat-visual.is-svg").filter({ has: page.locator("img") });
    await svg.getByRole("button", { name: "Source", exact: true }).click();
    await expect(svg.locator(".chat-visual-source code")).toHaveText(SVG);
    expect(externalRequests).toEqual([]);
    await expect(page.locator('#chat-items a[href="https://external-image.invalid/track.svg"]')).toBeVisible();
  });

  test("missing local files retry at completion and invalid SVG stays copyable", async ({ page, request }) => {
    const conversationId = await boot(page, request);
    const lateId = `late-image-${randomUUID()}`;
    await control(request, { action: "status", conversationId, status: "running" });
    await publish(request, conversationId, lateId, "![Late](late.svg)");
    await expect(page.locator("#chat-items .chat-visual")).toContainText(/prepar|not found|missing/i);
    await fs.writeFile(workspacePath("late.svg"), SVG);
    await control(request, { action: "status", conversationId, status: "idle" });
    await expect(page.locator("#chat-items .chat-visual img")).toHaveCount(1);
    const unsafe = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n';
    await publish(request, conversationId, "unsafe-svg", `\`\`\`svg\n${unsafe}\`\`\``, true);
    const refused = page.locator('[data-chat-item-id="unsafe-svg"] .chat-visual');
    await expect(refused.locator("img")).toHaveCount(0);
    await refused.getByRole("button", { name: "Source", exact: true }).click();
    await expect(refused.locator(".chat-visual-source code")).toHaveText(unsafe);
    await expect(page.locator("#chat-items script")).toHaveCount(0);
    await fs.writeFile(workspacePath("unsafe-local.svg"), unsafe);
    await publish(request, conversationId, "unsafe-file", "![Unsafe local SVG](unsafe-local.svg)", true);
    const refusedFile = page.locator('[data-chat-item-id="unsafe-file"] .chat-visual');
    await expect(refusedFile.locator("img")).toHaveCount(0);
    await refusedFile.getByRole("button", { name: "Source", exact: true }).click();
    await expect(refusedFile.locator(".chat-visual-source code")).toHaveText(unsafe);
    await fs.unlink(workspacePath("unsafe-local.svg"));
    await page.reload(); await openChatPanel(page);
    await refusedFile.getByRole("button", { name: "Source", exact: true }).click();
    await expect(refusedFile.locator(".chat-visual-source code")).toHaveText(unsafe);
  });

  test("late Markdown reference definitions keep already displayed snapshots unchanged", async ({ page, request }) => {
    const conversationId = await boot(page, request);
    await fs.writeFile(workspacePath("a.svg"), SVG.replace("Readable inline", "First image"));
    await fs.writeFile(workspacePath("b.svg"), SVG);
    await control(request, { action: "status", conversationId, status: "running" });
    await publish(request, conversationId, "reference-style", "![First][ref]\n\n![Second](b.svg)");
    const image = page.locator('#chat-items img[alt="Second"]');
    await expect(image).toHaveCount(1);
    const originalUrl = await image.getAttribute("src");
    await fs.writeFile(workspacePath("b.svg"), SVG.replace("Readable inline", "Changed source"));
    await control(request, { action: "delta", conversationId, itemId: "reference-style", delta: "\n\n[ref]: a.svg" });
    // A reference destination at the end of a live definition is provisional:
    // the next token could still extend its filename. Terminate the line before
    // expecting capture, without changing the already captured second image.
    await expect(page.locator("#chat-items .chat-visual-reference")).toContainText(["a.svg"]);
    await expect(page.locator("#chat-items .chat-visual img")).toHaveCount(1);
    await expect(image).toHaveAttribute("src", originalUrl!);
    await control(request, { action: "delta", conversationId, itemId: "reference-style", delta: "\n" });
    await expect(page.locator("#chat-items .chat-visual img")).toHaveCount(2);
    await expect(image).toHaveAttribute("src", originalUrl!);
    const second = page.locator("#chat-items .chat-visual").filter({ has: page.locator('img[alt="Second"]') });
    await second.getByRole("button", { name: "Source", exact: true }).click();
    await expect(second.locator(".chat-visual-source code")).toHaveText(SVG);
  });

  for (const raster of [
    { extension: "png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { extension: "jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  ]) test(`undecodable ${raster.extension} preserves its reference and immutable bytes without breaking the reply`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const conversationId = await boot(page, request);
    const reference = `./broken.${raster.extension}`;
    await fs.writeFile(workspacePath(reference), raster.bytes);
    await control(request, { action: "status", conversationId, status: "running" });
    const previewResponse = page.waitForResponse(response => /\/api\/chat\/visuals\/[0-9a-f]{64}$/.test(new URL(response.url()).pathname));
    const markdown = `Before the image.\n\n![Broken screenshot](${reference})\n\nThe rest of the reply remains readable.`;
    await publish(request, conversationId, "broken-raster", markdown);
    const response = await previewResponse;
    expect(response.status()).toBe(200);
    expect(await response.body()).toEqual(raster.bytes);
    const visual = page.locator('[data-chat-item-id="broken-raster"] .chat-visual');
    await expect(visual.locator(".chat-visual-fallback")).toContainText("Could not display Broken screenshot.");
    await expect(visual.locator(".chat-visual-reference")).toHaveText(reference);
    await expect(visual.locator(".chat-visual-enlarge")).toHaveCount(0);
    await expect(page.locator('[data-chat-item-id="broken-raster"]')).toContainText("The rest of the reply remains readable.");
    // Browser failure is presentation-only: even changing the original into
    // another image must not replace this occurrence's captured bytes.
    await fs.writeFile(workspacePath(reference), SVG);
    await publish(request, conversationId, "broken-raster", markdown + "\n\nStreaming continues after decoding fails.", true);
    await expect(visual.locator(".chat-visual-reference")).toHaveText(reference);
    await expect(page.locator('[data-chat-item-id="broken-raster"]')).toContainText("Streaming continues after decoding fails.");
    const stored = await page.request.get(response.url());
    expect(stored.ok()).toBe(true);
    expect(await stored.body()).toEqual(raster.bytes);
    await page.reload(); await openChatPanel(page);
    await expect(visual.locator(".chat-visual-reference")).toHaveText(reference);
    expect(await page.request.get(response.url()).then(result => result.body())).toEqual(raster.bytes);
    expect(errors).toEqual([]);
  });

  for (const status of [404, 503]) test(`HTTP ${status} preview failure retains the local SVG reference and copyable captured source`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const conversationId = await boot(page, request);
    await fs.writeFile(workspacePath("unavailable.svg"), SVG);
    let previewRequests = 0;
    await page.route(/\/api\/chat\/visuals\/[0-9a-f]{64}$/, async route => {
      previewRequests++;
      await route.fulfill({ status, contentType: "text/plain", body: "Preview unavailable" });
    });
    const markdown = "![Retained diagram](./unavailable.svg)\n\nContinue reading the explanation.";
    await publish(request, conversationId, "unavailable-svg", markdown);
    const visual = page.locator('[data-chat-item-id="unavailable-svg"] .chat-visual');
    await expect(visual.locator(".chat-visual-fallback")).toContainText("Could not display Retained diagram.");
    await expect(visual.locator(".chat-visual-reference")).toHaveText("./unavailable.svg");
    await expect(visual.locator(".chat-visual-enlarge")).toHaveCount(0);
    await fs.unlink(workspacePath("unavailable.svg"));
    await visual.getByRole("button", { name: "Source", exact: true }).click();
    await expect(visual.locator(".chat-visual-source code")).toHaveText(SVG);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await visual.getByRole("button", { name: "Copy source", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SVG);
    await publish(request, conversationId, "unavailable-svg", markdown + "\n\nThe reply continues after a failed preview.", true);
    await expect(visual.locator(".chat-visual-source")).toBeVisible();
    await expect(visual.locator(".chat-visual-source code")).toHaveText(SVG);
    await visual.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(visual.locator(".chat-visual-fallback")).toBeVisible();
    await expect(page.locator('[data-chat-item-id="unavailable-svg"]')).toContainText("The reply continues after a failed preview.");
    expect(previewRequests).toBe(1);
    await page.reload(); await openChatPanel(page);
    await expect(visual.locator(".chat-visual-reference")).toHaveText("./unavailable.svg");
    await visual.getByRole("button", { name: "Source", exact: true }).click();
    await expect(visual.locator(".chat-visual-source code")).toHaveText(SVG);
    expect(errors).toEqual([]);
  });
});

// Diagnostic comparison only; the full retention tests below remain authoritative.
for (const mobile of [false, true]) browserTest(`webkit ${mobile ? "mobile" : "desktop"}: Option+Tab Source focus precondition probe`, async ({ launchBrowser, request, baseURL }, testInfo) => {
  const browser = await launchBrowser("webkit");
  const page = await browser.newPage({ baseURL, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile, isMobile: mobile });
  const route = "Alt+Tab";
  let count = 0;
  let phase = "setup";
  let outcome = "not-established";
  let evidenceErrors = 0;
  const snapshots: unknown[] = [];
  const snapshot = async () => {
    try {
      snapshots.push({ count, phase, ...await page.evaluate(() => {
        const identify = (element: Element | null) => element ? {
          tag: element.tagName.toLowerCase(),
          id: ["chat-input", "chat-conversation-select", "chat-timeline", "chat-latest", "chat-items"].includes(element.id) ? element.id : null,
          control: element.matches('[data-visual-tab="source"]') ? "source"
            : element.matches('[data-visual-tab="preview"]') ? "preview"
            : element.matches("[data-visual-copy]") ? "copy" : null,
        } : null;
        const state = (selector: string) => {
          const element = document.querySelector<HTMLElement>(`[data-chat-item-id="growing-focused-svg"] .chat-visual ${selector}`);
          if (!element) return { connected: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            ...identify(element), connected: element.isConnected,
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && !element.closest("[hidden]"),
            disabled: element.matches(":disabled"), ariaDisabled: element.getAttribute("aria-disabled") === "true",
            tabIndex: element.tabIndex, inert: !!element.closest("[inert]"), focused: element === document.activeElement,
          };
        };
        return { active: identify(document.activeElement), documentFocused: document.hasFocus(), source: state('[data-visual-tab="source"]'), copy: state("[data-visual-copy]") };
      }) });
    } catch { evidenceErrors++; }
  };
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Reflect.set(window, "__visualCopiedText", text); } } });
    });
    const conversationId = await boot(page, request);
    await control(request, { action: "status", conversationId, status: "running" });
    const id = "growing-focused-svg";
    const prefix = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">\r\n<text x="10" y="40">Exact &amp;';
    await publish(request, conversationId, id, `\`\`\`svg\r\n${prefix}`);
    const sourceTab = page.locator(`[data-chat-item-id="${id}"] .chat-visual [data-visual-tab="source"]`);
    await sourceTab.click();
    phase = "traversal";
    await snapshot();
    while (count < 40 && !await sourceTab.evaluate(element => element === document.activeElement)) {
      await page.keyboard.press(route);
      count++;
      await snapshot();
    }
    phase = "assertion";
    await expect(sourceTab).toBeFocused();
    outcome = "focused";
    phase = "complete";
  } finally {
    await snapshot();
    try {
      await testInfo.attach("option-tab-source-precondition", {
        body: Buffer.from(JSON.stringify({ engine: "webkit", mobile, route, count, budget: 40, phase, outcome, evidenceErrors, snapshots }, null, 2)),
        contentType: "application/json",
      });
    } catch { /* Diagnostic attachment failures must not replace the verdict. */ }
    await browser.close();
  }
});

for (const engine of ["chromium", "webkit"] as const) {
  for (const mobile of [false, true]) browserTest(`${engine} ${mobile ? "mobile" : "desktop"}: growing SVG retains Source and logical keyboard focus through capture`, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile, isMobile: mobile });
    let releaseSource!: () => void;
    const focusRoute = engine === "webkit" ? "Alt+Tab" : "Tab";
    const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
    let focusEvidenceErrors = 0;
    try {
      // Observe the exact clipboard payload without platform-specific clipboard
      // permissions. Real controls and their activation path remain unchanged.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Reflect.set(window, "__visualCopiedText", text); } } });
      });
      const conversationId = await boot(page, request);
      await control(request, { action: "status", conversationId, status: "running" });
      const id = "growing-focused-svg";
      const prefix = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">\r\n<text x="10" y="40">Exact &amp;';
      let source = prefix;
      let markdown = `\`\`\`svg\r\n${source}`;
      await publish(request, conversationId, id, markdown);
      const visual = page.locator(`[data-chat-item-id="${id}"] .chat-visual`);
      const sourceTab = visual.locator('[data-visual-tab="source"]');
      const copy = visual.locator("[data-visual-copy]");
      const code = visual.locator(".chat-visual-source code");
      // Diagnostic only: observe public DOM and native events without changing
      // focus, key defaults, traversal budgets, or the assertions below.
      try {
        await page.evaluate(() => {
          const records: unknown[] = [];
          const nodes = new WeakMap<Element, number>();
          let nextNode = 0;
          let dropped = 0;
          let recordingErrors = 0;
          let step = "installed";
          const identify = (element: EventTarget | null) => {
            if (!(element instanceof Element)) return null;
            if (!nodes.has(element)) nodes.set(element, ++nextNode);
            return {
              node: nodes.get(element), tag: element.tagName.toLowerCase(),
              // No text, values, arbitrary attributes, URLs, or transcript IDs.
              id: ["chat-input", "chat-conversation-select", "chat-timeline", "chat-latest", "chat-items"].includes(element.id) ? element.id : null,
              control: element.matches('[data-visual-tab="source"]') ? "source"
                : element.matches('[data-visual-tab="preview"]') ? "preview"
                : element.matches("[data-visual-copy]") ? "copy" : null,
            };
          };
          const targetState = (selector: string) => {
            const element = document.querySelector<HTMLElement>(`[data-chat-item-id="growing-focused-svg"] .chat-visual ${selector}`);
            if (!element) return { connected: false };
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              ...identify(element), connected: element.isConnected,
              visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && !element.closest("[hidden]"),
              disabled: element.matches(":disabled"), ariaDisabled: element.getAttribute("aria-disabled") === "true",
              tabIndex: element.tabIndex, inert: !!element.closest("[inert]"),
            };
          };
          const record = (kind: string, event?: Event) => {
            try {
              if (records.length >= 512) { dropped++; return; }
              records.push({
                sequence: records.length, ms: performance.now(), step, kind,
                trusted: event?.isTrusted, eventTarget: identify(event?.target ?? null),
                relatedTarget: event instanceof FocusEvent ? identify(event.relatedTarget) : null,
                defaultPrevented: event?.defaultPrevented,
                key: event instanceof KeyboardEvent ? "Tab" : undefined,
                alt: event instanceof KeyboardEvent ? event.altKey : undefined,
                shift: event instanceof KeyboardEvent ? event.shiftKey : undefined,
                active: identify(document.activeElement), documentFocused: document.hasFocus(),
                source: targetState('[data-visual-tab="source"]'), copy: targetState("[data-visual-copy]"),
              });
            } catch { recordingErrors++; }
          };
          const keydown = (event: KeyboardEvent) => { if (event.key === "Tab") record("keydown", event); };
          const focusin = (event: FocusEvent) => record("focusin", event);
          document.addEventListener("keydown", keydown, true);
          document.addEventListener("focusin", focusin, true);
          Reflect.set(window, "__nativeVisualFocusEvidence", {
            snapshot(label: string) { step = label; record("snapshot"); },
            finish() {
              record("finish");
              document.removeEventListener("keydown", keydown, true);
              document.removeEventListener("focusin", focusin, true);
              Reflect.deleteProperty(window, "__nativeVisualFocusEvidence");
              return { records, dropped, recordingErrors };
            },
          });
        });
      } catch { focusEvidenceErrors++; }
      let focusAttempt = 0;
      const focusSnapshot = async (label: string) => {
        try { await page.evaluate(label => Reflect.get(window, "__nativeVisualFocusEvidence")?.snapshot(label), label); }
        catch { focusEvidenceErrors++; }
      };
      // Safari may not focus buttons on pointer activation. The native Option+Tab
      // comparison establishes its full-control route here; Chromium keeps Tab.
      // Never use locator.focus(), forced clicks or scripted focus.
      const focusByTab = async (selector: "source" | "copy") => {
        const button = selector === "source" ? sourceTab : copy;
        const attempt = ++focusAttempt;
        await focusSnapshot(`${attempt}:${selector}:start`);
        for (let i = 0; i < 40 && !await button.evaluate(element => element === document.activeElement); i++) {
          await focusSnapshot(`${attempt}:${selector}:${focusRoute}-${i + 1}:before`);
          await page.keyboard.press(focusRoute);
          await focusSnapshot(`${attempt}:${selector}:${focusRoute}-${i + 1}:after`);
        }
        await focusSnapshot(`${attempt}:${selector}:assert`);
        await expect(button).toBeFocused();
      };
      await sourceTab.click();
      await focusByTab("source");
      await expect(visual.locator(".chat-visual-source")).toBeVisible();
      expect(await code.textContent()).toBe(source);
      const append = async (delta: string) => {
        source += delta; markdown += delta;
        await control(request, { action: "delta", conversationId, itemId: id, delta });
        await expect.poll(() => code.textContent()).toBe(source);
        await expect(visual.locator(".chat-visual-source")).toBeVisible();
        await expect(sourceTab).toHaveAttribute("aria-pressed", "true");
      };
      await append(" growing &lt;source&gt;");
      await expect(sourceTab).toBeFocused();
      await copy.click();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "__visualCopiedText"))).toBe(source);
      await focusByTab("copy");
      await append("</text>\r\n");
      await expect(copy).toBeFocused();
      await copy.click();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "__visualCopiedText"))).toBe(source);
      await focusByTab("copy");
      await expect(visual.locator("img, svg, code.hljs")).toHaveCount(0);
      await page.route(/\/api\/chat\/visuals\/[0-9a-f]{64}\/source$/, async route => { await sourceGate; await route.continue(); });
      source += "</svg>\r\n";
      markdown += "</svg>\r\n```\r\n";
      await control(request, { action: "delta", conversationId, itemId: id, delta: "</svg>\r\n```\r\n" });
      await expect(visual).toHaveAttribute("data-visual-key", /^[a-f0-9]{64}$/);
      await expect(copy).toBeFocused();
      await expect(visual.locator(".chat-visual-source")).toBeVisible();
      await expect(copy).toHaveAttribute("aria-disabled", "true");
      releaseSource();
      await expect.poll(() => code.textContent()).toBe(source);
      await expect(copy).not.toHaveAttribute("aria-disabled", "true");
      await expect(copy).toBeFocused();
      await copy.click();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "__visualCopiedText"))).toBe(source);
      const image = visual.locator("img");
      const captured = await visual.getAttribute("data-visual-key");
      await image.evaluate(element => { element.setAttribute("data-regression-retained", "true"); });
      // Native text completion must not reopen Preview or autofocus a control
      // after the reader has deliberately returned to the composer.
      await page.locator("#chat-input").click();
      await publish(request, conversationId, id, markdown, true);
      await expect(page.locator(`[data-chat-item-id="${id}"]`)).toHaveAttribute("data-complete", "true");
      await expect(visual.locator(".chat-visual-source")).toBeVisible();
      await expect(page.locator("#chat-input")).toBeFocused();
      await expect(visual).toHaveAttribute("data-visual-key", captured!);
      await expect(image).toHaveCount(1);
      await expect(image).toHaveAttribute("data-regression-retained", "true");
      expect(await code.textContent()).toBe(source);
    } finally {
      releaseSource();
      // Best-effort evidence and listener cleanup must not replace a test failure.
      try {
        let trace: unknown = { unavailable: true };
        try { trace = await page.evaluate(() => Reflect.get(window, "__nativeVisualFocusEvidence")?.finish() ?? { unavailable: true }); }
        catch { focusEvidenceErrors++; }
        await testInfo.attach("native-visual-focus", {
          body: Buffer.from(JSON.stringify({ engine, mobile, focusRoute, focusEvidenceErrors, trace }, null, 2)),
          contentType: "application/json",
        });
      } catch { /* Diagnostic failures are never functional verdicts. */ }
      await browser.close();
    }
  });

  browserTest(`${engine}: streaming keeps keyboard focus on retained visual controls`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL });
    try {
      const conversationId = await boot(page, request);
      await control(request, { action: "status", conversationId, status: "running" });
      const markdown = `\`\`\`svg\n${SVG}\`\`\`\n`;
      await publish(request, conversationId, "focused-visual", markdown);
      const row = page.locator('[data-chat-item-id="focused-visual"]');
      const visual = row.locator(".chat-visual");
      await expect(visual.locator("img")).toHaveCount(1);
      await visual.getByRole("button", { name: "Source", exact: true }).click();
      await expect(visual.locator("[data-visual-copy]")).toBeEnabled();
      await visual.getByRole("button", { name: "Preview", exact: true }).click();
      for (const [index, selector] of ["[data-visual-tab=source]", "[data-visual-copy]", ".chat-visual-enlarge"].entries()) {
        const button = visual.locator(selector);
        await button.focus();
        await expect(button).toBeFocused();
        await publish(request, conversationId, "focused-visual", `${markdown}\n\nUpdate ${index}`);
        await expect(row).toContainText(`Update ${index}`);
        await expect(button).toBeFocused();
      }
      await visual.getByRole("button", { name: "Source", exact: true }).click();
      await expect(visual.locator(".chat-visual-source code")).toHaveText(SVG);
    } finally { await browser.close(); }
  });
  browserTest(`${engine}: first copy works after SVG source outlasts activation`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL });
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    try {
      const conversationId = await boot(page, request);
      await page.route(/\/api\/chat\/visuals\/[0-9a-f]{64}\/source$/, async route => {
        await responseReady;
        await route.continue();
      });
      await publish(request, conversationId, "slow-svg-source", `\`\`\`svg\n${SVG}\`\`\``);
      const visual = page.locator('[data-chat-item-id="slow-svg-source"] .chat-visual');
      const copy = visual.getByRole("button", { name: "Copy source", exact: true });
      await expect(copy).toBeDisabled();
      await visual.getByRole("button", { name: "Source", exact: true }).click();
      // Deliberately outlast transient activation from opening Source.
      await page.waitForTimeout(6_000);
      await expect(copy).toBeDisabled();
      release();
      await expect(copy).toBeEnabled();
      await copy.click();
      await expect(visual.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    } finally { release(); await browser.close(); }
  });
  browserTest(`${engine}: deferred Agent reports retain visible SVG code, copy, and inert image references`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL });
    try {
      const conversationId = await boot(page, request);
      const imageRequests: string[] = [];
      page.on("request", req => {
        if (/external-image\.invalid|\/api\/chat\/visuals\/|\/agent-report\.svg/.test(req.url())) imageRequests.push(req.url());
      });
      await control(request, { action: "item", conversationId, item: {
        id: "deferred-visual-report", type: "tool", name: "Agent", status: "completed", createdAt: Date.now(),
        input: JSON.stringify({ description: "Draw a diagram", subagent_type: "Explore", prompt: "Show the result." }),
        output: `\`\`\`svg\n${SVG}\`\`\`\n\n![Local](./agent-report.svg)\n\n![Remote](https://external-image.invalid/report.svg)\n\n<img src="https://external-image.invalid/report-raw.png" alt="Raw">`,
      } });
      const row = page.locator('[data-chat-item-id="deferred-visual-report"]');
      await expect(row).toHaveAttribute("data-chat-lazy", "");
      await expect(row.locator(".chat-visual")).toHaveCount(0);
      await row.locator("summary").first().click();
      const report = row.locator(".chat-subagent-result");
      await expect(report.locator("pre > code.hljs.language-svg")).toBeVisible();
      expect(await report.locator("pre > code").textContent()).toBe(SVG);
      await expect(row.locator(".chat-visual, img, svg, [data-visual-tab]")).toHaveCount(0);
      await expect(report.locator(".chat-visual-reference")).toHaveText("./agent-report.svg");
      await expect(report.locator('a[href="https://external-image.invalid/report.svg"]')).toBeVisible();
      await expect(report.locator('a[href="https://external-image.invalid/report-raw.png"]')).toBeVisible();
      await report.getByRole("button", { name: "Copy code to clipboard", exact: true }).click();
      await expect(report.locator("pre > .code-copy")).toHaveText("Copied!");
      expect(imageRequests).toEqual([]);
    } finally { await browser.close(); }
  });
  for (const focused of [true, false]) browserTest(`${engine}: touch Latest ${focused ? "keeps the focused composer" : "works without composer focus"} and resumes following`, async ({ launchBrowser, request, baseURL }) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const conversationId = await boot(page, request);
      for (let i = 0; i < 14; i++) await publish(request, conversationId, `focus-history-${i}`,
        `Message ${i}\n\n${"Earlier context remains readable. ".repeat(12)}`);
      const timeline = page.locator("#chat-timeline");
      await expect(page.locator('[data-chat-item-id="focus-history-13"]')).toBeAttached();
      await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
      const input = page.locator("#chat-input");
      await input.fill("Keep this draft while jumping to Latest.");
      await expect(input).toBeFocused();
      if (focused) await expect(page.locator(".touch-tab-bar")).toBeHidden();
      else {
        await timeline.tap();
        await expect(input).not.toBeFocused();
        await expect(page.locator(".touch-tab-bar")).toBeVisible();
        await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
      }
      await timeline.evaluate(element => { element.scrollTop -= 700; });
      await settleScroll(timeline);
      const readingTop = (await position(timeline)).top;
      await publish(request, conversationId, "focused-tail", "New output while the composer remains focused.");
      await expect(page.locator('[data-chat-item-id="focused-tail"]')).toBeAttached();
      await frames(page);
      expect(Math.abs((await position(timeline)).top - readingTop)).toBeLessThan(2);
      if (focused) await expect(input).toBeFocused();
      else await expect(input).not.toBeFocused();
      const latest = page.locator("#chat-latest");
      await expect(latest).toBeVisible();
      await latest.tap();
      await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
      if (focused) await expect(input).toBeFocused();
      else await expect(input).not.toBeFocused();
      await expect(input).toHaveValue("Keep this draft while jumping to Latest.");
      if (focused) await expect(page.locator(".touch-tab-bar")).toBeHidden();
      else await expect(page.locator(".touch-tab-bar")).toBeVisible();
      await publish(request, conversationId, "focused-after-latest", "Output continues following after the touch action.");
      await expect(page.locator('[data-chat-item-id="focused-after-latest"]')).toBeAttached();
      await expect.poll(async () => (await position(timeline)).bottom).toBeLessThan(2);
      await input.press("End");
      await input.press("!");
      await expect(input).toHaveValue("Keep this draft while jumping to Latest.!");
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
