import { test, expect, childChatControl, openSessionTab, signIn } from "./hub-fixtures";
import { openChatPanel } from "./chat-helpers";
import type { BrowserContext } from "@playwright/test";
import type { HubE2EInfo } from "./hub-fixtures";

test.use({ hubChatPolicy: true, hubWorkspaces: ["automatic"] });

async function setup(hub: HubE2EInfo, hubContext: BrowserContext) {
  const workspace = hub.workspaces[0]!;
  await childChatControl(workspace, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
  const page = await openSessionTab(hubContext, workspace);
  await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  await page.locator("#chat-input").fill("Start fixture turn");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const base = `${workspace.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}`;
  const post = (path: string, data: object) => hubContext.request.post(base + path, { data, headers: { origin: hub.origin } });
  return { workspace, page, conversationId, base, post };
}

test("trusted personal ON backgrounds once after actual composer steer admission through the real provider stack", async ({ hub, hubContext }) => {
  const { workspace, page, conversationId } = await setup(hub, hubContext);
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  // A fresh device's established delivery default is steer.
  await page.locator("#chat-input").fill("Steer fixture turn");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-action-feedback")).toContainText("background request acknowledged");
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const mutations = state.calls.filter(call => call.startsWith("POST "));
  const prompt = mutations.findLastIndex(call => call.includes("/prompt"));
  const background = mutations.findIndex(call => call.includes("/background"));
  expect(prompt).toBeGreaterThanOrEqual(0);
  expect(background).toBeGreaterThan(prompt);
  expect(mutations.filter(call => call.includes("/background"))).toHaveLength(1);
  expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(2);
  expect(mutations.filter(call => call.includes("/interrupt"))).toHaveLength(0);
  await expect(page.locator("#chat-input")).toHaveValue("");
  await childChatControl(workspace, { action: "opencode", op: "finish", conversationId });
  await expect(page.locator("#chat-stop")).toBeDisabled();
  await expect(page.locator("#chat-action-feedback")).toBeHidden();
});

test("a Settings-only read failure does not promise saved ON automation is disabled in another tab", async ({ hub, hubContext }) => {
  const { workspace, page, conversationId } = await setup(hub, hubContext);
  const settings = await hubContext.newPage();
  await settings.route("**/api/hub/settings/chat-preferences", route => route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: "browser-specific read unavailable" } }) : route.fallback());
  await settings.goto(`${hub.origin}/settings`);
  const error = settings.locator("#personal-chat-preferences-error");
  await expect(error).toContainText("cannot confirm");
  await expect(error).toContainText("saved preferences may still apply");
  await expect(error).not.toContainText("is skipped");
  await expect(settings.getByLabel("Keep workers running when I steer")).toBeDisabled();
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  await page.locator("#chat-input").fill("Steer under the saved server policy");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-action-feedback")).toContainText("background request acknowledged");
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  expect(state.calls.filter(call => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(1);
  await expect(error).toContainText("saved preferences may still apply");
});

test("one accepted Hub steer backgrounds all eligible shells and children, not already detached work", async ({ hub, hubContext }) => {
  const { workspace, conversationId, post } = await setup(hub, hubContext);
  const foreground = await childChatControl(workspace, { action: "opencode", op: "launchWorker", conversationId, background: false }) as { childId: string };
  const detached = await childChatControl(workspace, { action: "opencode", op: "launchWorker", conversationId }) as { childId: string };
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  expect(await (await post("/prompts", { requestId: "mixed", text: "Mixed blockers", delivery: "steer" })).json()).toMatchObject({ automaticBackground: "accepted" });
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[]; sessions: Record<string, { running: boolean; messages: Array<{ type: string }> }> };
  const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
  expect(mutations.map(call => call.replace(/.*\/(prompt|background)$/, "$1"))).toEqual(["prompt", "background"]);
  expect(state.sessions[foreground.childId]!.running).toBe(true);
  expect(state.sessions[detached.childId]!.running).toBe(true);
  const historyResponse = await hubContext.request.get(`${workspace.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}`);
  expect(historyResponse.ok()).toBe(true);
  const history = await historyResponse.json();
  const workers = history.items.filter((item: { type: string }) => item.type === "background_task");
  expect(workers).toHaveLength(3);
  expect(workers.every((item: { status: string; foreground?: boolean; stateUncertain?: boolean }) => item.status === "running" && item.foreground !== true && !item.stateUncertain)).toBe(true);
});

