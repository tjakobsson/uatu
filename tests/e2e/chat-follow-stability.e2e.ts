import { test as baseTest, expect } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { bootShell, frames as settleFrames, log, shell, position, drag } from "./chat-shell-helpers";

const test = withEngineBrowsers(baseTest);

type Frame = { frame: number; phase: string; top: number; extent: number; height: number; following: boolean };
type Write = Omit<Frame, "following"> & { before: number; source: string; reader: boolean; behavior?: string };
type Trace = { frame: number; phase: string; reader: boolean; frames: Frame[]; writes: Write[] };
declare global {
  interface Window {
    __followTrace: Trace;
    __followControllers: Array<{ isPinned(): boolean }>;
    __coordinatedOwners: Map<HTMLElement, { id: number; anchor: { isPinned(): boolean }; registrations: number }>;
    __activeCorrectionOwner?: number;
    __shellOwners: Map<HTMLElement, { snapshot(): { top: number; left: number; following: boolean; unseen: boolean } }>;
    __shellObservations: unknown[];
    __shellFrameTrace: { frame: number; phase: string; reader: boolean; frames: Array<Frame & { scroller: string; owner: number; desiredTop?: number }>;
      writes: Array<Write & { scroller: string; owner: number; correctionOwner?: number }> };
  }
}

attachPageDiagnosticsOnFailure(test);

// Every test here samples scroll writes per animation frame and holds each
// scroller to at most one automatic correction per frame. A loaded runner
// stretches and merges frames, so both groups are tagged @perf and run in the
// perf project, apart from the parallel functional suite.

