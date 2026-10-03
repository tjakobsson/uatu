// Settings → Agent accounts on a real Hub, over fake agent runtimes
// (tests/e2e/agent-accounts-fake.ts; hub-server.ts UATU_E2E_HUB_AGENT_ACCOUNTS).
// Everything above the agents is real: the account service, its attempts and
// deadlines, redirect confinement and delivery to a real loopback listener,
// the HTTP surface, the Settings pane, and the notice the Hub sends running
// workspaces, which reaches the workspace's chat through its live stream.

import type { Browser, Page } from "@playwright/test";

import { openChatConfiguration, openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { childChatControl, expect, openSessionTab, signIn, test, type HubE2EInfo, type HubE2EWorkspace } from "./hub-fixtures";
import { FAKE_CLAUDE_CODE, FAKE_CLAUDE_EMAIL, FAKE_DEVICE_CODE } from "./agent-accounts-fake";

test.use({ hubAgentAccounts: true, hubWorkspaces: ["accounts"] });

const PHONE = { width: 390, height: 844 };

// A phone: a touch device boots the session in touch mode, where the chat is
// its own tab. Signed in through the Hub's login form like any browser.
async function phoneChat(browser: Browser, hub: HubE2EInfo, workspace: HubE2EWorkspace, conversationId: string): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await signIn(page, hub);
  await page.goto(workspace.sessionUrl);
  await page.locator("#touch-tab-chat").click();
  await page.locator("#chat-conversation-select").selectOption(conversationId);
  return { page, close: () => context.close() };
}

