import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import { control, frames, settleScroll } from "./chat-shell-helpers";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const test = withEngineBrowsers(baseTest);
const rowCount = 500;
type ScrollSample = { before: number; top: number; reads: number; queries: number; trusted: boolean };

for (const engine of ["chromium", "webkit"] as const) for (const child of [false, true]) {
  test(`${engine} ${child ? "child" : "parent"} manual history scrolling bounds semantic measurement work`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    test.slow();
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1100, height: 844 } });
    const persist = async () => {
      try {
        const data = await page.evaluate(() => {
          const trace = Reflect.get(window, "__historyWork");
          return trace ? { samples: trace.samples, firstWord: trace.firstWord, words: trace.words,
            maxDrift: trace.maxDrift, sameText: trace.sameText, dropped: trace.dropped } : null;
        });
        const body = JSON.stringify({ engine, child, rowCount, data }, null, 2);
        const path = testInfo.outputPath("history-word-evidence.json");
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
        await testInfo.attach("history-word-evidence", { body, contentType: "application/json" });
      } catch { /* Diagnostic collection must preserve the original failure. */ }
    };
    try {
      await request.post("/__e2e/reset");
      const snapshot = await control(request, { action: "seed", child, items: Array.from({ length: rowCount }, (_, i) => ({
        id: `history:${i}`, type: "assistant_message", createdAt: i + 1,
        markdown: `History ${i}. ${"Ordinary reading context. ".repeat(12)}`,
      })) });
      const parent = child ? await control(request, { action: "seed", items: [{
        id: "history-task", type: "tool", createdAt: 1, name: "task", status: "completed",
        input: JSON.stringify({ description: "History child", subagent_type: "explore" }), childConversationId: snapshot.conversation.id,
      }] }) : snapshot;
      await page.addInitScript(() => {
        globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
        Reflect.set(window, "__historyPointQueries", 0);
        for (const method of ["elementsFromPoint", "elementFromPoint"] as const) {
          const original = document[method].bind(document);
          Object.defineProperty(document, method, { configurable: true, value: (x: number, y: number) => {
            Reflect.set(window, "__historyPointQueries", Reflect.get(window, "__historyPointQueries") + 1);
            return original(x, y);
          } });
        }
      });
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await openChatPanel(page);
      await page.locator("#chat-conversation-select").selectOption(parent.conversation.id);
      if (child) {
        await openChatWorkers(page);
        await page.locator(".chat-worker-inspect").filter({ has: page.locator(".chat-worker-name", { hasText: /^History child$/ }) }).click();
      }
      const timeline = page.locator(child ? "#chat-drilldown-timeline" : "#chat-timeline");
      const latest = page.locator(child ? "#chat-drilldown-latest" : "#chat-latest");
      // Every fixture item is a standalone message: no private presentation filter
      // is needed to derive the semantic pass bound independently.
      await expect(timeline.locator("[data-chat-item-id]")).toHaveCount(rowCount);
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await settleScroll(timeline);
      await timeline.hover();
      await page.mouse.wheel(0, -600);
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(300);
      await settleScroll(timeline);

      await timeline.evaluate(el => {
        const count = () => globalThis.__uatuChatPerformance?.counts["item-geometry"] ?? 0;
        const trace = { armed: true, samples: [] as ScrollSample[] };
        Reflect.set(window, "__historyWork", trace);
        let before = el.scrollTop, previousTop = el.scrollTop, reads = 0, queries = 0;
        el.addEventListener("scroll", () => { before = previousTop; reads = count(); queries = Reflect.get(window, "__historyPointQueries"); }, { capture: true });
        // Registered after the owner's target bubble listener. A capture-phase
        // microtask would not reliably wait for that listener in both engines.
        el.addEventListener("scroll", event => {
          if (trace.armed) trace.samples.push({ before, top: el.scrollTop, reads: count() - reads,
            queries: Reflect.get(window, "__historyPointQueries") - queries, trusted: event.isTrusted });
          previousTop = el.scrollTop;
        });
      });
      await timeline.evaluate(installFirstReadyWordProbe);
      for (const delta of [-180, 80]) {
        const before = await timeline.evaluate(el => el.scrollTop);
        await page.mouse.wheel(0, delta);
        await expect.poll(() => timeline.evaluate(el => el.scrollTop)).not.toBe(before);
        await settleScroll(timeline);
      }
      // Put the reading edge halfway into a real inter-row margin. This must
      // not turn an ordinary history callback into a full 500-row fallback.
      await timeline.evaluate(el => {
        const trace = Reflect.get(window, "__historyWork"); trace.wordPhase = "gap";
        const row = el.querySelectorAll<HTMLElement>("[data-chat-item-id]")[250]!;
        const margin = Number.parseFloat(getComputedStyle(row).marginBottom);
        if (!(margin > 0)) throw new Error("History fixture has no inter-row gap");
        el.scrollTop += row.getBoundingClientRect().bottom - el.getBoundingClientRect().top + margin / 2;
      });
      await settleScroll(timeline);
      const samples = await page.evaluate(() => {
        const trace = Reflect.get(window, "__historyWork"); trace.armed = false;
        return trace.samples as ScrollSample[];
      });
      // Observe the FIRST ready word, not a new baseline taken after settling.
      // Keep this append distinct from the later post-touch regression.
      await page.evaluate(() => { Reflect.get(window, "__historyWork").wordPhase = "append"; });
      await control(request, { action: "item", conversationId: snapshot.conversation.id, item: {
        id: "history:word-append", type: "assistant_message", createdAt: rowCount + 1, markdown: "Word-anchor output below the reader.",
      } });
      await expect(timeline.locator("[data-chat-item-id]")).toHaveCount(rowCount + 1);
      await expect(timeline.locator('[data-chat-item-id="history:word-append"]')).toContainText("Word-anchor output below the reader.");
      await settleScroll(timeline); await frames(page);
      const word = await page.evaluate(() => {
        const trace = Reflect.get(window, "__historyWork"); trace.wordActive = false;
        return { first: trace.firstWord, samples: trace.words, maxDrift: trace.maxDrift, sameText: trace.sameText };
      });
      await persist();
      expect(word.first, "first browser-ready visible word after reposition").not.toBeNull();
      expect(word.samples.length).toBeGreaterThan(1);
      expect(word.samples.some((sample: { phase: string }) => sample.phase === "gap")).toBe(true);
      expect(word.samples.some((sample: { phase: string }) => sample.phase === "append")).toBe(true);
      expect(word.sameText).toBe(true);
      expect(word.maxDrift, "first-ready word survives settling and unseen append").toBeLessThanOrEqual(2);
      await expect(latest).toBeVisible();
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every(sample => sample.trusted)).toBe(true);
      expect(samples.some(sample => sample.top !== sample.before && sample.reads > 0)).toBe(true);
      for (const sample of samples) {
        expect(sample.reads, JSON.stringify(sample)).toBeLessThanOrEqual(4);
        expect(sample.queries).toBeLessThanOrEqual(12);
        if (sample.top !== sample.before) expect(sample.reads).toBeGreaterThan(0);
      }

      // Synthetic protocol coverage, NOT native Safari touch/inertia coverage.
      // All events are in one task, so no new layout work occurs between steps.
      const touch = await timeline.evaluate(el => {
        const count = () => globalThis.__uatuChatPerformance?.counts["item-geometry"] ?? 0;
        const send = (name: string, y: number) => {
          const event = new Event(name, { bubbles: true });
          Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); el.dispatchEvent(event);
        };
        const before = count();
        const beforeQueries = Reflect.get(window, "__historyPointQueries");
        send("touchstart", 100);
        send("touchmove", 110);
        const intentReads = count() - before;
        const intentQueries = Reflect.get(window, "__historyPointQueries") - beforeQueries;
        const afterFirstIntent = count();
        const afterFirstQueries = Reflect.get(window, "__historyPointQueries");
        for (const y of [120, 130, 140, 150, 160]) send("touchmove", y);
        const repeatedIntentReads = count() - afterFirstIntent;
        const repeatedIntentQueries = Reflect.get(window, "__historyPointQueries") - afterFirstQueries;
        el.scrollTop -= 40;
        const beforeScroll = count();
        const beforeScrollQueries = Reflect.get(window, "__historyPointQueries");
        el.dispatchEvent(new Event("scroll"));
        const scrollReads = count() - beforeScroll;
        const scrollQueries = Reflect.get(window, "__historyPointQueries") - beforeScrollQueries;
        send("touchend", 160);
        return { intentReads, intentQueries, repeatedIntentReads, repeatedIntentQueries, scrollReads, scrollQueries, top: el.scrollTop };
      });
      expect(touch.intentReads).toBeGreaterThan(0);
      expect(touch.intentReads).toBeLessThanOrEqual(4);
      expect(touch.intentQueries).toBeGreaterThan(0);
      expect(touch.intentQueries).toBeLessThanOrEqual(12);
      expect(touch.repeatedIntentReads).toBe(0);
      expect(touch.repeatedIntentQueries).toBe(0);
      expect(touch.scrollReads).toBeGreaterThan(0);
      expect(touch.scrollReads).toBeLessThanOrEqual(4);
      expect(touch.scrollQueries).toBeGreaterThan(0);
      expect(touch.scrollQueries).toBeLessThanOrEqual(12);
      await settleScroll(timeline);
      // Appending below the reader must retain the fresh manual position,
      // rather than the older position where touch intent was first captured.
      await control(request, { action: "item", conversationId: snapshot.conversation.id, item: {
        id: "history:append", type: "assistant_message", createdAt: rowCount + 2, markdown: "New content below the reader.",
      } });
      await expect(timeline.locator("[data-chat-item-id]")).toHaveCount(rowCount + 2);
      await expect(timeline.locator('[data-chat-item-id="history:append"]')).toContainText("New content below the reader.");
      await expect(latest).toBeVisible();
      await settleScroll(timeline);
      expect(Math.abs(await timeline.evaluate(el => el.scrollTop) - touch.top)).toBeLessThanOrEqual(2);

      // Queue Latest and interrupt it in the same task: no test-owned position
      // write may conceal an unwanted automatic correction afterwards.
      const stopped = await timeline.evaluate((el, selector) => {
        const send = (name: string, y: number) => {
          const event = new Event(name, { bubbles: true });
          Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); el.dispatchEvent(event);
        };
        send("touchstart", 100); send("touchmove", 110);
        document.querySelector<HTMLButtonElement>(selector)!.click();
        send("touchmove", 120);
        return el.scrollTop;
      }, child ? "#chat-drilldown-latest" : "#chat-latest");
      await frames(page); await settleScroll(timeline);
      expect(Math.abs(await timeline.evaluate(el => el.scrollTop) - stopped)).toBeLessThanOrEqual(2);
      // Latest cleared the unseen flag even though upward intent cancelled its
      // positioning. A subsequent append makes the reader's button available again.
      await control(request, { action: "item", conversationId: snapshot.conversation.id, item: {
        id: "history:second-append", type: "assistant_message", createdAt: rowCount + 3, markdown: "More new content below the reader.",
      } });
      await expect(timeline.locator("[data-chat-item-id]")).toHaveCount(rowCount + 3);
      await expect(timeline.locator('[data-chat-item-id="history:second-append"]')).toContainText("More new content below the reader.");
      await expect(latest).toBeVisible();
      await latest.click();
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await testInfo.attach("history-work-counts.json", { contentType: "application/json", body: JSON.stringify({ rowCount, samples, touch, stopped }) });
    } finally {
      try { await page.evaluate(() => { const trace = Reflect.get(window, "__historyWork"); if (trace) trace.wordActive = false; }); } catch { /* preserve original failure */ }
      await persist(); await browser.close();
    }
  });
}

