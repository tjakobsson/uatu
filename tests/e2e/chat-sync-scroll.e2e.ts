import type { Locator, Page } from "@playwright/test";
import { test as hubTest, expect, childChatControl, signIn, openSessionTab, openEventSources } from "./hub-fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { openChatWorkers } from "./chat-helpers";

const test = withEngineBrowsers(hubTest);
type Anchor = { id: string; offset: number };

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// Cross-engine Playwright cannot perform a native touch swipe. Send the full
// touch lifecycle the follow controller consumes AND move the actual scroller.
// Keep the finger down while native events arrive, then test again after lift.
async function touchUp(timeline: Locator) {
  return timeline.evaluate(async node => {
    const top = node.scrollTop;
    for (const [type, y] of [["touchstart", 200], ["touchmove", 260], ["touchmove", 320]] as const) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { touches: { value: [{ identifier: 1, clientY: y, clientX: 160 }] }, changedTouches: { value: [{ identifier: 1, clientY: y, clientX: 160 }] } });
      node.dispatchEvent(event);
      if (type === "touchmove") node.scrollTop -= 60;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return top - node.scrollTop;
  });
}

async function lift(timeline: Locator) {
  await timeline.evaluate(node => {
    const event = new Event("touchend", { bubbles: true });
    Object.defineProperties(event, { touches: { value: [] }, changedTouches: { value: [{ identifier: 1, clientY: 320, clientX: 160 }] } });
    node.dispatchEvent(event);
  });
}

async function anchor(timeline: Locator): Promise<Anchor> {
  return timeline.evaluate(async node => {
    let previous = "", stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const bounds = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => {
        const rect = row.getBoundingClientRect();
        return rect.height > 0 && rect.top >= bounds.top && rect.top < bounds.bottom;
      });
      if (!row) throw new Error("No visible transcript anchor");
      const value = { id: row.dataset.chatItemId!, offset: row.getBoundingClientRect().top - bounds.top };
      const current = JSON.stringify([node.scrollTop, node.scrollHeight, value]);
      stable = previous === current ? stable + 1 : 0;
      if (stable === 3) return value;
      previous = current;
    }
    throw new Error("Transcript geometry never settled");
  });
}

async function preserved(timeline: Locator, before: Anchor) {
  await expect.poll(() => timeline.evaluate((node, before) => {
    const row = [...node.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => row.dataset.chatItemId === before.id);
    return row ? Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - before.offset) : Infinity;
  }, before)).toBeLessThan(2);
  expect(await timeline.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(80);
}

