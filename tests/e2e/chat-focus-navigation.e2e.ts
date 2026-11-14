import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { settleScroll } from "./chat-shell-helpers";
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
  test(`${engine}: request navigation interrupts active forward catch-up @perf`, async ({ launchBrowser, request, baseURL }, info) => {
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

      // Arm the public pill action before the update. Its scroll event invokes
      // the handler while forward catch-up is demonstrably unfinished, rather
      // than racing a remote click against the short animation deadline.
      await timeline.evaluate(node => {
        const state = { triggered: false, beforeTop: node.scrollTop, gap: 0, targetOffset: 0 };
        Object.assign(window, { __requestNavigationProbe: state });
        const navigate = () => {
          const target = node.querySelector<HTMLElement>('[data-chat-item-id="permission:navigation"]');
          const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
          if (!target || !pill || pill.dataset.requestTarget !== "permission:navigation") return;
          const band = node.getBoundingClientRect();
          const rect = target.getBoundingClientRect();
          const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
          if (node.scrollTop <= state.beforeTop + 1 || gap <= 600 || rect.top <= band.bottom + 20) return;
          state.triggered = true;
          state.gap = gap;
          state.targetOffset = rect.top - band.top;
          node.removeEventListener("scroll", navigate);
          pill.click();
        };
        node.addEventListener("scroll", navigate, { passive: true });
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
      await expect(card).toBeFocused();
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
      await info.attach("request-navigation-geometry", { body: JSON.stringify({ probe: await probe(), revealed, retained }), contentType: "application/json" });
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
        await expect(card).toBeFocused();
        await settleScroll(timeline);
        // Native keyboard traversal establishes control focus on both engines;
        // do not repair focus with script or waive this setup assertion.
        await page.keyboard.press(engine === "webkit" ? "Alt+Tab" : "Tab");
        const control = card.getByRole("button", { name: "Allow once", exact: true });
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
            await expect(card).toBeFocused();
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
        await info.attach("permission-republish-probe", { body: JSON.stringify({ probe: await probe(), revealed, retained }), contentType: "application/json" });
      } finally {
        // The transport wrapper and DOM references belong only to this context.
        await browser.close();
      }
    });
  }
}
