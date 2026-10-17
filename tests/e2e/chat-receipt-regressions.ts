import { test, expect, childChatControl, openSessionTab, signIn, type HubE2EInfo } from "./hub-fixtures";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import type { BrowserContext } from "@playwright/test";

async function setup(hub: HubE2EInfo, context: BrowserContext) {
  const workspace = hub.workspaces[0]!;
  await childChatControl(workspace, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
  const page = await openSessionTab(context, workspace);
  await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  await page.locator("#chat-input").fill("Start regression fixture");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const base = `${workspace.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}`;
  const post = (path: string, data: object) => context.request.post(base + path, { data, headers: { origin: hub.origin } });
  const state = async () => await childChatControl(workspace, { action: "opencode", op: "state" }) as { calls: string[]; sessions: Record<string, { pending: Array<{ payload: { text: string } }> }> };
  return { workspace, page, conversationId, base, post, state };
}

export const receiptRegressions = (trusted: boolean): void => test.describe(`${trusted ? "trusted" : "degraded"} Hub receipt regressions`, () => {

  test("applied prompt with lost native acknowledgement retains unknown on immediate retry", async ({ hub, hubContext }) => {
    const { workspace, conversationId, post, state } = await setup(hub, hubContext);
    await childChatControl(workspace, { action: "opencode", op: "losePromptResponse" });
    const before = await state();
    const body = { requestId: "unknown-shared-id", text: "Keep this accepted input once", delivery: "steer" };
    expect((await post("/prompts", body)).status()).toBe(409);
    expect((await post("/prompts", body)).status()).toBe(409);
    const alternatePath = baseUrl(hub, conversationId).replace(encodeURIComponent(conversationId), conversationId) + "/prompts";
    expect((await hubContext.request.post(alternatePath, { data: body, headers: { origin: hub.origin } })).status()).toBe(409);
    const after = await state();
    const mutations = after.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
    expect(mutations.filter(call => call.includes("/prompt"))).toHaveLength(1);
    expect(mutations.filter(call => call.includes("/background"))).toHaveLength(0);
    expect(after.sessions[conversationId.replace(/^opencode:/, "")]!.pending.filter(entry => entry.payload.text === body.text)).toHaveLength(1);
    const snapshot = await hubContext.request.get(baseUrl(hub, conversationId));
    expect(snapshot.ok()).toBe(true);
    expect((await snapshot.json()).queued).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: body.requestId, text: body.text })]));
  });

  test("two authenticated accounts using one client ID keep distinct inputs and own receipts", async ({ hub, hubContext, browser }) => {
    const { page, conversationId, base, post, state } = await setup(hub, hubContext);
    const other = await browser.newContext();
    try {
      await signIn(await other.newPage(), { ...hub, user: hub.otherUser! });
      const before = await state();
      const body = { requestId: "same-browser-id", text: "First account input", delivery: "steer" };
      const a = await (await post("/prompts", body)).json();
      const bResponse = await other.request.post(base + "/prompts", { data: { ...body, text: "Second account input" }, headers: { origin: hub.origin, "x-uatu-hub-principal": "forged-first-account" } });
      expect(bResponse.status()).toBe(202);
      const b = await bResponse.json();
      expect(a.messageId).not.toBe(b.messageId);
      const preferences = `${hub.origin}/api/hub/settings/chat-preferences`;
      const saved = await hubContext.request.get(preferences).then(response => response.json());
      expect((await hubContext.request.put(preferences, { headers: { origin: hub.origin }, data: { version: 1, expectedRevision: saved.revision, autoBackgroundOnSteer: false } })).ok()).toBe(true);
      expect(await (await post("/prompts", body)).json()).toEqual(a);
      expect(await (await other.request.post(base + "/prompts", { data: { ...body, text: "Second account input" }, headers: { origin: hub.origin } })).json()).toEqual(b);
      const after = await state();
      expect(after.calls.slice(before.calls.length).filter(call => call.startsWith("POST ") && call.includes("/prompt"))).toHaveLength(2);
      const pending = after.sessions[conversationId.replace(/^opencode:/, "")]!.pending.map(entry => entry.payload.text);
      expect(pending).toContain(body.text); expect(pending).toContain("Second account input");
      expect(JSON.stringify([a, b])).not.toMatch(/principal|receiptScope|secret/);
      await expect(page.locator("#chat-input")).toHaveValue("");
    } finally { await other.close(); }
  });

  for (const action of ["convert", "resume"] as const) test(`lost native ${action} acknowledgement stays unknown without any duplicate primary or background`, async ({ hub, hubContext }) => {
    const { workspace, page, conversationId, base, post, state } = await setup(hub, hubContext);
    const input = await (await post("/prompts", { requestId: "original-pending", text: "Preserve native input", delivery: action === "convert" ? "queue" : "steer" })).json();
    if (action === "resume") {
      await post("/cancel", { requestId: "pause" });
      await expect(page.locator("#chat-stop")).toBeDisabled();
    }
    await childChatControl(workspace, { action: "opencode", op: action === "convert" ? "losePromptResponse" : "loseResumeResponse" });
    const before = await state();
    const path = `${base}/queue/${encodeURIComponent(input.messageId)}${action === "convert" ? "" : "/send-now"}`;
    const mutation = () => hubContext.request.fetch(path, { method: action === "convert" ? "PATCH" : "POST", data: { requestId: "lost-native-operation", ...(action === "convert" ? { delivery: "steer" } : {}) }, headers: { origin: hub.origin } });
    expect((await mutation()).status()).toBe(409);
    expect((await mutation()).status()).toBe(409);
    const after = await state();
    const mutations = after.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
    expect(mutations.filter(call => call.includes(action === "convert" ? "/prompt" : "/interrupt?resume=true"))).toHaveLength(1);
    expect(mutations.filter(call => call.includes("/background"))).toHaveLength(0);
    expect(JSON.stringify(after.sessions[conversationId.replace(/^opencode:/, "")])).toContain("Preserve native input");
  });

  for (const action of ["convert", "held-now", "paused-now"] as const) for (const loss of ["transport", "server"] as const) test(`${action} ${loss} browser response loss keeps persistent uncertainty and the unrelated draft`, async ({ hub, hubContext }, testInfo) => {
    const { workspace, page, conversationId, base, post, state } = await setup(hub, hubContext);
    const held = await (await post("/prompts", { requestId: "held-original", text: "Action fixture input", delivery: action === "paused-now" ? "steer" : "queue" })).json();
    if (action !== "convert") {
      await post("/cancel", { requestId: "pause" });
      await expect(page.locator("#chat-stop")).toBeDisabled();
    }
    await childChatControl(workspace, { action: "opencode", op: "launchShell", conversationId, background: false });
    await page.locator("#chat-input").fill("Keep unrelated composing draft");
    const before = await state();
    const path = `/queue/${encodeURIComponent(held.messageId)}${action === "convert" ? "" : "/send-now"}`;
    let known: unknown, original: unknown;
    await page.route(`**${path}`, async route => {
      original = route.request().postDataJSON();
      const response = await route.fetch(); expect(response.ok()).toBe(true); known = await response.json();
      if (loss === "transport") await route.abort("failed");
      else await route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"Fixture acknowledgement lost"}' });
    }, { times: 1 });
    const button = action === "convert" ? page.locator("[data-queue-steer]") : action === "held-now" ? page.locator("[data-queue-send-now]").last() : page.getByRole("button", { name: "Send 1 paused steer now", exact: true });
    await button.click();
    await expect.poll(() => known).toBeTruthy();
    await expect(page.locator("#chat-action-feedback")).toContainText(/unconfirmed|could not be confirmed/i);
    await expect(page.locator("#chat-input")).toHaveValue("Keep unrelated composing draft");
    await page.locator("#chat-input").fill("Edited unrelated draft");
    await expect(page.locator("#chat-action-feedback")).toContainText(/unconfirmed|could not be confirmed/i);
    await captureScreenshot(page, testInfo, `review-${trusted ? "trusted" : "degraded"}-${action}-${loss}-unconfirmed`);
    const retry = await hubContext.request.fetch(base + path, { method: action === "convert" ? "PATCH" : "POST", data: original, headers: { origin: hub.origin } });
    expect(await retry.json()).toEqual(known);
    const after = await state();
    const mutations = after.calls.slice(before.calls.length).filter(call => call.startsWith("POST "));
    expect(mutations.filter(call => call.includes(action === "paused-now" ? "/interrupt?resume=true" : "/prompt"))).toHaveLength(1);
    expect(mutations.filter(call => call.includes("/background"))).toHaveLength(trusted ? 1 : 0);
    await page.reload(); await openChatPanel(page);
    const reloaded = await state();
    expect(reloaded.calls.filter(call => call.startsWith("POST "))).toEqual(after.calls.filter(call => call.startsWith("POST ")));
  });
});

function baseUrl(hub: HubE2EInfo, conversationId: string): string {
  return `${hub.workspaces[0]!.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}`;
}