// These are frame-budget tests, isolated from the functional suite's workers.
// The server, provider, adapter, Hub broker and browser are real; only native
// OpenCode HTTP/SSE is the existing source-shaped fixture (no model calls).
for (const engine of ["chromium", "webkit"] as const) for (const child of [false, true]) {
  test(`${engine} mobile ${child ? "long child" : "parent"} touch reading survives native sync traffic`, { tag: "@perf" }, async ({ launchBrowser, hub }, info) => {
    test.slow();
    const browser = await launchBrowser(engine);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await context.addInitScript(() => {
      const open = new Map<EventSource, string>();
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url: string | URL, init?: EventSourceInit) { super(url, init); open.set(this, String(url)); }
        close() { open.delete(this); super.close(); }
      };
      (window as any).__uatuOpenEventSources = () => [...open.values()];
    });
    const login = await context.newPage();
    try {
      await signIn(login, hub);
      await login.close();
      const workspace = hub.workspaces[0]!;
      const control = (body: Record<string, unknown>) => childChatControl(workspace, { action: "opencode", ...body }) as Promise<any>;
      await childChatControl(workspace, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
      const page = await openSessionTab(context, workspace);
      await page.locator("#touch-tab-chat").tap();
      await page.getByRole("button", { name: "New conversation" }).click();
      await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
      const parent = await page.locator("#chat-conversation-select").inputValue();
      await page.locator("#chat-input").fill("Start native scroll fixture");
      await page.locator("#chat-send").click();
      await expect(page.locator("#chat-stop")).toBeEnabled();
      const worker = await control({ op: "launchWorker", conversationId: parent }) as { childId: string; taskId: string };
      await control({ op: "appendHistory", conversationId: parent, count: 90 });
      await control({ op: "appendHistory", conversationId: worker.childId, count: 90 });
      await page.reload();
      await page.locator("#touch-tab-chat").tap();
      await expect(page.locator("#chat-items")).toContainText("Historical fixture answer 89");
      await page.locator("#chat-input").fill("Pending input survives native sync");
      await page.locator("#chat-input").press("Alt+Enter");
      await expect(page.locator("#chat-queue")).toContainText("Pending input survives native sync");
      await page.locator("#chat-input").fill("Unsent draft survives scrolling");
      await page.locator("#chat-input").blur();
      await openChatWorkers(page);
      const workerRow = page.locator(`#chat-compact-workers-items [data-background-task="${worker.taskId}"]`);
      await expect(workerRow).toHaveCount(1);
      if (child) {
        await workerRow.locator("[data-inspect-task]").click();
        await expect(page.locator("#chat-drilldown-items")).toContainText("Historical fixture answer 89");
      }
      const timeline = page.locator(child ? "#chat-drilldown-timeline" : "#chat-timeline");
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(1000);
      // Exercise real provider pagination, before monitoring unsolicited reads.
      for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
        const count = await timeline.locator("[data-chat-item-id]").count();
        let release!: () => void;
        let captured!: () => void;
        let capturedStatus = 0;
        const held = new Promise<void>(resolve => { release = resolve; });
        const received = new Promise<void>(resolve => { captured = resolve; });
        // Deliver metadata during the final older-page response. A report
        // appends child history and legitimately invalidates its prior cursor;
        // this test must not expect a subsequent stale-cursor read to succeed.
        await page.route(url => url.pathname.includes("/api/chat/conversations/") && url.searchParams.has("cursor"), async route => {
          const response = await route.fetch();
          capturedStatus = response.status();
          captured();
          await held;
          await route.fulfill({ response });
        }, { times: 1 });
        const paging = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).searchParams.has("cursor") && response.url().includes("/api/chat/conversations/"));
        await page.locator(child ? "#chat-drilldown-older" : "#chat-load-older").click();
        try {
          await received;
          expect(capturedStatus).toBe(200);
          if (pageIndex === 1) {
            await control({ op: "workerReport", childId: worker.childId, usedModel: "Concurrent history report", usedEffort: "high", costUsd: 0 });
            await expect(workerRow.locator(".chat-worker-model-name")).toHaveText("Concurrent history report");
          }
        } finally { release(); }
        await paging;
        await expect.poll(() => timeline.locator("[data-chat-item-id]").count()).toBeGreaterThan(count);
      }
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(2000);
      await frames(page);
      await timeline.evaluate(node => {
        for (const [type, y] of [["touchstart", 200], ["touchmove", 220]] as const) {
          const event = new Event(type, { bubbles: true });
          Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
          node.dispatchEvent(event);
        }
        node.scrollTop = node.scrollHeight - node.clientHeight - 300;
      });
      await lift(timeline);
      await anchor(timeline);
      expect(await touchUp(timeline)).toBeGreaterThan(40);
      await lift(timeline);
      await anchor(timeline);

      const snapshots: string[] = [];
      page.on("request", request => {
        const url = new URL(request.url());
        if (request.method() === "GET" && /\/api\/chat\/conversations\/[^/]+$/.test(url.pathname) && !url.searchParams.has("cursor")) snapshots.push(url.pathname);
      });
      await page.evaluate(() => {
        const state = { frame: 0, loading: [] as string[], writes: [] as number[], recording: false,
          reading: null as null | { selector: string; id: string; offset: number }, samples: [] as Array<{ frame: number; drift: number; bottom: number }> };
        (window as any).__syncScroll = state;
        const sample = () => {
          state.frame++;
          if (state.recording) for (const label of document.querySelectorAll<HTMLElement>(".uatu-loading-label")) {
            if (/Updating conversation/i.test(label.textContent ?? "") && label.getClientRects().length && getComputedStyle(label).visibility !== "hidden") state.loading.push(label.textContent!);
          }
          if (state.recording && state.reading) {
            const node = document.querySelector<HTMLElement>(state.reading.selector)!;
            const row = [...node.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => row.dataset.chatItemId === state.reading!.id);
            state.samples.push({ frame: state.frame, drift: row ? Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - state.reading.offset) : 1e9,
              bottom: node.scrollHeight - node.clientHeight - node.scrollTop });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await timeline.evaluate(node => {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        Object.defineProperty(node, "scrollTop", { configurable: true, get() { return descriptor.get!.call(this); }, set(top: number) {
          const state = (window as any).__syncScroll;
          if (state.recording) state.writes.push(state.frame);
          descriptor.set!.call(this, top);
        } });
        const scrollTo = node.scrollTo.bind(node);
        node.scrollTo = ((...args: any[]) => {
          const state = (window as any).__syncScroll;
          if (state.recording) state.writes.push(state.frame);
          (scrollTo as any)(...args);
        }) as typeof node.scrollTo;
      });
      const duringTouch = async (event: () => Promise<void>) => {
        // Require meaningful real movement, rather than assuming the browser
        // applies both 60px steps unchanged while intrinsic row sizes settle.
        expect(await touchUp(timeline)).toBeGreaterThan(40);
        const before = await anchor(timeline);
        await page.evaluate(reading => {
          (window as any).__syncScroll.reading = reading;
          (window as any).__syncScroll.recording = true;
        }, { selector: child ? "#chat-drilldown-timeline" : "#chat-timeline", ...before });
        await event();
        await frames(page);
        await preserved(timeline, before);
        await lift(timeline);
        await frames(page);
        await preserved(timeline, before);
        await page.evaluate(() => { (window as any).__syncScroll.recording = false; });
      };
      for (let index = 0; index < 4; index++) await duringTouch(async () => {
        await control({ op: "workerReport", childId: worker.childId, usedModel: `Scroll report ${index}`, usedEffort: "high", costUsd: index / 1000 });
        await expect(workerRow.locator(".chat-worker-model-name")).toHaveText(`Scroll report ${index}`);
      });
      let sibling!: { childId: string; taskId: string };
      await duringTouch(async () => {
        sibling = await control({ op: "launchWorker", conversationId: parent });
        await expect(page.locator(`#chat-compact-workers-items [data-background-task="${sibling.taskId}"]`)).toHaveCount(1);
      });
      await duringTouch(async () => {
        await control({ op: "settleWorker", childId: sibling.childId, text: "Sibling native delta and result" });
        await expect(page.locator(`#chat-compact-workers-items [data-background-task="${sibling.taskId}"]`)).toHaveAttribute("data-state", "completed");
      });
      await duringTouch(async () => {
        if (child) {
          await control({ op: "settleWorker", childId: worker.childId, text: "Inspected child native text delta arrived" });
          await expect(page.locator("#chat-drilldown-items")).toContainText("Inspected child native text delta arrived");
        } else {
          await control({ op: "finish", conversationId: parent, text: "Parent native text delta arrived" });
          await expect(page.locator("#chat-items")).toContainText("Parent native text delta arrived");
        }
      });
      if (child) await duringTouch(async () => {
        await control({ op: "finish", conversationId: parent, text: "Parent finished behind inspected child" });
        await expect(page.locator("#chat-items")).toContainText("Parent finished behind inspected child");
      });
      await expect(page.locator("#chat-input")).toHaveValue("Unsent draft survives scrolling");
      expect(snapshots).toEqual([]);
      const trace = await page.evaluate(() => (window as any).__syncScroll as { loading: string[]; writes: number[]; samples: Array<{ frame: number; drift: number; bottom: number }> });
      expect(trace.loading).toEqual([]);
      expect(trace.samples.length).toBeGreaterThan(14);
      expect(Math.max(...trace.samples.map(sample => sample.drift))).toBeLessThan(2);
      expect(Math.min(...trace.samples.map(sample => sample.bottom))).toBeGreaterThan(80);
      const counts = new Map<number, number>();
      for (const frame of trace.writes) counts.set(frame, (counts.get(frame) ?? 0) + 1);
      expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(1);
      expect(await openEventSources(page)).toHaveLength(1);
      expect(new URL((await openEventSources(page))[0]!, hub.origin).pathname).toBe("/api/hub/live");
      await info.attach("native-sync-scroll", { body: JSON.stringify({ engine, child, snapshots, ...trace }), contentType: "application/json" });
    } finally { await context.close(); await browser.close(); }
  });
}