test("native cancel settles blocking child before paused-batch resume; only detached work remains and no automatic background is forced", async ({ hub, hubContext }) => {
  const { workspace, page, conversationId, post } = await setup(hub, hubContext);
  const first = await post("/prompts", { requestId: "pending-a", text: "A", delivery: "steer" }).then(response => response.json());
  await post("/prompts", { requestId: "pending-b", text: "B", delivery: "steer" });
  const foreground = await childChatControl(workspace, { action: "opencode", op: "launchWorker", conversationId, background: false }) as { childId: string };
  const detached = await childChatControl(workspace, { action: "opencode", op: "launchWorker", conversationId }) as { childId: string };
  expect((await post("/cancel", { requestId: "pause" })).ok()).toBe(true);
  await expect(page.locator("#chat-stop")).toBeDisabled();
  const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[]; sessions: Record<string, { running: boolean }> };
  expect(before.sessions[foreground.childId]!.running).toBe(false);
  expect(before.sessions[detached.childId]!.running).toBe(true);
  expect(await (await post(`/queue/${encodeURIComponent(first.messageId)}/send-now`, { requestId: "resume" })).json()).toMatchObject({ automaticBackground: "not-needed" });
  const after = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  expect(after.calls.slice(before.calls.length).filter(call => call.startsWith("POST "))).toEqual([expect.stringContaining("/interrupt?resume=true")]);
});

for (const action of ["convert", "held-now", "paused-batch", "replacement"] as const) test(`${action} keeps native admission/resume ordering and one personal follow-up`, async ({ hub, hubContext }) => {
  const { workspace, page, conversationId, base, post } = await setup(hub, hubContext);
  let messageId: string | undefined;
  if (action === "convert" || action === "held-now") {
    const held = await post("/prompts", { requestId: "held", text: "Held fixture input", delivery: "queue" });
    expect(held.status()).toBe(202);
    messageId = (await held.json()).messageId;
  } else if (action === "paused-batch") {
    const first = await post("/prompts", { requestId: "paused-first", text: "First paused", delivery: "steer" });
    messageId = (await first.json()).messageId;
    expect((await post("/prompts", { requestId: "paused-second", text: "Second paused", delivery: "steer" })).status()).toBe(202);
    expect((await post("/cancel", { requestId: "pause" })).ok()).toBe(true);
    await expect(page.locator("#chat-stop")).toBeDisabled();
  } else {
    expect((await post("/undo", { requestId: "stage-replacement" })).ok()).toBe(true);
    await expect(page.locator("#chat-stop")).toBeDisabled();
  }
  await childChatControl(workspace, { action: "opencode", op: action === "replacement" ? "launchShellOnNextSteer" : "launchShell", conversationId, background: false });
  const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const response = action === "convert"
    ? await hubContext.request.patch(`${base}/queue/${encodeURIComponent(messageId!)}`, { headers: { origin: hub.origin }, data: { requestId: "convert", delivery: "steer" } })
    : action === "replacement" ? await post("/prompts", { requestId: "replacement", text: "Replacement fixture", delivery: "queue" })
      : await post(`/queue/${encodeURIComponent(messageId!)}/send-now`, { requestId: "send-now" });
  expect(response.ok(), await response.text()).toBe(true);
  expect(await response.json()).toMatchObject({ delivery: "steer", automaticBackground: "accepted" });
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
  expect(mutations.filter(call => call.includes("/background"))).toHaveLength(1);
  const primary = mutations.findIndex(call => call.includes(action === "paused-batch" ? "/interrupt?resume=true" : "/prompt"));
  expect(primary).toBeGreaterThanOrEqual(0);
  expect(mutations.findIndex(call => call.includes("/background"))).toBeGreaterThan(primary);
  expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(action === "paused-batch" ? 0 : 1);
});

