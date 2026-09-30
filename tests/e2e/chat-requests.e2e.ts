// Ten permissions in one turn left a user unable to tell which still needed
// them. These assert the two things that answer "did I miss one?" — a count
// that does not scroll away, and a way to reach the one you can act on.
import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import type { FakeE2EChatService } from "./chat-service";
import { expect, test } from "./fixtures";

// Where the confirm-always-allow-scope change keeps its evidence.

test("outstanding requests are counted, reachable, and clear at zero", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Batch", items: [] } })
    .then(r => r.json()) as { conversation: { id: string } };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChatPanel(page);
  const id = seeded.conversation.id;
  const jump = page.locator("#chat-requests-jump");
  const timeline = page.locator("#chat-timeline");
  const target = page.locator('[data-chat-item-id="permission:p2"]');
  // How much of the answerable card the timeline is actually showing. The
  // pill's rule is about that band, not about the window, so a card clipped
  // by the scroller is measured here rather than with toBeInViewport.
  const shownHeight = () => timeline.evaluate(element => {
    const card = element.querySelector('[data-chat-item-id="permission:p2"]')?.getBoundingClientRect();
    if (!card) return -1;
    const band = element.getBoundingClientRect();
    return Math.max(0, Math.min(card.bottom, band.bottom) - Math.max(card.top, band.top));
  });
  await expect(jump).toBeHidden();

  // Transcript above the requests, so the newest one can be scrolled out of
  // the band. Without it the conversation never scrolls and the two halves of
  // the rule below cannot be told apart.
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const filler: ConversationItem = {
      id: `part:filler-${i}`, type: "assistant_message", createdAt: i,
      markdown: `Filler ${i}\n\n${"The renderer walked the tree and reported what it found. ".repeat(12)}`,
    };
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: filler } });
  }

  for (const i of [0, 1, 2]) {
    const item: ConversationItem = {
      id: `permission:p${i}`, type: "permission", createdAt: 10 + i, requestId: `p${i}`,
      action: "bash", resources: [`cmd-${i}`], status: "pending",
    };
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item } });
  }

  // The answerable request is on screen, so the pill has nothing to offer and
  // yields — but it is still counting, which is the half of the report that
  // answers "did I miss one?".
  await expect(jump).toHaveText("3 requests need your answer");
  await expect.poll(shownHeight).toBeGreaterThan(0);
  await expect(jump).toBeHidden();
  await expect(jump).toHaveText("3 requests need your answer");

  // Scrolled off the card, the count is unchanged and the pill comes back as
  // the way to reach it.
  await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
  await timeline.evaluate(element => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(shownHeight).toBe(0);
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText("3 requests need your answer");

  await jump.click();
  await expect(target).toBeInViewport();
  await expect.poll(shownHeight).toBeGreaterThan(0);

  for (const i of [0, 1, 2]) {
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: {
      id: `permission:p${i}`, type: "permission", createdAt: 10 + i, requestId: `p${i}`,
      action: "bash", resources: [`cmd-${i}`], status: "resolved", outcome: "approved-once",
    } } });
  }
  // Zero is reported by the pill going away with nothing left to say — not by
  // the same hiding the yield rule performs while a count still stands.
  await expect(jump).toBeHidden();
  await expect(jump).toHaveText("");

  // Recovered requests can share a timestamp and arrive in provider order.
  // Admission breaks that tie by greatest id, not by whichever arrived last.
  for (const requestId of ["z", "a"]) {
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: {
      id: `permission:${requestId}`, type: "permission", createdAt: 20, requestId,
      action: "bash", resources: [`cmd-${requestId}`], status: "pending",
    } } });
  }
  await expect(jump).toHaveAttribute("data-request-target", "permission:z");
  await expect(page.locator('[data-chat-item-id="permission:z"]')).toHaveAttribute("data-request-state", "needs-answer");
  await expect(page.locator('[data-chat-item-id="permission:a"]')).toHaveAttribute("data-request-state", "queued");
});

test("a variant without a model is refused at the boundary", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Variant pairing", items: [] } })
    .then(r => r.json()) as { conversation: { id: string } };
  // The browser context carries the workspace session; page.request shares it.
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  // A variant names an effort OF a model; accepting a bare one would tie its
  // validity to server-side memory of the conversation's current model, which
  // an adapter restart empties while the session keeps its model.
  const response = await page.request.post(`/api/chat/conversations/${seeded.conversation.id}/prompts`, {
    // The browser sends these itself; the request context must state them.
    headers: { origin: new URL(page.url()).origin },
    data: { requestId: "r-variant-alone", text: "think hard", variant: "high" },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ error: "variant requires a model selection" });
});

