#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { CHAT_WORKLOAD_SIZES, chatWorkload, workloadBytes } from "../tests/fixtures/chat-performance";
import { measureProviderHistory } from "./bench-chat-providers";

// Build the normal SPA with production compilation/minification, using the
// existing deterministic e2e providers. Native-provider work is measured
// separately; these timings attribute the shared browser presentation only.
const output = path.resolve(process.env.UATU_CHAT_BENCH_OUTPUT ?? ".local/chat-benchmark");
await mkdir(output, { recursive: true });
const binary = path.join(output, "server");
for (const cmd of process.env.UATU_CHAT_BENCH_REUSE_BUILD ? [] : [
  ["bun", "build", "--compile", "--minify", "tests/e2e/server.ts", "--outfile", binary],
  ...(process.platform === "darwin" ? [["codesign", "--force", "--sign", "-", binary]] : []),
]) {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) throw new Error(`Benchmark build failed: ${cmd[0]}`);
}
const port = Number(process.env.UATU_CHAT_BENCH_PORT ?? 4379);
const baseURL = `http://127.0.0.1:${port}`;
const server = Bun.spawn([binary], { env: { ...process.env, NODE_ENV: "production", UATU_E2E_PORT: String(port), UATU_E2E_WORKSPACE: path.join(output, "workspace") }, stdout: "pipe", stderr: "inherit" });
const browser = await chromium.launch();
const profiles = [
  { name: "unthrottled", cpu: 1, latency: 0 },
  { name: "cpu4", cpu: 4, latency: 0 },
  { name: "network", cpu: 1, latency: 150 },
  { name: "combined", cpu: 4, latency: 150 },
];
const report = {
  revision: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  serverSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex"),
  browser: browser.version(), hardware: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory: os.totalmem() },
  viewport: { width: 390, height: 844 }, warmSamples: 30, downstreamMbps: 1.6,
  physicalDevice: "Not measured. Desktop Chromium emulates a touch viewport and CPU/network slowdown.",
  workloads: CHAT_WORKLOAD_SIZES.map(workloadBytes), results: [] as unknown[],
  providers: process.env.UATU_CHAT_BENCH_PROVIDER_RESULTS
    ? JSON.parse(await readFile(process.env.UATU_CHAT_BENCH_PROVIDER_RESULTS, "utf8")).providers
    : await measureProviderHistory(output),
};
if (process.env.UATU_CHAT_BENCH_RESUME) {
  const previous = JSON.parse(await readFile(path.join(output, "results.json"), "utf8"));
  report.results = previous.results;
  report.providers = previous.providers;
}
async function control(data: Record<string, unknown>) {
  const response = await fetch(`${baseURL}/__e2e/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error(`Control failed: ${response.status}`);
  return response.json() as Promise<any>;
}
async function painted(page: Page) {
  return page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
}
async function tab(page: Page, name: string) {
  await page.evaluate(name => {
    (globalThis as any).__chatTabDuration = null;
    document.querySelector<HTMLButtonElement>(`#touch-tab-${name}`)!.addEventListener("click", () => {
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const surface = document.querySelector<HTMLElement>("#chat-surface")!;
        if (name === "chat" && surface.getBoundingClientRect().height <= 0) throw new Error("Chat was not presented");
        (globalThis as any).__chatTabDuration = performance.now() - start;
      }));
    }, { once: true, capture: true });
  }, name);
  await page.locator(`#touch-tab-${name}`).click();
  await page.waitForFunction(() => (globalThis as any).__chatTabDuration !== null);
  return page.evaluate(() => (globalThis as any).__chatTabDuration as number);
}
async function work(page: Page) { return page.evaluate(() => structuredClone(globalThis.__uatuChatPerformance)); }
try {
  const ready = new TextDecoder();
  let announcement = "";
  for await (const chunk of server.stdout) {
    announcement += ready.decode(chunk);
    if (announcement.includes(baseURL)) break;
  }
  for (const agent of ["claude", "opencode"]) for (const count of CHAT_WORKLOAD_SIZES) for (const profile of profiles) {
    if (process.env.UATU_CHAT_BENCH_FILTER && !`${agent}-${count}-${profile.name}`.includes(process.env.UATU_CHAT_BENCH_FILTER)) continue;
    if (report.results.some((result: any) => result.agent === agent && result.count === count && result.profile.name === profile.name)) continue;
    if (process.env.UATU_CHAT_BENCH_SMOKE && (count !== 50 || profile.name !== "unthrottled")) continue;
    const context = await browser.newContext({ baseURL, viewport: report.viewport, hasTouch: true, isMobile: true, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(120_000);
    page.on("pageerror", error => console.error("Browser error:", error.message));
    await context.addInitScript(() => {
      globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
      const data = { longTasks: [] as number[], events: [] as number[] };
      (globalThis as any).__chatBrowserTiming = data;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) data.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) data.events.push(entry.duration); }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    await cdp.send("Network.enable");
    await fetch(`${baseURL}/__e2e/reset`, { method: "POST" });
    await control({ action: "agents", count: 2 });
    const snapshot = await control({ action: "seed", agent, title: "Performance fixture", items: chatWorkload(count), older: chatWorkload(50, "older", -50) });
    const token = await fetch(`${baseURL}/__e2e/terminal-token`).then(response => response.json()) as { token: string };
    // Use a real stored image, including decode/viewer work; missing-image
    // placeholders alone do not exercise attachment presentation.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upload = new FormData();
    upload.set("file", new Blob([png], { type: "image/png" }), "fixture.png");
    const storedResponse = await fetch(`${baseURL}/api/chat/conversations/${encodeURIComponent(snapshot.conversation.id)}/attachments?t=${encodeURIComponent(token.token)}`, { method: "POST", headers: { origin: baseURL }, body: upload });
    if (!storedResponse.ok) throw new Error(`Fixture image upload failed: ${storedResponse.status}`);
    const stored = await storedResponse.json() as { id: string };
    const loadedItems = chatWorkload(count).map(item => item.type === "user_message" && item.attachments
      ? { ...item, attachments: item.attachments.map(attachment => ({ ...attachment, id: stored.id })) } : item);
    for (const item of loadedItems) if (item.type === "user_message" && item.attachments) {
      await control({ action: "item", conversationId: snapshot.conversation.id, item });
    }
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await page.locator("#touch-tab-chat").waitFor({ state: "visible" });
    // App assets are setup, outside the cold-Chat interval. Throttle every
    // measured Chat request after setup has loaded, including its first read.
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.latency, downloadThroughput: profile.latency ? 1_600_000 / 8 : -1, uploadThroughput: profile.latency ? 750_000 / 8 : -1 });
    const label = `${agent}-${count}-${profile.name}`;
    await context.tracing.start({ screenshots: true, snapshots: false });
    const reads: { label: string; durationMs: number; finishedAtMs: number }[] = [];
    page.on("requestfinished", request => {
      const url = new URL(request.url());
      if (url.pathname.includes("/chat/") && request.method() === "GET" && !url.pathname.endsWith("/events")) {
        const timing = request.timing();
        reads.push({ label: url.pathname.includes("/conversations/") ? "snapshot" : "auxiliary", durationMs: timing.responseEnd, finishedAtMs: timing.startTime + timing.responseEnd });
      }
    });
    const coldStart = await page.evaluate(() => performance.now());
    await tab(page, "chat");
    const lastItem = page.locator(`[data-chat-item-id="bench:${count - 1}"]`);
    const readFailure = page.locator(".chat-read-error:not([hidden])");
    let coldReadRetries = 0;
    // A deliberately large first page can exceed the ordinary 30-second
    // deadline on the slow link. Record it and exercise the visible read-only
    // retry once; include both attempts in cold latency, never the warm samples.
    await Promise.race([
      lastItem.waitFor({ state: "attached", timeout: 120_000 }),
      readFailure.waitFor({ state: "visible", timeout: 120_000 }),
    ]);
    if (await readFailure.isVisible()) {
      coldReadRetries++;
      console.log(`${label}: cold read failed; exercising read-only retry`);
      await readFailure.getByRole("button", { name: "Retry read" }).click();
    }
    await page.locator('[data-chat-item-id="bench:49"], [data-chat-item-id="bench:499"], [data-chat-item-id="bench:1999"]').last().waitFor({ state: "attached", timeout: 120_000 });
    await page.waitForFunction(count => document.querySelectorAll("#chat-items > [data-chat-item-id], #chat-items [data-chat-item-id]").length >= count, count, { timeout: 120_000 });
    const coldPaint = await painted(page);
    const coldMs = coldPaint - coldStart;
    const snapshotRead = reads.find(read => read.label === "snapshot");
    const snapshotPresentationMs = snapshotRead
      ? Math.max(0, coldPaint + await page.evaluate(() => performance.timeOrigin) - snapshotRead.finishedAtMs) : null;
    await page.screenshot({ path: path.join(output, `${label}-cold.png`) });
    const coldWork = await work(page);
    console.log(`${label}: cold capture complete`);
    for (let i = 0; i < 3; i++) { await tab(page, "files"); await tab(page, "chat"); }
    const warm: number[] = [];
    // Hold delivery of a complete inventory, not a provider contribution:
    // the merged inventory intentionally omits contributions after four seconds.
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>(resolve => { releaseInventory = resolve; });
    let inventoryHeld = false;
    await page.route(url => url.pathname === "/api/chat/conversations", async route => {
      if (route.request().method() !== "GET" || inventoryHeld) return route.continue();
      inventoryHeld = true;
      const response = await route.fetch();
      await inventoryGate;
      await route.fulfill({ response });
    });
    for (let i = 0; i < 30; i++) {
      await tab(page, "files");
      warm.push(await tab(page, "chat"));
      if (i % 10 === 9) console.log(`${label}: ${i + 1} warm samples`);
    }
    if (!inventoryHeld) throw new Error("Warm returns did not request inventory");
    releaseInventory();
    await page.unrouteAll({ behavior: "wait" });
    await page.locator("#chat-timeline").evaluate(el => { el.scrollTop = 0; });
    await painted(page);
    const pagingStart = await page.evaluate(() => performance.now());
    console.log(`${label}: requesting older history`);
    await page.locator("#chat-load-older").evaluate((el: HTMLButtonElement) => el.click());
    console.log(`${label}: older history control clicked`);
    await page.screenshot({ path: path.join(output, `${label}-paging.png`) });
    let pagingError: string | undefined;
    await page.locator('[data-chat-item-id="older:0"]').waitFor({ state: "attached" }).catch(() => { pagingError = "Older content did not appear within 30 seconds"; });
    const pagingMs = pagingError ? null : await painted(page) - pagingStart;
    console.log(`${label}: paging complete`);
    const stream = async (hidden: boolean, pinned: boolean) => {
      console.log(`${label}: streaming hidden=${hidden} pinned=${pinned}`);
      await tab(page, "chat");
      await page.locator("#chat-timeline").evaluate((el, pinned) => { el.scrollTop = pinned ? el.scrollHeight : 200; }, pinned);
      await painted(page);
      console.log(`${label}: stream paint complete`);
      if (hidden) await tab(page, "files");
      const before = await work(page);
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        await control({ action: "item", conversationId: snapshot.conversation.id,
          item: { id: "stream-fixture", type: "assistant_message", createdAt: Date.now(), markdown: "Incremental content. ".repeat(i + 1) } });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await painted(page);
      const after = await work(page);
      const elapsedMs = performance.now() - start;
      const revealMs = hidden ? await tab(page, "chat") : undefined;
      return { elapsedMs, revealMs, renders: (after?.counts["transcript-render"] ?? 0) - (before?.counts["transcript-render"] ?? 0), geometry: (after?.counts["item-geometry"] ?? 0) - (before?.counts["item-geometry"] ?? 0) };
    };
    const streaming = { pinned: await stream(false, true), unpinned: await stream(false, false), hidden: await stream(true, false) };
    const resumeStart = await page.evaluate(() => {
      const start = performance.now();
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      return start;
    });
    const resumeMs = await painted(page) - resumeStart;
    const sorted = [...warm].sort((a, b) => a - b);
    const images = await page.locator("#chat-items img").evaluateAll(nodes => ({
      mounted: nodes.length,
      decoded: nodes.filter(node => (node as HTMLImageElement).naturalWidth > 0).length,
    }));
    if (images.decoded === 0) throw new Error("Fixture images did not decode");
    const result = { agent, count, profile, imageBytes: png.byteLength, uiBytes: new TextEncoder().encode(JSON.stringify(loadedItems)).byteLength, coldMs, coldReadRetries, snapshotPresentationMs, coldWork, warm, warmP95Ms: sorted[Math.ceil(warm.length * .95) - 1], pagingMs, pagingError, streaming, resumeMs,
      images, domElements: await page.locator("#chat-items *").count(), reads, work: await work(page), browserTiming: await page.evaluate(() => (globalThis as any).__chatBrowserTiming) };
    report.results.push(result);
    await context.tracing.stop({ path: path.join(output, `${label}.zip`) });
    await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`${label}: cold ${coldMs.toFixed(1)} ms, warm p95 ${result.warmP95Ms.toFixed(1)} ms, hidden renders ${streaming.hidden.renders}`);
    await context.close();
  }
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  server.kill();
  const killTimer = setTimeout(() => server.kill("SIGKILL"), 2_000);
  await server.exited;
  clearTimeout(killTimer);
}