/** Frame-only public DOM probe. No owner hooks or private state; its point
 * queries occur outside native event handlers and do not inflate their deltas.
 * A ready-gated caret captures the first available word after the gap jump;
 * the same immutable UTF16 range is then measured through settling/append. */
function installFirstReadyWordProbe(scroller: HTMLElement): void {
  const trace = Reflect.get(window, "__historyWork") as any;
  Object.assign(trace, { wordActive: true, wordPhase: "native", firstWord: null, words: [], maxDrift: 0, sameText: true, dropped: 0 });
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-chat-item-id]"));
  const ordinals = new Map(rows.map((row, i) => [row, i]));
  const bounds = scroller.getBoundingClientRect(), x = bounds.left + bounds.width / 2;
  const doc = scroller.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  let word: { node: Text; start: number; end: number; value: string; row: HTMLElement } | null = null;
  const sample = (timestamp: number) => {
    if (!trace.wordActive) return;
    if (trace.wordPhase !== "native") {
      let capturedOffset: number | null = null;
      if (!word) for (const fraction of [.02, .2, .5]) {
        const y = bounds.top + bounds.height * fraction, row = doc.elementFromPoint(x, y)?.closest<HTMLElement>("[data-chat-item-id]");
        const body = row?.querySelector<HTMLElement>(".chat-assistant-content");
        if (!row || !ordinals.has(row) || !body?.checkVisibility({ contentVisibilityAuto: true })) continue;
        const caret = doc.caretPositionFromPoint?.(x, y), fallback = caret ? null : doc.caretRangeFromPoint?.(x, y);
        const node = caret?.offsetNode ?? fallback?.startContainer, offset = caret?.offset ?? fallback?.startOffset;
        if (node?.nodeType !== Node.TEXT_NODE || offset === undefined || !body.contains(node)) continue;
        const text = node as Text; let start = Math.min(offset, text.length - 1); if (start < 0) continue;
        while (start < text.length && /\s/.test(text.data[start])) start++; if (start >= text.length) continue;
        let end = start + 1; while (start > 0 && /\S/.test(text.data[start - 1])) start--;
        while (end < text.length && /\S/.test(text.data[end])) end++;
        const range = doc.createRange(); range.setStart(text, start); range.setEnd(text, end);
        const candidateOffset = range.getBoundingClientRect().top - bounds.top;
        if (candidateOffset < 0 || candidateOffset >= bounds.height) continue;
        capturedOffset = candidateOffset;
        word = { node: text, start, end, value: text.data.slice(start, end), row }; break;
      }
      if (word) {
        const ready = word.node.isConnected && !!word.row.querySelector<HTMLElement>(".chat-assistant-content")?.checkVisibility({ contentVisibilityAuto: true });
        let offset: number | null = null;
        if (ready) {
          if (capturedOffset !== null) offset = capturedOffset;
          else { const range = doc.createRange(); range.setStart(word.node, word.start); range.setEnd(word.node, word.end); offset = range.getBoundingClientRect().top - bounds.top; }
        }
        const position = { time: performance.now(), timestamp, phase: trace.wordPhase, ordinal: ordinals.get(word.row),
          startUTF16: word.start, endUTF16: word.end, offset, sameText: ready && word.node.data.slice(word.start, word.end) === word.value };
        trace.sameText &&= position.sameText;
        if (!trace.firstWord && offset !== null && offset >= 0 && offset < bounds.height) trace.firstWord = position;
        if (trace.firstWord && offset !== null) trace.maxDrift = Math.max(trace.maxDrift, Math.abs(offset - trace.firstWord.offset));
        if (trace.words.length < 1024) trace.words.push(position); else trace.dropped++;
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