for (const browserName of ["chromium", "webkit"] as const) for (const touch of [false, true]) for (const child of [false, true]) {
  test(`${browserName} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} integrated shell frame budget`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
    // A long scenario (a fresh page boot, then ~25 update/settle cycles
    // across inline, floating, and maximized phases). On a loaded CI runner
    // WebKit spends ~13s booting alone and was timing out at 30s while still
    // progressing; the budget is time, not a frame assertion.
    test.slow();
    const browser = await launchBrowser(browserName);
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      let instrumented = false;
      await page.route("**/*.js", async route => {
        const response = await route.fetch();
        const source = await response.text();
        const body = source.replace(/owners\d*\.set\(scroller, this\);/g, match => {
          instrumented = true;
          return `${match} {
            const registry = globalThis.__coordinatedOwners ??= new Map(); const prior = registry.get(scroller);
            const entry = { id: prior?.id ?? registry.size + 1, anchor: this.options.anchor, registrations: (prior?.registrations ?? 0) + 1 };
            registry.set(scroller, entry);
            const flush = this.flush; this.flush = function(timestamp) {
              const previous = globalThis.__activeCorrectionOwner; globalThis.__activeCorrectionOwner = entry.id;
              try { return flush.call(this, timestamp); } finally { globalThis.__activeCorrectionOwner = previous; }
            };
            const coordinated = this;
            for (const method of ["pause", "observe"]) {
              const apply = entry.anchor[method]; entry.anchor[method] = function(geometry, movement) {
                const shell = globalThis.__shellOwners?.get(scroller); const before = shell?.snapshot();
                const value = apply.call(this, geometry, movement);
                if (shell && globalThis.__shellFrameTrace) (globalThis.__shellObservations ??= []).push({
                  phase: globalThis.__shellFrameTrace.phase, frame: globalThis.__shellFrameTrace.frame,
                  method, movement, geometry, before, after: shell.snapshot(),
                  pending: coordinated.upwardPending, previous: coordinated.previous
                });
                return value;
              };
            }
          }`;
        }).replace(/isPinned: \(\) => this\.following,/g,
          "isPinned: () => { (globalThis.__shellOwners ??= new Map()).set(this.viewport, this); return this.following; },");
        await route.fulfill({ response, body });
      });
      const shape = child ? "bash" : "command";
      const fixture = await bootShell(page, request, { child, touch, shape, output: log(100, true), extra: Array.from({ length: 20 }, (_, i) => ({
        id: `shell-history:${i}`, type: "assistant_message" as const, createdAt: i + 2, markdown: `History ${i}\n\n${"Transcript context. ".repeat(30)}`,
      })) });
      expect(instrumented).toBe(true);
      const { viewport, outputView, timeline } = fixture;
      await expect.poll(async () => (await position(viewport)).bottom).toBeLessThan(2);
      await settleFrames(page);
      expect(await viewport.evaluate(el => !!window.__shellOwners?.get(el as HTMLElement))).toBe(true);
      await expect.poll(() => timeline.evaluate(el => window.__coordinatedOwners.get(el as HTMLElement)!.anchor.isPinned())).toBe(true);
      await viewport.evaluate(el => {
        const state: Window["__shellFrameTrace"] = { frame: 0, phase: "inline-passive", reader: false, frames: [], writes: [] };
        window.__shellFrameTrace = state;
        const targets = [document.querySelector<HTMLElement>("#chat-timeline")!, document.querySelector<HTMLElement>("#chat-drilldown-timeline")!, el as HTMLElement];
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        for (const node of targets) {
          const registration = window.__coordinatedOwners.get(node)!;
          if (!registration) throw new Error(`No coordinated owner for ${node.id || node.className}`);
          const name = node === el ? "shell" : node.id;
          Object.defineProperty(node, "scrollTop", { configurable: true, get() { return descriptor.get!.call(this); }, set(top: number) {
            state.writes.push({ frame: state.frame, phase: state.phase, top, before: descriptor.get!.call(this), extent: node.scrollHeight,
              height: node.clientHeight, source: new Error().stack ?? "", reader: state.reader, scroller: name, owner: registration.id,
              correctionOwner: window.__activeCorrectionOwner });
            descriptor.set!.call(this, top);
          } });
          const scrollTo = node.scrollTo.bind(node);
          node.scrollTo = ((options: ScrollToOptions) => {
            state.writes.push({ frame: state.frame, phase: state.phase, top: options.top ?? node.scrollTop, before: node.scrollTop,
              extent: node.scrollHeight, height: node.clientHeight, source: new Error().stack ?? "", reader: state.reader,
              behavior: options.behavior, scroller: name, owner: registration.id, correctionOwner: window.__activeCorrectionOwner });
            scrollTo(options);
          }) as typeof node.scrollTo;
        }
        const sample = () => {
          state.frame++;
          for (const node of targets) {
            if (!node.clientHeight) continue;
            const registration = window.__coordinatedOwners.get(node)!;
            state.frames.push({ frame: state.frame, phase: state.phase, top: node.scrollTop, extent: node.scrollHeight,
              height: node.clientHeight, following: registration.anchor.isPinned(), owner: registration.id,
              scroller: node === el ? "shell" : node.id,
              desiredTop: node === el ? window.__shellOwners.get(node)!.snapshot().top : undefined });
          }
          if (el.isConnected) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const phase = (value: string) => page.evaluate(value => { window.__shellFrameTrace.phase = value; }, value);
      const following = () => viewport.evaluate(el => window.__coordinatedOwners.get(el as HTMLElement)!.anchor.isPinned());
      const outerIntent = () => timeline.evaluate(el => window.__coordinatedOwners.get(el as HTMLElement)!.anchor.isPinned());
      const latest = outputView.getByRole("button", { name: /Latest output/ });
      let count = 100;
      const update = async (size = ++count, status: "running" | "completed" = "running") => {
        count = size;
        await fixture.update(shell(shape, log(size, true), status));
        await expect(viewport.locator(".chat-shell-lines > span")).toHaveCount(size);
        await expect(timeline.locator('[data-chat-item-id="shell:a"]')).toHaveClass(new RegExp(`\\bis-${status}\\b`));
        await settleFrames(page);
      };
      const atBottom = async () => { await expect.poll(async () => (await position(viewport)).bottom).toBeLessThan(2); expect(await following()).toBe(true); };
      const stableReading = async (top: number) => {
        await expect.poll(async () => Math.abs((await position(viewport)).top - top)).toBeLessThan(2);
        expect(await following()).toBe(false);
      };
      const interrupt = async (pendingLatest = false) => {
        const outerBefore = await outerIntent();
        if (!touch && !pendingLatest) { await viewport.hover(); await page.mouse.wheel(0, -4); }
        else await viewport.evaluate((el, pending) => {
          if (pending) el.closest(".chat-shell-output")!.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
            if (button.textContent?.includes("Latest output")) button.click();
          });
          if (navigator.maxTouchPoints) {
            for (const [name, y] of [["touchstart", 100], ["touchmove", 104]] as const) {
              const event = new Event(name, { bubbles: true });
              Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); el.dispatchEvent(event);
            }
          } else el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -4 }));
          window.__shellFrameTrace.reader = true; el.scrollTop -= 4; window.__shellFrameTrace.reader = false;
        }, pendingLatest);
        await expect.poll(following).toBe(false);
        await settleFrames(page);
        expect(await outerIntent()).toBe(outerBefore);
        return (await position(viewport)).top;
      };
      for (let i = 0; i < 4; i++) { await update(); await atBottom(); }
      await phase("inline-upward");
      let reading = await interrupt(); await update(); await stableReading(reading);
      await phase("inline-interrupted-latest");
      reading = await interrupt(true); await update(); await stableReading(reading);
      await phase("inline-latest");
      const arriving = update(); await latest.click(); await arriving; await atBottom();
      await update(); await atBottom();
      await phase("inline-resize");
      await outputView.locator(".chat-shell-inline-resize").focus();
      await page.keyboard.press("ArrowDown"); await settleFrames(page); await atBottom();
      await phase("floating");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const floating = page.getByRole("region", { name: "Shell output window" });
      await expect(floating).toBeVisible(); await settleFrames(page); await atBottom();
      for (let i = 0; i < 3; i++) { await phase("floating-passive"); await update(); await atBottom(); }
      if (!touch) {
        await phase("floating-resize");
        await drag(page, floating.locator(".chat-shell-window-resize"), 100, 60); await atBottom();
        await phase("maximized");
        await floating.getByRole("button", { name: "Maximize", exact: true }).click();
        await settleFrames(page); await atBottom();
      }
      await phase("full-area-passive"); await update(); await atBottom();
      await phase("full-area-upward"); reading = await interrupt(); await update(); await stableReading(reading);
      await phase("full-area-interrupted-latest"); reading = await interrupt(true); await update(); await stableReading(reading);
      await phase("paused-clamp");
      await update(3); expect(await following()).toBe(false); expect((await position(viewport)).top).toBe(0);
      await update(130); await stableReading(0);
      await phase("full-area-latest");
      const incoming = update(); await latest.click(); await incoming; await atBottom();
      await phase("completion"); await update(count, "completed"); await atBottom();
      await expect(floating.locator(".chat-shell-window-metadata")).toContainText("Completed");
      if (!touch) {
        await phase("restore-size"); await floating.getByRole("button", { name: "Restore size" }).click();
        await settleFrames(page); await atBottom();
      }
      await phase("return"); await floating.getByRole("button", { name: "Return to chat" }).click();
      await expect(floating).toHaveCount(0); await settleFrames(page); await atBottom();
      await phase("returned-passive"); await update(count + 1, "completed"); await atBottom();
      await phase("paused-popout"); reading = await interrupt();
      await timeline.evaluate(el => {
        window.__shellFrameTrace.reader = true; el.scrollTop -= 80; window.__shellFrameTrace.reader = false;
      });
      await settleFrames(page);
      expect(await outerIntent()).toBe(false);
      const outerTop = (await position(timeline)).top;
      const clampedReading = async () => {
        const expected = await viewport.evaluate((el, top) => Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight)), reading);
        await stableReading(expected);
      };
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      await expect(floating).toBeVisible(); await settleFrames(page); await clampedReading();
      expect(await outerIntent()).toBe(false);
      if (!touch) {
        await phase("paused-maximize"); await floating.getByRole("button", { name: "Maximize", exact: true }).click();
        await settleFrames(page); await clampedReading();
        await phase("paused-restore"); await floating.getByRole("button", { name: "Restore size" }).click();
        await settleFrames(page); await clampedReading();
      }
      await phase("paused-return"); await floating.getByRole("button", { name: "Return to chat" }).click();
      await expect(floating).toHaveCount(0); await settleFrames(page); await stableReading(reading);
      expect(await outerIntent()).toBe(false);
      expect(Math.abs((await position(timeline)).top - outerTop)).toBeLessThan(2);
      expect(await viewport.evaluate(el => window.__coordinatedOwners.get(el as HTMLElement)!.registrations)).toBe(1);

      const trace = await page.evaluate(() => window.__shellFrameTrace);
      const summaries = [];
      for (const name of new Set(trace.frames.map(frame => frame.scroller))) {
        const writes = trace.writes.filter(write => write.scroller === name && !write.reader);
        expect(writes.filter(write => write.correctionOwner !== write.owner), `${name}: write outside its registered owner`).toEqual([]);
        const perFrame = new Map<number, number>();
        for (const write of writes) perFrame.set(write.frame, (perFrame.get(write.frame) ?? 0) + 1);
        expect(Math.max(0, ...perFrame.values()), `${name}: competing corrections`).toBeLessThanOrEqual(1);
        expect(writes.some(write => write.behavior === "smooth"), `${name}: smooth correction`).toBe(false);
        const samples = trace.frames.filter(frame => frame.scroller === name);
        const backwards = samples.filter((frame, index) => {
          const previous = samples[index - 1];
          return previous && frame.phase === previous.phase && /passive|^inline-latest$|^full-area-latest$/.test(frame.phase)
            && frame.following && previous.following && frame.extent >= previous.extent && frame.height === previous.height && frame.top < previous.top - 1;
        });
        expect(backwards, `${name}: stable-extent upward movement`).toEqual([]);
        summaries.push({ scroller: name, frames: samples.length, writes: writes.length, max: Math.max(0, ...perFrame.values()) });
      }
      expect(errors).toEqual([]);
      console.log(`${browserName} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} shell trace ${JSON.stringify(summaries)}`);
    } finally {
      const trace = await page.evaluate(() => window.__shellFrameTrace).catch(() => undefined);
      if (trace) {
        const observations = await page.evaluate(() => window.__shellObservations);
        if (observations) await testInfo.attach("shell-scroll-observations.json", { body: JSON.stringify(observations, null, 2), contentType: "application/json" });
      }
      if (trace) await testInfo.attach("integrated-shell-frames.json", { body: JSON.stringify(trace, null, 2), contentType: "application/json" });
      await browser.close();
    }
  });
}