test("a pending edit permission shows its diff, and a resolved one recedes", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Review", items: [] } })
    .then(r => r.json()) as { conversation: { id: string } };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChatPanel(page);
  const id = seeded.conversation.id;

  // A pending edit permission shows the change it would apply, beside its choices.
  const edit: ConversationItem = {
    id: "permission:edit", type: "permission", createdAt: 20, requestId: "edit",
    action: "edit", resources: ["src/app.ts"], status: "pending",
    diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
  };
  await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: edit } });
  const card = page.locator('[data-chat-item-id="permission:edit"]');
  await expect(card.locator(".chat-request-change .chat-diff")).toContainText("const a = 2;");
  await expect(card.locator('[data-permission-outcome="approved-once"]')).toBeVisible();

  // Resolve it: the card recedes to a one-line trace, its diff gone, its resource
  // still reachable in the collapsed body.
  await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: {
    ...edit, status: "resolved", outcome: "approved-once",
  } } });
  await expect(card.locator(".chat-request-trace")).toHaveText("Allowed once");
  await expect(card.locator(".chat-request-change")).toHaveCount(0);
  await expect(card).not.toHaveAttribute("open", /.*/);
  await expect(card.locator("ul code")).toContainText("src/app.ts");
});

test("a surfaced subagent request opens its transcript without changing the parent selection", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const child = await request.post("/__e2e/chat", { data: { action: "seed", title: "Child transcript", child: true, items: [
    { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
  ] } }).then(response => response.json()) as { conversation: { id: string } };
  const requestItem: ConversationItem = {
    id: "permission:surfaced", type: "permission", createdAt: 3, requestId: "surfaced",
    conversationId: child.conversation.id, action: "bash", resources: ["bun test"], status: "pending",
  };
  const parent = await request.post("/__e2e/chat", { data: { action: "seed", title: "Parent", items: [
    {
      id: "tool:agent", type: "tool", createdAt: 2, name: "task", status: "completed",
      input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
      childConversationId: child.conversation.id,
    },
    requestItem,
  ] } }).then(response => response.json()) as { conversation: { id: string } };
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChatPanel(page);

  const card = page.locator('[data-chat-item-id="permission:surfaced"]');
  await expect(card.locator(".chat-request-origin")).toContainText("Requested by explore · Review renderer.");
  await card.getByRole("button", { name: "Open transcript" }).click();
  await expect(page.locator("#chat-drilldown-items")).toContainText("child findings");
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent.conversation.id);

  await page.locator("#chat-drilldown-back").click();
  await expect(page.locator("#chat-drilldown")).toBeHidden();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent.conversation.id);
  await expect(card).toBeVisible();
});

