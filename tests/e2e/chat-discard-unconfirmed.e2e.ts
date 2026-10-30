import type { APIRequestContext, Page } from "@playwright/test";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";
import { expect, test as base } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";

const test = withEngineBrowsers(base);
type NativeState = { calls: string[]; unhandled: string[]; sessions: Record<string, { running: boolean; pending: Array<{ id: string }>; messages: Array<{ type: string; text?: string }> }> };
async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function heldAdmissionFixture(page: Page, request: APIRequestContext, mode: "desktop" | "touch") {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (mode === "touch") await page.locator("#touch-tab-chat").tap(); else await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  const sessionID = conversationId.replace(/^opencode:/, "");
  const chat = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
  const headers = { origin: new URL(page.url()).origin };
  const post = (path: string, data: unknown) => request.post(`${chat}${path}?t=${encodeURIComponent(token)}`, { data, headers });
  const snapshot = () => request.get(`${chat}?t=${encodeURIComponent(token)}`).then(response => response.json());
  expect((await post("/prompts", { requestId: "start", text: "Start fixture work" })).ok()).toBe(true);
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const headResponse = await post("/prompts", { requestId: "head", text: "Original uncertain held input", delivery: "queue" });
  expect(headResponse.ok()).toBe(true);
  const head = await headResponse.json() as { messageId: string };
  expect((await post("/prompts", { requestId: "behind", text: "Other queued input", delivery: "queue" })).ok()).toBe(true);
  const state = () => control(request, { action: "opencode", op: "state" }) as Promise<NativeState>;
  const unknown = async () => {
    await control(request, { action: "opencode", op: "unknownPromptBeforeAdmission" });
    const result = await request.patch(`${chat}/queue/${encodeURIComponent(head.messageId)}?t=${encodeURIComponent(token)}`, { data: { requestId: "convert", delivery: "steer" }, headers });
    expect(result.ok()).toBe(false);
  };
  return { conversationId, sessionID, post, snapshot, state, unknown, head };
}

const nativeWrites = (value: NativeState) => value.calls.filter(call => /^(POST|PATCH|DELETE) /.test(call));

type DiscardEventGate = {
  target?: { conversationId: string; messageId: string };
  pending: Array<() => void>;
  removals: number;
  release(): number;
};

// Delay genuine frames at the browser's public SSE boundary. Keep all frames
// for the target conversation ordered; never invent native or queue evidence.
function installDiscardEventGate() {
  const scope = window as unknown as { discardEventGate: DiscardEventGate };
  const gate: DiscardEventGate = scope.discardEventGate = {
    pending: [], removals: 0,
    release() {
      gate.target = undefined;
      const frames = gate.pending.splice(0);
      for (const frame of frames) frame();
      return frames.length;
    },
  };
  const original = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (type, listener, options) {
    if (type !== "live" || !listener) return original.call(this, type, listener, options);
    const source = this;
    return original.call(this, type, event => {
      const envelope = JSON.parse((event as MessageEvent).data);
      const invoke = () => typeof listener === "function" ? listener.call(source, event) : listener.handleEvent(event);
      if (gate.target && envelope.topic === "conversation" && envelope.key === gate.target.conversationId) {
        const data = envelope.event?.data;
        if (data?.type === "conversation.queue" && data.change?.kind === "removed" && data.change.messageId === gate.target.messageId) gate.removals++;
        gate.pending.push(invoke);
      } else invoke();
    }, options);
  };
}

type ConfirmationCloseGate = {
  held: boolean;
  nativeCloses: number;
  focusAfterRelease?: "composer" | "other";
  events: Array<{ type: string; trusted: boolean; open: boolean; value: string; confirmSubmitter: boolean }>;
  release(): boolean;
};

