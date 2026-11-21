import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { control, position, settleScroll } from "./chat-shell-helpers";
import { saveEvidence } from "./evidence";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  for (const removed of [false, true]) {
    test(`${engine}: ${removed
      ? "passive snapshot removal cancels pending request navigation without stealing focus"
      : "pending request navigation survives a passive snapshot replacement"}`, async ({ launchBrowser, request, baseURL }, info) => {
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
      let phase = 0;
      const geometry: Record<string, unknown> = {};
      try {
        await request.post("/__e2e/reset");
        const permission = { id: "permission:snapshot-navigation", type: "permission", createdAt: 2,
          requestId: "snapshot-navigation", action: "bash", resources: ["Original synthetic resource"], status: "pending" };
        const seeded = await control(request, { action: "seed", title: "Passive snapshot navigation", configuration: { mode: "build" }, items: [
          { id: "snapshot:lead", type: "assistant_message", createdAt: 1, markdown: "Context before the request." },
          permission,
          ...Array.from({ length: 24 }, (_, index) => ({ id: `snapshot:tail:${index}`, type: "assistant_message", createdAt: index + 3,
            markdown: `Reading row ${index}.\n\nStable context below the pending request.\n\nMore context for this reading row.` })),
        ] });
        const id = seeded.conversation.id as string;
        const marker = "Replacement synthetic resource";
        await page.addInitScript(({ id, marker, removed }) => {
          const state = {
            armed: false, consumed: false, held: false, released: false, parsed: false,
            payloadMatches: false, activated: false, connectedAtClick: false, composerAtClick: false,
            pillReady: false, retainedAfterClick: false, firstFrame: false, planBeforeFrame: false,
            oldConnectedAtFrame: false, oldCurrentAtFrame: false, sameSelectionAtFrame: false,
            requestFocusEvents: 0, errors: 0,
          };
          const selector = '[data-chat-item-id="permission:snapshot-navigation"]';
          let old: HTMLElement | null = null;
          let composer: HTMLElement | null = null;
          let release = () => {};
          const current = () => document.querySelector<HTMLElement>(selector);
          Reflect.set(window, "__snapshotNavigation", {
            arm() { old = current(); composer = document.getElementById("chat-input"); state.armed = true; },
            release() { state.released = true; release(); },
            evidence() {
              return { ...state, oldConnected: Boolean(old?.isConnected), oldIsCurrent: current() === old,
                composerFocused: document.activeElement === composer,
                originalStillRendered: Boolean(current()?.textContent?.includes("Original synthetic resource")) };
            },
          });
          document.addEventListener("focusin", event => {
            if (state.activated && event.target instanceof Element && event.target.closest(selector)) state.requestFocusEvents++;
          }, true);
          const nativeFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");
            const matches = state.armed && !state.consumed && method === "GET"
              && url.pathname === `/api/chat/conversations/${encodeURIComponent(id)}` && !url.searchParams.has("cursor");
            if (!matches) return nativeFetch(input, init);
            state.consumed = true;
            state.held = true;
            // Hold BEFORE native fetch so provider updates belong to the real
            // response. Cleanup and the application's read AbortSignal both
            // release this gate; no never-settling response promise is created.
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            await new Promise<void>(resolve => {
              release = resolve;
              if (state.released || signal?.aborted) resolve();
              else signal?.addEventListener("abort", resolve, { once: true });
            });
            signal?.removeEventListener("abort", release);
            const response = await nativeFetch(input, init);
            const nativeJson = response.json.bind(response);
            Object.defineProperty(response, "json", { configurable: true, value: () => nativeJson().then(value => {
              // Never throw assertions through ChatApiClient's json().catch().
              // Preserve the native body and capture setup failures as evidence.
              state.parsed = true;
              try {
                const item = value.items?.find((item: { id: string }) => item.id === "permission:snapshot-navigation");
                state.payloadMatches = response.ok && value.conversation?.id === id && value.configuration?.mode === "plan"
                  && !value.olderCursor && (removed ? !item : item?.status === "pending" && item.resources?.includes(marker));
                const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
                state.connectedAtClick = Boolean(old?.isConnected && current() === old);
                state.composerAtClick = document.activeElement === composer;
                state.pillReady = Boolean(pill && !pill.hidden && !pill.disabled && pill.dataset.requestTarget === "permission:snapshot-navigation");
                if (state.payloadMatches && state.connectedAtClick && state.composerAtClick && state.pillReady) {
                  // Register an ordinary observer BEFORE the handler queues its
                  // correction. Installation updates this public mode label
                  // synchronously; transcript rendering is queued afterwards.
                  requestAnimationFrame(() => {
                    state.firstFrame = true;
                    state.planBeforeFrame = Boolean(document.getElementById("chat-configuration-trigger")?.getAttribute("aria-label")?.includes("Mode: Plan"));
                    state.oldConnectedAtFrame = Boolean(old?.isConnected);
                    state.oldCurrentAtFrame = current() === old;
                    state.sameSelectionAtFrame = (document.getElementById("chat-conversation-select") as HTMLSelectElement | null)?.value === id;
                  });
                  state.activated = true;
                  // Intentional non-focus-taking activation of the REAL pill
                  // handler, preserving the natively focused composer in both
                  // engines rather than relying on Safari button focus policy.
                  pill!.click();
                  state.retainedAfterClick = document.activeElement === composer;
                }
              } catch { state.errors++; }
              return value;
            }) });
            return response;
          };
        }, { id, marker, removed });
        const evidence = () => page.evaluate(() => Reflect.get(window, "__snapshotNavigation")?.evidence());
        const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
        await page.goto(`/?t=${encodeURIComponent(token)}`);
        await openChatPanel(page);
        const picker = page.locator("#chat-conversation-select");
        await picker.selectOption(id);
        const timeline = page.locator("#chat-timeline");
        const card = timeline.locator('[data-chat-item-id="permission:snapshot-navigation"]');
        const composer = page.locator("#chat-input");
        await expect(card).toBeAttached();
        await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Mode: Build/);
        await expect.poll(async () => Math.abs((await position(timeline)).bottom)).toBeLessThanOrEqual(2);
        await settleScroll(timeline);
        await timeline.hover();
        await page.mouse.wheel(0, -400);
        await expect.poll(async () => (await position(timeline)).bottom).toBeGreaterThan(200);
        await settleScroll(timeline);
        await composer.click();
        await expect(composer).toBeFocused();
        await settleScroll(timeline);
        const placement = () => card.evaluate(node => {
          const band = document.getElementById("chat-timeline")!.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return { top: rect.top - band.top, bottom: rect.bottom - band.bottom, belowTop: rect.bottom - band.top };
        });
        expect((await placement()).belowTop).toBeLessThan(0);
        await expect(page.locator("#chat-requests-jump")).toBeVisible();
        phase = 1;
        await page.evaluate(() => Reflect.get(window, "__snapshotNavigation").arm());
        await control(request, { action: "resync" });
        await expect.poll(async () => (await evidence()).held).toBe(true);
        phase = 2;
        // Resync closes the old topic subscription before this read. Mutations
        // now reach the authoritative snapshot, not an earlier streamed paint.
        if (removed) await control(request, { action: "removeItem", conversationId: id, itemId: permission.id });
        else await control(request, { action: "item", conversationId: id, item: { ...permission, resources: [marker] } });
        await control(request, { action: "configuration", conversationId: id, configuration: { mode: "plan" } });
        await settleScroll(timeline);
        expect(await evidence()).toMatchObject({ oldConnected: true, oldIsCurrent: true, originalStillRendered: true, composerFocused: true, parsed: false });
        await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Mode: Build/);
        const reading = await timeline.evaluate(node => {
          const band = node.getBoundingClientRect();
          const row = [...node.querySelectorAll<HTMLElement>('[data-chat-item-id^="snapshot:tail:"]')].find(row => {
            const rect = row.getBoundingClientRect();
            return rect.height > 0 && rect.top >= band.top && rect.bottom <= band.bottom;
          });
          if (!row) throw new Error("Native wheel setup left no complete reading row");
          return { id: row.dataset.chatItemId!, offset: row.getBoundingClientRect().top - band.top };
        });
        const readingDrift = () => timeline.evaluate((node, reading) => {
          const row = [...node.querySelectorAll<HTMLElement>("[data-chat-item-id]")].find(row => row.dataset.chatItemId === reading.id);
          return row ? Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - reading.offset) : Infinity;
        }, reading);
        phase = 3;
        await page.evaluate(() => Reflect.get(window, "__snapshotNavigation").release());
        await expect.poll(async () => (await evidence()).parsed).toBe(true);
        expect(await evidence()).toMatchObject({ payloadMatches: true, activated: true, connectedAtClick: true,
          composerAtClick: true, pillReady: true, retainedAfterClick: true, errors: 0 });
        phase = 4;
        await expect.poll(async () => (await evidence()).firstFrame).toBe(true);
        expect(await evidence()).toMatchObject({ planBeforeFrame: true, oldConnectedAtFrame: true, oldCurrentAtFrame: true, sameSelectionAtFrame: true });
        await expect(picker).toHaveValue(id);
        if (removed) await expect(card).toHaveCount(0);
        else await expect(card).toContainText(marker);
        await expect.poll(async () => (await evidence()).oldConnected).toBe(false);
        phase = 5;
        const assertOutcome = async () => {
          if (removed) {
            await expect(card).toHaveCount(0);
            await expect(page.locator("#chat-requests-jump")).toBeHidden();
            await expect(composer).toBeFocused();
            expect((await evidence()).requestFocusEvents).toBe(0);
            expect(await readingDrift()).toBeLessThanOrEqual(2);
          } else {
            await expect(card.locator(":scope > summary")).toBeFocused();
            await expect.poll(async () => (await placement()).top).toBeGreaterThanOrEqual(-1);
            await expect.poll(async () => (await placement()).bottom).toBeLessThanOrEqual(1);
          }
        };
        await settleScroll(timeline);
        await assertOutcome();
        const revealed = removed ? null : await placement();
        geometry.beforeOutput = removed ? { drift: await readingDrift() } : revealed;
        await control(request, { action: "item", conversationId: id, item: {
          id: "snapshot:later", type: "assistant_message", createdAt: 100,
          markdown: "Later output after snapshot navigation.\n\n".repeat(30),
        } });
        await expect(timeline.locator('[data-chat-item-id="snapshot:later"]')).toContainText("Later output after snapshot navigation.");
        await settleScroll(timeline);
        await assertOutcome();
        if (revealed) expect(Math.abs((await placement()).top - revealed.top)).toBeLessThanOrEqual(2);
        geometry.afterOutput = removed ? { drift: await readingDrift() } : await placement();
        phase = 6;
      } finally {
        try {
          await page.evaluate(() => Reflect.get(window, "__snapshotNavigation")?.release());
          const probe = await page.evaluate(() => Reflect.get(window, "__snapshotNavigation")?.evidence());
          await saveEvidence(info, `snapshot-navigation-${engine}-${removed ? "removed" : "retained"}.json`, JSON.stringify({ phase, probe, geometry }));
        } catch { /* Diagnostic collection must preserve the original verdict. */ }
        finally { await browser.close(); }
      }
    });
  }
}
