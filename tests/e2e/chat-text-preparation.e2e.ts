import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { control, frames, settleScroll } from "./chat-shell-helpers";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const test = withEngineBrowsers(baseTest);
const rowCount = 240;

test("webkit desktop parent keeps fresh loaded text at the bottom after initial layout", { tag: "@perf" }, async ({ launchBrowser, request, baseURL }) => {
  const browser = await launchBrowser("webkit");
  const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
  try {
    await request.post("/__e2e/reset");
    await control(request, { action: "seed", title: "Scroll contract", child: false,
      items: Array.from({ length: 40 }, (_, i) => ({ id: `contract:Scroll contract:${i}`, type: "assistant_message", createdAt: i + 1,
        markdown: `Message ${i}\n\n${"Stable transcript context. ".repeat(20)}` })) });
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await openChatPanel(page);
    const timeline = page.locator("#chat-timeline");
    await expect(timeline).toContainText("Message 39");
    const gap = () => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(gap).toBeLessThan(2);
    // A synchronous zero can precede a later rollback. Observe beyond the
    // initial placement without another write, stylesheet override or sampler.
    await frames(page, 3);
    expect(await gap(), "initial bottom placement survives subsequent browser layout").toBeLessThan(2);
  } finally {
    await browser.close();
  }
});

