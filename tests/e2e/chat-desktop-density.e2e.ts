import { expect, test } from "./fixtures";
import { openChatPanel, openChatPending, openChatWorkers } from "./chat-helpers";

test("legacy Queue default cannot change Enter or Alt+Enter, including after reload", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2" } });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation");
  const submit = async (text: string, key: string, delivery: string) => {
    await page.locator("#chat-input").fill(text);
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press(key);
    const response = await accepted;
    expect(response.request().postDataJSON()).toMatchObject({ text, delivery });
    expect(await response.json()).toMatchObject({ delivery });
  };
  await page.locator("#chat-input").fill("Start work");
  const started = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await page.locator("#chat-input").press("Enter");
  expect((await started).request().postDataJSON()).toMatchObject({ delivery: "steer" });
  expect(await (await started).json()).toMatchObject({ pending: false });
  await expect(page.locator("#chat-stop")).toBeEnabled();
  await submit("Steer despite legacy Queue", "Enter", "steer");
  await submit("Queue explicitly", "Alt+Enter", "queue");
  await page.reload();
  await openChatPanel(page);
  await submit("Still steer after reload", "Enter", "steer");
  await submit("Still queue explicitly", "Alt+Enter", "queue");
  expect(await page.evaluate(() => localStorage.getItem("uatu:presentation:v1:%2F:chat-delivery"))).toBe("queue");
});

for (const fraction of [0.4, 0.8]) test(`desktop density follows pane width (${fraction})`, async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(fraction => localStorage.setItem("uatu:presentation:v1:%2F:uatu:chat-panel", JSON.stringify({ open: true, fraction })), fraction);
  // An upgrading browser may still have the retired Queue default.
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation");
  const input = page.locator("#chat-input");
  await expect(page.locator("#chat-keyboard-hint")).toHaveText("Enter: send · Shift+Enter: new line");
  await input.fill("Review density without losing controls");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  for (let i = 0; i < 12; i++) await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } });
  await expect(page.locator("#chat-compact-workers [data-worker-id]")).toHaveCount(12);
  await openChatWorkers(page);
  for (let i = 0; i < 8; i++) {
    await input.fill(`Queued review ${i}`); await input.press("Alt+Enter");
    await expect(page.locator(".chat-queued-message")).toHaveCount(i + 1);
  }
  await openChatPending(page);
  await expect(page.locator("#chat-keyboard-hint")).toHaveText("Enter: steer · Alt+Enter: queue");
  for (const selector of ["#chat-send", "#chat-stop", "#chat-attach", "#chat-configuration-trigger"]) {
    expect((await page.locator(selector).boundingBox())!.height).toBe(32);
  }
  const inspect = page.locator(".chat-worker-inspect").first();
  await expect(inspect.locator(".chat-worker-meta")).toBeVisible();
  const row = (await inspect.boundingBox())!;
  const paneWidth = await page.locator(".chat-work-dock").evaluate(node => node.clientWidth);
  if (fraction > 0.5) expect(paneWidth).toBeGreaterThanOrEqual(640);
  expect(row.height, `actual dock width ${paneWidth}`).toBe(paneWidth >= 640 ? 28 : 44);
  if (fraction > 0.5) {
    const reading = await page.locator(".chat-transcript-area").evaluate(node => node.getBoundingClientRect().height);
    expect(reading).toBeGreaterThanOrEqual(200);
    expect(reading).toBeLessThanOrEqual(281);
  }
  expect(await page.locator("#chat-composer").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.locator(".chat-work-dock").evaluate(node => getComputedStyle(node).overflowY)).not.toBe("auto");
  for (const selector of ["#chat-compact-workers-items", ".chat-queue-content"]) {
    expect(await page.locator(selector).evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  }
  // Shrinking the actual window yields reading space, not unreachable Stop.
  await page.setViewportSize({ width: 1440, height: 500 });
  await expect(page.locator("#chat-stop")).toBeInViewport();
  await expect(page.locator("#chat-compact-workers > summary")).toBeInViewport();
  await expect(page.locator("[data-pending-toggle]")).toBeInViewport();
  await page.evaluate(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
  await input.fill("Ignore the retired keyboard preference");
  await expect(page.locator("#chat-keyboard-hint")).toHaveText("Enter: steer · Alt+Enter: queue");
  await input.press("Enter");
  await expect(page.locator('.chat-queued-message[data-delivery="steer"]')).toHaveCount(1);
  await input.fill("Use the one-time keyboard override");
  await input.press("Alt+Enter");
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(9);
  await page.reload();
  await openChatPanel(page);
  await expect(page.locator("#chat-keyboard-hint")).toHaveText("Enter: steer · Alt+Enter: queue");
  await input.fill("Still steer after reload");
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await input.press("Enter");
  expect(await (await accepted).json()).toMatchObject({ pending: true, delivery: "steer" });
  expect(await page.evaluate(() => localStorage.getItem("uatu:presentation:v1:%2F:chat-delivery"))).toBe("queue");
});

test("explicit comfortable mode keeps touch targets on a fine-pointer desktop", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "touch"));
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2" } });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.locator("#touch-tab-chat").click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await expect(page.locator("#chat-state")).toContainText("Started new conversation");
  await expect(page.locator("#chat-send")).toBeVisible();
  await expect(page.locator("#chat-keyboard-hint")).toBeHidden();
  expect((await page.locator("#chat-send").boundingBox())!.height).toBe(44);
});