test("opposing accounts share work, not policy or same-ID receipts; replay retains the first snapshot", async ({ hub, hubContext, browser }) => {
  const { workspace, page, conversationId, post } = await setup(hub, hubContext);
  const other = await browser.newContext();
  try {
    const login = await other.newPage();
    await signIn(login, { ...hub, user: hub.otherUser! });
    const settings = `${hub.origin}/api/hub/settings/chat-preferences`;
    const preference = await other.request.get(settings).then(response => response.json());
    expect((await other.request.put(settings, { headers: { origin: hub.origin }, data: { version: 1, expectedRevision: preference.revision, autoBackgroundOnSteer: false } })).ok()).toBe(true);
    await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
    const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
    const aliceBody = { requestId: "shared-client-id", text: "ON account input", delivery: "steer" };
    const [on, off] = await Promise.all([
      post("/prompts", aliceBody),
      other.request.post(`${workspace.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}/prompts`, { headers: { origin: hub.origin, "x-uatu-hub-chat-policy": "forged ON principal" }, data: { ...aliceBody, text: "OFF account input" } }),
    ]);
    expect(on.status()).toBe(202); expect(off.status()).toBe(202);
    const accepted = await on.json(), disabled = await off.json();
    expect(accepted.automaticBackground).toBe("accepted");
    expect(disabled).not.toHaveProperty("automaticBackground");
    expect(disabled.messageId).not.toBe(accepted.messageId);
    const current = await hubContext.request.get(settings).then(response => response.json());
    expect((await hubContext.request.put(settings, { headers: { origin: hub.origin }, data: { version: 1, expectedRevision: current.revision, autoBackgroundOnSteer: false } })).ok()).toBe(true);
    await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
    expect(await (await post("/prompts", aliceBody)).json()).toEqual(accepted);
    const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[]; sessions: Record<string, { pending: Array<{ payload: { text: string } }> }> };
    const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
    expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(2);
    expect(mutations.filter(call => call.includes("/background"))).toHaveLength(1);
    const pending = state.sessions[conversationId.replace(/^opencode:/, "")]!.pending.map(entry => entry.payload.text);
    expect(pending).toContain("ON account input"); expect(pending).toContain("OFF account input");
    expect(JSON.stringify(accepted)).not.toMatch(/principal|receiptScope|policy|secret/);
    await expect(page.locator("#chat-input")).toHaveValue("");
  } finally { await other.close(); }
});

for (const outcome of ["lost-primary", "lost-background", "refused-background"] as const) test(`${outcome} preserves input and never repeats either native mutation under its retained receipt`, async ({ hub, hubContext }) => {
  const { workspace, page, conversationId, post } = await setup(hub, hubContext);
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  await childChatControl(workspace, { action: "opencode", op: outcome === "lost-primary" ? "losePromptResponse" : outcome === "lost-background" ? "loseBackgroundResponse" : "refuseBackground" });
  const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const sent = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/prompts"));
  await page.locator("#chat-input").fill("Preserve uncertain fixture input");
  await page.locator("#chat-send").click();
  const body = (await sent).postDataJSON();
  await expect(page.locator("#chat-action-feedback")).toContainText(outcome === "lost-primary" ? "unconfirmed" : outcome === "lost-background" ? "could not be confirmed" : "was refused");
  await expect(page.locator("#chat-input")).toHaveValue("");
  await expect(page.locator("#chat-queue")).toContainText("Preserve uncertain fixture input");
  const replay = await post("/prompts", body);
  expect(replay.status()).toBe(outcome === "lost-primary" ? 409 : 202);
  if (outcome !== "lost-primary") expect(await replay.json()).toMatchObject({ pending: true, delivery: "steer", automaticBackground: outcome === "lost-background" ? "unknown" : "failed" });
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
  expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(1);
  expect(mutations.filter(call => call.includes("/background"))).toHaveLength(outcome === "lost-primary" ? 0 : 1);
  await childChatControl(workspace, { action: "opencode", op: "finish", conversationId });
  await expect(page.locator("#chat-stop")).toBeDisabled();
  await expect(page.locator("#chat-action-feedback")).toContainText(outcome === "lost-primary" ? "unconfirmed" : outcome === "lost-background" ? "could not be confirmed" : "was refused");
});

