import { expect, test } from "./fixtures";
import { openChatPanel } from "./chat-helpers";

type ReadinessGate = { held: boolean; release(): void };

test("reload restores composer readiness before fixed Enter and Alt+Enter delivery", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2" } });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation");
  const input = page.locator("#chat-input");
  await input.fill("Start work");
  const started = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await input.press("Enter");
  expect(await (await started).json()).toMatchObject({ pending: false });
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const id = await page.locator("#chat-conversation-select").inputValue();
  const snapshot = await page.request.get(`/api/chat/conversations/${encodeURIComponent(id)}`);
  expect(snapshot.ok()).toBe(true);
  const { configuration } = await snapshot.json();
  expect(configuration).toBeDefined();
  await input.fill("Saved private draft");
  await page.addInitScript(({ id }) => {
    // Hold a real snapshot at the browser boundary, including through a
    // service worker, without replacing its contents or the live stream.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { __readinessGate: { held: false, release: () => release() } });
    const original = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      const value = args[0];
      const url = new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url, location.href);
      if (url.pathname === `/api/chat/conversations/${encodeURIComponent(id)}`) {
        (window as unknown as { __readinessGate: ReadinessGate }).__readinessGate.held = true;
        await gate;
      }
      return response;
    };
  }, { id });
  let prompts = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/prompts")) prompts++; });
  await page.reload();
  await openChatPanel(page);
  await page.waitForFunction(() => (window as unknown as { __readinessGate: ReadinessGate }).__readinessGate.held);
  await expect(input).toHaveValue("Saved private draft");
  await expect(input).toBeDisabled();
  await expect(page.locator("#chat-send")).toBeDisabled();
  await expect(page.locator("#chat-attach")).toBeEnabled();
  await page.locator("#chat-attach-input").setInputFiles({
    name: "readiness.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
  await expect(input).toHaveValue("Saved private draft");
  await expect(input).toBeDisabled();
  await page.locator("#chat-attachments .chat-attachment-remove").click();
  await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(0);
  expect(prompts).toBe(0);
  const chooser = page.locator("#chat-conversation-select");
  await chooser.focus();
  await page.evaluate(() => (window as unknown as { __readinessGate: ReadinessGate }).__readinessGate.release());
  await expect(input).toBeEnabled();
  await expect(chooser).toBeFocused();
  await expect(input).toHaveValue("Saved private draft");
  expect(prompts).toBe(0);
  const submissions = [
    ["Still steer after reload", "Enter", "steer"],
    ["Still queue explicitly", "Alt+Enter", "queue"],
  ] as const;
  for (const [index, [text, key, delivery]] of submissions.entries()) {
    await input.fill(text);
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press(key);
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toMatchObject({ text, delivery, ...configuration });
    expect(await response.json()).toMatchObject({ delivery, configuration });
    expect(prompts).toBe(index + 1);
  }
  expect(await page.evaluate(() => localStorage.getItem("uatu:presentation:v1:%2F:chat-delivery"))).toBe("queue");
});

for (const agent of ["claude", "opencode"] as const) test(`${agent} failed opening permits draft-only editing through a timed-out retry`, async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", agent, items: [
    { id: "recovery:answer", type: "assistant_message", createdAt: 1, markdown: "Loaded recovery history" },
  ] } }).then(response => response.json());
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0, mutations = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/chat/")) mutations++; });
  await page.route(`**/api/chat/conversations/${encodeURIComponent(seeded.conversation.id)}?*`, async route => {
    if (++reads === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Recovery history unavailable" }) });
    else { await gate; await route.continue(); }
  });
  try {
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await openChatPanel(page);
    const input = page.locator("#chat-input");
    const send = page.locator("#chat-send");
    const unsentNotice = page.getByRole("status").filter({ hasText: "Nothing was sent; your draft was kept." });
    const readError = page.locator(".chat-read-error").filter({ visible: true });
    await expect(readError).toContainText("Recovery history unavailable");
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
    await expect(input).toBeEnabled();
    await expect(send).toBeDisabled();
    await input.fill("Draft after failed opening");
    for (const key of ["Enter", "Alt+Enter"]) {
      await input.press(key);
      await expect(unsentNotice).toHaveCount(1);
      await expect(unsentNotice).toHaveAttribute("aria-live", "polite");
      await expect(unsentNotice).toHaveAttribute("aria-atomic", "true");
      await expect(input).toHaveValue("Draft after failed opening");
      await expect(readError).toContainText("Recovery history unavailable");
      await expect(page.getByRole("button", { name: "Retry read" })).toBeEnabled();
      expect(mutations).toBe(0);
    }
    await input.blur();
    await page.clock.install();
    await page.getByRole("button", { name: "Retry read" }).click();
    await expect(page.locator(".uatu-loading-label").filter({ hasText: "Loading conversation..." })).toBeVisible();
    await expect(page.locator("#chat-timeline")).toHaveAttribute("aria-busy", "true");
    await expect(input).toBeEnabled();
    await expect(send).toBeDisabled();
    await input.fill("Draft edited during hung retry");
    for (const key of ["Enter", "Alt+Enter"]) {
      await input.press(key);
      await expect(unsentNotice).toHaveCount(1);
      await expect(unsentNotice).toHaveAttribute("aria-live", "polite");
      await expect(unsentNotice).toHaveAttribute("aria-atomic", "true");
      await expect(input).toHaveValue("Draft edited during hung retry");
      await expect(send).toBeDisabled();
      await expect(page.locator("#chat-timeline")).toHaveAttribute("aria-busy", "true");
      await expect(page.locator(".uatu-loading-label").filter({ hasText: "Loading conversation..." })).toBeVisible();
      expect(mutations).toBe(0);
    }
    await page.clock.fastForward(30_001);
    await expect(readError).toContainText("timed out");
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("Draft edited during hung retry");
    await page.getByRole("button", { name: "Retry read" }).click();
    await expect(page.locator("#chat-timeline")).toHaveAttribute("aria-busy", "true");
    await expect(input).toBeEnabled();
    release();
    await expect(page.locator('[data-chat-item-id="recovery:answer"]')).toBeVisible();
    await expect(input).toHaveValue("Draft edited during hung retry");
    await expect(send).toBeEnabled();
    await expect(unsentNotice).toHaveCount(0);
    await expect(readError).toHaveCount(0);
    expect(reads).toBe(3);
    expect(mutations).toBe(0);
  } finally { release(); }
});