// New ownership regression only: observe a genuine native close, hold its
// delivery, then explicitly redispatch it (untrusted) after the next intent.
// This controls dialog lifecycle, not provider evidence or HTTP receipts.
function installConfirmationCloseGate() {
  let held: Event | undefined;
  const gate: ConfirmationCloseGate = {
    held: false, nativeCloses: 0, events: [],
    release() {
      if (!held) throw new Error("No native close held");
      const event = held;
      const wasTrusted = event.isTrusted;
      held = undefined;
      gate.held = false;
      document.querySelector("#chat-action-confirm")!.dispatchEvent(event);
      // Observe restoration before the waiting next owner can open in a microtask.
      gate.focusAfterRelease = document.activeElement?.id === "chat-input" ? "composer" : "other";
      return wasTrusted;
    },
  };
  (window as unknown as { confirmationCloseGate: ConfirmationCloseGate }).confirmationCloseGate = gate;
  for (const type of ["cancel", "close", "submit"]) document.addEventListener(type, event => {
    const dialog = document.querySelector<HTMLDialogElement>("#chat-action-confirm");
    if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
    gate.events.push({ type, trusted: event.isTrusted, open: dialog.open, value: dialog.returnValue,
      confirmSubmitter: type === "submit" && (event as SubmitEvent).submitter?.getAttribute("value") === "confirm" });
    if (type === "close" && event.isTrusted && ++gate.nativeCloses === 1) {
      held = event;
      gate.held = true;
      event.stopImmediatePropagation();
    }
  }, true);
}