// A browser-layout contract: message bodies must be ready before occupying
// the viewport. rAF/checkVisibility samples are prepaint, not proof of painted
// pixels or physical Safari touch/inertia. Exercise the real rendered UI and
// preserve its reading position without inspecting a preparation controller.
for (const engine of ["webkit", "chromium"] as const) for (const child of [false, true]) test(`${engine} phone ${child ? "child" : "parent"} prepares history text without displacing the paused reader`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const evidence: Record<string, any> = { engine, child, version: browser.version(), rowCount,
    gesture: "18 synthetic touch-intent/scrollTop steps, not native touch/inertia", paintMeasured: false };
  const network = { request: { history: 0, live: 0, poll: 0, other: 0 }, response: { history: 0, live: 0, poll: 0, other: 0 } };
  const category = (raw: string): keyof typeof network.request => {
    const path = new URL(raw).pathname;
    if (/live|events/.test(path)) return "live";
    if (/history|items|transcript/.test(path)) return "history";
    if (/status|agents|conversations|personal-state/.test(path)) return "poll";
    return "other";
  };
  let armed = false;
  page.on("request", r => { if (armed) network.request[category(r.url())]++; });
  page.on("response", r => { if (armed) network.response[category(r.url())]++; });
  let trace: Awaited<ReturnType<typeof page.evaluateHandle>> | undefined;
  try {
    await request.post("/__e2e/reset");
    const seeded = await control(request, { action: "seed", child, items: Array.from({ length: rowCount }, (_, i) => ({
      id: `synthetic:${i}`, type: "assistant_message", createdAt: i + 1, completedAt: i + 2,
      markdown: i % 4 === 0 ? `Synthetic short ${i}. A brief answer.`
        : i % 4 === 1 ? `Synthetic long ${i}.\n\n${Array.from({ length: 10 }, () => "A synthetic paragraph with ordinary words to wrap across narrow screens. ".repeat(5)).join("\n\n")}`
        : i % 4 === 2 ? `Synthetic list ${i}.\n\n${Array.from({ length: 18 }, (_, j) => `- Item ${j}: **synthetic emphasis** and a longer explanation for natural line wrapping.`).join("\n")}`
        : `Synthetic code ${i}.\n\n\`\`\`ts\n${Array.from({ length: 26 }, (_, j) => `const synthetic${j} = ${j}; // ordinary example`).join("\n")}\n\`\`\`\n\n${"A final synthetic explanation. ".repeat(25)}`,
    })) });
    const parent = child ? await control(request, { action: "seed", items: [{
      id: "synthetic:child-task", type: "tool", createdAt: 1, name: "task", status: "completed",
      input: JSON.stringify({ description: "Synthetic child", subagent_type: "explore", prompt: "go" }),
      childConversationId: seeded.conversation.id,
    }] }) : seeded;
    await page.addInitScript(() => { globalThis.__uatuChatPerformance = { counts: {}, durations: {} }; });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await page.locator("#chat-conversation-select").selectOption(parent.conversation.id);
    if (child) {
      await openChatWorkers(page);
      await page.locator(".chat-worker-inspect").filter({ has: page.locator(".chat-worker-name", { hasText: /^Synthetic child$/ }) }).click();
    }
    const timeline = page.locator(child ? "#chat-drilldown-timeline" : "#chat-timeline");
    const latest = page.locator(child ? "#chat-drilldown-latest" : "#chat-latest");
    await expect(timeline.locator(".chat-assistant-message")).toHaveCount(rowCount);
    await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    await settleScroll(timeline);
    evidence.before = await timeline.evaluate(el => {
      const rows = Array.from(el.querySelectorAll<HTMLElement>(".chat-assistant-message"));
      return { rows: rows.length, rowsWithText: rows.filter(row => !!row.querySelector(".chat-assistant-content")?.textContent?.trim()).length,
        textCharacters: rows.reduce((n, row) => n + (row.textContent?.length ?? 0), 0), counters: structuredClone(globalThis.__uatuChatPerformance) };
    });
    expect(evidence.before.rowsWithText, "all fixture bodies are available before input").toBe(rowCount);
    trace = await timeline.evaluateHandle(el => {
      type SemanticPoint = { ordinal: number; utf16: number };
      type Word = { node: Text; start: number; end: number; ordinal: number; value: string };
      type Hit = { ordinal: number | null; text?: boolean; visible?: boolean; top?: number; height?: number };
      type Sample = { frame: number; time: number; dt: number; phase: string; top: number; extent: number; hits: Hit[]; semantic: SemanticPoint | null };
      const rows = Array.from(el.querySelectorAll<HTMLElement>(".chat-assistant-message"));
      const ordinals = new Map(rows.map((row, ordinal) => [row, ordinal]));
      const rect = el.getBoundingClientRect();
      const doc = el.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
      const x = rect.left + rect.width / 2;
      const caret = (y: number) => {
        const point = doc.caretPositionFromPoint?.(x, y);
        const fallback = point ? null : doc.caretRangeFromPoint?.(x, y);
        const node = point?.offsetNode ?? fallback?.startContainer;
        const offset = point?.offset ?? fallback?.startOffset;
        if (node?.nodeType !== Node.TEXT_NODE || offset === undefined) return null;
        const row = node.parentElement?.closest<HTMLElement>(".chat-assistant-message");
        if (!row || !ordinals.has(row)) return null;
        return { node: node as Text, offset, row, ordinal: ordinals.get(row)! };
      };
      const semantic = (point: NonNullable<ReturnType<typeof caret>>): SemanticPoint => {
        const walker = doc.createTreeWalker(point.row, NodeFilter.SHOW_TEXT);
        let utf16 = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node === point.node) return { ordinal: point.ordinal, utf16: utf16 + point.offset };
          utf16 += node.textContent?.length ?? 0;
        }
        throw new Error("Visible caret must belong to its message row");
      };
      let word: Word | null = null;
      const wordPosition = () => {
        if (!word || !word.node.isConnected) return null;
        const range = doc.createRange(); range.setStart(word.node, word.start); range.setEnd(word.node, word.end);
        return { ordinal: word.ordinal, startUTF16: word.start, endUTF16: word.end,
          offset: range.getBoundingClientRect().top - rect.top,
          sameText: word.node.data.slice(word.start, word.end) === word.value };
      };
      const state = { active: true, phase: "before", frame: 0, reader: false, samples: [] as Sample[],
        writes: [] as Array<{ frame: number; reader: boolean; before: number; top: number }>, trustedScrolls: 0,
        mutations: 0, geometryPerScroll: [] as number[],
        setPhase(phase: string) { this.phase = phase; },
        input() {
          for (const [name, y] of [["touchstart", 100], ["touchmove", 660], ["touchend", 660]] as const) {
            const event = new Event(name, { bubbles: true });
            Object.defineProperty(event, "touches", { value: name === "touchend" ? [] : [{ clientY: y }] });
            el.dispatchEvent(event);
            if (name === "touchmove") { this.reader = true; el.scrollTop -= 560; this.reader = false; }
          }
        },
        captureWord() {
          this.phase = "paused";
          for (const fraction of [0.2, 0.5, 0.8]) {
            const point = caret(rect.top + rect.height * fraction);
            if (!point || !point.node.length) continue;
            let start = Math.min(point.offset, point.node.length - 1);
            while (start < point.node.length && /\s/.test(point.node.data[start])) start++;
            if (start >= point.node.length) continue;
            let end = start + 1;
            while (start > 0 && /\S/.test(point.node.data[start - 1])) start--;
            while (end < point.node.length && /\S/.test(point.node.data[end])) end++;
            word = { node: point.node, start, end, ordinal: point.ordinal, value: point.node.data.slice(start, end) };
            const position = wordPosition();
            if (position && position.offset >= 0 && position.offset < rect.height) return position;
          }
          return null;
        },
        wordPosition,
        snapshot() { return { samples: this.samples, writes: this.writes, trustedScrolls: this.trustedScrolls,
          mutations: this.mutations, geometryPerScroll: this.geometryPerScroll, counters: structuredClone(globalThis.__uatuChatPerformance) }; },
        stop() { this.active = false; observer.disconnect(); Reflect.deleteProperty(el, "scrollTop"); Reflect.deleteProperty(el, "scrollTo"); },
      };
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
      Object.defineProperty(el, "scrollTop", { configurable: true,
        get() { return descriptor.get!.call(this); },
        set(top: number) {
          if (state.active) state.writes.push({ frame: state.frame, reader: state.reader, before: descriptor.get!.call(this), top });
          descriptor.set!.call(this, top);
        } });
      const scrollTo = el.scrollTo.bind(el);
      el.scrollTo = ((options: ScrollToOptions) => {
        if (state.active) state.writes.push({ frame: state.frame, reader: state.reader, before: el.scrollTop, top: options.top ?? el.scrollTop });
        scrollTo(options);
      }) as typeof el.scrollTo;
      const observer = new MutationObserver(records => { if (state.active) state.mutations += records.length; });
      observer.observe(el, { childList: true, subtree: true, characterData: true });
      let geometryBefore = 0;
      el.addEventListener("scroll", () => { geometryBefore = globalThis.__uatuChatPerformance?.counts["item-geometry"] ?? 0; }, { capture: true });
      el.addEventListener("scroll", event => {
        if (!state.active) return;
        state.geometryPerScroll.push((globalThis.__uatuChatPerformance?.counts["item-geometry"] ?? 0) - geometryBefore);
        if (event.isTrusted) state.trustedScrolls++;
      });
      let last = performance.now();
      const sample = (time: number) => {
        if (!state.active) return;
        state.frame++;
        const seen = new Set<HTMLElement>();
        const hits: Hit[] = [0.2, 0.5, 0.8].map(fraction => {
          const hit = doc.elementFromPoint(x, rect.top + rect.height * fraction);
          const row = hit?.closest<HTMLElement>(".chat-assistant-message");
          if (!row || !ordinals.has(row)) return { ordinal: null };
          const body = row.querySelector<HTMLElement>(".chat-assistant-content");
          const bounds = seen.has(row) ? null : row.getBoundingClientRect(); seen.add(row);
          return { ordinal: ordinals.get(row)!, text: !!body?.textContent?.trim(),
            visible: body?.checkVisibility({ contentVisibilityAuto: true }) ?? false, top: bounds?.top, height: bounds?.height };
        });
        // Compare reading order at ONE fixed point, never mix different y's.
        // Only query a caret after that point's body is ready, so the semantic
        // observation does not deliberately lay out a skipped message.
        const point = hits[0].visible ? caret(rect.top + rect.height * 0.2) : null;
        state.samples.push({ frame: state.frame, time, dt: time - last, phase: state.phase,
          top: el.scrollTop, extent: el.scrollHeight, hits,
          semantic: point && point.ordinal === hits[0].ordinal ? semantic(point) : null });
        last = time;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return state;
    });
    const handle = trace as any;
    const box = (await timeline.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    armed = true;
    for (let i = 0; i < 18; i++) {
      await handle.evaluate((state: any, i: number) => state.setPhase(`up-${i}`), i);
      await handle.evaluate((state: any) => state.input());
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }
    evidence.reading = await handle.evaluate((state: any) => state.captureWord());
    await settleScroll(timeline);
    await frames(page);
    evidence.afterPause = await handle.evaluate((state: any) => state.wordPosition());
    evidence.gesture = { ...await handle.evaluate((state: any) => state.snapshot()), network };
    armed = false;
    // Prove paused intent through public behavior rather than an owner getter:
    // later output stays unseen, exposes Latest, and does not move the word.
    await handle.evaluate((state: any) => state.setPhase("append"));
    await control(request, { action: "item", conversationId: seeded.conversation.id, item: {
      id: "synthetic:append", type: "assistant_message", createdAt: rowCount + 1, completedAt: rowCount + 2,
      markdown: "Synthetic later output below the paused reader.",
    } });
    await expect(timeline.locator(".chat-assistant-message")).toHaveCount(rowCount + 1);
    await settleScroll(timeline);
    await frames(page);
    evidence.afterAppend = await handle.evaluate((state: any) => state.wordPosition());
    evidence.latestVisible = await latest.isVisible();
    const observations = evidence.gesture.samples as Array<any>;
    const late = observations.filter(sample => sample.hits.some((hit: any) => hit.ordinal !== null && (!hit.text || !hit.visible)));
    const semantic = observations.filter(sample => sample.semantic && sample.phase.startsWith("up-"));
    const reversals = semantic.slice(1).flatMap((sample, i) => {
      const before = semantic[i].semantic, after = sample.semantic;
      return after.ordinal > before.ordinal || (after.ordinal === before.ordinal && after.utf16 > before.utf16)
        ? [{ time: sample.time, phase: sample.phase, before, after }] : [];
    });
    const writesPerFrame = new Map<number, number>();
    for (const write of evidence.gesture.writes) if (!write.reader) writesPerFrame.set(write.frame, (writesPerFrame.get(write.frame) ?? 0) + 1);
    evidence.summary = { frames: observations.length, notReadyFrames: late.length, semanticSamples: semantic.length,
      semanticReversals: reversals, maxAutomaticWritesPerFrame: Math.max(0, ...writesPerFrame.values()),
      maxGeometryPerScroll: Math.max(0, ...evidence.gesture.geometryPerScroll),
      pauseWordDriftPx: evidence.reading && evidence.afterPause ? evidence.afterPause.offset - evidence.reading.offset : null,
      appendWordDriftPx: evidence.reading && evidence.afterAppend ? evidence.afterAppend.offset - evidence.reading.offset : null,
      conservationAssertionsPassed: 0 };
    // Run reader conservation before readiness so a layout-preparation change
    // cannot hide displacement behind a green ready-state measurement.
    expect(evidence.reading, "a real visible word must be captured at input stop").not.toBeNull();
    expect(evidence.afterPause?.sameText, "the captured word survives settling").toBe(true);
    expect(Math.abs(evidence.summary.pauseWordDriftPx), "same word offset after input stops").toBeLessThanOrEqual(2);
    evidence.summary.conservationAssertionsPassed++;
    expect(evidence.afterAppend?.sameText, "the captured word survives unseen output").toBe(true);
    expect(Math.abs(evidence.summary.appendWordDriftPx), "same word offset after unseen output").toBeLessThanOrEqual(2);
    evidence.summary.conservationAssertionsPassed++;
    await expect(latest, "paused reading keeps later output unseen").toBeVisible();
    evidence.summary.conservationAssertionsPassed++;
    expect(semantic.length, "observe actual text-order progress, not only scrollTop coordinates").toBeGreaterThan(1);
    expect(reversals, "upward history input must not countersteer toward later text").toEqual([]);
    evidence.summary.conservationAssertionsPassed++;
    expect(evidence.summary.maxAutomaticWritesPerFrame).toBeLessThanOrEqual(1);
    expect(evidence.summary.maxGeometryPerScroll).toBeLessThanOrEqual(4);
    console.log(JSON.stringify({ engine, child, summary: evidence.summary, reading: evidence.reading, afterPause: evidence.afterPause,
      afterAppend: evidence.afterAppend, latestVisible: evidence.latestVisible, network }));
    expect(late.length, "message bodies must be browser-ready before occupying the viewport (prepaint, not pixel proof)").toBe(0);
  } finally {
    armed = false;
    try { await (trace as any)?.evaluate((state: any) => state.stop()); } catch { /* preserve original failure */ }
    try {
      const body = JSON.stringify(evidence, null, 2);
      const path = testInfo.outputPath("text-preparation-numeric-evidence.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await testInfo.attach("text-preparation-numeric-evidence", { body, contentType: "application/json" });
    } catch { /* evidence must not replace the original failure */ }
    await trace?.dispose().catch(() => {});
    await browser.close();
  }
});
