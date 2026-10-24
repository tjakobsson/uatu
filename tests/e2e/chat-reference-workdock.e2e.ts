import { test as base, expect } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";
import type { Locator } from "@playwright/test";
import { expectWorkControlVisible, expectWorkLayoutReady } from "./work-panel-assertions";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);

async function fullyVisible(control: Locator) {
  await expectWorkControlVisible(control);
}

for (const engine of ["chromium", "webkit"] as const) for (const touch of [false, true]) {
  test(`reference work card owns its header and rows: ${engine} ${touch ? "phone" : "desktop"}`, async ({ launchBrowser, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
    await page.addInitScript(touch => {
      const viewport = Object.assign(new EventTarget(), { height: touch ? 844 : 900, width: touch ? 390 : 1280, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    }, touch);
    try {
      await request.post("/__e2e/reset");
      await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
      const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      if (touch) await page.locator("#touch-tab-chat").click(); else await openChatPanel(page);
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
      await page.locator("#chat-input").fill("Implement the task model and check layout independently");
      await page.locator("#chat-send").click();
      await expect(page.locator("#chat-stop")).toBeEnabled();
      const conversationId = await page.locator("#chat-conversation-select").inputValue();
      for (let i = 0; i < 6; i++) {
        const worker = await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId, background: i !== 0 } }).then(r => r.json());
        if (i >= 3) await request.post("/__e2e/chat", { data: { action: "opencode", op: "settleWorker", childId: worker.childId, workerState: i === 4 ? "error" : "completed" } });
      }
      await page.locator("#chat-input").fill("Check the remaining layout details");
      const firstQueued = page.waitForResponse(response => response.url().endsWith("/prompts") && response.request().method() === "POST");
      await page.locator("#chat-input").press("Alt+Enter"); await firstQueued;
      const card = page.locator("#chat-compact-workers"), pending = page.locator("[data-pending-toggle]");
      const revealWork = async () => {
        // Viewport/text/disclosure changes schedule measured desktop layout.
        await expectWorkLayoutReady(page);
        await expect.poll(() => page.locator("#chat-work-dock").evaluate(dock => {
          const workers = dock.querySelector<HTMLDetailsElement>("#chat-compact-workers");
          const queue = dock.querySelector<HTMLElement>("#chat-queue");
          const expanded = !!workers?.open && !workers.hidden || !!queue && !queue.hidden && queue.dataset.expanded === "true";
          return dock.hasAttribute("data-work-content-expanded") === expanded;
        })).toBe(true);
        const reveal = page.locator("#chat-work-toggle");
        if (await reveal.isVisible()) await reveal.click();
      };
      // Provider acknowledgements precede the live projection's render. Wait
      // for the actual canonical rows/counts before opening or measuring it.
      await expect(card.locator("[data-worker-id]")).toHaveCount(6);
      await expect(page.locator("#chat-compact-workers-label")).toHaveText("3 working · 3 finished");
      await expect(card).toBeVisible();
      await saveEvidence(info, "initial-disclosure-input.json", JSON.stringify(await card.evaluate(node => {
        const summary = node.querySelector("summary")!, r = summary.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { open: (node as HTMLDetailsElement).open, centerHit: hit ? { tag: hit.tagName, id: hit.id, className: hit.className } : null, summary: r.toJSON(), visibility: document.visibilityState };
      }), null, 2));
      if (!touch) {
        // This fixture intentionally exercises closed cards, not the new-work
        // desktop default. Establish that deliberate state through real controls.
        await expect(card).toHaveAttribute("open");
        await card.locator(":scope > summary").click({ position: { x: 8, y: 8 } });
        await expect(pending).toHaveAttribute("aria-expanded", "true");
        await pending.click();
      }
      await expect(card).not.toHaveAttribute("open");
      await card.locator(":scope > summary").click({ position: { x: 8, y: 8 } });
      await expect(card).toHaveAttribute("open", "");
      await captureScreenshot(page, info, `reference-${engine}-${touch ? "phone" : "desktop"}-initial`);
      await saveEvidence(info, "initial-geometry.json", JSON.stringify(await page.locator("#chat-work-dock").evaluate(dock => [...dock.children].map(node => ({ id: node.id, display: getComputedStyle(node).display, box: node.getBoundingClientRect().toJSON() }))), null, 2));
      await expect(card).toBeVisible();
      await expect(card.locator("[data-worker-id]")).toHaveCount(6);
      await expect(page.locator("#chat-subagents")).toBeHidden();
      await expect(page.locator("#chat-background-tasks")).toBeHidden();
      await expect(pending).toBeVisible();
      expect(await card.evaluate(node => getComputedStyle(node).display)).not.toBe("contents");
      expect(await card.evaluate(node => getComputedStyle(node).borderTopWidth)).toBe("1px");
      await expect.poll(() => card.evaluate(node => {
        const box = node.getBoundingClientRect(), heading = node.querySelector("summary")!.getBoundingClientRect();
        const rows = node.querySelector("#chat-compact-workers-items")!.getBoundingClientRect();
        return heading.top >= box.top && rows.top >= heading.bottom - 1 && rows.bottom <= box.bottom;
      })).toBe(true);
      expect(await pending.evaluate(node => !!node.closest("#chat-queue") && !node.closest("#chat-compact-workers"))).toBe(true);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        const scenes = touch ? [{ width: 390, height: 844, visual: 844 }, { width: 320, height: 568, visual: 568 }, { width: 390, height: 844, visual: 450 }, { width: 390, height: 844, visual: 380 }, { width: 844, height: 390, visual: 230 }] : [{ width: 1280, height: 900, visual: 900 }, { width: 1280, height: 480, visual: 480 }];
        for (const scene of scenes) {
          await page.setViewportSize({ width: scene.width, height: scene.height });
          await page.evaluate(scene => { Object.assign(window.visualViewport!, { height: scene.visual, width: scene.width }); window.visualViewport!.dispatchEvent(new Event("resize")); }, scene);
          await page.locator("#chat-input").fill("Keep the composing draft");
          for (const expanded of [false, true]) {
            await revealWork();
            if ((await card.getAttribute("open") !== null) !== expanded) await card.locator(":scope > summary").click({ position: { x: 8, y: 8 } });
            await revealWork();
            // Neither card's heading may fold into a shared scroll viewport.
            await pending.scrollIntoViewIfNeeded();
            await expect(pending).toBeInViewport();
            await saveEvidence(info, `geometry-${theme}-${scene.width}-${scene.visual}-${expanded}.json`, JSON.stringify(await page.evaluate(() => Object.fromEntries(["chat-work-dock", "chat-compact-workers", "chat-queue", "chat-queue-content", "chat-composer", "chat-timeline"].map(id => { const node = document.getElementById(id)!; return [id, { box: node.getBoundingClientRect().toJSON(), scroll: node.scrollTop, css: node.getAttribute("style"), min: getComputedStyle(node).minHeight, max: getComputedStyle(node).maxHeight }]; }))), null, 2));
            const scrollers = await page.locator("#chat-work-dock").evaluate(node => [node, ...node.querySelectorAll("*")].filter(child => child.getBoundingClientRect().height > 0 && /auto|scroll/.test(getComputedStyle(child).overflowY)).map(child => child.id));
            expect(scrollers).toEqual(expanded ? ["chat-compact-workers-items"] : []);
            expect((await pending.boundingBox())!.y).toBeGreaterThanOrEqual((await card.boundingBox())!.y + (await card.boundingBox())!.height + 7);
            await expect(page.locator("#chat-input")).toHaveValue("Keep the composing draft");
            await captureScreenshot(page, info, `reference-${engine}-${touch ? "phone" : "desktop"}-${theme}-${scene.width}-${scene.visual}-${expanded}`);
            await pending.click();
            await expect(pending).toHaveAttribute("aria-expanded", "true");
            await revealWork();
            await expectWorkLayoutReady(page);
            await fullyVisible(card.locator(":scope > summary")); await fullyVisible(pending);
            const action = page.locator("[data-queue-remove]").last();
            await pending.focus(); await action.focus(); await fullyVisible(action);
            await fullyVisible(page.locator("#chat-send")); await fullyVisible(page.locator("#chat-stop"));
            await captureScreenshot(page, info, `independent-${engine}-${touch ? "phone" : "desktop"}-${theme}-${scene.width}-${scene.visual}-${expanded}-queue-open`);
            await pending.click();
            await expect(pending).toHaveAttribute("aria-expanded", "false");
          }
        }
      }
      // Saturated real route state: twenty canonical workers and the full
      // twenty-message inbox, with either disclosure and at 200% root text.
      await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1280, height: 900 });
      await page.evaluate(touch => { Object.assign(window.visualViewport!, { height: touch ? 844 : 900, width: touch ? 390 : 1280 }); window.visualViewport!.dispatchEvent(new Event("resize")); }, touch);
      let lastChild = "";
      for (let i = 0; i < 14; i++) {
        const worker = await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } }).then(r => r.json());
        lastChild = worker.childId;
      }
      for (let i = 1; i < 20; i++) {
        await page.locator("#chat-input").fill(`Follow-up layout check ${i}`);
        const accepted = page.waitForResponse(response => response.url().endsWith("/prompts") && response.request().method() === "POST");
        await page.locator("#chat-input").press("Alt+Enter"); await accepted;
        await expect(page.locator(".chat-queued-message")).toHaveCount(i + 1);
      }
      await expect(card.locator("[data-worker-id]")).toHaveCount(20);
      await expect(page.locator(".chat-queued-message")).toHaveCount(20);
      await expect(pending).toHaveText("20 queued");
      const scrollState = () => page.evaluate(() => Object.fromEntries(["chat-compact-workers-items", "chat-queue-content", "chat-work-dock", "chat-timeline"].map(id => [id, document.getElementById(id)!.scrollTop])));
      for (const enlarged of [false, true]) {
        if (enlarged) await page.addStyleTag({ content: "html { font-size: 200% !important }" });
        await revealWork();
        if (await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
        await revealWork();
        for (const workersOpen of [false, true]) for (const queueOpen of [false, true]) {
          if ((await card.getAttribute("open") !== null) !== workersOpen) await card.locator(":scope > summary").click({ position: { x: 8, y: 8 } });
          await expect(card).toHaveJSProperty("open", workersOpen);
          if ((await pending.getAttribute("aria-expanded") === "true") !== queueOpen) await pending.click();
          await expect(pending).toHaveAttribute("aria-expanded", String(queueOpen));
          await revealWork();
          await expectWorkLayoutReady(page);
          if (!workersOpen && !queueOpen) {
            const closed = await page.locator("#chat-compact-workers, #chat-queue").evaluateAll(cards => cards.map(card => {
              const css = getComputedStyle(card);
              return { actual: card.getBoundingClientRect().height, natural: card.querySelector("summary, .chat-queue-header")!.getBoundingClientRect().height + (parseFloat(css.borderTopWidth) || 0) + (parseFloat(css.borderBottomWidth) || 0) };
            }));
            for (const card of closed) expect(card.actual).toBeCloseTo(card.natural, 0);
          }
          await fullyVisible(card.locator(":scope > summary"));
          await fullyVisible(pending);
          const scrollers = await page.locator("#chat-work-dock").evaluate(node => [node, ...node.querySelectorAll("*")].filter(child => child.getBoundingClientRect().height > 0 && /auto|scroll/.test(getComputedStyle(child).overflowY)).map(child => child.id));
          expect(scrollers).toEqual([...(workersOpen ? ["chat-compact-workers-items"] : []), ...(queueOpen ? ["chat-queue-content"] : [])]);
          if (queueOpen) {
            const remove = page.locator("[data-queue-remove]").last();
            await remove.focus();
            await fullyVisible(remove);
          }
          if (workersOpen && queueOpen) {
            const budget = await page.locator("#chat-work-dock").evaluate(dock => {
              const surface = document.querySelector<HTMLElement>("#chat-surface")!;
              const transcript = document.querySelector<HTMLElement>(".chat-transcript-area")!;
              const css = getComputedStyle(surface), px = (s: string) => parseFloat(s) || 0;
              const fixed = [...surface.children].reduce((sum, node) => {
                const style = getComputedStyle(node);
                return node === dock || node === transcript || style.display === "none" || ["absolute", "fixed"].includes(style.position) ? sum : sum + node.getBoundingClientRect().height + px(style.marginTop) + px(style.marginBottom);
              }, px(css.paddingTop) + px(css.paddingBottom));
              return { remaining: surface.clientHeight - fixed, dock: dock.getBoundingClientRect().height, transcript: transcript.clientHeight, oldCap: document.documentElement.dataset.uiMode === "touch" ? (window.visualViewport?.height ?? innerHeight) * .35 : Math.min(surface.clientHeight * .4, 400) };
            });
            await saveEvidence(info, `expanded-budget-${enlarged ? "200" : "100"}.json`, JSON.stringify(budget, null, 2));
            if (!enlarged) {
              // Fine-pointer desktop keeps a 35% reading band (200–280px);
              // comfortable/touch keeps 20% (32–96px), not one phone budget.
              const reading = touch ? Math.min(96, Math.max(32, budget.remaining * .2)) : Math.min(280, Math.max(200, budget.remaining * .35));
              expect(budget.dock).toBeGreaterThan(budget.oldCap);
              expect(budget.transcript).toBeCloseTo(reading, 0);
              expect(budget.dock + budget.transcript).toBeCloseTo(budget.remaining, 0);
              // Reconstruct only 005cb41's original normal-size caps, so the
              // evidence includes actual before/after layout, not just math.
              const previous = await page.addStyleTag({ content: touch
                ? 'html[data-ui-mode="touch"] .chat-work-dock { --chat-work-budget: calc(var(--chat-visual-height) * .35) !important; } html[data-ui-mode="touch"] .chat-transcript-area { min-height: 0 !important; }'
                : 'html[data-ui-mode="desktop"] .chat-work-dock { --chat-work-budget: min(calc(var(--chat-panel-height) * .4), 25rem) !important; } html[data-ui-mode="desktop"] .chat-transcript-area { min-height: min(12rem, calc(var(--chat-panel-height) * .35)) !important; }' });
              await expect.poll(() => page.locator("#chat-work-dock").evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(budget.oldCap + 1);
              const before = await page.locator("#chat-work-dock").evaluate(node => node.getBoundingClientRect().height);
              await captureScreenshot(page, info, `expanded-budget-${engine}-${touch ? "phone" : "desktop"}-previous-cap`);
              await previous.evaluate(node => node.remove());
              await expect.poll(() => page.locator("#chat-work-dock").evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(budget.dock, 0);
              await saveEvidence(info, "expanded-budget-before-after.json", JSON.stringify({ before, after: budget.dock, conversation: budget.transcript, remaining: budget.remaining, baseline: "005cb41 normal-size CSS caps reconstructed over the same 20+20 state" }, null, 2));
            }
            // Mobile WebKit does not expose wheel input. Its hardware-keyboard
            // PageDown performs native scroll routing through a pane action;
            // Chromium still covers real wheel and touch gestures below.
            for (const id of ["chat-compact-workers-items", "chat-queue-content"]) {
              const nativeKey = touch && engine === "webkit";
              if (nativeKey) await page.locator(`#${id} button`).first().focus();
              await page.locator(`#${id}`).evaluate(node => node.scrollTop = 0);
              // Focus and restored layout can schedule resize/reading-anchor
              // corrections. Wall-clock polling can look stable while rendering
              // is paused: require three unchanged actual frames after setup,
              // including pane/header geometry, before the pre-input baseline.
              const ready = await page.evaluateHandle(() => {
                let previous = "", stable = 0, frame = 0;
                const sample = () => {
                  const current = JSON.stringify({
                    panes: ["chat-compact-workers-items", "chat-queue-content", "chat-work-dock", "chat-timeline"].map(id => {
                      const node = document.getElementById(id)!;
                      return [id, node.scrollTop, node.clientHeight, node.scrollHeight, node.getBoundingClientRect().toJSON()];
                    }),
                    headers: [...document.querySelectorAll("#chat-compact-workers > summary, [data-pending-toggle]")].map(node => node.getBoundingClientRect().toJSON()),
                    active: document.querySelector("#chat-work-dock")?.getAttribute("data-work-active"),
                  });
                  stable = current === previous ? stable + 1 : 0; previous = current;
                  if (stable < 3) frame = requestAnimationFrame(sample);
                };
                frame = requestAnimationFrame(sample);
                return { get stable() { return stable; }, stop: () => cancelAnimationFrame(frame) };
              });
              try {
                await expect.poll(() => ready.evaluate(state => state.stable)).toBeGreaterThanOrEqual(3);
              } finally { await ready.evaluate(state => state.stop()); await ready.dispose(); }
              const before = await scrollState();
              const headerBefore = [await card.locator(":scope > summary").boundingBox(), await pending.boundingBox()];
              // Keep a sticky record of sibling/header movement, including
              // transient changes that return before native input settles.
              const isolation = await page.evaluateHandle(({ id, before }) => {
                const changes: { id: string; before: number; after: number }[] = [];
                const headers = [...document.querySelectorAll("#chat-compact-workers > summary, [data-pending-toggle]")];
                const headerRects = headers.map(node => JSON.stringify(node.getBoundingClientRect()));
                const movedHeaders: number[] = [];
                let frame = 0;
                const sample = () => {
                  for (const other of Object.keys(before)) if (other !== id) {
                    const after = document.getElementById(other)!.scrollTop;
                    if (after !== before[other] && !changes.some(change => change.id === other)) changes.push({ id: other, before: before[other]!, after });
                  }
                  headers.forEach((node, index) => {
                    if (JSON.stringify(node.getBoundingClientRect()) !== headerRects[index] && !movedHeaders.includes(index)) movedHeaders.push(index);
                  });
                };
                const tick = () => { sample(); frame = requestAnimationFrame(tick); };
                document.addEventListener("scroll", sample, true);
                tick();
                return { changes, movedHeaders, stop: () => { cancelAnimationFrame(frame); document.removeEventListener("scroll", sample, true); sample(); } };
              }, { id, before });
              try {
                if (nativeKey) await page.locator(`#${id} button`).first().press("PageDown");
                else { await page.locator(`#${id}`).hover(); await page.mouse.wheel(0, 180); }
                await expect.poll(async () => (await scrollState())[id]).toBeGreaterThan(0);
                // PageDown may still animate after the first nonzero offset,
                // even with reduced motion. Finish this pane's native input
                // before asserting isolation or beginning the sibling's input.
                let previous = -1, stable = 0;
                await expect.poll(async () => {
                  const current = (await scrollState())[id]!;
                  stable = current === previous ? stable + 1 : 0; previous = current;
                  return stable;
                }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
                const after = await scrollState();
                for (const other of Object.keys(before)) if (other !== id) expect(after[other], `${id} must not scroll ${other}`).toBe(before[other]);
                expect(await isolation.evaluate(monitor => { monitor.stop(); return { offsets: monitor.changes, headers: monitor.movedHeaders }; })).toEqual({ offsets: [], headers: [] });
                expect([await card.locator(":scope > summary").boundingBox(), await pending.boundingBox()]).toEqual(headerBefore);
                await fullyVisible(card.locator(":scope > summary")); await fullyVisible(pending);
              } finally { await isolation.evaluate(monitor => monitor.stop()); await isolation.dispose(); }
            }
            if (touch && engine === "chromium") {
              const session = await page.context().newCDPSession(page);
              for (const id of ["chat-compact-workers-items", "chat-queue-content"]) {
                await page.locator(`#${id}`).evaluate(node => node.scrollTop = 0);
                const box = (await page.locator(`#${id}`).boundingBox())!;
                const before = await scrollState();
                await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height - 3 }] });
                for (let step = 1; step <= 5; step++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height - 3 - step * Math.min(12, (box.height - 6) / 5) }] });
                await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                await expect.poll(async () => (await scrollState())[id]).toBeGreaterThan(0);
                let previous = -1, stable = 0;
                await expect.poll(async () => {
                  const current = (await scrollState())[id]!;
                  stable = current === previous ? stable + 1 : 0; previous = current;
                  return stable;
                }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
                const after = await scrollState();
                for (const other of Object.keys(before)) if (other !== id) expect(after[other]).toBe(before[other]);
              }
              await session.detach();
            }
          }
          await captureScreenshot(page, info, `independent-${engine}-${touch ? "phone" : "desktop"}-20-workers-20-pending-${enlarged ? "200" : "100"}-${workersOpen}-${queueOpen}`);
        }
      }
      await pending.focus();
      const beforeUpdates = await scrollState();
      const focusedHeader = await pending.elementHandle();
      const workerUpdate = await request.post("/__e2e/chat", { data: { action: "opencode", op: "settleWorker", childId: lastChild, workerState: "completed" } });
      expect(workerUpdate.ok()).toBe(true);
      await expect(page.locator("#chat-compact-workers-label")).toHaveText("16 working · 4 finished");
      expect(await scrollState()).toEqual(beforeUpdates);
      const messageId = await page.locator(".chat-queued-message").last().getAttribute("data-chat-queued-id");
      expect(await page.evaluate(async ({ conversationId, messageId, token }) => {
        const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(messageId!)}?t=${encodeURIComponent(token)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), delivery: "steer" }) });
        return response.status;
      }, { conversationId, messageId, token })).toBe(200);
      await expect(pending).toHaveText("1 steer · 19 queued");
      await expect(pending).toBeFocused();
      expect(await pending.evaluate((node, previous) => node === previous, focusedHeader)).toBe(true);
      expect(await scrollState()).toEqual(beforeUpdates);
      await expect(card).toHaveAttribute("open", "");
      await expect(pending).toHaveAttribute("aria-expanded", "true");
      // Both engines and both device modes retain the same pane identity and
      // reading offsets through deliberate close/reopen, not just updates.
      const pane = await page.locator("#chat-queue-content").elementHandle();
      const beforeDisclosure = await scrollState();
      await pending.click(); await expect(pending).toHaveAttribute("aria-expanded", "false");
      await pending.click(); await expect(pending).toHaveAttribute("aria-expanded", "true");
      await expect.poll(scrollState).toEqual(beforeDisclosure);
      expect(await page.locator("#chat-queue-content").evaluate((node, previous) => node === previous, pane)).toBe(true);
      await card.locator(":scope > summary").click({ position: { x: 8, y: 8 } }); await expect(card).not.toHaveAttribute("open");
      await card.locator(":scope > summary").click({ position: { x: 8, y: 8 } }); await expect(card).toHaveAttribute("open", "");
      await expect.poll(scrollState).toEqual(beforeDisclosure);
    } finally { await page.close(); }
  });
}