for (const browserName of ["chromium", "webkit"] as const) {
  for (const touch of [false, true]) {
    for (const child of [false, true]) test(`${browserName} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} coordinated following`, { tag: "@perf" }, async ({ launchBrowser, request, baseURL }, testInfo) => {
      const browser = await launchBrowser(browserName);
      const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
        viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        let instrumented = false;
        await page.route("**/*.js", async route => {
          const response = await route.fetch();
          const source = await response.text();
          const body = source.replace(/isPinned\(\)\s*\{\s*return this\.pinned;\s*\}/g, () => {
            instrumented = true;
            return "isPinned() { const controllers = globalThis.__followControllers ??= []; if (!controllers.includes(this)) controllers.push(this); return this.pinned; }";
          });
          await route.fulfill({ response, body });
        });
        await request.post("/__e2e/reset");
        const items = Array.from({ length: 40 }, (_, i) => ({ id: `follow:${i}`, type: "assistant_message", createdAt: i + 1,
          markdown: `Message ${i}\n\n${"A deterministic line of transcript text. ".repeat(8)}` }));
        const snapshot = await request.post("/__e2e/chat", { data: { action: "seed", child, items } }).then(r => r.json());
        if (child) await request.post("/__e2e/chat", { data: { action: "seed", items: [{ id: "follow:child", type: "tool", createdAt: 1,
          name: "task", status: "completed", input: JSON.stringify({ description: "Follow fixture", subagent_type: "explore", prompt: "go" }),
          childConversationId: snapshot.conversation.id }] } });
        const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
        await page.goto(`/?t=${encodeURIComponent(token)}`);
        if (touch) await page.locator("#touch-tab-chat").click();
        else await openChatPanel(page);
        if (child) {
          await page.locator("#chat-subagents summary").click();
          await page.getByRole("button", { name: "explore · Follow fixture" }).click();
        }
        const selector = child ? "#chat-drilldown-timeline" : "#chat-timeline";
        const latest = child ? "#chat-drilldown-latest" : "#chat-latest";
        const scroller = page.locator(selector);
        const frames = () => page.evaluate(() => new Promise<void>(resolve => {
          let left = 4;
          const next = () => { if (--left) requestAnimationFrame(next); else resolve(); };
          requestAnimationFrame(next);
        }));
        const bottom = () => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
        const following = () => page.evaluate(index => window.__followControllers[index]!.isPinned(), child ? 1 : 0);
        const phase = (name: string) => page.evaluate(value => { window.__followTrace.phase = value; }, name);
        await expect(page.locator('[data-chat-item-id="follow:39"]')).toBeVisible();
        await expect.poll(bottom).toBeLessThan(2);
        await frames();
        expect(instrumented).toBe(true);
        await scroller.evaluate((el, isChild) => {
          const state: Trace = { frame: 0, phase: "passive", reader: false, frames: [], writes: [] };
          window.__followTrace = state;
          const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
          Object.defineProperty(el, "scrollTop", { configurable: true, get() { return descriptor.get!.call(this); }, set(top: number) {
            state.writes.push({ frame: state.frame, phase: state.phase, top, before: descriptor.get!.call(this), extent: el.scrollHeight,
              height: el.clientHeight, source: new Error().stack ?? "", reader: state.reader });
            descriptor.set!.call(this, top);
          } });
          const scrollTo = el.scrollTo.bind(el);
          el.scrollTo = ((options: ScrollToOptions) => {
            state.writes.push({ frame: state.frame, phase: state.phase, top: options.top ?? el.scrollTop, before: el.scrollTop, extent: el.scrollHeight,
              height: el.clientHeight, behavior: options.behavior, source: new Error().stack ?? "", reader: state.reader });
            scrollTo(options);
          }) as typeof el.scrollTo;
          const sample = () => {
            state.frame++;
            state.frames.push({ frame: state.frame, phase: state.phase, top: el.scrollTop, extent: el.scrollHeight, height: el.clientHeight,
              following: window.__followControllers[isChild ? 1 : 0]!.isPinned() });
            if (el.isConnected) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, child);
        const append = async (i: number) => {
          const response = await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id,
            item: { id: `append:${i}`, type: "assistant_message", createdAt: 100 + i, markdown: `Append ${i}\n\n${"Streaming text. ".repeat(25)}` } } });
          expect(response.ok()).toBe(true);
          await expect(page.locator(`[data-chat-item-id="append:${i}"]`)).toBeAttached();
          await frames();
        };
        for (let i = 0; i < 8; i++) { await append(i); expect(await following()).toBe(true); await expect.poll(bottom).toBeLessThan(2); }
        await phase("reading");
        await scroller.evaluate(el => { window.__followTrace.reader = true; el.scrollTop -= 700; window.__followTrace.reader = false; });
        await frames();
        await append(8);
        expect(await following()).toBe(false);
        await expect(page.locator(latest)).toBeVisible();
        await phase("latest");
        const arrivingDuringLatest = append(9);
        await page.locator(latest).click();
        await arrivingDuringLatest;
        await frames();
        await expect.poll(bottom).toBeLessThan(2);
        for (let i = 10; i < 13; i++) { await append(i); await expect.poll(bottom).toBeLessThan(2); }

        await phase("upward");
        if (touch) {
          // Playwright has no cross-engine swipe API. Deliver the touch input
          // sequence and its 4px default movement deterministically in the page.
          await scroller.evaluate(el => {
            for (const [name, y] of [["touchstart", 100], ["touchmove", 104]] as const) {
              const event = new Event(name, { bubbles: true });
              Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientY: y }] });
              el.dispatchEvent(event);
            }
            window.__followTrace.reader = true; el.scrollTop -= 4; window.__followTrace.reader = false;
          });
        } else {
          await scroller.hover(); await page.mouse.wheel(0, -4);
        }
        await expect.poll(following).toBe(false);
        await frames();
        const readerTop = await scroller.evaluate(el => el.scrollTop);
        await append(13);
        expect(await following()).toBe(false);
        expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - readerTop)).toBeLessThan(2);

        // A latest request interrupted before its queued frame must never land.
        await phase("interrupted-latest");
        await scroller.evaluate((el, button) => {
          document.querySelector<HTMLButtonElement>(button)!.click();
          if (navigator.maxTouchPoints) {
            for (const [name, y] of [["touchstart", 100], ["touchmove", 104]] as const) {
              const event = new Event(name, { bubbles: true });
              Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
              el.dispatchEvent(event);
            }
          } else el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -4 }));
          window.__followTrace.reader = true; el.scrollTop -= 4; window.__followTrace.reader = false;
        }, latest);
        await frames();
        expect(await following()).toBe(false);
        const interruptedTop = await scroller.evaluate(el => el.scrollTop);
        await append(14);
        expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - interruptedTop)).toBeLessThan(2);

        await phase("resize");
        await page.setViewportSize(touch ? { width: 390, height: 744 } : { width: 1440, height: 800 });
        await frames();
        expect(await following()).toBe(false);
        await phase("intrinsic-grow");
        await scroller.evaluate(el => { el.querySelector<HTMLElement>('[data-chat-item-id="follow:0"]')!.style.height = "1000px"; });
        await frames();
        expect(await following()).toBe(false);
        await phase("extent-shrink");
        await scroller.evaluate(el => {
          for (const item of el.querySelectorAll<HTMLElement>("[data-chat-item-id]")) item.style.display = "none";
        });
        await frames();
        expect(await scroller.evaluate(el => el.scrollTop)).toBe(0);
        expect(await following()).toBe(false);
        await append(15);
        expect(await following()).toBe(false);

        await phase("completion");
        await scroller.evaluate(el => {
          for (const item of el.querySelectorAll<HTMLElement>("[data-chat-item-id]")) item.style.removeProperty("display");
        });
        await frames();
        await page.locator(latest).click();
        const output = Array.from({ length: 30 }, (_, i) => `command line ${i}`).join("\n");
        for (const status of ["running", "completed"] as const) {
          const response = await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id,
            item: { id: "follow:command", type: "command", createdAt: 200, command: "deterministic-fixture", status, output,
              ...(status === "completed" ? { exitCode: 0 } : {}) } } });
          expect(response.ok()).toBe(true);
          await expect(page.locator('[data-chat-item-id="follow:command"]')).toHaveClass(new RegExp(`\\bis-${status}\\b`));
          await frames();
          expect(await following()).toBe(true);
          await expect.poll(bottom).toBeLessThan(2);
        }
        await phase("activity-toggle");
        for (let toggle = 0; toggle < 2; toggle++) {
          await page.locator('[data-chat-item-id="follow:command"]').evaluate(row => row.querySelector<HTMLElement>("summary")!.click());
          await frames();
          expect(await following()).toBe(true);
          await expect.poll(bottom).toBeLessThan(2);
        }
        const trace = await page.evaluate(() => window.__followTrace);
        const automatic = trace.writes.filter(write => !write.reader);
        expect(automatic.some(write => write.behavior === "smooth")).toBe(false);
        const counts = new Map<number, number>();
        for (const write of automatic) counts.set(write.frame, (counts.get(write.frame) ?? 0) + 1);
        expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(1);
        const backwards = trace.frames.filter((frame, i) => {
          const prior = trace.frames[i - 1];
          return prior && ["passive", "latest"].includes(frame.phase) && frame.phase === prior.phase
            && frame.extent >= prior.extent && frame.height === prior.height && frame.top < prior.top - 1;
        });
        expect(backwards).toEqual([]);
        expect(errors).toEqual([]);
        console.log(`${browserName} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"}: ${trace.frames.length} frames, ${automatic.length} automatic writes, max ${Math.max(0, ...counts.values())}/frame, ${backwards.length} stable-extent upward frames`);
      } finally {
        const trace = await page.evaluate(() => window.__followTrace).catch(() => undefined);
        if (trace) await testInfo.attach("follow-frames.json", { body: JSON.stringify(trace, null, 2), contentType: "application/json" });
        await browser.close();
      }
    });
  }
}
