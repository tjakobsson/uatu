import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { settleScroll } from "./chat-shell-helpers";
import { saveEvidence } from "./evidence";
import { LIVE_ENVELOPE_EVENT } from "../../src/shared/live-protocol";

type RepublishProbe = {
  oldCard: HTMLElement | null;
  oldControl: HTMLElement | null;
  marker: string;
  conversationId: string;
  cancel: boolean;
  triggered: boolean;
  connectedAtClick: boolean;
  focusedAtClick: boolean;
  retainedAfterClick: boolean;
  connectedAtBlur: boolean;
  blurredToBody: boolean;
  focusAfterActivation: number;
};
type ProbeWindow = Window & { __requestRepublishProbe: RepublishProbe };

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: request navigation interrupts pending forward catch-up @perf`, async ({ launchBrowser, request, baseURL }, info) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await request.post("/__e2e/reset");
      const tail = "Transcript content below the pending request.\n\n".repeat(100);
      const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Request navigation", items: [
        { id: "navigation:lead", type: "assistant_message", createdAt: 1, markdown: "Context before the request." },
        { id: "permission:navigation", type: "permission", createdAt: 2, requestId: "navigation", action: "bash", resources: ["synthetic command"], status: "pending" },
        { id: "navigation:tail", type: "assistant_message", createdAt: 3, markdown: tail },
      ] } }).then(response => response.json());
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await openChatPanel(page);
      await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
      const timeline = page.locator("#chat-timeline");
      const card = page.locator('[data-chat-item-id="permission:navigation"]');
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      await settleScroll(timeline);
      await expect(page.locator("#chat-requests-jump")).toHaveAttribute("data-request-target", "permission:navigation");

      // Arm the public pill action before the update. A resize observation on
      // the transcript runs after the frame's animation callbacks, so it clicks
      // once the growth is laid out and forward catch-up is due but has not yet
      // written a position. This does not depend on frame cost or easing.
      await timeline.evaluate(node => {
        const state = { triggered: false, beforeTop: node.scrollTop, gap: 0, targetOffset: 0 };
        Object.assign(window, { __requestNavigationProbe: state });
        const observer = new ResizeObserver(() => {
          const target = node.querySelector<HTMLElement>('[data-chat-item-id="permission:navigation"]');
          const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
          if (!target || !pill || pill.dataset.requestTarget !== "permission:navigation") return;
          const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
          if (gap <= 600 || Math.abs(node.scrollTop - state.beforeTop) > 1) return;
          state.triggered = true;
          state.gap = gap;
          state.targetOffset = target.getBoundingClientRect().top - node.getBoundingClientRect().top;
          observer.disconnect();
          pill.click();
        });
        observer.observe(document.getElementById("chat-items")!);
      });
      await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
        id: "navigation:lead", type: "assistant_message", createdAt: 1,
        markdown: "New streamed context before the request.\n\n".repeat(300),
      } } });
      const probe = () => page.evaluate(() => (window as unknown as {
        __requestNavigationProbe: { triggered: boolean; gap: number; targetOffset: number };
      }).__requestNavigationProbe);
      await expect.poll(async () => (await probe()).triggered).toBe(true);
      expect((await probe()).gap).toBeGreaterThan(600);
      await expect(card.locator(":scope > summary")).toBeFocused();
      const placement = () => card.evaluate(node => {
        const band = document.getElementById("chat-timeline")!.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return { top: rect.top - band.top, bottom: rect.bottom - band.bottom };
      });
      await expect.poll(async () => (await placement()).top).toBeGreaterThanOrEqual(-1);
      await expect.poll(async () => (await placement()).bottom).toBeLessThanOrEqual(1);
      await settleScroll(timeline);
      const revealed = await placement();

      await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
        id: "navigation:tail", type: "assistant_message", createdAt: 3, markdown: tail + "Later output after navigation.\n\n".repeat(30),
      } } });
      await expect(page.locator('[data-chat-item-id="navigation:tail"]')).toContainText("Later output after navigation.");
      await settleScroll(timeline);
      const retained = await placement();
      expect(retained.top).toBeGreaterThanOrEqual(-1);
      expect(retained.bottom).toBeLessThanOrEqual(1);
      expect(Math.abs(retained.top - revealed.top)).toBeLessThanOrEqual(2);
      await saveEvidence(info, `request-navigation-geometry-${engine}.json`, JSON.stringify({ probe: await probe(), revealed, retained }));
    } finally {
      await browser.close();
    }
  });

  test(`${engine}: Find Next pauses following when revealing a match below the viewport during catch-up @perf`, async ({ launchBrowser, request, baseURL }, info) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await request.post("/__e2e/reset");
      const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Find catch-up navigation", items: [
        { id: "find:lead", type: "assistant_message", createdAt: 1, markdown: "Initial short context." },
      ] } }).then(response => response.json());
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await openChatPanel(page);
      await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
      const timeline = page.locator("#chat-timeline");
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      await settleScroll(timeline);

      // Open Find on a query not yet in the transcript so following remains active.
      const needle = "catchup-find-target";
      await timeline.focus();
      await page.keyboard.press("ControlOrMeta+f");
      await expect(page.locator("#find-query")).toBeFocused();
      await page.locator("#find-query").fill(needle);
      await expect(page.locator("#find-status")).toHaveText("No results");

      // Arm Find Next once streamed output grows the timeline far below the
      // viewport and smooth catch-up is pending/active. Focus stays in Find.
      await timeline.evaluate((node, query) => {
        const measureMatch = (): { top: number; bottom: number } | null => {
          const band = node.getBoundingClientRect();
          const walker = document.createTreeWalker(document.getElementById("chat-items")!, NodeFilter.SHOW_TEXT);
          let current: Node | null;
          while ((current = walker.nextNode())) {
            const offset = current.textContent?.indexOf(query) ?? -1;
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(current, offset);
            range.setEnd(current, offset + query.length);
            const rect = range.getBoundingClientRect();
            return { top: rect.top - band.top, bottom: rect.bottom - band.bottom };
          }
          return null;
        };
        const state = { triggered: false, gap: 0, matchTopBefore: 0, viewportHeight: node.clientHeight, measureMatch };
        Object.assign(window, { __findCatchupProbe: state });
        const trigger = () => {
          if (state.triggered) return;
          const next = document.querySelector<HTMLButtonElement>("#find-next");
          const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
          const match = measureMatch();
          if (!next || next.disabled || gap <= 600 || !match || match.top <= node.clientHeight) return;
          state.triggered = true;
          state.gap = gap;
          state.matchTopBefore = match.top;
          state.viewportHeight = node.clientHeight;
          observer.disconnect();
          next.click();
        };
        const observer = new ResizeObserver(() => {
          trigger();
          if (!state.triggered) queueMicrotask(trigger);
        });
        observer.observe(document.getElementById("chat-items")!);
      }, needle);

      const streamed = [
        "Streamed lead paragraph above the target match.\n\n".repeat(100),
        `Target match line: ${needle}\n\n`,
        "Streamed tail paragraph below the target match.\n\n".repeat(100),
      ].join("");
      await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
        id: "find:stream", type: "assistant_message", createdAt: 2, markdown: streamed,
      } } });

      const probe = () => page.evaluate(() => {
        const { triggered, gap, matchTopBefore, viewportHeight } = (window as unknown as {
          __findCatchupProbe: { triggered: boolean; gap: number; matchTopBefore: number; viewportHeight: number };
        }).__findCatchupProbe;
        return { triggered, gap, matchTopBefore, viewportHeight };
      });
      await expect.poll(async () => (await probe()).triggered).toBe(true);
      expect((await probe()).gap).toBeGreaterThan(600);
      expect((await probe()).matchTopBefore).toBeGreaterThan((await probe()).viewportHeight);
      await expect(page.locator("#find-status")).toHaveText("1 of 1");

      const matchPlacement = () => page.evaluate(() => (window as unknown as {
        __findCatchupProbe: { measureMatch: () => { top: number; bottom: number } | null };
      }).__findCatchupProbe.measureMatch());

      await settleScroll(timeline);
      const revealed = await matchPlacement();
      expect(revealed).not.toBeNull();
      expect(revealed!.top).toBeGreaterThanOrEqual(-1);
      expect(revealed!.bottom).toBeLessThanOrEqual(1);

      // Additional streamed output after Find Next must keep following paused
      // and retain the selected match in place.
      await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
        id: "find:after", type: "assistant_message", createdAt: 3, markdown: "Later output after Find Next.\n\n".repeat(30),
      } } });
      await expect(page.locator('[data-chat-item-id="find:after"]')).toContainText("Later output after Find Next.");
      await settleScroll(timeline);
      const retained = await matchPlacement();
      expect(retained).not.toBeNull();
      expect(retained!.top).toBeGreaterThanOrEqual(-1);
      expect(retained!.bottom).toBeLessThanOrEqual(1);
      expect(Math.abs(retained!.top - revealed!.top)).toBeLessThanOrEqual(2);
      await expect(page.locator("#chat-latest")).toBeVisible();
      await saveEvidence(info, `find-catchup-geometry-${engine}.json`, JSON.stringify({ probe: await probe(), revealed, retained }));
    } finally {
      await browser.close();
    }
  });
}

for (const engine of ["chromium", "webkit"] as const) {
  for (const cancel of [false, true]) {
    test(`${engine}: queued permission republish ${cancel ? "respects deliberate blur before replacement" : "reveals the current card after render-induced focus loss"}`, async ({ launchBrowser, request, baseURL }, info) => {
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
      try {
        // Observe public transport delivery, after the application's synchronous
        // projection handler returns but before its queued transcript paint.
        // No render scheduling or application ownership state is intercepted.
        await page.addInitScript(eventName => {
          const add = EventSource.prototype.addEventListener;
          EventSource.prototype.addEventListener = function (this: EventSource, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
            if (type !== eventName || typeof listener !== "function") return add.call(this, type, listener, options);
            return add.call(this, type, function (this: EventSource, event: Event) {
              listener.call(this, event);
              const probe = (window as unknown as ProbeWindow).__requestRepublishProbe;
              if (!probe || probe.triggered) return;
              const envelope = JSON.parse((event as MessageEvent).data) as {
                topic: string; key?: string; event: { kind: string; data?: {
                  type?: string; item?: { id?: string; resources?: string[] };
                } };
              };
              if (envelope.topic !== "conversation" || envelope.key !== probe.conversationId
                || envelope.event.kind !== "data" || envelope.event.data?.type !== "item.upsert"
                || envelope.event.data.item?.id !== "permission:republish"
                || !envelope.event.data.item.resources?.includes(probe.marker)) return;
              const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
              probe.triggered = true;
              probe.connectedAtClick = Boolean(probe.oldCard?.isConnected && probe.oldControl?.isConnected
                && !probe.oldCard.textContent?.includes(probe.marker)
                && pill && !pill.hidden && pill.dataset.requestTarget === "permission:republish");
              probe.focusedAtClick = document.activeElement === probe.oldControl;
              if (!probe.connectedAtClick || !probe.focusedAtClick) return;
              // Intentional non-focus-taking activation of the REAL public
              // handler: model Safari's pill activation while DOM focus stays
              // inside the old request, without assuming native click focuses
              // buttons equally in Chromium and WebKit.
              pill!.click();
              probe.retainedAfterClick = document.activeElement === probe.oldControl;
              if (probe.cancel) {
                probe.connectedAtBlur = Boolean(probe.oldCard?.isConnected && probe.oldControl?.isConnected);
                probe.oldControl!.blur();
                probe.blurredToBody = document.activeElement === document.body;
              }
            }, options);
          } as typeof EventSource.prototype.addEventListener;
          document.addEventListener("focusin", event => {
            const probe = (window as unknown as ProbeWindow).__requestRepublishProbe;
            if (probe?.triggered && event.target instanceof Element
              && event.target.closest('[data-chat-item-id="permission:republish"]')) probe.focusAfterActivation++;
          });
        }, LIVE_ENVELOPE_EVENT);
        await request.post("/__e2e/reset");
        const permission = { id: "permission:republish", type: "permission", createdAt: 2,
          requestId: "republish", action: "bash", resources: ["synthetic command"], status: "pending" };
        const tail = "Transcript below the pending permission.\n\n".repeat(100);
        const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Permission republish", items: [
          { id: "republish:lead", type: "assistant_message", createdAt: 1, markdown: "Context before the request." },
          permission,
          { id: "republish:tail", type: "assistant_message", createdAt: 3, markdown: tail },
        ] } }).then(response => response.json());
        const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
        await page.goto(`/?t=${encodeURIComponent(token)}`);
        await openChatPanel(page);
        await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
        const timeline = page.locator("#chat-timeline");
        const card = page.locator('[data-chat-item-id="permission:republish"]');
        const pill = page.locator("#chat-requests-jump");
        await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
        await settleScroll(timeline);
        await pill.click();
        const summary = card.locator(":scope > summary");
        await expect(summary).toBeFocused();
        await settleScroll(timeline);
        // Native keyboard traversal establishes control focus on both engines;
        // do not repair focus with script or waive this setup assertion.
        const control = card.getByRole("button", { name: "Allow once", exact: true });
        await page.keyboard.press(engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab");
        await expect(control).toBeFocused();
        const band = (await timeline.boundingBox())!;
        await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
        await page.mouse.wheel(0, 1600);
        const placement = () => card.evaluate(node => {
          const band = document.getElementById("chat-timeline")!.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return { top: rect.top - band.top, bottom: rect.bottom - band.bottom, belowTop: rect.bottom - band.top };
        });
        await expect.poll(async () => (await placement()).belowTop).toBeLessThan(0);
        await settleScroll(timeline);
        await expect(control).toBeFocused();
        await expect(pill).toBeVisible();
        const marker = `queued-permission-republish-${engine}-${cancel ? "blur" : "retain"}`;
        await control.evaluate((node, options) => {
          (window as unknown as ProbeWindow).__requestRepublishProbe = {
            oldCard: node.closest<HTMLElement>('[data-chat-item-id="permission:republish"]'), oldControl: node as HTMLElement,
            ...options, triggered: false, connectedAtClick: false, focusedAtClick: false,
            retainedAfterClick: false, connectedAtBlur: false, blurredToBody: false, focusAfterActivation: 0,
          };
        }, { marker, cancel, conversationId: seeded.conversation.id });
        const probe = () => page.evaluate(() => {
          const { oldCard, oldControl, marker: _marker, conversationId: _id, ...observations } = (window as unknown as ProbeWindow).__requestRepublishProbe;
          return { ...observations, oldCardConnected: Boolean(oldCard?.isConnected), oldControlConnected: Boolean(oldControl?.isConnected) };
        });
        const republished = await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id,
          item: { ...permission, resources: [marker] } } });
        expect(republished.ok()).toBe(true);
        await expect.poll(async () => (await probe()).triggered).toBe(true);
        expect(await probe()).toMatchObject({ connectedAtClick: true, focusedAtClick: true, retainedAfterClick: true });
        await expect(card).toContainText(marker);
        await expect.poll(async () => (await probe()).oldCardConnected).toBe(false);
        expect((await probe()).oldControlConnected).toBe(false);
        const assertOutcome = async () => {
          if (cancel) {
            expect(await probe()).toMatchObject({ connectedAtBlur: true, blurredToBody: true, focusAfterActivation: 0 });
            await expect(page.locator("body")).toBeFocused();
            expect((await placement()).belowTop).toBeLessThan(0);
          } else {
            await expect(summary).toBeFocused();
            await expect.poll(async () => (await placement()).top).toBeGreaterThanOrEqual(-1);
            await expect.poll(async () => (await placement()).bottom).toBeLessThanOrEqual(1);
          }
        };
        await settleScroll(timeline);
        await assertOutcome();
        const revealed = await placement();
        await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
          id: "republish:tail", type: "assistant_message", createdAt: 3, markdown: tail + "Later output after republish.\n\n".repeat(30),
        } } });
        await expect(page.locator('[data-chat-item-id="republish:tail"]')).toContainText("Later output after republish.");
        await settleScroll(timeline);
        await assertOutcome();
        const retained = await placement();
        expect(Math.abs(retained.top - revealed.top)).toBeLessThanOrEqual(2);
        await saveEvidence(info, `permission-republish-probe-${engine}-${cancel ? "blur" : "retain"}.json`,
          JSON.stringify({ probe: await probe(), revealed, retained }));
      } finally {
        // The transport wrapper and DOM references belong only to this context.
        await browser.close();
      }
    });
  }
}