test("same-account devices share retained receipts while a stale ON display cannot override saved OFF", async ({ hub, hubContext, browser }) => {
  const { workspace, conversationId, post } = await setup(hub, hubContext);
  const staleSettings = await hubContext.newPage();
  await staleSettings.goto(`${hub.origin}/settings`);
  await expect(staleSettings.getByLabel("Keep workers running when I steer")).toBeChecked();
  const other = await browser.newContext();
  try {
    const login = await other.newPage(); await signIn(login, hub);
    await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
    const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
    const body = { requestId: "device-shared", text: "Shared device input", delivery: "steer" };
    const accepted = await (await post("/prompts", body)).json();
    expect(accepted.automaticBackground).toBe("accepted");
    const settings = `${hub.origin}/api/hub/settings/chat-preferences`;
    const saved = await other.request.get(settings).then(response => response.json());
    expect((await other.request.put(settings, { headers: { origin: hub.origin }, data: { version: 1, expectedRevision: saved.revision, autoBackgroundOnSteer: false } })).ok()).toBe(true);
    await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
    const endpoint = `${workspace.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}/prompts`;
    expect(await (await other.request.post(endpoint, { headers: { origin: hub.origin }, data: body })).json()).toEqual(accepted);
    await expect(staleSettings.getByLabel("Keep workers running when I steer")).toBeChecked();
    expect(await (await post("/prompts", { ...body, requestId: "new-after-off", text: "Fresh OFF input" })).json()).not.toHaveProperty("automaticBackground");
    const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
    const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
    expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(2);
    expect(mutations.filter(call => call.includes("/background"))).toHaveLength(1);
  } finally { await other.close(); }
});

test("browser response loss, reload and later blockers never replay the accepted composite operation", async ({ hub, hubContext }) => {
  const { workspace, page, conversationId, post } = await setup(hub, hubContext);
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  let original: object | undefined, known: object | undefined;
  await page.route("**/api/chat/conversations/*/prompts", async route => {
    original = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    known = await response.json();
    await route.abort("failed");
  }, { times: 1 });
  await page.locator("#chat-input").fill("Lost browser response input");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-action-feedback")).toContainText("unconfirmed");
  await expect(page.locator("#chat-input")).toHaveValue("");
  await page.reload(); await openChatPanel(page);
  await expect(page.locator("#chat-queue")).toContainText("Lost browser response input");
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  expect(await (await post("/prompts", original!)).json()).toEqual(known);
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
  expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(1);
  expect(mutations.filter(call => call.includes("/background"))).toHaveLength(1);
});

test("lost native batch-resume acknowledgement retains its receipt without duplicate prompts or resume", async ({ hub, hubContext }) => {
  const { workspace, page, conversationId, post } = await setup(hub, hubContext);
  const first = await post("/prompts", { requestId: "paused-a", text: "Paused A", delivery: "steer" }).then(response => response.json());
  await post("/prompts", { requestId: "paused-b", text: "Paused B", delivery: "steer" });
  await post("/cancel", { requestId: "pause" });
  await expect(page.locator("#chat-stop")).toBeDisabled();
  await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
  await childChatControl(workspace, { action: "opencode", op: "loseResumeResponse" });
  const before = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[] };
  const resume = () => post(`/queue/${encodeURIComponent(first.messageId)}/send-now`, { requestId: "uncertain-resume" });
  expect((await resume()).status()).toBe(409);
  expect((await resume()).status()).toBe(409);
  const state = await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[]; sessions: Record<string, { messages: Array<{ text?: string }> }> };
  const mutations = state.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
  expect(mutations.filter(call => call.includes("/interrupt?resume=true"))).toHaveLength(1);
  expect(mutations.filter(call => call.includes("/prompt") || call.includes("/background"))).toHaveLength(0);
  const messages = state.sessions[conversationId.replace(/^opencode:/, "")]!.messages;
  expect(messages.filter(message => message.text === "Paused A")).toHaveLength(1);
  expect(messages.filter(message => message.text === "Paused B")).toHaveLength(1);
});
