import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test as baseTest, expect } from "./fixtures";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { bootShell, log, shell } from "./chat-shell-helpers";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);

async function control(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function frames(page: Page, count = 3) {
  await page.evaluate(count => new Promise<void>(resolve => {
    const next = () => { if (--count <= 0) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}

async function seed(request: APIRequestContext, title = "Scroll contract", child = false) {
  const snapshot = await control(request, { action: "seed", title, child, items: Array.from({ length: 40 }, (_, i) => ({
    id: `contract:${title}:${i}`, type: "assistant_message", createdAt: i + 1,
    markdown: `Message ${i}\n\n${"Stable transcript context. ".repeat(20)}`,
  })) }) as { conversation: { id: string } };
  if (child) await control(request, { action: "seed", items: [{ id: "contract:child", type: "tool", createdAt: 1,
    name: "task", status: "completed", input: JSON.stringify({ description: "Scroll contract child", subagent_type: "explore", prompt: "inspect" }),
    childConversationId: snapshot.conversation.id }] });
  return snapshot;
}

async function open(page: Page, request: APIRequestContext, touch: boolean, child = false) {
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  if (touch) await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  if (child) {
    await openChatWorkers(page);
    await page.locator(".chat-worker-inspect").filter({ has: page.locator(".chat-worker-name", { hasText: /^Scroll contract child$/ }) }).click();
  }
  const timeline = page.locator(child ? "#chat-drilldown-timeline" : "#chat-timeline");
  await expect(timeline).toContainText("Message 39");
  await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
  return timeline;
}

async function pause(page: Page, timeline: Locator, touch: boolean) {
  if (touch) {
    // Cross-engine touch default scrolling is delivered explicitly, as in
    // chat-follow-stability; native wheel scrolling is used on desktop.
    await timeline.evaluate(el => {
      for (const [name, y] of [["touchstart", 100], ["touchmove", 600]] as const) {
        const event = new Event(name, { bubbles: true });
        Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientY: y }] });
        el.dispatchEvent(event);
      }
      el.scrollTop -= 500;
      el.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
  } else {
    await timeline.hover();
    await page.mouse.wheel(0, -500);
  }
  await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(300);
  await frames(page);
}

for (const engine of ["chromium", "webkit"] as const) for (const touch of [false, true]) {
  for (const child of [false, true]) {
  test(`${engine} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} preserves visible text when its own message grows above it`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      const { conversation } = await seed(request, "Scroll contract", child);
      const timeline = await open(page, request, touch, child);
      const markdown = Array.from({ length: 35 }, (_, i) => `Interior paragraph ${i}. ${"Reading context. ".repeat(12)}`).join("\n\n");
      const update = (markdown: string) => control(request, { action: "item", conversationId: conversation.id,
        item: { id: "contract:interior", type: "assistant_message", createdAt: 100, markdown } });
      await update(markdown);
      await expect(timeline).toContainText("Interior paragraph 34.");
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await pause(page, timeline, touch);
      const paragraph = timeline.locator('[data-chat-item-id="contract:interior"] p').filter({ hasText: /^Interior paragraph 12\./ });
      await paragraph.evaluate(node => {
        const scroller = node.closest<HTMLElement>(".chat-timeline")!;
        scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
        scroller.dispatchEvent(new Event("scroll"));
      });
      await frames(page);
      const offset = () => paragraph.evaluate(node => node.getBoundingClientRect().top - node.closest(".chat-timeline")!.getBoundingClientRect().top);
      const initial = await offset();
      await update(`${"Earlier text grows within the same message. ".repeat(120)}\n\n${markdown}`);
      await expect(timeline).toContainText("Earlier text grows within the same message.");
      await frames(page, 24);
      const final = await offset();
      await testInfo.attach("interior-reading-anchor.json", { body: JSON.stringify({ initial, final, drift: final - initial }), contentType: "application/json" });
      expect(Math.abs(final - initial), "anchoring the message box alone must not let visible text jump").toBeLessThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test(`${engine} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} streams smoothly, settles within 300ms, and yields to upward input`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      const { conversation } = await seed(request, "Scroll contract", child);
      const timeline = await open(page, request, touch, child);
      await control(request, { action: "item", conversationId: conversation.id,
        item: { id: "contract:stream", type: "assistant_message", createdAt: 100, markdown: "Streaming reply" } });
      await expect(timeline).toContainText("Streaming reply");
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await frames(page);
      const trace = await timeline.evaluateHandle(el => {
        const state = { active: true, samples: [] as Array<{ time: number; top: number; extent: number; height: number }> };
        const sample = (time: number) => {
          state.samples.push({ time, top: el.scrollTop, extent: el.scrollHeight, height: el.clientHeight });
          if (state.active) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      });
      try {
        await frames(page);
        const beforeStream = await timeline.evaluate(el => el.scrollTop);
        await control(request, { action: "delta", conversationId: conversation.id, itemId: "contract:stream",
          delta: Array.from({ length: 18 }, (_, i) => `\n\nStreamed paragraph ${i}: ${"New output. ".repeat(8)}`).join("") });
        await expect(timeline).toContainText("Streamed paragraph 17");
        await timeline.evaluate((el, from) => new Promise<void>((resolve, reject) => {
          let remaining = 60;
          const sample = () => {
            if (el.scrollTop > from + 1 && el.scrollHeight - el.clientHeight - el.scrollTop > 2) resolve();
            else if (--remaining === 0) reject(new Error("Streaming never exposed an intermediate position"));
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }), beforeStream);
        if (touch) await timeline.evaluate(el => {
          for (const [name, y] of [["touchstart", 104], ["touchmove", 100]] as const) {
            const event = new Event(name, { bubbles: true });
            Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientY: y }] });
            el.dispatchEvent(event);
          }
          el.scrollTop += 4;
          el.dispatchEvent(new Event("touchend", { bubbles: true }));
        });
        else { await timeline.hover(); await page.mouse.wheel(0, 4); }
        await frames(page, 24);
        const samples = await trace.evaluate(state => { state.active = false; return state.samples; });
        await testInfo.attach("smooth-stream-frames.json", { body: JSON.stringify(samples), contentType: "application/json" });
        const growth = samples.findIndex((sample, i) => i > 0 && sample.extent > samples[i - 1]!.extent + 2);
        expect(growth, "fixture must produce actual transcript growth").toBeGreaterThan(0);
        const moving = samples.slice(growth).filter((sample, i) => {
          const prior = samples[growth + i - 1]!;
          return sample.top > prior.top + 0.5;
        });
        expect(moving.length, "following must progress across frames, not teleport").toBeGreaterThanOrEqual(3);
        expect(moving.some(sample => sample.extent - sample.height - sample.top > 2), "movement must include intermediate reading positions").toBe(true);
        const backwards = samples.slice(growth).filter((sample, i) => {
          const prior = samples[growth + i - 1]!;
          return sample.extent >= prior.extent && sample.height === prior.height && sample.top < prior.top - 1;
        });
        expect(backwards, "passive append-only following must never bounce upward").toEqual([]);
        const lastGrowth = samples.reduce((index, sample, i) => i > 0 && sample.extent !== samples[i - 1]!.extent ? i : index, growth);
        const settled = samples.slice(lastGrowth).find(sample => sample.extent - sample.height - sample.top <= 2);
        expect(settled, "following must reach latest after output settles").toBeDefined();
        expect(settled!.time - samples[lastGrowth]!.time, "catch-up after the final layout update").toBeLessThanOrEqual(300);

        await pause(page, timeline, touch);
        await control(request, { action: "delta", conversationId: conversation.id, itemId: "contract:stream", delta: "\n\nUnseen while paused." });
        await expect(timeline).toContainText("Unseen while paused.");
        const latest = page.locator(child ? "#chat-drilldown-latest" : "#chat-latest");
        await expect(latest).toBeVisible();
        if (!touch) await timeline.hover();
        const readingTop = await timeline.evaluate(el => el.scrollTop);
        // Keep the mouse over the timeline for native wheel interruption. The
        // button's action is exercised without moving the pointer away from it.
        await latest.evaluate(button => (button as HTMLButtonElement).click());
        await timeline.evaluate((el, from) => new Promise<void>((resolve, reject) => {
          let remaining = 60;
          const sample = () => {
            if (el.scrollTop > from + 1 && el.scrollHeight - el.clientHeight - el.scrollTop > 2) resolve();
            else if (--remaining === 0) reject(new Error("Latest never exposed an interruptible intermediate position"));
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }), readingTop);
        if (touch) await timeline.evaluate(el => {
          for (const [name, y] of [["touchstart", 100], ["touchmove", 104]] as const) {
            const event = new Event(name, { bubbles: true });
            Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientY: y }] });
            el.dispatchEvent(event);
          }
          el.scrollTop -= 4;
          el.dispatchEvent(new Event("touchend", { bubbles: true }));
        });
        else await page.mouse.wheel(0, -4);
        await frames(page, 4);
        const interrupted = await timeline.evaluate(el => el.scrollTop);
        await control(request, { action: "delta", conversationId: conversation.id, itemId: "contract:stream", delta: "\n\nIncoming after interrupted latest." });
        await expect(timeline).toContainText("Incoming after interrupted latest.");
        await frames(page, 24);
        expect(Math.abs(await timeline.evaluate(el => el.scrollTop) - interrupted), "new output must not restart interrupted animation").toBeLessThanOrEqual(2);
        await expect(latest).toBeVisible();
      } finally {
        await trace.evaluate(state => { state.active = false; });
        await trace.dispose();
      }
    } finally {
      await browser.close();
    }
  });

  test(`${engine} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} shell output follows smoothly without moving its outer timeline`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      const shape = child ? "bash" : "command";
      const fixture = await bootShell(page, request, { child, touch, shape, output: log(100),
        extra: Array.from({ length: 20 }, (_, i) => ({ id: `shell-context:${i}`, type: "assistant_message" as const,
          createdAt: i + 2, markdown: `History ${i}\n\n${"Earlier conversation. ".repeat(20)}` })) });
      const viewport = fixture.viewport;
      await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await expect.poll(() => fixture.timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      // Pause the outer owner independently while keeping its shell in view.
      // A pinned outer timeline may legitimately move when its own extent
      // changes, so independence must be checked against a paused reader.
      await fixture.timeline.evaluate(el => {
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -4 }));
        el.scrollTop -= 4;
      });
      await frames(page);
      const outerTop = await fixture.timeline.evaluate(el => el.scrollTop);
      const trace = await viewport.evaluateHandle(el => {
        const state = { active: true, samples: [] as Array<{ time: number; top: number; extent: number; height: number }> };
        const sample = (time: number) => {
          state.samples.push({ time, top: el.scrollTop, extent: el.scrollHeight, height: el.clientHeight });
          if (state.active) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      });
      try {
        await frames(page);
        await fixture.update(shell(shape, log(140)));
        await expect(viewport.locator(".chat-shell-lines > span")).toHaveCount(140);
        await frames(page, 24);
        const samples = await trace.evaluate(state => { state.active = false; return state.samples; });
        await testInfo.attach("smooth-shell-frames.json", { body: JSON.stringify(samples), contentType: "application/json" });
        const growth = samples.findIndex((sample, i) => i > 0 && sample.extent > samples[i - 1]!.extent + 2);
        expect(growth).toBeGreaterThan(0);
        const moving = samples.slice(growth).filter((sample, i) => sample.top > samples[growth + i - 1]!.top + 0.5);
        expect(moving.length, "shell following must progress across frames, not teleport").toBeGreaterThanOrEqual(3);
        expect(moving.some(sample => sample.extent - sample.height - sample.top > 2)).toBe(true);
        const backwards = samples.slice(growth).filter((sample, i) => {
          const prior = samples[growth + i - 1]!;
          return sample.extent >= prior.extent && sample.height === prior.height && sample.top < prior.top - 1;
        });
        expect(backwards, "append-only shell following must not bounce upward").toEqual([]);
        const lastGrowth = samples.reduce((index, sample, i) => i > 0 && sample.extent !== samples[i - 1]!.extent ? i : index, growth);
        const settled = samples.slice(lastGrowth).find(sample => sample.extent - sample.height - sample.top <= 2);
        expect(settled).toBeDefined();
        expect(settled!.time - samples[lastGrowth]!.time).toBeLessThanOrEqual(300);
        expect(Math.abs(await fixture.timeline.evaluate(el => el.scrollTop) - outerTop), "inner output growth must not move the outer reading position").toBeLessThanOrEqual(2);
      } finally {
        await trace.evaluate(state => { state.active = false; });
        await trace.dispose();
      }
    } finally {
      await browser.close();
    }
  });
  }

  for (const format of ["quote", "list", "tight-list"] as const) test(`${engine} ${touch ? "touch" : "desktop"} preserves unchanged nested ${format} text when earlier content grows`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      const { conversation } = await seed(request);
      const timeline = await open(page, request, touch);
      const paragraphs = Array.from({ length: 35 }, (_, i) => `Nested paragraph ${i}. ${"Reading context. ".repeat(format === "tight-list" && i === 12 ? 120 : 12)}`);
      const wrap = (paragraphs: string[]) => format === "quote"
        ? paragraphs.map(text => `> ${text}`).join("\n>\n")
        : paragraphs.map(text => `- ${text}${format === "tight-list" && text.startsWith("Nested paragraph 12.")
          ? `\n  - ${paragraphs[0]!.startsWith("Earlier nested") ? "Updated" : "Original"} nested child below the reading region.` : ""}`).join("\n");
      const update = (paragraphs: string[]) => control(request, { action: "item", conversationId: conversation.id,
        item: { id: "contract:nested", type: "assistant_message", createdAt: 100, markdown: wrap(paragraphs) } });
      await update(paragraphs);
      await expect(timeline).toContainText("Nested paragraph 34.");
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await pause(page, timeline, touch);
      const reading = timeline.locator(`[data-chat-item-id="contract:nested"] ${format === "quote" ? "blockquote p" : "li"}`)
        .filter({ hasText: /^Nested paragraph 12\./ });
      await reading.evaluate((node, offset) => {
        const scroller = node.closest<HTMLElement>(".chat-timeline")!;
        scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
        scroller.dispatchEvent(new Event("scroll"));
      }, format === "tight-list" ? -200 : 40);
      await frames(page);
      const offset = () => reading.evaluate(node => node.getBoundingClientRect().top - node.closest(".chat-timeline")!.getBoundingClientRect().top);
      const initial = await offset();
      await update(["Earlier nested text grows. ".repeat(120), ...paragraphs]);
      await expect(timeline).toContainText("Earlier nested text grows.");
      await frames(page, 24);
      const final = await offset();
      await testInfo.attach("nested-reading-anchor.json", { body: JSON.stringify({ format, initial, final, drift: final - initial }), contentType: "application/json" });
      expect(Math.abs(final - initial), "a container fingerprint must not invalidate unchanged nested reading text").toBeLessThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test(`${engine} ${touch ? "touch" : "desktop"} preserves reading text after a collapsed activity group on resize`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      const { conversation } = await seed(request);
      const timeline = await open(page, request, touch);
      for (let i = 0; i < 3; i++) await control(request, { action: "item", conversationId: conversation.id,
        item: { id: `contract:closed-tool:${i}`, type: "tool", createdAt: 90 + i, name: "read", status: "completed",
          input: JSON.stringify({ filePath: `context-${i}.ts` }), output: "Completed synthetic activity." } });
      const markdown = "This unchanged reading paragraph follows completed activity. " + "A careful reader keeps their place while the conversation pane changes width. ".repeat(3);
      await control(request, { action: "item", conversationId: conversation.id,
        item: { id: "contract:closed-reading", type: "assistant_message", createdAt: 100, markdown } });
      await control(request, { action: "item", conversationId: conversation.id,
        item: { id: "contract:closed-tail", type: "assistant_message", createdAt: 101,
          markdown: Array.from({ length: 50 }, (_, i) => `Trailing context ${i}. ${"Plenty of remaining scroll room. ".repeat(10)}`).join("\n\n") } });
      const paragraph = timeline.locator('[data-chat-item-id="contract:closed-reading"] p');
      await expect(paragraph).toHaveText(markdown);
      const group = timeline.locator('[data-chat-item-id="group:contract:closed-tool:0"]');
      await expect(group).not.toHaveAttribute("open");
      await expect(group.locator(".chat-group-items [data-chat-item-id]")).toHaveCount(3);
      await pause(page, timeline, touch);
      // Moving through auto-skipped history realizes its intrinsic sizes.
      // Finish setup at the intended reading line before applying the tested
      // fresh input and resize, rather than mistaking realization for drift.
      await expect.poll(async () => {
        await paragraph.evaluate(node => {
          const scroller = node.closest<HTMLElement>(".chat-timeline")!;
          scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1500 }));
          scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 20;
          scroller.dispatchEvent(new Event("scroll"));
        });
        await frames(page, 6);
        return paragraph.evaluate(node => Math.abs(node.getBoundingClientRect().top - node.closest(".chat-timeline")!.getBoundingClientRect().top + 20));
      }).toBeLessThanOrEqual(1);
      if (touch) await timeline.evaluate(el => {
        for (const [name, y] of [["touchstart", 100], ["touchmove", 102]] as const) {
          const event = new Event(name, { bubbles: true });
          Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientY: y }] });
          el.dispatchEvent(event);
        }
        el.scrollTop -= 2;
        el.dispatchEvent(new Event("touchend", { bubbles: true }));
      });
      else { await timeline.hover(); await page.mouse.wheel(0, -2); }
      await frames(page, 6);
      const reading = await paragraph.evaluate(node => {
        const scroller = node.closest<HTMLElement>(".chat-timeline")!;
        const rect = node.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
        // Observe a visible character independently of the controller's caret
        // hit test (WebKit touch can return an element at a line's left edge).
        const range = node.ownerDocument.createRange();
        let index = 0;
        for (; index < node.textContent!.length; index++) {
          range.setStart(node.firstChild!, index); range.setEnd(node.firstChild!, index + 1);
          const character = range.getBoundingClientRect();
          if (character.top >= bounds.top && character.bottom <= bounds.bottom) break;
        }
        if (index === node.textContent!.length) throw new Error(`Reading paragraph must be visible: ${rect.top - bounds.top}`);
        // The first hidden tool may end just above the viewport; a later
        // placeholder is the bogus first-visible row that steals the anchor.
        const hidden = Array.from(scroller.querySelectorAll<HTMLElement>(".chat-group-items [data-chat-item-id]"))
          .find(element => {
            const box = element.getBoundingClientRect();
            return box.height > 0 && box.bottom > bounds.top && box.top < bounds.bottom;
          });
        if (!hidden) throw new Error("A nonpresented tool placeholder must overlap the reading viewport");
        return { index, offset: range.getBoundingClientRect().top - bounds.top, width: rect.width,
          hidden: { top: hidden.getBoundingClientRect().top - bounds.top, height: hidden.getBoundingClientRect().height,
            visibility: hidden.checkVisibility?.({ contentVisibilityAuto: true, visibilityProperty: true }) },
          viewportHeight: scroller.clientHeight, remaining: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop };
      });
      expect(reading.remaining).toBeGreaterThan(2000);
      await page.setViewportSize(touch ? { width: 480, height: 844 } : { width: 1600, height: 900 });
      await frames(page, 24);
      const final = await paragraph.evaluate((node, index) => {
        const range = node.ownerDocument.createRange(); range.setStart(node.firstChild!, index); range.setEnd(node.firstChild!, index + 1);
        return { offset: range.getBoundingClientRect().top - node.closest(".chat-timeline")!.getBoundingClientRect().top,
          width: node.getBoundingClientRect().width };
      }, reading.index);
      await testInfo.attach("collapsed-group-reading-anchor.json", { body: JSON.stringify({ reading, final, drift: final.offset - reading.offset }), contentType: "application/json" });
      expect(reading.hidden.height, "the closed group's descendant must expose a real placeholder box").toBeGreaterThan(0);
      expect(reading.hidden.top + reading.hidden.height, "the hidden placeholder must overlap the reading viewport").toBeGreaterThan(0);
      expect(reading.hidden.top).toBeLessThan(reading.viewportHeight);
      // WebKit may report true here despite the closed ancestor. Structural
      // presentation, not this optional browser API, is the portable contract.
      if (engine === "chromium" && reading.hidden.visibility !== undefined) expect(reading.hidden.visibility).toBe(false);
      expect(Math.abs(final.width - reading.width)).toBeGreaterThan(20);
      expect(Math.abs(final.offset - reading.offset), "hidden activity placeholders must not steal the visible text anchor").toBeLessThanOrEqual(2);
    } finally { await browser.close(); }
  });

  test(`${engine} ${touch ? "touch" : "desktop"} preserves the first visible text line when a paragraph rewraps`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      const { conversation } = await seed(request);
      const timeline = await open(page, request, touch);
      await control(request, { action: "item", conversationId: conversation.id,
        item: { id: "contract:rewrap", type: "assistant_message", createdAt: 100,
          markdown: Array.from({ length: 1600 }, (_, i) => `word${String(i).padStart(4, "0")}`).join(" ") } });
      const paragraph = timeline.locator('[data-chat-item-id="contract:rewrap"] p');
      await expect(paragraph).toContainText("word1599");
      await expect.poll(() => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
      await pause(page, timeline, touch);
      await timeline.evaluate(el => {
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1500 }));
        el.scrollTop -= 1500;
      });
      await frames(page);
      // This small genuine movement leaves the previous fine character in
      // view. It must choose the new reading line, unlike a correction echo.
      await timeline.evaluate(el => {
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));
        el.scrollTop -= 20;
      });
      await frames(page);
      const reading = await paragraph.evaluate(node => {
        const scroller = node.closest<HTMLElement>(".chat-timeline")!;
        const x = node.getBoundingClientRect().left + 5;
        const y = scroller.getBoundingClientRect().top + 8;
        const doc = node.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
        const caret = doc.caretPositionFromPoint?.(x, y);
        const fallback = caret ? null : doc.caretRangeFromPoint?.(x, y);
        const text = caret?.offsetNode ?? fallback?.startContainer;
        const offset = caret?.offset ?? fallback?.startOffset;
        if (text !== node.firstChild || offset === undefined) throw new Error("Fixture must expose plain text at the reading point");
        const index = Math.min(offset, node.textContent!.length - 1);
        const range = doc.createRange();
        range.setStart(text!, index); range.setEnd(text!, index + 1);
        return { index, offset: range.getBoundingClientRect().top - scroller.getBoundingClientRect().top, width: node.getBoundingClientRect().width };
      });
      if (touch) await page.setViewportSize({ width: 480, height: 844 });
      else {
        const divider = page.locator("#chat-resizer");
        await divider.focus();
        for (let i = 0; i < 3; i++) await divider.press("ArrowLeft");
      }
      await frames(page, 24);
      const final = await paragraph.evaluate((node, index) => {
        const range = node.ownerDocument.createRange();
        range.setStart(node.firstChild!, index); range.setEnd(node.firstChild!, index + 1);
        return { offset: range.getBoundingClientRect().top - node.closest(".chat-timeline")!.getBoundingClientRect().top, width: node.getBoundingClientRect().width };
      }, reading.index);
      await testInfo.attach("rewrapped-text-anchor.json", { body: JSON.stringify({ reading, final, drift: final.offset - reading.offset }), contentType: "application/json" });
      expect(Math.abs(final.width - reading.width), "fixture must actually change the paragraph width").toBeGreaterThan(20);
      expect(Math.abs(final.offset - reading.offset), "the same visible text line must survive rewrapping").toBeLessThanOrEqual(2);

      // A late intrinsic image size change inside this same paragraph must
      // reach the real ResizeObserver path, without a synthetic scroll event.
      await paragraph.evaluate(node => {
        const image = node.ownerDocument.createElement("img");
        image.dataset.scrollContractImage = "";
        image.alt = "Delayed intrinsic image";
        image.style.cssText = "display:block;width:10px;height:1px";
        node.prepend(image);
      });
      await frames(page, 4);
      await paragraph.locator("img[data-scroll-contract-image]").evaluate(image => { (image as HTMLElement).style.height = "400px"; });
      await frames(page, 24);
      const afterImage = await paragraph.evaluate((node, index) => {
        const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE)!;
        const range = node.ownerDocument.createRange();
        range.setStart(text, index); range.setEnd(text, index + 1);
        return range.getBoundingClientRect().top - node.closest(".chat-timeline")!.getBoundingClientRect().top;
      }, reading.index);
      await testInfo.attach("intrinsic-image-text-anchor.json", { body: JSON.stringify({ initial: reading.offset, afterImage, drift: afterImage - reading.offset }), contentType: "application/json" });
      expect(Math.abs(afterImage - reading.offset), "intrinsic growth above the text inside one paragraph must not move the reading line").toBeLessThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test(`${engine} ${touch ? "touch" : "desktop"} reduced motion follows directly without intermediate positions`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await request.post("/__e2e/reset");
      const { conversation } = await seed(request);
      const timeline = await open(page, request, touch);
      const trace = await timeline.evaluateHandle(el => {
        const state = { active: true, samples: [] as Array<{ top: number; extent: number; height: number }>,
          writes: [] as Array<{ top: number; extent: number; height: number }> };
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        Object.defineProperty(el, "scrollTop", { configurable: true,
          get() { return descriptor.get!.call(this); },
          set(top: number) {
            descriptor.set!.call(this, top);
            state.writes.push({ top: descriptor.get!.call(this), extent: el.scrollHeight, height: el.clientHeight });
          },
        });
        const sample = () => {
          state.samples.push({ top: el.scrollTop, extent: el.scrollHeight, height: el.clientHeight });
          if (state.active) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      });
      try {
        await frames(page);
        await control(request, { action: "item", conversationId: conversation.id,
          item: { id: "contract:reduced", type: "assistant_message", createdAt: 100,
            markdown: Array.from({ length: 12 }, (_, i) => `Reduced motion paragraph ${i}. ${"Output. ".repeat(12)}`).join("\n\n") } });
        await expect(timeline).toContainText("Reduced motion paragraph 11.");
        await frames(page, 12);
        const { samples, writes } = await trace.evaluate(state => { state.active = false; return { samples: state.samples, writes: state.writes }; });
        await testInfo.attach("reduced-motion-frames.json", { body: JSON.stringify({ samples, writes }), contentType: "application/json" });
        expect(samples.at(-1)!.extent - samples.at(-1)!.height - samples.at(-1)!.top).toBeLessThanOrEqual(2);
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.filter(write => Math.abs(write.extent - write.height - write.top) > 2),
          "each reduced-motion correction must directly reach its current bottom").toEqual([]);
        // Markdown may produce more than one layout. A sample taken after a
        // new layout but before its correction is not an animation frame.
        expect(samples.filter((sample, i) => i > 0 && sample.extent === samples[i - 1]!.extent
          && sample.height === samples[i - 1]!.height && sample.top > samples[i - 1]!.top + 0.5
          && sample.extent - sample.height - sample.top > 2),
          "reduced motion must not expose animated intermediate positions").toEqual([]);
      } finally {
        await trace.evaluate(state => { state.active = false; });
        await timeline.evaluate(el => { Reflect.deleteProperty(el, "scrollTop"); });
        await trace.dispose();
      }
    } finally {
      await browser.close();
    }
  });

  test(`${engine} ${touch ? "touch" : "desktop"} sending preserves the paused reading anchor`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    try {
      await request.post("/__e2e/reset");
      await seed(request);
      const timeline = await open(page, request, touch);
      await pause(page, timeline, touch);
      const anchor = await timeline.evaluate(el => {
        const top = el.getBoundingClientRect().top;
        const row = [...el.querySelectorAll<HTMLElement>("[data-chat-item-id]")]
          .find(row => row.getBoundingClientRect().top >= top)!;
        return { id: row.dataset.chatItemId!, offset: row.getBoundingClientRect().top - top };
      });
      const trace = await timeline.evaluateHandle((el, id) => {
        const state = { active: true, offsets: [] as Array<number | null> };
        const sample = () => {
          const row = el.querySelector<HTMLElement>(`[data-chat-item-id="${CSS.escape(id)}"]`);
          state.offsets.push(row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null);
          if (state.active) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return state;
      }, anchor.id);
      try {
        await frames(page);
        const input = page.locator("#chat-input");
        await input.fill("Send without losing my place");
        if (touch) await page.locator("#chat-send").tap();
        else await input.press("Enter");
        await expect(page.locator("#chat-items")).toContainText("Send without losing my place");
        await frames(page, 24);
        const offsets = await trace.evaluate(state => { state.active = false; return state.offsets; });
        await testInfo.attach("paused-send-anchor.json", { body: JSON.stringify({ anchor, offsets }), contentType: "application/json" });
        expect(offsets.length).toBeGreaterThan(0);
        expect(offsets, "the reading anchor must survive submission rendering").not.toContain(null);
        const drift = Math.max(...offsets.map(offset => Math.abs(offset! - anchor.offset)));
        expect(drift, "sending must not pull a paused reader to latest, even transiently").toBeLessThanOrEqual(2);
        await expect(page.locator("#chat-latest")).toBeVisible();
      } finally {
        await trace.evaluate(state => { state.active = false; });
        await trace.dispose();
      }
    } finally {
      await browser.close();
    }
  });
}