for (const browserName of ["chromium", "webkit"] as const) for (const mode of ["desktop", "touch"] as const) test.describe(`local discard ${mode} ${browserName}`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(browserName);
    const page = await browser.newPage({ baseURL, viewport: mode === "touch" ? { width: 390, height: 844 } : { width: 1360, height: 960 }, hasTouch: mode === "touch", isMobile: mode === "touch" });
    await page.addInitScript(installDiscardEventGate);
    await use(page);
    await browser.close();
  } });

  test("confirms local-only removal without native writes or draining the held queue", async ({ page, request }, info) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    if (mode === "touch") await page.locator("#touch-tab-chat").tap(); else await openChatPanel(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    const sessionID = conversationId.replace(/^opencode:/, "");
    const chat = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
    const post = (path: string, data: unknown) => request.post(`${chat}${path}?t=${encodeURIComponent(token)}`, { data, headers: { origin: new URL(page.url()).origin } });
    const started = await post("/prompts", { requestId: "start", text: "Start fixture work" });
    expect(started.ok(), await started.text()).toBe(true);
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await control(request, { action: "opencode", op: "unknownPromptBeforeAdmission" });
    const unknown = await post("/prompts", { requestId: "original-unknown", text: "Original uncertain input", delivery: "steer" });
    expect(unknown.ok()).toBe(false);
    const state = () => control(request, { action: "opencode", op: "state" }) as Promise<NativeState>;
    expect((await state()).sessions[sessionID]!.pending).toEqual([]);
    const heldAcceptance = await post("/prompts", { requestId: "held", text: "Other queued input", delivery: "queue" });
    expect(heldAcceptance.ok()).toBe(true);
    await saveEvidence(info, `discard-${mode}-${browserName}-before-settlement.json`, JSON.stringify({ acceptance: await heldAcceptance.json(), native: await state(), snapshot: await request.get(`${chat}?t=${encodeURIComponent(token)}`).then(response => response.json()) }, null, 2));
    // A normal finish before discard legitimately drains held work. Stop the
    // parent explicitly to establish idle/dormant setup instead; this says
    // nothing about cancellation of the unknown admission.
    expect((await post("/cancel", { requestId: "setup-stop-parent" })).ok()).toBe(true);
    await saveEvidence(info, `discard-${mode}-${browserName}-settlement.json`, JSON.stringify({ native: await state(), snapshot: await request.get(`${chat}?t=${encodeURIComponent(token)}`).then(response => response.json()) }, null, 2));
    await expect(page.locator("#chat-stop")).toBeDisabled();
    const snapshot = await request.get(`${chat}?t=${encodeURIComponent(token)}`).then(response => response.json()) as { queued: Array<{ id: string; admissionUncertaintyId?: string }> };
    const eligible = snapshot.queued.find(entry => entry.admissionUncertaintyId)!;
    expect(eligible.admissionUncertaintyId).toEqual(expect.any(String));
    const refused = await post(`/queue/${encodeURIComponent(eligible.id)}/discard-unconfirmed`, { requestId: "wrong-token", uncertaintyId: "stale-token" });
    expect(refused.status()).toBe(409);
    const toggle = page.locator("[data-pending-toggle]");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const discard = page.locator("[data-queue-discard]");
    await expect(discard).toHaveCount(1);
    // Collapsed entries already exist in the DOM; expansion paints on a frame.
    // Wait for that paint before measuring the action's actual target size.
    await expect(discard).toBeVisible();
    const rowGeometry = await discard.boundingBox();
    expect(rowGeometry!.height).toBeGreaterThanOrEqual(32);
    const input = page.locator("#chat-input");
    await input.fill("Keep my unrelated draft");
    const mutations: Array<{ url: string; body: unknown }> = [];
    page.on("request", req => { if (req.method() === "POST" && req.url().includes("/queue/")) mutations.push({ url: req.url(), body: req.postDataJSON() }); });
    const before = await state();
    if (mode === "touch") await discard.tap(); else { await discard.focus(); await discard.press("Enter"); }
    const dialog = page.locator("#chat-action-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName("Discard local record?");
    await expect(dialog).toContainText("Removing Uatu’s local record does not cancel or resend it; the original may still arrive.");
    await expect(dialog).toContainText("Other messages will stay queued until you choose Send now or submit a new message, or a later normal idle transition occurs.");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    const geometry = await dialog.getByRole("button", { name: "Discard local record", exact: true }).boundingBox();
    expect(geometry!.height).toBeGreaterThanOrEqual(mode === "touch" ? 44 : 24);
    await captureScreenshot(page, info, `discard-${mode}-${browserName}-warning`);
    if (mode === "touch") await dialog.getByRole("button", { name: "Cancel", exact: true }).tap(); else await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(discard).toBeFocused();
    await expect(input).toHaveValue("Keep my unrelated draft");
    expect(mutations).toEqual([]);
    await page.evaluate(({ conversationId, messageId }) => {
      (window as unknown as { discardEventGate: DiscardEventGate }).discardEventGate.target = { conversationId, messageId };
    }, { conversationId, messageId: eligible.id });
    if (mode === "touch") await discard.tap(); else await discard.press("Enter");
    // Reopening waits for the previous native close event. Do not send Tab
    // until the new dialog has established its required initial Cancel focus.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    const accepted = page.waitForResponse(response => response.url().includes("/discard-unconfirmed"));
    if (mode === "touch") await dialog.getByRole("button", { name: "Discard local record", exact: true }).tap();
    else {
      // macOS WebKit's default Tab mode skips buttons; Option+Tab includes them.
      await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      await expect(dialog.getByRole("button", { name: "Discard local record", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
    }
    const acknowledgement = await accepted;
    expect(await acknowledgement.json()).toEqual({ discarded: true, outcomeUnconfirmed: true });
    await expect(discard).toHaveCount(0);
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(1);
    await expect(page.locator("#chat-queue")).toContainText("Other queued input");
    await expect(input).toHaveValue("Keep my unrelated draft");
    // First observe the acknowledgement's warning, then release its real SSE
    // removal. This ordering deterministically caught the transient-status bug.
    const feedback = page.locator("#chat-action-feedback");
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText("Delivery remains unconfirmed");
    await page.waitForFunction(() => (window as unknown as { discardEventGate: DiscardEventGate }).discardEventGate.removals === 1);
    const released = await page.evaluate(() => (window as unknown as { discardEventGate: DiscardEventGate }).discardEventGate.release());
    expect(released).toBeGreaterThanOrEqual(1);
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText("Delivery remains unconfirmed");
    await expect(feedback).toContainText("the original may still arrive");
    await expect(feedback).toContainText("Discard did not cancel or resend it");
    const after = await state();
    const writes = (value: NativeState) => value.calls.filter(call => /^(POST|PATCH|DELETE) /.test(call));
    expect(writes(after)).toEqual(writes(before));
    expect(after.sessions[sessionID]!.running).toBe(false);
    expect(after.sessions[sessionID]!.pending).toEqual([]);
    expect(after.sessions[sessionID]!.messages.some(message => message.text === "Original uncertain input" || message.text === "Other queued input")).toBe(false);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.url).toContain(`/queue/${encodeURIComponent(eligible.id)}/discard-unconfirmed`);
    expect(mutations[0]!.body).toEqual({ requestId: expect.any(String), uncertaintyId: eligible.admissionUncertaintyId });
    expect(after.unhandled).toEqual([]);
    // The desktop notice band is deliberately scrollable. Its first visible
    // line must carry uncertainty, not only the bounded message excerpt.
    expect(await feedback.evaluate(node => {
      const range = document.createRange();
      const start = node.textContent!.indexOf("Delivery remains unconfirmed");
      range.setStart(node.firstChild!, start);
      range.setEnd(node.firstChild!, start + "Delivery remains unconfirmed".length);
      const text = range.getBoundingClientRect();
      const region = document.querySelector("#chat-composer-notices")!.getBoundingClientRect();
      return text.top >= region.top && text.bottom <= region.bottom;
    })).toBe(true);
    await captureScreenshot(page, info, `discard-${mode}-${browserName}-held`);
    if (mode === "desktop") {
      const notices = page.locator("#chat-composer-notices");
      await notices.focus();
      await notices.press("End");
      await expect.poll(() => notices.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight)).toBe(true);
      await captureScreenshot(page, info, `discard-${mode}-${browserName}-notice-scrolled`);
      await notices.press("Home");
      await expect.poll(() => notices.evaluate(node => node.scrollTop)).toBe(0);
    }
    await saveEvidence(info, `discard-${mode}-${browserName}.json`, JSON.stringify({ writesBefore: writes(before), writesAfter: writes(after), mutations, geometry, rowGeometry, nativeSession: after.sessions[sessionID] }, null, 2));
    // Only this explicit action is allowed to release the remaining held input.
    await page.locator("[data-queue-send-now]").click();
    await expect(page.locator("#chat-items")).toContainText("Other queued input");
    await expect(input).toHaveValue("Keep my unrelated draft");
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText("Delivery remains unconfirmed");
  });

  test("close ownership keeps cancelled A separate from native-confirmed B with exactly one local HTTP mutation", async ({ page, request }, info) => {
    await page.addInitScript(installConfirmationCloseGate);
    await request.post("/__e2e/reset");
    await control(request, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    if (mode === "touch") await page.locator("#touch-tab-chat").tap(); else await openChatPanel(page);
    // Independent real HTTP/native-fake setup. Only the rendered UI may
    // authorize either discard; two conversations make target ownership visible.
    const prepare = async (owner: "A" | "B") => {
      const previous = await page.locator("#chat-conversation-select").inputValue();
      await page.getByRole("button", { name: "New conversation" }).click();
      await expect(page.locator("#chat-conversation-select")).not.toHaveValue(previous);
      await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
      const conversationId = await page.locator("#chat-conversation-select").inputValue();
      const chat = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
      const post = (path: string, data: unknown) => request.post(`${chat}${path}?t=${encodeURIComponent(token)}`, { data, headers: { origin: new URL(page.url()).origin } });
      expect((await post("/prompts", { requestId: `start-${owner}`, text: `Start fixture ${owner}` })).ok()).toBe(true);
      await expect(page.locator("#chat-stop")).toBeEnabled();
      await control(request, { action: "opencode", op: "unknownPromptBeforeAdmission" });
      expect((await post("/prompts", { requestId: `unknown-${owner}`, text: `Uncertain ${owner}`, delivery: "steer" })).ok()).toBe(false);
      expect((await post("/prompts", { requestId: `held-${owner}`, text: `Held follower ${owner}`, delivery: "queue" })).ok()).toBe(true);
      expect((await post("/cancel", { requestId: `setup-stop-${owner}` })).ok()).toBe(true);
      await expect(page.locator("#chat-stop")).toBeDisabled();
      const snapshot = () => request.get(`${chat}?t=${encodeURIComponent(token)}`).then(response => response.json()) as Promise<{ queued: Array<{ id: string; admissionUncertaintyId?: string; text: string }> }>;
      const eligible = (await snapshot()).queued.find(entry => entry.admissionUncertaintyId)!;
      expect(eligible.admissionUncertaintyId).toEqual(expect.any(String));
      return { conversationId, snapshot, eligible, path: `${chat}/queue/${encodeURIComponent(eligible.id)}/discard-unconfirmed` };
    };
    const a = await prepare("A");
    const b = await prepare("B");
    expect(b.conversationId).not.toBe(a.conversationId);
    const input = page.locator("#chat-input");
    await input.fill("Keep unrelated B draft");
    const select = page.locator("#chat-conversation-select");
    const reveal = async (messageId: string) => {
      // selectOption changes the picker before its conversation snapshot paints.
      // Match the actual target, not a still-rendered row from the old owner.
      await expect(page.locator(`[data-queue-discard="${messageId}"]`)).toHaveCount(1);
      const toggle = page.locator("[data-pending-toggle]");
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      await expect(page.locator(`[data-queue-discard="${messageId}"]`)).toBeVisible();
    };
    await select.selectOption(a.conversationId);
    await reveal(a.eligible.id);
    const discard = page.locator("[data-queue-discard]");
    const dialog = page.locator("#chat-action-confirm");
    const mutations: Array<{ isA: boolean; isB: boolean; requestId: boolean; sameBToken: boolean }> = [];
    page.on("request", req => {
      if (req.method() !== "POST" || !new URL(req.url()).pathname.endsWith("/discard-unconfirmed")) return;
      const body = req.postDataJSON();
      mutations.push({ isA: new URL(req.url()).pathname === a.path, isB: new URL(req.url()).pathname === b.path,
        requestId: typeof body.requestId === "string", sameBToken: body.uncertaintyId === b.eligible.admissionUncertaintyId });
    });
    const before = await control(request, { action: "opencode", op: "state" }) as NativeState;
    if (mode === "touch") await discard.tap(); else { await discard.focus(); await discard.press("Enter"); }
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    if (mode === "touch") await dialog.getByRole("button", { name: "Cancel", exact: true }).tap(); else await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    if (mode === "desktop") await expect(discard).toBeFocused();
    await page.waitForFunction(() => (window as unknown as { confirmationCloseGate: ConfirmationCloseGate }).confirmationCloseGate.held);
    await select.selectOption(b.conversationId);
    await reveal(b.eligible.id);
    await expect(input).toHaveValue("Keep unrelated B draft");
    if (mode === "touch") await discard.tap(); else { await discard.focus(); await discard.press("Enter"); }
    // Release after B intent, BEFORE expecting B visible: correct ownership
    // serializes reopening behind A's real close completion.
    await expect(dialog).not.toBeVisible();
    expect(mutations).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { confirmationCloseGate: ConfirmationCloseGate }).confirmationCloseGate.release())).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { confirmationCloseGate: ConfirmationCloseGate }).confirmationCloseGate.focusAfterRelease)).toBe("composer");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    const accepted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === b.path);
    if (mode === "touch") await dialog.getByRole("button", { name: "Discard local record", exact: true }).tap();
    else {
      await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
      await expect(dialog.getByRole("button", { name: "Discard local record", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
    }
    expect(await (await accepted).json()).toEqual({ discarded: true, outcomeUnconfirmed: true });
    await expect(discard).toHaveCount(0);
    await expect(dialog).not.toBeVisible();
    await expect(input).toHaveValue("Keep unrelated B draft");
    const afterA = await a.snapshot(), afterB = await b.snapshot();
    expect(afterA.queued.find(entry => entry.id === a.eligible.id)?.admissionUncertaintyId).toBe(a.eligible.admissionUncertaintyId);
    expect(afterB.queued.some(entry => entry.id === b.eligible.id)).toBe(false);
    expect(afterB.queued.map(entry => entry.text)).toEqual(["Held follower B"]);
    expect(mutations).toEqual([{ isA: false, isB: true, requestId: true, sameBToken: true }]);
    const after = await control(request, { action: "opencode", op: "state" }) as NativeState;
    expect(nativeWrites(after)).toEqual(nativeWrites(before));
    expect(after.unhandled).toEqual([]);
    await page.waitForFunction(() => (window as unknown as { confirmationCloseGate: ConfirmationCloseGate }).confirmationCloseGate.nativeCloses === 2);
    const lifecycle = await page.evaluate(() => (window as unknown as { confirmationCloseGate: ConfirmationCloseGate }).confirmationCloseGate.events);
    expect(lifecycle.some(event => event.type === "close" && event.trusted)).toBe(true);
    expect(lifecycle.some(event => event.type === "close" && !event.trusted)).toBe(true);
    expect(lifecycle.some(event => event.type === "submit" && event.trusted && event.confirmSubmitter)).toBe(true);
    await saveEvidence(info, `confirmation-ownership-${mode}-${browserName}.json`, JSON.stringify({ lifecycle, mutations, originalAStillUnconfirmed: true, bLocallyDiscarded: true, draftRetained: true }, null, 2));
  });

  test("held unknown admission visibly pauses its follower without Stop or native replay", async ({ page, request }, info) => {
    const f = await heldAdmissionFixture(page, request, mode);
    await f.unknown();
    const toggle = page.locator("[data-pending-toggle]");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const head = page.locator("#chat-queue .chat-queued-message").filter({ hasText: "Original uncertain held input" });
    const behind = page.locator("#chat-queue .chat-queued-message").filter({ hasText: "Other queued input" });
    await expect(head).toHaveAttribute("data-paused", "");
    await expect(head).toContainText("Outcome unconfirmed");
    await expect(head).toContainText("Do not repeat this pending message");
    await expect(behind).toHaveAttribute("data-paused", "");
    await expect(behind.locator(".chat-queued-paused")).toHaveText("Paused");
    await expect(behind.locator(".chat-queued-tag")).toHaveText("Blocked by unconfirmed admission");
    await expect(behind).not.toContainText("Sends after your next message");
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const before = await f.state();
    const snapshot = await f.snapshot();
    expect(snapshot.queued.find((entry: { text: string }) => entry.text === "Other queued input")).toMatchObject({ delivery: "queue", paused: true });
    const after = await f.state();
    expect(nativeWrites(after)).toEqual(nativeWrites(before));
    expect(after.sessions[f.sessionID]!.running).toBe(true);
    expect(after.sessions[f.sessionID]!.messages.some(message => message.text === "Original uncertain held input" || message.text === "Other queued input")).toBe(false);
    expect(after.unhandled).toEqual([]);
    await captureScreenshot(page, info, `held-unknown-${mode}-${browserName}`);
  });

  test("a fresh explicit Queue after Stop and local discard resumes the old head before the new message", async ({ page, request }, info) => {
    const f = await heldAdmissionFixture(page, request, mode);
    expect((await f.post("/cancel", { requestId: "stop" })).ok()).toBe(true);
    await expect(page.locator("#chat-stop")).toBeDisabled();
    await f.unknown();
    const toggle = page.locator("[data-pending-toggle]");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const input = page.locator("#chat-input");
    await input.fill("New explicit Queue");
    const before = await f.state();
    const discard = page.locator("[data-queue-discard]");
    if (mode === "touch") await discard.tap(); else await discard.click();
    const dialog = page.locator("#chat-action-confirm");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(dialog).toContainText("submit a new message");
    const discarding = page.waitForResponse(response => response.url().includes("/discard-unconfirmed"));
    const confirm = dialog.getByRole("button", { name: "Discard local record", exact: true });
    if (mode === "touch") await confirm.tap(); else await confirm.click();
    expect((await discarding).ok()).toBe(true);
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(1);
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveAttribute("data-paused", "");
    await expect(input).toHaveValue("New explicit Queue");
    await expect(page.locator("#chat-items")).not.toContainText("Other queued input");
    const kept = await f.state();
    expect(nativeWrites(kept)).toEqual(nativeWrites(before));
    const submitted = page.waitForRequest(req => req.method() === "POST" && req.url().includes("/prompts") && req.postDataJSON().text === "New explicit Queue");
    await input.press("Alt+Enter");
    expect((await submitted).postDataJSON().delivery).toBe("queue");
    await expect(page.locator("#chat-items")).toContainText("Other queued input");
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(1);
    await expect(page.locator("#chat-queue")).toContainText("New explicit Queue");
    await control(request, { action: "opencode", op: "finish", conversationId: f.conversationId, text: "First queued answer" });
    await expect(page.locator("#chat-items")).toContainText("New explicit Queue");
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(0);
    const after = await f.state();
    expect(after.sessions[f.sessionID]!.messages.filter(message => message.type === "user").map(message => message.text)).toEqual(["Start fixture work", "Other queued input", "New explicit Queue"]);
    expect(after.calls.filter(call => call.startsWith(`POST /api/session/${f.sessionID}/prompt`))).toHaveLength(4);
    expect(after.unhandled).toEqual([]);
    await expect(page.locator("#chat-action-feedback")).toContainText("Delivery remains unconfirmed");
    await captureScreenshot(page, info, `discard-new-queue-${mode}-${browserName}`);
  });
});
