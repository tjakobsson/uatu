import { chromium, webkit, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";
import { chatWorkload } from "../fixtures/chat-performance";
import { armConversationCommit, conversationCommit, stopConversationCommit } from "./chat-shell-performance-helpers";
import { bootShell, control, drag, expectBounded, expectReading, frames, log, openShellRow, position, settleScroll, shell } from "./chat-shell-helpers";

const floating = (page: Page) => page.getByRole("region", { name: "Shell output window" });

/** Expose existing buffer statistics in the served test bundle, never product code. */
async function instrumentShell(page: Page) {
  await page.addInitScript(() => {
    (window as any).__shellProbe = { controllers: [], lineWrites: 0, parseMs: 0, paints: 0 };
    const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
    Object.defineProperty(Element.prototype, "innerHTML", { ...innerHTML, set(value) {
      if (this.classList?.contains("chat-shell-line")) (window as any).__shellProbe.lineWrites++;
      innerHTML.set!.call(this, value);
    } });
    globalThis.__uatuChatPerformance = { counts: {}, durations: {} };
  });
  let instrumented = false;
  await page.route("**/*.js", async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = "const update = this.buffer.update(this.snapshot);";
    const body = source.replace(marker, () => {
      instrumented = true;
      return `const probe = globalThis.__shellProbe;
        if (!probe.controllers.includes(this)) probe.controllers.push(this);
        const parseStart = performance.now();
        const update = this.buffer.update(this.snapshot);
        probe.parseMs += performance.now() - parseStart; probe.paints++;`;
    });
    await route.fulfill({ response, body });
  });
  return () => expect(instrumented, "test-only shell buffer instrumentation matched the bundle").toBe(true);
}

const work = (page: Page) => page.evaluate(() => {
  const probe = (window as any).__shellProbe;
  const owner = probe.controllers.find((c: any) => c.itemId === "shell:a");
  return { ...owner.buffer.stats, lineWrites: probe.lineWrites, paints: probe.paints, parseMs: probe.parseMs,
    transcriptRenders: globalThis.__uatuChatPerformance?.counts["transcript-render"] ?? 0 };
});