// "Allow always" is the one choice that outlives the request, and OpenCode's
// rule is not the command on the card: `git status --short` installs
// `git status *`. These prove the reply waits for a confirmation that shows
// the agent's own pattern, and that nothing else about the card changed.
test.describe("Allow always asks for confirmation", () => {
  type Replies = { permissionChoices: FakeE2EChatService["permissionChoices"] };
  const replies = async (request: APIRequestContext) => (await request.post("/__e2e/chat", { data: { action: "stats" } }).then(r => r.json()) as Replies).permissionChoices;
  const publish = (request: APIRequestContext, conversationId: string, item: ConversationItem) =>
    request.post("/__e2e/chat", { data: { action: "item", conversationId, item } });
  const shell = (requestId: string, createdAt: number, alwaysPatterns?: string[], action = "bash", resources = ["git status --short"]): ConversationItem => ({
    id: `permission:${requestId}`, type: "permission", createdAt, requestId, action, resources, status: "pending",
    ...(alwaysPatterns ? { alwaysPatterns } : {}),
  });

  // Desktop opens the side panel; touch mode reaches chat through its tab.
  async function boot(page: Page, request: APIRequestContext, open: (page: Page, conversationId: string) => Promise<void> = openChatPanel): Promise<string> {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Status check", items: [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Is the tree clean?" },
    ] } }).then(r => r.json()) as { conversation: { id: string } };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await open(page, seeded.conversation.id);
    return seeded.conversation.id;
  }
  const openTouchChat = async (page: Page, conversationId: string) => {
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
  };

  test("shows the agent's pattern apart from the command, and replies only on Confirm", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const id = await boot(page, request);
    await publish(request, id, shell("shell", 20, ["git status *"]));
    const card = page.locator('[data-chat-item-id="permission:shell"]');
    const always = card.getByRole("button", { name: "Allow always" });
    const stage = card.locator("[data-permission-confirming]");
    await expect(always).toBeVisible();

    // Allow always opens the stage and sends nothing.
    await always.click();
    await expect(stage).toBeVisible();
    await expect(always).toBeHidden();
    // The agent's pattern is what will be allowed; the command stays above,
    // apart from it, so the reader sees where the two differ.
    await expect(stage.locator(".chat-request-always code")).toHaveText(["git status *"]);
    await expect(card.locator(":scope > ul > li code")).toHaveText(["git status --short"]);
    await expect(stage.locator(".chat-request-confirm-action")).toHaveText("bash");
    await expect(stage.locator(".chat-request-scope")).toContainText("until OpenCode restarts");
    await expect(stage.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(await replies(request)).toEqual([]);
    await captureScreenshot(page, testInfo, "after-confirmation-prefix-desktop");

    // Cancel returns to the pending choices; still nothing sent.
    await stage.getByRole("button", { name: "Cancel" }).click();
    await expect(stage).toBeHidden();
    await expect(always).toBeVisible();
    await expect(always).toBeFocused();
    expect(await replies(request)).toEqual([]);

    // Escape inside the stage is Cancel.
    await always.click();
    await expect(stage).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(stage).toBeHidden();
    await expect(always).toBeVisible();
    expect(await replies(request)).toEqual([]);

    // Confirm sends the persistent reply once, and the card records it as before.
    await always.click();
    await stage.getByRole("button", { name: "Confirm" }).click();
    await expect(card.locator(".chat-request-trace")).toHaveText("Allowed always");
    await expect(card).toHaveAttribute("data-request-state", "resolved");
    expect(await replies(request)).toEqual([{ interactionId: "shell", outcome: "approved-session" }]);
  });

  test("a sole wildcard names the whole action, and no pattern is said plainly", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const id = await boot(page, request);
    await publish(request, id, shell("fetch", 20, ["*"], "webfetch", ["https://example.com/docs"]));
    const fetchCard = page.locator('[data-chat-item-id="permission:fetch"]');
    await fetchCard.getByRole("button", { name: "Allow always" }).click();
    const wildcard = fetchCard.locator("[data-permission-confirming]");
    await expect(wildcard.locator(".chat-request-confirm-lead")).toContainText("every");
    await expect(wildcard.locator(".chat-request-confirm-action")).toHaveText("webfetch");
    await expect(wildcard.locator(".chat-request-always")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "after-confirmation-wildcard-desktop");
    await wildcard.getByRole("button", { name: "Cancel" }).click();

    // A newer request with nothing reusable becomes the answerable one.
    await publish(request, id, shell("bare", 21, [], "skill", ["review-code"]));
    const bareCard = page.locator('[data-chat-item-id="permission:bare"]');
    await bareCard.getByRole("button", { name: "Allow always" }).click();
    const bare = bareCard.locator("[data-permission-confirming]");
    await expect(bare.locator(".chat-request-confirm-lead")).toContainText("no reusable pattern");
    await expect(bare.locator(".chat-request-confirm-lead")).toContainText("only this request");
    await expect(bare.locator(".chat-request-always")).toHaveCount(0);
    await expect(bare.locator(".chat-request-scope")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "after-confirmation-no-pattern-desktop");
    expect(await replies(request)).toEqual([]);
  });

  test("a request resolved elsewhere closes its confirmation; once and reject still reply on one click", async ({ page, request }) => {
    const id = await boot(page, request);
    await publish(request, id, shell("shell", 20, ["git status *"]));
    const card = page.locator('[data-chat-item-id="permission:shell"]');
    await card.getByRole("button", { name: "Allow always" }).click();
    await expect(card.locator("[data-permission-confirming]")).toBeVisible();
    // Answered from another client: the card recedes as any resolved one.
    await publish(request, id, { ...shell("shell", 20, ["git status *"]), status: "resolved", outcome: "approved-once" });
    await expect(card.locator(".chat-request-trace")).toHaveText("Allowed once");
    await expect(card.locator("[data-permission-confirming]")).toHaveCount(0);
    await expect(card.getByRole("button")).toHaveCount(0);
    expect(await replies(request)).toEqual([]);

    await publish(request, id, shell("once", 21, ["git status *"]));
    await page.locator('[data-chat-item-id="permission:once"]').getByRole("button", { name: "Allow once" }).click();
    await expect(page.locator('[data-chat-item-id="permission:once"] .chat-request-trace')).toHaveText("Allowed once");
    await publish(request, id, shell("reject", 22, ["git status *"]));
    await page.locator('[data-chat-item-id="permission:reject"]').getByRole("button", { name: "Reject" }).click();
    await expect(page.locator('[data-chat-item-id="permission:reject"] .chat-request-trace')).toHaveText("Rejected");
    expect(await replies(request)).toEqual([
      { interactionId: "once", outcome: "approved-once" },
      { interactionId: "reject", outcome: "rejected" },
    ]);
  });

  test.describe("at phone width", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the stage fits the card in touch mode", async ({ page, request }, testInfo) => {
      const id = await boot(page, request, openTouchChat);
      await publish(request, id, shell("shell", 20, ["git status *"]));
      const card = page.locator('[data-chat-item-id="permission:shell"]');
      await card.getByRole("button", { name: "Allow always" }).click();
      const stage = card.locator("[data-permission-confirming]");
      await expect(stage.locator(".chat-request-always code")).toHaveText(["git status *"]);
      await expect(stage.getByRole("button", { name: "Confirm" })).toBeVisible();
      await captureScreenshot(page, testInfo, "after-confirmation-phone");
      expect(await replies(request)).toEqual([]);
    });
  });
});

