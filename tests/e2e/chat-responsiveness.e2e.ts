import { test, expect } from "./fixtures";
import { installClipboardMock, readClipboardMock } from "./chat-helpers";
import { chatWorkload } from "../fixtures/chat-performance";

for (const agent of ["claude", "opencode"]) test.describe(`${agent} presentation`, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("hidden output retains the draft and anchor without transcript work", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const snapshot = await request.post("/__e2e/chat", { data: { action: "seed", agent, items: chatWorkload(50) } }).then(r => r.json());
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.addInitScript(() => { globalThis.__uatuChatPerformance = { counts: {}, durations: {} }; });
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator('[data-chat-item-id="bench:49"]')).toBeVisible();
    await page.locator("#chat-input").fill("Retain this draft");
    await page.locator("#chat-input").blur();
    await page.locator("#chat-timeline").evaluate(el => { el.scrollTop = 300; });
    await page.waitForTimeout(100);
    const beforeTop = await page.locator("#chat-timeline").evaluate(el => el.scrollTop);
    await page.locator("#touch-tab-files").click();
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => structuredClone(globalThis.__uatuChatPerformance));
    for (let i = 0; i < 8; i++) await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id,
      item: { id: "hidden-update", type: "assistant_message", createdAt: Date.now(), markdown: `Hidden update ${i}` } } });
    for (const tab of ["preview", "terminal", "files"]) {
      await page.locator(`#touch-tab-${tab}`).click();
      await expect(page.locator(`#touch-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
      await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id,
        item: { id: "hidden-update", type: "assistant_message", createdAt: Date.now(), markdown: "Hidden update 7" } } });
    }
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => structuredClone(globalThis.__uatuChatPerformance));
    expect(after?.counts["transcript-render"]).toBe(before?.counts["transcript-render"]);
    expect(after?.counts["item-geometry"]).toBe(before?.counts["item-geometry"]);
    await expect(page.locator("#touch-tab-chat")).toHaveAttribute("data-badge", "");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator('[data-chat-item-id="hidden-update"]')).toContainText("Hidden update 7");
    await expect(page.locator("#chat-input")).toHaveValue("Retain this draft");
    expect(Math.abs(await page.locator("#chat-timeline").evaluate(el => el.scrollTop) - beforeTop)).toBeLessThan(3);
  });

  test("pinned viewport resize avoids measuring transcript items", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    await request.post("/__e2e/chat", { data: { action: "seed", agent, items: chatWorkload(50) } });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.addInitScript(() => { globalThis.__uatuChatPerformance = { counts: {}, durations: {} }; });
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator('[data-chat-item-id="bench:49"]')).toBeVisible();
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => globalThis.__uatuChatPerformance?.counts["item-geometry"] ?? 0);
    await page.setViewportSize({ width: 390, height: 744 });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => globalThis.__uatuChatPerformance?.counts["item-geometry"] ?? 0)).toBe(before);
    const distance = await page.locator("#chat-timeline").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    expect(distance).toBeLessThan(3);
  });
  test("optional catalogs and a hidden preview cannot block restored Chat", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    await request.post("/__e2e/chat", { data: { action: "seed", agent, items: chatWorkload(50) } });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    let previewReads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/document?*", async route => { previewReads++; await gate; await route.continue(); });
    await page.route(/\/api\/chat\/(models|modes|commands)\?/, async route => {
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Catalog unavailable" }) });
    });
    await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:active-tab", "chat"));
    try {
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await expect(page.locator('[data-chat-item-id="bench:49"]')).toBeVisible();
      await expect(page.locator("#chat-configuration-trigger")).toBeDisabled();
      expect(previewReads).toBe(0);
      await page.locator("#chat-input").fill("Draft while catalogs wait");
      release();
      await expect(page.locator("#chat-configuration-trigger")).toBeEnabled();
      await expect(page.locator("#chat-input")).toHaveValue("Draft while catalogs wait");
    } finally { release(); }
  });

  test("a failed read offers a read-only retry and a superseded read cannot replace selection", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const first = await request.post("/__e2e/chat", { data: { action: "seed", agent, items: chatWorkload(50, "first") } }).then(r => r.json());
    const second = await request.post("/__e2e/chat", { data: { action: "seed", agent, items: chatWorkload(50, "second") } }).then(r => r.json());
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    let inventoryReads = 0;
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>(resolve => { releaseInventory = resolve; });
    await page.route("**/api/chat/conversations", async route => {
      if (++inventoryReads === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "History list unavailable" }) });
      else { await inventoryGate; await route.continue(); }
    });
    let mutations = 0;
    page.on("request", req => { if (req.method() === "POST" && req.url().includes("/api/chat/")) mutations++; });
    await page.route(`**/api/chat/conversations/${encodeURIComponent(second.conversation.id)}?*`, async route => {
      reads++;
      if (reads === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "History unavailable" }) });
      else { await gate; await route.continue(); }
    });
    try {
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await page.locator("#touch-tab-chat").click();
      await expect(page.locator(".chat-read-error").filter({ visible: true })).toContainText("History list unavailable");
      await page.getByRole("button", { name: "Retry read" }).click();
      await expect(page.locator(".uatu-loading-label")).toHaveText("Loading conversations...");
      await page.locator("#touch-tab-files").click();
      await page.locator("#touch-tab-chat").click();
      await expect(page.locator(".uatu-loading-label")).toHaveText("Loading conversations...");
      releaseInventory();
      await expect(page.locator(".chat-read-error").filter({ visible: true })).toContainText("History unavailable");
      await expect(page.getByRole("button", { name: "Retry read" })).toBeVisible();
      await page.locator("#chat-input").fill("Keep my draft");
      await page.locator("#chat-input").blur();
      await page.clock.install();
      await page.getByRole("button", { name: "Retry read" }).click();
      await expect(page.locator(".uatu-loading-label").filter({ hasText: "Loading conversation..." })).toBeVisible();
      await expect(page.locator("#chat-timeline")).toHaveAttribute("aria-busy", "true");
      await page.clock.fastForward(30_001);
      await expect(page.locator(".chat-read-error").filter({ visible: true })).toContainText("timed out");
      await page.getByRole("button", { name: "Retry read" }).click();
      await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
      await expect(page.locator('[data-chat-item-id="first:49"]')).toBeVisible();
      release();
      await expect(page.locator("#chat-conversation-select")).toHaveValue(first.conversation.id);
      await expect(page.locator('[data-chat-item-id="second:49"]')).toHaveCount(0);
      await page.locator("#chat-conversation-select").selectOption(second.conversation.id);
      await expect(page.locator('[data-chat-item-id="second:49"]')).toBeVisible();
      await expect(page.locator("#chat-input")).toHaveValue("Keep my draft");
      expect(mutations).toBe(0);
    } finally { releaseInventory(); release(); }
  });

  test("long loaded history preserves find, copy, links, prompt jumps and active selections", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const items = chatWorkload(500);
    items[2] = { id: "bench:2", type: "assistant_message", createdAt: items[2]!.createdAt,
      markdown: "Early unique answer\n\n```ts\nconst searchable = 42;\n```\n[Read workspace](README.md)" };
    items[3] = { id: "bench:3", type: "tool", createdAt: items[3]!.createdAt, name: "read", status: "completed", output: "Unique collapsed result", input: "README.md" };
    const snapshot = await request.post("/__e2e/chat", { data: { action: "seed", agent, items } }).then(r => r.json());
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator('[data-chat-item-id="bench:499"]')).toBeVisible();
    await page.locator("#chat-timeline").focus();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator("#find-query")).toHaveAttribute("placeholder", "Find in chat");
    await page.locator("#find-query").fill("Unique collapsed result");
    await expect(page.locator('[data-chat-item-id="bench:3"]')).toContainText("Unique collapsed result");
    await expect(page.locator("#find-status")).toHaveText("1 of 1");
    await expect(page.locator('[data-chat-item-id="bench:3"]')).toHaveAttribute("open", "");
    await expect(page.locator('[data-chat-item-id="bench:3"]')).toBeInViewport();
    await page.locator("#find-query").fill("const searchable = 42");
    await expect(page.locator("#find-status")).toHaveText("1 of 1");
    await page.keyboard.press("Escape");
    await installClipboardMock(page);
    const answer = page.locator('[data-chat-item-id="bench:2"]');
    await answer.locator('[data-chat-copy="code"]').click();
    expect(await readClipboardMock(page)).toBe("const searchable = 42;\n");
    await answer.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el.querySelector("p")!);
      const selection = getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      (globalThis as any).__retainedAnswer = el;
    });
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id,
      item: { id: "late", type: "assistant_message", createdAt: Date.now(), markdown: "New output" } } });
    await expect(page.locator('[data-chat-item-id="late"]')).toBeAttached();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("Early unique answer");
    expect(await answer.evaluate(el => el === (globalThis as any).__retainedAnswer)).toBe(true);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    const firstDot = page.locator("#chat-prompt-rail .chat-prompt-dot").first();
    const promptId = await firstDot.getAttribute("data-prompt-target");
    await firstDot.click();
    await expect(page.locator(`[data-chat-item-id="${promptId}"]`)).toBeInViewport();
    await answer.locator("[data-file-ref]").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await expect(page.locator("#preview")).toContainText("README");
    await page.locator("#touch-tab-chat").click();
    const order = await page.locator("#chat-items [data-chat-item-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-chat-item-id")));
    expect(order.indexOf("bench:2")).toBeLessThan(order.indexOf("bench:499"));
    const question = page.locator('[data-chat-item-id="bench:499"]');
    await question.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.getByRole("radio", { name: "Browser tests Exercise navigation and reading" }).check();
    await question.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(question).toContainText("Answered");
  });

  test("hidden child output suspends presentation and resumes its reading position", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const child = await request.post("/__e2e/chat", { data: { action: "seed", agent, child: true, items: chatWorkload(50, "child") } }).then(r => r.json());
    await request.post("/__e2e/chat", { data: { action: "seed", agent, items: [{
      id: "tool:child", type: "tool", createdAt: 1, name: "task", status: "completed",
      input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
      childConversationId: child.conversation.id,
    }] } });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.addInitScript(() => { globalThis.__uatuChatPerformance = { counts: {}, durations: {} }; });
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Review renderer" }).click();
    await expect(page.locator('[data-chat-item-id="child:49"]')).toBeVisible();
    await page.locator("#chat-drilldown-timeline").evaluate(el => { el.scrollTop = 250; });
    await page.waitForTimeout(100);
    const top = await page.locator("#chat-drilldown-timeline").evaluate(el => el.scrollTop);
    await page.locator("#touch-tab-files").click();
    const before = await page.evaluate(() => globalThis.__uatuChatPerformance?.counts["transcript-render"]);
    for (let i = 0; i < 5; i++) await request.post("/__e2e/chat", { data: { action: "item", conversationId: child.conversation.id,
      item: { id: "child:late", type: "assistant_message", createdAt: Date.now(), markdown: `Child update ${i}` } } });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => globalThis.__uatuChatPerformance?.counts["transcript-render"])).toBe(before);
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator('[data-chat-item-id="child:late"]')).toContainText("Child update 4");
    expect(Math.abs(await page.locator("#chat-drilldown-timeline").evaluate(el => el.scrollTop) - top)).toBeLessThan(3);
    await page.locator("#chat-drilldown-back").click();
    await expect(page.locator("#chat-drilldown")).toBeHidden();
  });

});