async function accountsControl(hub: HubE2EInfo, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(hub.agentAccountsControl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return response.json();
}

async function openSettings(page: Page, agent?: string): Promise<void> {
  // A real load every time: from /settings, a URL that differs only in its
  // fragment would be a same-document navigation that reads nothing.
  await page.goto("about:blank");
  await page.goto(`/settings${agent ? `#agent-accounts/${agent}` : ""}`);
  await expect(page.locator(".agent-account-card")).toHaveCount(2);
  await expect(page.locator(".agent-account-summary").filter({ hasText: "Checking" })).toHaveCount(0);
}

const card = (page: Page, agent: string) => page.locator(`.agent-account-card[data-agent="${agent}"]`);
const provider = (page: Page, id: string) => page.locator(`.agent-provider[data-provider="${id}"]`);

async function findProvider(page: Page, query: string, id: string) {
  const opencode = card(page, "opencode");
  if (!await opencode.evaluate(node => (node as HTMLDetailsElement).open)) await opencode.locator(":scope > summary").click();
  await opencode.locator(".agent-provider-filter").fill(query);
  // A logged-in provider is listed twice while it matches the search: under
  // "Logged in" and among the results. The search results are its second section.
  const target = opencode.locator(":scope > .credential-body > .credential-section").nth(1).locator(`.agent-provider[data-provider="${id}"]`);
  if (!await target.evaluate(node => (node as HTMLDetailsElement).open)) await target.locator(":scope > summary").click();
  return target;
}

test.describe("Settings → Agent accounts", () => {
  test("each agent is a collapsed card stating its login, the scope is stated, and a deep link opens its card", async ({ hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    await expect(page.locator(".agent-accounts-scope")).toContainText("They apply to every workspace and every user of this Hub");
    await expect(card(page, "opencode")).not.toHaveAttribute("open", "");
    await expect(card(page, "opencode").locator(".agent-account-summary")).toHaveText("1 provider logged in");
    await expect(card(page, "claude").locator(".agent-account-summary")).toHaveText("Not logged in");
    await captureScreenshot(page, testInfo, "agent-accounts-collapsed-desktop");

    await openSettings(page, "claude");
    await expect(card(page, "claude")).toHaveAttribute("open", "");
    await expect(card(page, "opencode")).not.toHaveAttribute("open", "");
    await page.setViewportSize(PHONE);
    await card(page, "claude").scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "agent-accounts-claude-card-phone");
  });

  test("a key login with an extra field reports errors beside its form, clears the key, and lists the provider as logged in", async ({ hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    const cloudflare = await findProvider(page, "cloud", "cloudflare-workers-ai");
    const form = cloudflare.locator(".agent-method-form");
    await form.locator('input[name="key"]').fill("bad-key");
    await form.getByRole("button", { name: "Save key" }).click();
    // The missing account id is named beside the form, not on the page.
    await expect(form.locator(".local-error")).toHaveText("Enter your Cloudflare Account ID is required.");
    await expect(page.locator("#agent-accounts-error")).toBeHidden();
    await expect(page.locator("#action-error")).not.toContainText("Cloudflare");
    await form.locator('input[name="accountId"]').fill("abc123");
    await form.locator('input[name="key"]').fill("bad-key");
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(form.locator(".local-error")).toHaveText("Invalid API key");
    await captureScreenshot(page, testInfo, "agent-accounts-key-error-desktop");
    await form.locator('input[name="key"]').fill("cf-good-key");
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(card(page, "opencode").locator(".agent-account-summary")).toHaveText("2 providers logged in");
    await expect(cloudflare.locator(":scope > summary .chip")).toHaveText("Saved login");
    await expect(cloudflare.locator('input[name="key"]')).toHaveValue("");
  });

  test("a conditional field appears only for its answer", async ({ hubContext }) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    const copilot = await findProvider(page, "copilot", "github-copilot");
    const enterprise = copilot.locator('[data-field-key="enterpriseUrl"]');
    await expect(enterprise).toBeHidden();
    await copilot.locator('select[name="deploymentType"]').selectOption("enterprise");
    await expect(enterprise).toBeVisible();
    await copilot.locator('select[name="deploymentType"]').selectOption("github.com");
    await expect(enterprise).toBeHidden();
  });

  test("a device login shows the code to enter and completes when the provider's site approves it", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await page.setViewportSize(PHONE);
    await openSettings(page);
    const copilot = await findProvider(page, "copilot", "github-copilot");
    await copilot.getByRole("button", { name: "Log in" }).click();
    const attempt = copilot.locator(".agent-attempt");
    await expect(attempt.locator(".agent-device-code-value")).toHaveText(FAKE_DEVICE_CODE);
    await expect(attempt.getByRole("link", { name: "the sign-in page" })).toHaveAttribute("href", "https://github.com/login/device");
    await expect(attempt.getByRole("button", { name: "Copy" })).toBeVisible();
    await attempt.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "agent-accounts-device-code-phone");
    expect(await accountsControl(hub, { action: "approve", target: "github-copilot" })).toEqual({ approved: true });
    await expect(attempt.locator(".agent-attempt-done")).toHaveText("Logged in.");
    await expect(card(page, "opencode").locator(".agent-account-summary")).toHaveText("2 providers logged in");
  });

  test("a localhost redirect is finished from a pasted address; an address for anything else is refused", async ({ hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    const openai = await findProvider(page, "openai", "openai");
    await openai.locator(".agent-method-form").filter({ hasText: "ChatGPT Pro/Plus (browser)" }).getByRole("button", { name: "Log in" }).click();
    const attempt = openai.locator(".agent-attempt");
    await expect(attempt).toContainText("Unless this device is the Hub machine, that page will not load.");
    const href = await attempt.getByRole("link", { name: "Open the sign-in page" }).getAttribute("href");
    const authorize = new URL(href!);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "browser-code");
    callback.searchParams.set("state", authorize.searchParams.get("state")!);

    const address = attempt.locator('input[name="address"]');
    await address.fill(`http://evil.example.test${callback.pathname}${callback.search}`);
    await attempt.getByRole("button", { name: "Finish login" }).click();
    await expect(attempt.locator(".local-error")).toHaveText("That address is not this login's local callback.");
    await captureScreenshot(page, testInfo, "agent-accounts-redirect-refused-desktop");

    // A browser on another device shows the address with 127.0.0.1 or
    // localhost; either reaches the listener the login is waiting on.
    callback.hostname = "127.0.0.1";
    await address.fill(callback.toString());
    await attempt.getByRole("button", { name: "Finish login" }).click();
    await expect(openai.locator(".agent-attempt-done")).toHaveText("Logged in.");
    await expect(openai.locator(":scope > summary .chip")).toHaveText("Browser login");
  });

  test("a Claude Code login fails on a wrong code, starts again, and logs in with the code the page shows", async ({ hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openSettings(page, "claude");
    const claude = card(page, "claude");
    await claude.getByRole("button", { name: "Claude subscription (Pro, Max, Team or Enterprise)" }).click();
    const attempt = claude.locator(".agent-attempt");
    await expect(attempt.getByRole("link", { name: "Open the sign-in page" })).toBeVisible();
    await captureScreenshot(page, testInfo, "agent-accounts-claude-code-desktop");
    await attempt.locator('input[name="code"]').fill("wrong-code");
    await attempt.getByRole("button", { name: "Submit code" }).click();
    await expect(claude.locator(".agent-attempt.is-failed .local-error")).toHaveText("Invalid authorization code");
    await claude.getByRole("button", { name: "Start again" }).click();
    await claude.locator('.agent-attempt input[name="code"]').fill(`${FAKE_CLAUDE_CODE}#fake`);
    await claude.getByRole("button", { name: "Submit code" }).click();
    await expect(claude.locator(".agent-account-summary")).toHaveText(`Logged in as ${FAKE_CLAUDE_EMAIL} · Claude Max`);
  });

  test("a login not finished in time expires and offers to start again", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    await accountsControl(hub, { action: "expireNextAfter", ms: 1_500 });
    const copilot = await findProvider(page, "copilot", "github-copilot");
    await copilot.getByRole("button", { name: "Log in" }).click();
    await expect(copilot.locator(".agent-device-code-value")).toBeVisible();
    await expect(copilot.locator(".agent-attempt.is-expired")).toContainText("The login expired before it was finished.");
    await expect(copilot.getByRole("button", { name: "Start again" })).toBeEnabled();
  });

  test("a field the agent marks secret is masked, and starting again asks for it instead of keeping it", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    const gitlab = await findProvider(page, "gitlab", "gitlab");
    const instance = gitlab.locator('input[name="instanceUrl"]');
    const secret = gitlab.locator('input[name="clientSecret"]');
    await expect(instance).toHaveAttribute("type", "text");
    await expect(secret).toHaveAttribute("type", "password");
    await instance.fill("gitlab.example.com");
    await secret.fill("gloas-client-secret");
    await accountsControl(hub, { action: "expireNextAfter", ms: 1_500 });
    await gitlab.getByRole("button", { name: "Log in" }).click();
    await expect(gitlab.locator(".agent-attempt.is-expired")).toContainText("The login expired before it was finished.");
    await gitlab.getByRole("button", { name: "Start again" }).click();
    // Nothing started blind: the form asks for the secret, which the page did not keep.
    await expect(gitlab.locator(".agent-method-form .local-error")).toHaveText("Enter OAuth client secret again, then log in.");
    await expect(gitlab.locator('input[name="clientSecret"]')).toHaveValue("");
    await expect(gitlab.locator('input[name="clientSecret"]')).toBeFocused();
    await expect(gitlab.locator('input[name="instanceUrl"]')).toHaveValue("gitlab.example.com");
    await captureScreenshot(page, testInfo, "agent-accounts-secret-field-start-again");
    await gitlab.locator('input[name="clientSecret"]').fill("gloas-client-secret");
    await gitlab.getByRole("button", { name: "Log in" }).click();
    await expect(gitlab.locator(".agent-device-code-value")).toHaveText(FAKE_DEVICE_CODE);
  });

  test("where the agent keeps several keys for a provider, another can be made the active one", async ({ hub, hubContext }) => {
    await accountsControl(hub, { action: "twoGroqKeys" });
    const page = await hubContext.newPage();
    await openSettings(page);
    const groq = await findProvider(page, "groq", "groq");
    const work = groq.locator(".agent-credential").filter({ hasText: "Groq work" });
    const personal = groq.locator(".agent-credential").filter({ hasText: "Groq personal" });
    await expect(work.locator(".chip.is-ready")).toHaveText("Active");
    await personal.getByRole("button", { name: "Make active" }).click();
    await expect(personal.locator(".chip.is-ready")).toHaveText("Active");
    await expect(work.getByRole("button", { name: "Make active" })).toBeVisible();
  });

  test("logging out asks first and states the machine-wide effect; a key from the environment offers no logout", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openSettings(page);
    const berget = await findProvider(page, "berget", "berget");
    let message = "";
    page.once("dialog", dialog => { message = dialog.message(); void dialog.dismiss(); });
    await berget.getByRole("button", { name: "Log out" }).click();
    expect(message).toContain("Every workspace on this Hub, every user of this Hub, and OpenCode itself on this machine lose this login.");
    await expect(berget.locator(":scope > summary .chip")).toHaveText("Saved login");
    page.once("dialog", dialog => void dialog.accept());
    await berget.getByRole("button", { name: "Log out" }).click();
    await expect(card(page, "opencode").locator(".agent-account-summary")).toHaveText("No provider logged in");

    await accountsControl(hub, { action: "claudeSource", source: "env-api-key" });
    // The Hub re-reads an agent at most every two seconds; a reload after
    // that shows the key from the environment.
    await expect(async () => {
      await openSettings(page, "claude");
      await expect(card(page, "claude").locator(".agent-account-summary")).toHaveText("API key from ANTHROPIC_API_KEY", { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await expect(card(page, "claude")).toContainText("A browser login does not take effect while it is set.");
    await expect(card(page, "claude").getByRole("button", { name: /^Log out/ })).toHaveCount(0);
  });
});

test.describe("chat and agent logins", () => {
  test("the composer says the agent is not logged in, links to Agent accounts, and clears after a login there", async ({ browser, hub, hubContext }, testInfo) => {
    const workspace = hub.workspaces[0]!;
    const seeded = await childChatControl(workspace, {
      action: "seed",
      title: "Logins",
      items: [{ id: "user:1", type: "user_message", createdAt: 10, text: "hello" }],
    }) as { conversation: { id: string } };
    await childChatControl(workspace, { action: "models", models: [] });
    await childChatControl(workspace, { action: "login", login: "missing" });

    const session = await openSessionTab(hubContext, workspace);
    await openChatPanel(session);
    await session.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    const notice = session.locator("#chat-login-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("OpenCode is not logged in.");
    await expect(notice.getByRole("link", { name: "Log in to OpenCode" })).toHaveAttribute("href", "/settings#agent-accounts/opencode");
    await captureScreenshot(session, testInfo, "chat-login-notice-desktop");
    await openChatConfiguration(session);
    await expect(session.locator("#chat-configuration-empty")).toContainText("No provider is logged in.");
    await captureScreenshot(session, testInfo, "chat-picker-no-provider-desktop");
    await session.keyboard.press("Escape");
    const phone = await phoneChat(browser, hub, workspace, seeded.conversation.id);
    await expect(phone.page.locator("#chat-login-notice")).toContainText("OpenCode is not logged in.");
    await captureScreenshot(phone.page, testInfo, "chat-login-notice-phone");
    await phone.close();

    // Log in through Settings in another tab: the Hub tells the workspace,
    // and the open chat catches up without a reload.
    const settings = await hubContext.newPage();
    await openSettings(settings);
    const groq = await findProvider(settings, "groq", "groq");
    await groq.locator('input[name="key"]').fill("gsk-good-key");
    await groq.getByRole("button", { name: "Save key" }).click();
    await expect(groq.locator(":scope > summary .chip")).toHaveText("Saved login");

    await expect(notice).toBeHidden();
    expect(await childChatControl(workspace, { action: "accountChanges" })).toEqual({ changes: [{ kind: "added" }] });
    await openChatConfiguration(session);
    await expect(session.locator(".chat-configuration-model").first()).toBeVisible();
  });

  test("a turn that failed on the login names the agent, keeps its words, and links to log in", async ({ browser, hub, hubContext }, testInfo) => {
    const workspace = hub.workspaces[0]!;
    const seeded = await childChatControl(workspace, {
      action: "seed",
      title: "Login failure",
      items: [
        { id: "user:1", type: "user_message", createdAt: 10, text: "hello" },
        { id: "notice:login:1", type: "notice", createdAt: 11, level: "error", code: "login-failed", message: "Not logged in · Please run /login" },
      ],
    }) as { conversation: { id: string } };
    const session = await openSessionTab(hubContext, workspace);
    await openChatPanel(session);
    await session.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    const failure = session.locator(".chat-login-failed");
    await expect(failure.locator(".chat-login-failed-title")).toHaveText("OpenCode login failed");
    await expect(failure.locator(".chat-login-failed-detail")).toHaveText("Not logged in · Please run /login");
    await expect(failure.getByRole("link", { name: "Log in to OpenCode" })).toHaveAttribute("href", "/settings#agent-accounts/opencode");
    await captureScreenshot(session, testInfo, "chat-login-failed-desktop");
    const phone = await phoneChat(browser, hub, workspace, seeded.conversation.id);
    await expect(phone.page.locator(".chat-login-failed-title")).toHaveText("OpenCode login failed");
    await captureScreenshot(phone.page, testInfo, "chat-login-failed-phone");
    await phone.close();
  });
});