for (const engine of ["chromium", "webkit"] as const) {
  for (const child of [false, true]) for (const collapsed of ["row", "group"] as const) test(`${engine} ${child ? "child" : "parent"} return focuses the visible collapsed ${collapsed} summary`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { outputView, timeline } = await bootShell(page, request, { child, extra: [98, 99].map(createdAt => ({
        id: `read:${createdAt}`, type: "tool" as const, name: "read", status: "completed" as const, createdAt, output: "Earlier step",
      })) });
      const row = timeline.locator('[data-chat-item-id="shell:a"]');
      const group = row.locator("xpath=ancestor::details[contains(@class,'chat-activity-group')]");
      const container = collapsed === "row" ? row : group;
      const summary = container.locator(":scope > summary");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      await summary.focus(); await summary.press("Enter");
      await expect(container).not.toHaveAttribute("open", "");
      const top = await timeline.evaluate(el => el.scrollTop);
      const window = floating(page);
      if (collapsed === "row") await window.getByRole("button", { name: "Return to chat" }).click();
      else {
        await window.getByRole("button", { name: "Return to chat" }).focus();
        await page.keyboard.press("Escape");
      }
      await expect(window).toHaveCount(0);
      await expect(container).not.toHaveAttribute("open", "");
      await expect(summary).toBeFocused();
      expect(await timeline.evaluate(el => el.scrollTop)).toBe(top);
      if (child) await expect(page.locator("#chat-drilldown")).toBeVisible();
    } finally { await browser.close(); }
  });

  for (const shape of ["command", "bash"] as const) test(`${engine} ${shape} scrolling alone preserves inspection through completion and unchanged reconstruction`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const output = log(200);
      const { outputView, viewport, timeline, update, parentId } = await bootShell(page, request, { shape, output });
      await viewport.hover(); await page.mouse.wheel(0, -800); await frames(page);
      await settleScroll(viewport);
      const anchor = await position(viewport);
      expect(anchor.bottom).toBeGreaterThan(100);
      await update(shell(shape, output, "completed"));
      await expect(outputView).toHaveAttribute("data-status", "completed");
      await expect(timeline.locator('[data-chat-item-id="shell:a"]')).toHaveAttribute("open", "");
      await expectReading(viewport, anchor);
      await expect(outputView.getByRole("button", { name: "Latest output", exact: true })).toBeVisible();
      const other = await control(request, { action: "seed", title: "Inspect another conversation", items: [] });
      const chooser = page.locator("#chat-conversation-select");
      await chooser.selectOption(other.conversation.id);
      await expect(outputView).toHaveCount(0);
      await chooser.selectOption(parentId);
      await expect(outputView).toBeVisible();
      await expect(outputView.getByRole("button", { name: "Latest output", exact: true })).toBeVisible();
      await expectReading(viewport, anchor);
      await chooser.selectOption(other.conversation.id);
      await expect(outputView).toHaveCount(0);
      await update(shell(shape, `${output}\noutput received while away`, "completed"));
      await chooser.selectOption(parentId);
      await expect(viewport).toContainText("output received while away");
      await expect(outputView.getByRole("button", { name: /New output.*Latest output/ })).toBeVisible();
      await expectReading(viewport, anchor);
    } finally { await browser.close(); }
  });

  for (const touch of [false, true]) test(`${engine} ${touch ? "touch" : "desktop"} full-area output protects covered prompt navigation`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    try {
      const { outputView } = await bootShell(page, request, { touch, extra: [
        { id: "second-prompt", type: "user_message", text: "Second prompt to navigate to", createdAt: 2 },
      ] });
      const rail = page.locator("#chat-prompt-rail");
      await expect(rail.locator("button")).toHaveCount(2);
      await expect(rail).toBeVisible();
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      if (!touch) await window.getByRole("button", { name: "Maximize", exact: true }).click();
      await expect(window).toHaveClass(/is-full-area/);
      await expect.poll(() => rail.evaluate(el => !!el.closest("[inert]"))).toBe(true);
      await window.getByRole("button", { name: "Return to chat" }).focus();
      for (let i = 0; i < 16; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest("#chat-prompt-rail"))).toBe(false);
      }
      if (touch) {
        expect(await page.locator("#touch-tab-bar").evaluate(el => !!el.closest("[inert]"))).toBe(false);
      } else {
        await window.getByRole("button", { name: "Restore size" }).click();
        await expect.poll(() => rail.evaluate(el => !!el.closest("[inert]"))).toBe(false);
      }
      await window.getByRole("button", { name: "Return to chat" }).click();
      await expect.poll(() => rail.evaluate(el => !!el.closest("[inert]"))).toBe(false);
      await rail.locator("button").first().focus();
      await expect(rail.locator("button").first()).toBeFocused();
    } finally { await browser.close(); }
  });

  test(`${engine} floating Find excludes hidden inline chrome and restores it on return`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { outputView, update } = await bootShell(page, request, { output: "visible-output-needle" });
      const popout = outputView.getByRole("button", { name: "Pop out", exact: true });
      await popout.click();
      const window = floating(page);
      await window.getByRole("button", { name: "Return to chat" }).focus();
      await page.keyboard.press("Meta+f");
      for (const query of ["Pop out", "fixture-shell:a"]) {
        await page.locator("#find-query").fill(query);
        await expect(page.locator("#find-status")).toHaveText("No results");
      }
      await update(shell("command", "visible-output-needle\nlater-output-needle"));
      await page.locator("#find-query").fill("output-needle");
      await expect(page.locator("#find-status")).toHaveText("1 of 2");
      await page.keyboard.press("Enter");
      await expect(page.locator("#find-status")).toHaveText("2 of 2");
      await page.keyboard.press("Escape");
      await window.getByRole("button", { name: "Maximize", exact: true }).click();
      await page.keyboard.press("Meta+f");
      await page.locator("#find-query").fill("Pop out");
      await expect(page.locator("#find-status")).toHaveText("No results");
      await page.keyboard.press("Escape");
      await window.getByRole("button", { name: "Return to chat" }).click();
      await expect(popout).toBeVisible();
      await expect(outputView.locator(".chat-tool-command")).toBeVisible();
      await expect(outputView.getByRole("separator", { name: /Output height/ })).toBeVisible();
      await page.keyboard.press("Meta+f");
      await page.locator("#find-query").fill("fixture-shell:a");
      await expect(page.locator("#find-status")).toHaveText(/\d+ of \d+/);
    } finally { await browser.close(); }
  });

  for (const child of [false, true]) test(`${engine} ${child ? "child" : "parent"} find reveals inline error matches on both axes`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { update, outputView, timeline } = await bootShell(page, request, { shape: "bash", child });
      const needle = "unique-inline-error-match";
      const errorText = `${"earlier error line\n".repeat(60)}${"wide-column ".repeat(50)}${needle}`;
      await update({ ...shell("bash", "stdout stays available", "failed"), error: errorText });
      const error = outputView.getByLabel("Error output");
      await expect(error).toContainText(needle);
      await expect(outputView).toHaveAttribute("data-status", "failed");
      await openShellRow(timeline, "shell:a");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).focus();
      await page.keyboard.press("Meta+f");
      await page.locator("#find-query").fill(needle);
      await expect(page.locator("#find-status")).toHaveText("1 of 1");
      await expect.poll(() => error.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await expect.poll(() => error.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      await expect.poll(() => error.evaluate((el, text) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const offset = node.textContent!.indexOf(text);
          if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + text.length);
          const match = range.getBoundingClientRect(), pane = el.getBoundingClientRect();
          return match.top >= pane.top && match.bottom <= pane.bottom && match.left >= pane.left && match.right <= pane.right;
        }
        return false;
      }, needle)).toBe(true);
      await expect(error).toBeInViewport();
    } finally { await browser.close(); }
  });

  test(`${engine} covered Preview find cannot receive focus behind full-area shell output`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, hasTouch: true, viewport: { width: 1440, height: 1000 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      // The mode toggle is available only on coarse-pointer devices.
      await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "desktop"));
      const { outputView } = await bootShell(page, request);
      await page.locator(".preview-shell").focus();
      await page.keyboard.press("Meta+f");
      await expect(page.locator("#find-query")).toHaveAttribute("aria-label", "Find in document");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      await window.getByRole("button", { name: "Maximize", exact: true }).click();
      await expect.poll(() => page.locator("#find-query").evaluate(el => !!el.closest("[inert]"))).toBe(true);
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest("#find-bar"))).toBe(false);
      }
      await window.getByRole("button", { name: "Restore size" }).click();
      await expect.poll(() => page.locator("#find-query").evaluate(el => !!el.closest("[inert]"))).toBe(false);
      await page.locator("#find-query").focus();
      await expect(page.locator("#find-query")).toBeFocused();
      const modeToggle = page.getByRole("button", { name: "Switch to touch layout" });
      await expect(modeToggle).toBeVisible();
      await modeToggle.focus();
      await expect(modeToggle).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
      await page.locator("#touch-tab-chat").click();
      await expect(window).toHaveClass(/is-full-area/);
      await expect.poll(() => page.locator("#find-query").evaluate(el => !!el.closest("[inert]"))).toBe(true);
      await window.getByRole("button", { name: "Return to chat" }).focus();
      await page.keyboard.press("Meta+f");
      await expect(window.locator("#find-query")).toBeFocused();
      await expect(window.locator("#find-query")).toHaveAttribute("aria-label", "Find in chat");
      expect(await window.locator("#find-query").evaluate(el => !!el.closest("[inert]"))).toBe(false);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });

  for (const shape of ["command", "bash"] as const) test(`${engine} ${shape} normalized completion time reaches the floating header`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { update, outputView } = await bootShell(page, request, { shape });
      const completedAt = Date.UTC(2026, 8, 15, 10, 30);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      await update({ ...shell(shape, "finished output", "completed"), completedAt });
      // Short weekday, local ISO date, and 24-hour clock, in the page's zone.
      const formatted = await page.evaluate(time => {
        const at = new Date(time);
        const pad = (value: number) => String(value).padStart(2, "0");
        return `${at.toLocaleDateString([], { weekday: "short" })} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
      }, completedAt);
      await expect(floating(page).locator(".chat-shell-window-metadata")).toContainText(formatted);
      await page.reload();
      await openChatPanel(page);
      await openShellRow(page.locator("#chat-timeline"), "shell:a");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      await expect(floating(page).locator(".chat-shell-window-metadata")).toContainText(formatted);
    } finally { await browser.close(); }
  });

  for (const agent of ["opencode", "claude"] as const) {
    for (const shape of ["command", "bash"] as const) {
      for (const child of [false, true]) test(`${engine} ${agent} ${shape} ${child ? "child" : "parent"} full running scrollback flow`, async ({ request, baseURL }, testInfo) => {
        const browser = await ({ chromium, webkit })[engine].launch();
        const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        try {
          let output = log(160, true);
          const fixture = await bootShell(page, request, { agent, shape, child, output, extra: [98, 99].map(createdAt => ({
            id: `read:${createdAt}`, type: "tool", name: "read", status: "completed", createdAt, output: "Earlier step",
          })) });
          const { viewport, outputView, timeline, update } = fixture;
          await expect.poll(async () => (await position(viewport)).bottom).toBeLessThan(2);
          const node = await viewport.elementHandle();
          await viewport.hover(); await page.mouse.wheel(90, -1200); await frames(page);
          const anchor = await position(viewport);
          expect(anchor.bottom).toBeGreaterThan(500); expect(anchor.left).toBeGreaterThan(0);
          output += "\nappend-before-resize";
          await update(shell(shape, output));
          await expect(viewport).toContainText("append-before-resize");
          await expectReading(viewport, anchor);
          await expect(outputView.getByRole("button", { name: /New output.*Latest output/ })).toBeVisible();
          const handle = outputView.getByRole("separator", { name: /Output height/ });
          const initialHeight = Number(await handle.getAttribute("aria-valuenow"));
          await drag(page, handle, 0, 60);
          expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(initialHeight);
          await handle.focus(); await page.keyboard.press("ArrowDown");
          const inlineHeight = Number(await handle.getAttribute("aria-valuenow"));
          await expect(handle).toHaveAttribute("aria-valuemin", /\d+/);
          await expect(handle).toHaveAttribute("aria-valuemax", /\d+/);
          expect(await handle.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
          await expectReading(viewport, anchor);
          await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
          const window = floating(page);
          await expect(window).toHaveCount(1);
          await expect(window).toHaveAttribute("data-shell-item-id", "shell:a");
          await expect(window.locator(".chat-shell-window-title")).toHaveText("fixture-shell:a");
          await expect(window.locator(".chat-shell-window-metadata")).toContainText(child ? "Shell child" : "Scrollback owner");
          expect(await viewport.evaluate((el, original) => el === original, node)).toBe(true);
          await expect(window.getByRole("button", { name: "Return to chat" })).toBeFocused();
          await expect(timeline.locator(".chat-shell-slot.is-popped-out")).toHaveCount(1);
          await expectReading(viewport, anchor);
          await drag(page, window.getByRole("group", { name: /^Move output/ }), 100, 60);
          await drag(page, window.getByRole("group", { name: /^Resize output/ }), 140, 60);
          const mover = window.getByRole("group", { name: /^Move output/ });
          const resizer = window.getByRole("group", { name: /^Resize output/ });
          const moved = (await window.boundingBox())!;
          await mover.focus(); await page.keyboard.press("ArrowRight");
          await expect.poll(async () => (await window.boundingBox())!.x).toBe(moved.x + 10);
          await resizer.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowDown");
          await expect(resizer).toHaveAttribute("aria-label", /Width bounds.*height bounds/);
          expect(await resizer.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
          const rect = (await window.boundingBox())!;
          expect(rect.width).toBeGreaterThan((await page.locator("#chat-surface").boundingBox())!.width);
          await expectBounded(page, window); await expectReading(viewport, anchor);
          expect(page.context().pages()).toHaveLength(1);
          expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
          // The uncovered composer remains usable in nonmodal mode.
          await page.locator("#chat-input").fill("draft while inspecting output");
          await window.getByRole("button", { name: "Maximize", exact: true }).click();
          await expect(window).toHaveClass(/is-full-area/);
          const full = (await window.boundingBox())!;
          expect(full.width).toBeGreaterThan(rect.width); expect(full.height).toBeGreaterThan(rect.height);
          await expectBounded(page, window); await expectReading(viewport, anchor);
          // Real Tab traversal must never reach a covered composer or transcript.
          for (let i = 0; i < 10; i++) {
            await page.keyboard.press("Tab");
            expect(await page.evaluate(() => !!document.activeElement?.closest("#chat-input, #chat-items, #chat-drilldown-items"))).toBe(false);
          }
          output += "\nfinal-completion-line";
          await update(shell(shape, output, "completed"));
          await control(request, { action: "status", conversationId: fixture.id, status: "completed" });
          await expect(window).toHaveAttribute("data-status", "completed");
          await expect(viewport.locator(".chat-shell-line").last()).toHaveText("final-completion-line");
          await expectReading(viewport, anchor);
          await expect(timeline.locator(".chat-activity-group").first()).toHaveAttribute("open", "");
          await control(request, { action: "status", conversationId: fixture.id, status: "running" });
          await update(shell(shape, "later command log", "running", "shell:b"));
          await expect(window).toHaveAttribute("data-shell-item-id", "shell:a");
          await expect(window).not.toContainText("later command log");
          await window.getByRole("button", { name: "Restore size" }).click();
          expect(await window.boundingBox()).toEqual(rect);
          await expectReading(viewport, anchor);
          if (agent === "opencode" && shape === "command" && !child) await captureScreenshot(page, testInfo, `${engine}-desktop-floating`);
          await window.getByRole("button", { name: "Return to chat" }).focus();
          await page.keyboard.press("Escape");
          await expect(window).toHaveCount(0);
          if (child) await expect(page.locator("#chat-drilldown")).toBeVisible();
          await expect(outputView.getByRole("button", { name: "Pop out", exact: true })).toBeFocused();
          await expect(handle).toHaveAttribute("aria-valuenow", String(inlineHeight));
          await expectReading(viewport, anchor);
          await expect(timeline.locator('[data-chat-item-id="shell:a"]')).toHaveAttribute("open", "");
          await expect(timeline.locator(".chat-activity-group").first()).toHaveAttribute("open", "");
          await outputView.getByRole("button", { name: /Latest output/ }).click();
          await expect.poll(async () => (await position(viewport)).bottom).toBeLessThan(2);
          expect((await position(viewport)).left).toBe(anchor.left);
          expect(errors).toEqual([]);
        } finally { await browser.close(); }
      });
    }
  }

  for (const outcome of ["completed", "failed", "cancelled"] as const) for (const shape of ["command", "bash"] as const) for (const child of [false, true]) test(`${engine} ${shape} ${child ? "child" : "parent"} ${outcome} keeps selected identity through regrouping`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
    try {
      const { outputView, update, viewport } = await bootShell(page, request, { shape, child, agent: shape === "bash" ? "claude" : "opencode" });
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      await viewport.hover(); await page.mouse.wheel(0, -1000); await frames(page);
      const anchor = await position(viewport), geometry = await window.boundingBox();
      await update({ ...shell(shape, log(120, true) + "\nfinal", outcome), ...(outcome === "failed"
        ? shape === "bash" ? { error: "\x1b[31mseparate error output\x1b[0m" } : { exitCode: 7 } : {}) });
      await expect(window).toHaveAttribute("data-status", outcome);
      if (outcome === "failed" && shape === "bash") await expect(window.getByLabel("Error output")).toHaveText("separate error output");
      await expect(window.locator(".chat-shell-window-metadata")).toContainText(outcome[0]!.toUpperCase() + outcome.slice(1));
      await expect(window.locator(".chat-shell-window-metadata")).not.toContainText(/\d{4}|Invalid Date/);
      await update(shell("bash", "new command", "running", "shell:b"));
      await expect(window).toHaveAttribute("data-shell-item-id", "shell:a");
      expect(await window.boundingBox()).toEqual(geometry); await expectReading(viewport, anchor);
      await window.getByRole("button", { name: "Maximize", exact: true }).click();
      await window.getByRole("button", { name: "Return to chat" }).focus();
      await page.keyboard.press("Escape");
      await expect(window).toHaveCount(0); await expectReading(viewport, anchor);
      if (child) await expect(page.locator("#chat-drilldown")).toBeVisible();
    } finally { await browser.close(); }
  });

  for (const agent of ["opencode", "claude"] as const) test(`${engine} ${agent} long output parse and DOM work stays incremental`, async ({ request, baseURL }, testInfo) => {
    test.setTimeout(60_000);
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    const evidence: Record<string, unknown> = { engine, agent, initialLines: 5000, updates: 20, conversationWorkloadItems: 50 };
    const requests: Record<string, unknown>[] = [];
    evidence.controlRequests = requests;
    const boundedControl = async (data: Record<string, unknown>) => {
      const sample: Record<string, unknown> = { action: data.action, conversationId: data.conversationId,
        update: evidence.updateIndex, phase: evidence.phase, timeoutMilliseconds: 10_000 };
      requests.push(sample);
      const start = Date.now();
      try {
        const response = await request.post("/__e2e/chat", { data, timeout: 10_000 });
        sample.status = response.status();
        expect(response.ok(), `fixture control ${data.action}`).toBe(true);
        return await response.json();
      } catch (error) {
        sample.error = String(error);
        throw error;
      } finally { sample.milliseconds = Date.now() - start; }
    };
    try {
      const checkInstrumentation = await instrumentShell(page);
      let output = log(5000);
      evidence.initialCodeUnits = output.length;
      const shape = agent === "claude" ? "bash" : "command";
      evidence.phase = "initial conversation selection";
      const bootStart = Date.now();
      const { outputView, viewport, id, parentId } = await test.step("Open the seeded long-output conversation", () => bootShell(page, request, { agent, shape, output,
        extra: chatWorkload(50).map((item, index) => ({ ...item, createdAt: index + 2 })) }));
      evidence.bootMilliseconds = Date.now() - bootStart;
      checkInstrumentation();
      const firstNode = await viewport.locator(".chat-shell-line").first().elementHandle();
      const initial = await work(page); evidence.before = initial;
      const latencies: number[] = [];
      evidence.updateToDOMMilliseconds = latencies;
      const startLength = output.length;
      evidence.phase = "streaming appends";
      for (let i = 0; i < 20; i++) {
        evidence.updateIndex = i;
        output += `\nupdate-${i} ${"append-only ".repeat(20)}`;
        const start = Date.now();
        await boundedControl({ action: "item", conversationId: id, item: shell(shape, output) });
        await expect(viewport.locator(".chat-shell-line").last()).toContainText(`update-${i}`);
        latencies.push(Date.now() - start);
      }
      const after = await work(page); evidence.after = after;
      evidence.appendedCodeUnits = output.length - startLength;
      expect(after.inputCodeUnits - initial.inputCodeUnits).toBe(output.length - startLength);
      expect(after.resets).toBe(initial.resets);
      expect(after.lineWrites - initial.lineWrites).toBeLessThanOrEqual(40);
      expect(after.lineWrites - initial.lineWrites).toBeGreaterThanOrEqual(20);
      expect(after.renderedCells - initial.renderedCells).toBeLessThan((output.length - startLength) * 2);
      expect(after.segmentedCodeUnits - initial.segmentedCodeUnits).toBeLessThan((output.length - startLength) * 2);
      expect(after.prefixCodeUnits).toBeGreaterThan(initial.prefixCodeUnits);
      expect(await viewport.locator(".chat-shell-line").first().evaluate((el, first) => el === first, firstNode)).toBe(true);
      await expect(viewport.locator(".chat-shell-line")).toHaveCount(5020);
      evidence.phase = "inspect earliest output and pop out";
      await viewport.focus(); await page.keyboard.press("Home");
      await expect.poll(async () => (await position(viewport)).top).toBe(0);
      await expect(viewport.locator(".chat-shell-line").first()).toBeInViewport();
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      evidence.phase = "move and resize";
      const interactionStart = Date.now();
      await drag(page, window.getByRole("group", { name: /^Move output/ }), 50, 20);
      await drag(page, window.getByRole("group", { name: /^Resize output/ }), 100, 40);
      await expectBounded(page, window);
      evidence.moveResizeMilliseconds = Date.now() - interactionStart;
      expect(Date.now() - interactionStart).toBeLessThan(3000);
      // Navigate through the real inventory selector with a long log retained.
      evidence.phase = "seed navigation target";
      const other = await boundedControl({ action: "seed", agent, title: "Other long-output view", items: [
        { id: "navigation-target", type: "assistant_message", createdAt: 1, markdown: "Navigation target committed" },
      ] });
      evidence.navigationTargetId = other.conversation.id;
      evidence.returnConversationId = parentId;
      const navigationStart = Date.now();
      const navigate = async (conversationId: string, itemId: string, label: string) => {
        await armConversationCommit(page, conversationId, itemId);
        const start = Date.now();
        try {
          await test.step(label, () => page.locator("#chat-conversation-select").selectOption(conversationId));
          await expect.poll(async () => (await conversationCommit(page)).milliseconds, `${label}: target transcript committed`).toBeDefined();
          const sample = await conversationCommit(page);
          expect(sample.milliseconds, `${label}: selector change to target transcript DOM commit`).toBeLessThan(3000);
        } finally {
          evidence[itemId === "navigation-target" ? "navigateAway" : "navigateBack"] = {
            ...await conversationCommit(page), roundtripMilliseconds: Date.now() - start,
          };
          await stopConversationCommit(page);
        }
      };
      evidence.phase = "select navigation target";
      await navigate(other.conversation.id, "navigation-target", "Select the newly seeded conversation");
      evidence.phase = "release floating window";
      await expect(window).toHaveCount(0);
      evidence.phase = "select original conversation";
      await navigate(parentId, "shell:a", "Return to the long-output conversation");
      evidence.phase = "inspect retained shell row";
      await test.step("Inspect the retained shell row", () => openShellRow(page.locator("#chat-timeline"), "shell:a"));
      await expect(viewport.locator(".chat-shell-line")).toHaveCount(5020);
      expect((await viewport.locator(".chat-shell-line").allTextContents()).join("")).toBe(output + "\n");
      evidence.navigationMilliseconds = Date.now() - navigationStart;
      // The whole roundtrip also includes two actions, row expansion and protocol
      // waits. Each navigation's browser response has its own unchanged 3s budget.
      evidence.phase = "complete";
    } finally {
      const report = JSON.stringify(evidence, null, 2);
      await saveEvidence(testInfo, `${engine}-${agent}-shell-long-output-work.json`, report + "\n");
      await testInfo.attach("shell-long-output-work.json", { body: report, contentType: "application/json" });
      await browser.close();
    }
  });

  for (const child of [false, true]) for (const touch of [false, true]) test(`${engine} ${touch ? "touch" : "desktop"} ${child ? "child" : "parent"} hidden popped output completes without painting`, async ({ request, baseURL }, testInfo) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    try {
      const instrumented = await instrumentShell(page);
      const shape = child ? "bash" : "command";
      const { outputView, viewport, update } = await bootShell(page, request, { child, touch, shape, agent: child ? "claude" : "opencode" });
      instrumented();
      await viewport.focus(); await page.keyboard.press("Home"); await page.keyboard.press("PageDown"); await frames(page);
      await settleScroll(viewport);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      if (!touch) await drag(page, window.getByRole("group", { name: /^Resize output/ }), 80, 40);
      const geometry = await window.boundingBox(), anchor = await position(viewport);
      const ownerNode = await outputView.elementHandle();
      if (touch) await page.locator("#touch-tab-files").click();
      else await page.locator("#chat-collapse").click();
      await expect.soft(page.locator(".chat-shell-window")).toBeHidden({ timeout: 1000 });
      await frames(page);
      const before = await work(page);
      let output = log(120, true);
      for (let i = 0; i < 8; i++) { output += `\nhidden-${i}`; await update(shell(shape, output)); }
      await update(shell(shape, output + "\nhidden-final", "completed"));
      // Allow the existing streamed-event scheduler to process its hidden branch.
      await page.waitForTimeout(200);
      const hidden = await work(page);
      expect(hidden).toEqual(before);
      if (touch) await page.locator("#touch-tab-chat").click();
      else await page.locator("#chat-expand").click();
      await expect(window).toBeVisible();
      await expect(window).toHaveAttribute("data-shell-item-id", "shell:a");
      await expect(window).toHaveAttribute("data-status", "completed");
      await expect(viewport).toContainText("hidden-final");
      expect(await outputView.evaluate((el, owner) => el === owner, ownerNode)).toBe(true);
      expect(await window.boundingBox()).toEqual(geometry);
      await expectReading(viewport, anchor);
      const report = JSON.stringify({ engine, touch, child, before, hidden, restored: await work(page) }, null, 2);
      await saveEvidence(testInfo, `${engine}-${touch ? "touch" : "desktop"}-${child ? "child" : "parent"}-hidden-work.json`, report + "\n");
      await testInfo.attach("hidden-shell-work.json", { body: report, contentType: "application/json" });
      await window.getByRole("button", { name: "Return to chat" }).click();
      await expect(window).toHaveCount(0);
      if (child) await expect(page.locator("#chat-drilldown")).toBeVisible();
    } finally { await browser.close(); }
  });

  for (const touch of [false, true]) for (const theme of ["light", "dark"] as const) test(`${engine} ${touch ? "touch" : "desktop"} ${theme} layout bounds and return controls`, async ({ request, baseURL }, testInfo) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, hasTouch: true, isMobile: touch, colorScheme: theme,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    try {
      if (!touch) await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "desktop"));
      const output = "\x1b[32mgreen\x1b[0m\n" + log(150, true);
      const { outputView, viewport, update } = await bootShell(page, request, { touch, output });
      const height = outputView.getByRole("separator", { name: /Output height/ });
      await height.focus(); await page.keyboard.press("End");
      expect(await height.getAttribute("aria-valuenow")).toBe(await height.getAttribute("aria-valuemax"));
      await height.press("Home");
      expect(await height.getAttribute("aria-valuenow")).toBe(await height.getAttribute("aria-valuemin"));
      await height.press("ArrowDown");
      if (touch && engine === "chromium") {
        const before = Number(await height.getAttribute("aria-valuenow"));
        const rect = (await height.boundingBox())!;
        const session = await page.context().newCDPSession(page);
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        for (let i = 1; i <= 4; i++) {
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y + i * 10 }] });
          await frames(page);
        }
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
        await expect.poll(async () => Number(await height.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
      }
      const inlineHeight = await height.getAttribute("aria-valuenow");
      if (touch) await outputView.getByRole("button", { name: "Pop out", exact: true }).tap();
      else await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      await expectBounded(page, window);
      const styles = await viewport.evaluate(el => {
        const css = getComputedStyle(el), root = getComputedStyle(document.documentElement);
        return { background: css.backgroundColor, foreground: css.color, family: css.fontFamily, whiteSpace: css.whiteSpace,
          green: getComputedStyle(el.querySelector(".ansi-fg-2")!).color, terminalGreen: root.getPropertyValue("--terminal-ansi-green").trim() };
      });
      expect(styles.background).toBe("rgb(11, 18, 32)"); expect(styles.family).toContain("Hack Nerd Font Mono");
      expect(styles.whiteSpace).toBe("pre");
      const rgb = `rgb(${[1, 3, 5].map(i => parseInt(styles.terminalGreen.slice(i, i + 2), 16)).join(", ")})`;
      expect(styles.green).toBe(rgb);
      const geometry = await window.boundingBox();
      if (touch) {
        await expect(window).toHaveClass(/is-full-area/);
        await expect(window.getByRole("button", { name: "Maximize", exact: true })).toBeHidden();
        await expect(window.locator(".chat-shell-window-resize")).toBeHidden();
        const tab = (await page.locator("#touch-tab-bar").boundingBox())!;
        expect(geometry!.y + geometry!.height).toBeCloseTo(tab.y, 0);
      } else {
        await drag(page, window.getByRole("group", { name: /^Move output/ }), -3000, -3000);
        await expectBounded(page, window);
        await drag(page, window.getByRole("group", { name: /^Resize output/ }), 3000, 3000);
        await expectBounded(page, window);
      }
      await captureScreenshot(page, testInfo, `${engine}-${touch ? "touch" : "desktop"}-${theme}`);
      await test.step("inventory refresh keeps covered controls unfocusable", async () => {
        if (!touch) await window.getByRole("button", { name: "Maximize", exact: true }).click();
        const seeded = await control(request, { action: "seed", title: "Inventory refresh while maximized", items: [] });
        await expect(page.locator("#chat-conversation-select option").filter({ hasText: "Inventory refresh while maximized" })).toHaveAttribute("value", seeded.conversation.id);
        await page.locator("#chat-input").focus();
        await expect(page.locator("#chat-input")).not.toBeFocused();
        expect(await page.locator("#chat-input").evaluate(el => !!el.closest("[inert]"))).toBe(true);
        if (!touch) await window.getByRole("button", { name: "Restore size" }).click();
      });
      // Deterministic container shrink models keyboard-reduced visible space;
      // this is browser viewport evidence, not a physical software keyboard.
      await test.step("shrink viewport and hide desktop output with Chat", async () => {
        await page.setViewportSize(touch ? { width: 390, height: 430 } : { width: 720, height: 420 });
        if (!touch) {
          await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");
          await expect(page.locator(".chat-shell-window")).toBeHidden();
          await update(shell("command", output + "\ncompleted while narrow", "completed"));
        }
      });
      await test.step("restore latest desktop output automatically at reduced height", async () => {
        if (!touch) {
          // The guard preserves the open preference. Clicking the transient
          // expand strip races its automatic disappearance after resize.
          await page.setViewportSize({ width: 1100, height: 420 });
          await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
          await expect(window).toBeVisible();
          await expect(window).toHaveAttribute("data-status", "completed");
          await expect(viewport).toContainText("completed while narrow");
        }
      });
      await expectBounded(page, window);
      await captureScreenshot(page, testInfo, `${engine}-${touch ? "touch" : "desktop"}-${theme}-small`);
      await window.getByRole("button", { name: "Return to chat" }).focus();
      await page.keyboard.press("Escape");
      await expect(window).toHaveCount(0);
      await expect(outputView.getByRole("button", { name: "Pop out", exact: true })).toBeFocused();
      expect(Number(await height.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(await height.getAttribute("aria-valuemax")));
      await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
      await expect(height).toHaveAttribute("aria-valuenow", inlineHeight!);
    } finally { await browser.close(); }
  });

  for (const touch of [false, true]) test(`${engine} ${touch ? "touch" : "desktop"} find and native selection survive streaming and reparenting`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    try {
      let output = "earliest-unique-needle\n" + log(180) + "\nlatest-unique-needle";
      const { outputView, viewport, update } = await bootShell(page, request, { touch, output });
      await viewport.focus(); await page.keyboard.press("Home");
      await expect.poll(async () => (await position(viewport)).top).toBe(0);
      const line = viewport.locator(".chat-shell-line").first();
      const lineNode = await line.elementHandle();
      const box = (await line.boundingBox())!;
      await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + 115, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
      const selected = await page.evaluate(() => getSelection()?.toString());
      expect(selected!.length).toBeGreaterThan(5);
      output += "\nselection-append"; await update(shell("command", output));
      await expect(viewport).toContainText("selection-append");
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
      expect(await line.evaluate((el, original) => el === original, lineNode)).toBe(true);
      await page.keyboard.press("ControlOrMeta+c");
      await page.locator("#chat-input").fill("");
      await page.locator("#chat-input").press("ControlOrMeta+v");
      await expect(page.locator("#chat-input")).toHaveValue(selected!);
      // Restore the native selection after pasting into the composer.
      await viewport.focus(); await page.keyboard.press("Home"); await frames(page);
      const selectedBox = (await line.boundingBox())!;
      await page.mouse.move(selectedBox.x + 2, selectedBox.y + selectedBox.height / 2); await page.mouse.down();
      await page.mouse.move(selectedBox.x + 115, selectedBox.y + selectedBox.height / 2, { steps: 5 }); await page.mouse.up();
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
      // Keyboard activation avoids the normal pointer click clearing selection.
      await outputView.getByRole("button", { name: "Pop out", exact: true }).focus(); await page.keyboard.press("Enter");
      expect.soft(await page.evaluate(() => getSelection()?.toString()), "selection after keyboard Pop out").toBe(selected);
      await page.keyboard.press("ControlOrMeta+c");
      const window = floating(page);
      for (const mode of touch ? ["touch"] : ["floating", "maximized", "inline"]) {
        if (mode === "maximized") await window.getByRole("button", { name: "Maximize", exact: true }).click();
        if (mode === "inline") await window.getByRole("button", { name: "Return to chat" }).click();
        await viewport.focus(); await page.keyboard.press("ControlOrMeta+f");
        await expect(page.locator("#find-query")).toHaveAttribute("placeholder", "Find in chat");
        for (const needle of ["earliest-unique-needle", "latest-unique-needle"]) {
          await page.locator("#find-query").fill(needle);
          await expect(page.locator("#find-status")).toHaveText("1 of 1");
          const target = viewport.locator(".chat-shell-line").filter({ hasText: needle });
          await expect(target).toBeInViewport();
          const visible = await target.evaluate(el => {
            const rect = el.getBoundingClientRect(), parent = el.closest("pre")!.getBoundingClientRect();
            return rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1;
          });
          expect(visible).toBe(true);
        }
        await page.keyboard.press("Escape");
        if (mode !== "inline") await expect(window).toBeVisible();
      }
    } finally { await browser.close(); }
  });

  test(`${engine} item A and B retain separate geometry through navigation and mode changes`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, hasTouch: true, viewport: { width: 1440, height: 1000 } });
    try {
      await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "desktop"));
      const { outputView, viewport, timeline, parentId, update } = await bootShell(page, request);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      await drag(page, window.getByRole("group", { name: /^Resize output/ }), 50, 20);
      const a = await window.boundingBox();
      await window.getByRole("button", { name: "Return to chat" }).click();
      await update(shell("bash", log(100), "running", "shell:b"));
      await openShellRow(timeline, "shell:b");
      const bView = page.locator('.chat-shell-output[data-shell-item-id="shell:b"]');
      await bView.getByRole("button", { name: "Pop out", exact: true }).click();
      await drag(page, window.getByRole("group", { name: /^Resize output/ }), -180, -100);
      const b = await window.boundingBox(); expect(b).not.toEqual(a);
      // A's explicit Pop out transfers sole ownership and restores A's bounds.
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      await expect(window).toHaveCount(1); await expect(window).toHaveAttribute("data-shell-item-id", "shell:a");
      expect(await window.boundingBox()).toEqual(a);
      await expect(bView.locator(".chat-shell-viewport")).toBeVisible();
      const other = await control(request, { action: "seed", title: "Navigate away", items: [] });
      await page.locator("#chat-conversation-select").selectOption(other.conversation.id);
      await expect(window).toHaveCount(0);
      await page.locator("#chat-conversation-select").selectOption(parentId);
      await expect(window).toHaveCount(0);
      await openShellRow(timeline, "shell:a");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      expect.soft(await window.boundingBox()).toEqual(a);
      await drag(page, window.getByRole("group", { name: /^Move output/ }), 500, 0);
      const modeGeometry = await window.boundingBox();
      await viewport.focus(); await page.keyboard.press("Home"); await page.keyboard.press("PageDown"); await frames(page);
      await settleScroll(viewport);
      const anchor = await position(viewport);
      // The persistent rail toggle is outside the output work area.
      await page.getByRole("button", { name: "Switch to touch layout" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
      await page.locator("#touch-tab-chat").click();
      await expect(window).toHaveClass(/is-full-area/);
      await expectReading(viewport, anchor);
      await window.getByRole("button", { name: "Return to chat" }).click();
      await page.locator("#touch-tab-files").click();
      await page.locator("#ui-mode-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      expect(await window.boundingBox()).toEqual(modeGeometry);
      await expectReading(viewport, anchor);
    } finally { await browser.close(); }
  });

  for (const child of [false, true]) test(`${engine} ${child ? "child" : "parent"} return preserves deliberate outer reading and releases ownership`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const history = Array.from({ length: 30 }, (_, i) => ({ id: `history:${i}`, type: "assistant_message" as const,
        createdAt: i + 2, markdown: `History ${i}\n\n${"Read this earlier answer. ".repeat(25)}` }));
      const { timeline, outputView, viewport, id } = await bootShell(page, request, { child, extra: history });
      await viewport.hover(); await page.mouse.wheel(0, -800); await frames(page);
      await settleScroll(viewport);
      const shellAnchor = await position(viewport);
      const outerBefore = await position(timeline);
      const height = outputView.getByRole("separator", { name: /Output height/ });
      await height.focus(); await page.keyboard.press("ArrowDown");
      await expectReading(viewport, shellAnchor);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      const window = floating(page);
      // Sample an actual visible row rather than treating a legitimate extent
      // clamp as an anchor failure when the placeholder changes size.
      const box = (await timeline.boundingBox())!;
      const beforeReading = await position(timeline);
      await page.mouse.move(box.x + box.width - 25, box.y + box.height / 2);
      await page.mouse.wheel(0, -500); await frames(page);
      // Wheel scrolling can continue past the four paint frames, especially
      // in WebKit. Capture the reader's settled position before returning.
      await settleScroll(timeline);
      const reader = await position(timeline);
      expect(reader.top).toBeLessThan(beforeReading.top - 100);
      await window.getByRole("button", { name: "Return to chat" }).focus();
      await page.keyboard.press("Escape");
      await expect(window).toHaveCount(0);
      await expectReading(timeline, reader); await expectReading(viewport, shellAnchor);
      expect((await position(timeline)).top).toBeLessThan(outerBefore.top - 100);
      // Reopening must be explicit; owning-child navigation releases it.
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      if (child) {
        await page.locator("#chat-drilldown-back").click();
        await expect(window).toHaveCount(0);
        await expect(page.locator("#chat-drilldown")).toBeHidden();
      } else {
        await control(request, { action: "removeItem", conversationId: id, itemId: "shell:a" });
        await expect(window).toHaveCount(0);
        await expect(outputView).toHaveCount(0);
      }
      await page.locator("#chat-input").fill("Ownership released");
      await page.keyboard.press("ArrowLeft");
      await expect(window).toHaveCount(0);
    } finally { await browser.close(); }
  });

  test(`${engine} disconnection does not invent completion`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const { outputView } = await bootShell(page, request);
      await outputView.getByRole("button", { name: "Pop out", exact: true }).click();
      await control(request, { action: "disconnect" });
      await page.waitForTimeout(250);
      const window = floating(page);
      await expect(window).toHaveAttribute("data-status", "running");
      await expect(window.locator(".chat-shell-window-metadata")).not.toContainText(/Completed|Failed|Cancelled|\d{4}/);
      await window.getByRole("button", { name: "Return to chat" }).click();
      await expect(window).toHaveCount(0);
    } finally { await browser.close(); }
  });

  for (const child of [false, true]) test(`${engine} ${child ? "child" : "parent"} find materializes completed-only shell output once`, async ({ request, baseURL }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const output = "lazy-earliest-needle\n" + log(200) + "\nlazy-latest-needle";
      const { timeline } = await bootShell(page, request, { child, status: "completed", extra: [shell("bash", output, "completed", "shell:b")] });
      const row = timeline.locator('[data-chat-item-id="shell:b"]');
      await expect(row).not.toHaveAttribute("open", "");
      await expect(row.locator(".chat-shell-viewport")).toHaveCount(0);
      await timeline.focus(); await page.keyboard.press("ControlOrMeta+f");
      for (const needle of ["lazy-earliest-needle", "lazy-latest-needle"]) {
        await page.locator("#find-query").fill(needle);
        await expect(page.locator("#find-status")).toHaveText("1 of 1");
        await expect(row).toHaveAttribute("open", "");
        await expect(row.locator(".chat-shell-viewport")).toHaveCount(1);
        await expect(row.locator(".chat-shell-line")).toHaveCount(202);
        await expect(row.locator(".chat-shell-line").filter({ hasText: needle })).toBeInViewport();
      }
      await page.keyboard.press("Escape");
      await row.getByRole("button", { name: "Pop out", exact: true }).click();
      await expect(floating(page)).toHaveAttribute("data-status", "completed");
      await expect(floating(page)).toHaveAttribute("data-shell-item-id", "shell:b");
    } finally { await browser.close(); }
  });
}