// GitHub #476: OpenCode's ask for an MCP tool carries the tool's name and a
// `*`, nothing about the call. The card reads the arguments from the tool
// row the request belongs to (named by the request, as 2.x does, or the
// open row under the action name), shows them while the request is open,
// and recedes without them. A request with no row to read is today's card,
// which is also the "before" picture of this change.
test.describe("an MCP permission shows the call it would allow", () => {
  const publish = (request: APIRequestContext, conversationId: string, item: ConversationItem) =>
    request.post("/__e2e/chat", { data: { action: "item", conversationId, item } });
  const codeRow: ConversationItem = {
    id: "tool:call_function_dh8j80sy7yde_1", type: "tool", createdAt: 2, name: "execute", status: "running",
    input: JSON.stringify({ code: 'const res = await tools.tracker.create_issue({\n  title: "Login fails on Safari",\n  body: "Steps: open /login in Safari 18, submit valid credentials, observe a blank page.",\n  labels: ["bug", "safari"],\n});\nreturn res;' }),
  };
  const mcp = (requestId: string, createdAt: number, overrides: Partial<Extract<ConversationItem, { type: "permission" }>> = {}): ConversationItem => ({
    id: `permission:${requestId}`, type: "permission", createdAt, requestId,
    action: "tracker_create_issue", resources: ["*"], alwaysPatterns: ["*"], status: "pending", ...overrides,
  });

  async function boot(page: Page, request: APIRequestContext, open: (page: Page, conversationId: string) => Promise<void> = openChatPanel): Promise<string> {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "File an issue", items: [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "File the Safari login bug in the tracker." },
    ] } }).then(r => r.json()) as { conversation: { id: string } };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await open(page, seeded.conversation.id);
    return seeded.conversation.id;
  }
  const openTouchChat = async (page: Page, conversationId: string) => {
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
  };

  test("the card shows the call's arguments while open and recedes without them", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const id = await boot(page, request);

    // Before: the request as OpenCode sends it, with no row to read, a name
    // and a `*`. This is the card the issue is about.
    await publish(request, id, mcp("bare", 20));
    const bare = page.locator('[data-chat-item-id="permission:bare"]');
    await expect(bare.locator("ul code")).toHaveText(["*"]);
    await expect(bare.locator(".chat-request-arguments")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "before-mcp-permission-desktop");
    await publish(request, id, mcp("bare", 20, { status: "resolved", outcome: "rejected" }));

    // After: the row the request names is in the conversation, so the card
    // shows what the call would run with, in place of the wildcard.
    await publish(request, id, codeRow);
    await publish(request, id, mcp("mcp", 21, { sourceToolId: codeRow.id, mcp: { server: "tracker", tool: "create_issue" } }));
    const card = page.locator('[data-chat-item-id="permission:mcp"]');
    await expect(card.locator("summary")).toContainText("Permission: MCP tracker › create_issue");
    await expect(card.locator(".chat-request-arguments")).toContainText('title: "Login fails on Safari"');
    await expect(card.locator(".chat-request-arguments")).toContainText("tools.tracker.create_issue");
    await expect(card.locator("ul li")).toHaveCount(0);
    await expect(card.locator('[data-permission-outcome="approved-once"]')).toBeVisible();
    await captureScreenshot(page, testInfo, "after-mcp-permission-desktop");

    // A command permission beside it is unchanged: its resource, no block.
    await publish(request, id, { id: "tool:call_bash", type: "tool", createdAt: 22, name: "bash", status: "running", input: JSON.stringify({ command: "git status --short" }) });
    await publish(request, id, mcp("cmd", 23, { action: "bash", resources: ["git status --short"], alwaysPatterns: ["git status *"], sourceToolId: "tool:call_bash" }));
    const command = page.locator('[data-chat-item-id="permission:cmd"]');
    await expect(command.locator("ul code")).toHaveText(["git status --short"]);
    await expect(command.locator(".chat-request-arguments")).toHaveCount(0);

    // Answered, the MCP card recedes as any other: outcome in the summary,
    // the wildcard OpenCode sent back in the body, the arguments on the row.
    await publish(request, id, mcp("mcp", 21, { sourceToolId: codeRow.id, mcp: { server: "tracker", tool: "create_issue" }, status: "resolved", outcome: "approved-once" }));
    await expect(card.locator(".chat-request-trace")).toHaveText("Allowed once");
    await expect(card.locator(".chat-request-arguments")).toHaveCount(0);
    await expect(card).not.toHaveAttribute("open", /.*/);
    await expect(card.locator("ul code")).toHaveText(["*"]);
    await expect(card.locator("summary")).toContainText("Permission: MCP tracker › create_issue");
    await publish(request, id, mcp("cmd", 23, { action: "bash", resources: ["git status --short"], alwaysPatterns: ["git status *"], sourceToolId: "tool:call_bash", status: "resolved", outcome: "approved-once" }));
    await captureScreenshot(page, testInfo, "after-mcp-permission-resolved-desktop");
  });

  test("a request naming no row reads the open row under its action name", async ({ page, request }) => {
    const id = await boot(page, request);
    await publish(request, id, { id: "tool:call_direct", type: "tool", createdAt: 2, name: "tracker_create_issue", status: "running", input: JSON.stringify({ title: "Login fails on Safari", labels: ["bug"] }) });
    await publish(request, id, mcp("direct", 20));
    const card = page.locator('[data-chat-item-id="permission:direct"]');
    await expect(card.locator(".chat-request-arguments")).toHaveText('title: Login fails on Safari\nlabels: ["bug"]');
    await expect(card.locator("ul li")).toHaveCount(0);
  });

  test.describe("at phone width", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the arguments fit the card in touch mode", async ({ page, request }, testInfo) => {
      const id = await boot(page, request, openTouchChat);
      await publish(request, id, mcp("bare", 20));
      await expect(page.locator('[data-chat-item-id="permission:bare"] ul code')).toHaveText(["*"]);
      await captureScreenshot(page, testInfo, "before-mcp-permission-phone");
      await publish(request, id, mcp("bare", 20, { status: "resolved", outcome: "rejected" }));
      await publish(request, id, codeRow);
      await publish(request, id, mcp("mcp", 21, { sourceToolId: codeRow.id, mcp: { server: "tracker", tool: "create_issue" } }));
      const card = page.locator('[data-chat-item-id="permission:mcp"]');
      await expect(card.locator("summary")).toContainText("Permission: MCP tracker › create_issue");
      await expect(card.locator(".chat-request-arguments")).toContainText("Login fails on Safari");
      await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
      await captureScreenshot(page, testInfo, "after-mcp-permission-phone");
      await publish(request, id, mcp("mcp", 21, { sourceToolId: codeRow.id, mcp: { server: "tracker", tool: "create_issue" }, status: "resolved", outcome: "approved-once" }));
      await expect(card.locator(".chat-request-trace")).toHaveText("Allowed once");
      await expect(card.locator(".chat-request-arguments")).toHaveCount(0);
      await captureScreenshot(page, testInfo, "after-mcp-permission-resolved-phone");
    });
  });
});
