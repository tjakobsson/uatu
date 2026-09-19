import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openEventSources } from "./hub-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";

const exec = promisify(execFile);
test.use({ hubWorktrees: true, hubWorkspaces: ["atlas-desktop", "atlas-touch"] });

// The published JSON family, over the signed-in Hub session `hubContext`
// carries — the same credential the browser itself uses, and the only one
// the Hub honors on these routes.
async function worktreeInventory(page: Page, sourceWorkspaceId: string) {
  const response = await page.request.get(`/api/hub/worktrees?source=${encodeURIComponent(sourceWorkspaceId)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).inventory;
}
async function worktreeAction(page: Page, action: "create" | "open" | "delete", body: Record<string, unknown>) {
  const response = await page.request.post(`/api/hub/worktrees/${action}`, { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
}
async function ready(page: Page) {
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}
async function surface(page: Page, name: "Files" | "Preview" | "Terminal" | "Chat") {
  await ready(page);
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") {
    await page.getByRole("tab", { name, exact: true }).click();
  } else if (name === "Chat" && await page.locator("#chat-expand").isVisible()) {
    await page.locator("#chat-expand").click();
  } else if (name === "Terminal" && !await page.locator("#terminal-panel").isVisible()) {
    await page.locator("#terminal-toggle").click();
  }
}
async function picker(page: Page) {
  await surface(page, "Files");
  if (!await page.locator("#hub-menu").isVisible()) await page.locator("#hub-toggle").click();
}
async function chat(page: Page, id: string, body: Record<string, unknown>) {
  const response = await page.request.post(`/s/${id}/__e2e/chat`, { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function seed(page: Page, id: string, marker: string) {
  const snapshot = await chat(page, id, { action: "seed", title: marker,
    items: [{ id: marker, type: "assistant_message", createdAt: 1, markdown: marker }] });
  await surface(page, "Chat");
  await page.locator("#chat-conversation-select").selectOption(snapshot.conversation.id);
  await expect(page.locator("#chat-items")).toContainText(marker);
  return snapshot.conversation.id as string;
}
async function terminal(page: Page, folder: string, marker: string) {
  await surface(page, "Terminal");
  const pane = page.locator('.terminal-pane[data-active="true"]');
  await expect(pane.locator('[data-terminal-ready="true"]')).toBeVisible();
  await pane.locator(".xterm-helper-textarea").focus();
  // The shell writes cwd into a temporary checkout file. This proves the PTY
  // cwd independently of labels or the browser's terminal presentation.
  await page.keyboard.type(`pwd -P > ${marker}.txt`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => {
    try { return await (await import("node:fs/promises")).readFile(path.join(folder, `${marker}.txt`), "utf8").then(s => s.trim()); }
    catch { return ""; }
  }).toBe(await realpath(folder));
  return pane.getAttribute("data-session-id");
}

for (const touch of [false, true]) test.describe(touch ? "real worktrees touch" : "real worktrees desktop", () => {
  const parentId = touch ? "atlas-touch" : "atlas-desktop";
  // Separate repositories also isolate journeys scheduled on the same worker.
  test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });
  test("picker creation, JSON API live updates and independent checkout round trips", async ({ hub, hubContext }, info) => {
    test.setTimeout(60_000);
    hub = { ...hub, workspaces: hub.workspaces.filter(workspace => workspace.id === parentId) };
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);
    await surface(page, "Files");
    await page.getByRole("button", { name: "Follow", exact: true }).click();
    await page.locator('[data-item-path="NOTES.md"]').click();
    const sourceConversation = await seed(page, parentId, "source conversation only");
    const sourceTerminal = await terminal(page, hub.workspaces[0]!.path, "source-cwd");
    await picker(page);
    await page.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree" }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/browser");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText("Created feature/browser");
    expect(new URL(page.url()).pathname).toContain(`/s/${parentId}/`);
    const inventory = await worktreeInventory(page, parentId);
    const child = inventory.checkouts.find((row: { branch: string }) => row.branch === "feature/browser");
    expect(child.running).toBe(false);
    expect(child.sourceRef).toBe("main");
    expect(await git(child.path, ["branch", "--show-current"])).toBe("feature/browser");
    // Change only the child checkout and commit, so file, search and Git
    // results have independently observable identities.
    await writeFile(path.join(child.path, "CHILD.md"), "# child-checkout-marker\n");
    await git(child.path, ["add", "CHILD.md"]);
    await git(child.path, ["-c", "user.name=Uatu Test", "-c", "user.email=uatu@example.test", "commit", "-m", "child-only-commit"]);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${child.workspaceId}/`));
    await surface(page, "Files");
    await page.getByRole("button", { name: "Follow", exact: true }).click();
    await page.locator('[data-item-path="CHILD.md"]').click();
    await surface(page, "Preview");
    await expect(page.locator("#preview")).toContainText("child-checkout-marker");
    await captureScreenshot(page, info, `integrated-${touch ? "touch" : "desktop"}-child-preview`);
    const childConversation = await seed(page, child.workspaceId, "child conversation only");
    await expect(page.locator("#chat-conversation-select")).not.toContainText("source conversation only");
    const childTerminal = await terminal(page, child.path, "child-cwd");
    expect(childTerminal).not.toBe(sourceTerminal);
    await surface(page, "Files");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await page.locator("#search-query").fill("child-checkout-marker");
    await expect(page.locator(".search-hit")).toHaveCount(1);
    await expect(page.locator(".search-file")).toContainText("CHILD.md");
    await expect(page.locator("#change-overview")).toContainText("feature/browser");
    await expect(page.locator("#git-log")).toContainText("child-only-commit");
    const state = await page.request.get(`/s/${child.workspaceId}/api/state`).then(r => r.json());
    expect(JSON.stringify(state)).toContain(child.path);
    expect(await git(child.path, ["log", "-1", "--format=%s"])).toBe("child-only-commit");
    expect(await git(hub.workspaces[0]!.path, ["log", "-1", "--format=%s"])).toBe("initial");

    async function context(id: string, document: string, conversation: string, marker: string, terminalId: string | null) {
      await ready(page);
      await expect(page).toHaveURL(new RegExp(`/s/${id}/`));
      await surface(page, "Files");
      await expect(page.locator(`[data-item-path="${document}"]`)).toHaveAttribute("aria-selected", "true");
      await surface(page, "Preview");
      await expect(page.locator("#preview")).toContainText(marker);
      await surface(page, "Chat");
      await expect(page.locator("#chat-conversation-select")).toHaveValue(conversation);
      await surface(page, "Terminal");
      await expect(page.locator('.terminal-pane[data-active="true"]')).toHaveAttribute("data-session-id", terminalId!);
    }
    await picker(page);
    await page.locator(`#hub-menu a[href="/s/${parentId}/"]`).click();
    await context(parentId, "NOTES.md", sourceConversation, `${parentId} source notes`, sourceTerminal);
    await page.goBack();
    await context(child.workspaceId, "CHILD.md", childConversation, "child-checkout-marker", childTerminal);
    await page.goForward();
    await context(parentId, "NOTES.md", sourceConversation, `${parentId} source notes`, sourceTerminal);
    await picker(page);
    const liveEvents: unknown[] = [];
    page.on("response", response => { if (response.url().includes("/api/hub/state")) liveEvents.push(response.status()); });
    const fromApi = await worktreeAction(page, "create", { sourceWorkspaceId: parentId, mode: "new-branch", branch: "feature/cli", baseRef: "main" });
    expect(fromApi.ok).toBe(true);
    await expect(page.locator("#hub-menu")).toContainText("feature/cli");
    expect(new URL(page.url()).pathname).toContain(`/s/${parentId}/`);
    await captureScreenshot(page, info, `integrated-${touch ? "touch" : "desktop"}-picker`);
    expect(await openEventSources(page)).toHaveLength(1);

    // An agent-owned checkout appears without registration or navigation.
    const externalPath = path.join(path.dirname(hub.workspaces[0]!.path), `${parentId}-external-agent`);
    await git(hub.workspaces[0]!.path, ["worktree", "add", "-b", "agent/external", externalPath, "main"]);
    await expect.poll(async () => (await worktreeInventory(page, parentId)).checkouts.some((row: { branch: string }) => row.branch === "agent/external")).toBe(true);
    const external = (await worktreeInventory(page, parentId)).checkouts.find((row: { branch: string }) => row.branch === "agent/external");
    expect(external.registered).toBe(false);
    expect(external.ownership).toBe("external");
    // F7: Existing branch does not offer a branch another checkout already
    // holds, so the dialog can no longer reach the occupancy refusal at all.
    await picker(page);
    await page.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await page.getByRole("dialog").getByRole("combobox").fill("agent/external");
    await expect(page.locator('[role="option"][data-value="local:agent/external"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The Hub's own refusal is untouched behind it: a completed request
    // carrying the actionable reason, having changed nothing.
    const refused = await worktreeAction(page, "create", {
      sourceWorkspaceId: parentId, mode: "existing-local", base: { kind: "local", ref: "agent/external" },
    });
    expect(refused.ok).toBe(false);
    expect(String(refused.error?.message ?? "")).toContain("already checked out");
    expect((await worktreeInventory(page, parentId)).checkouts
      .find((row: { path: string }) => row.path === externalPath).registered).toBe(false);
    // Registration is reached from the fork menu's register list, the one
    // place an unregistered checkout is acted on.
    await picker(page);
    await page.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Register worktree…", exact: true }).click();
    await page.getByRole("dialog").locator(".wt-card").filter({ hasText: "agent/external" })
      .getByRole("button", { name: "Register workspace", exact: true }).click();
    await expect(page.getByText("Registration does not move files", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Register workspace", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // A registered tree Uatu did not create says so in the picker, instead of
    // claiming an unknown origin for a branch it never created (decision A).
    // Scoped to THIS test's own checkout: the desktop and touch runs share one
    // hub and both register an `agent/external` of the same repository.
    const registeredExternal = (await worktreeInventory(page, parentId)).checkouts
      .find((row: { path: string }) => row.path === externalPath);
    await picker(page);
    await expect(page.locator(`#hub-menu a[data-workspace-id="${registeredExternal.workspaceId}"] .hub-menu-provenance`))
      .toHaveText("External worktree");
    await page.locator("#hub-toggle").click();
    await git(hub.workspaces[0]!.path, ["worktree", "remove", externalPath]);
    await expect.poll(async () => (await worktreeInventory(page, parentId)).checkouts.find((row: { branch: string }) => row.branch === "agent/external")?.availability).toBe("missing");
    await picker(page);
    const missing = (await worktreeInventory(page, parentId)).checkouts.find((row: { branch: string }) => row.branch === "agent/external");
    const missingRow = page.locator(`#hub-menu a[data-workspace-id="${missing.workspaceId}"]`);
    await expect(missingRow).toContainText("Missing checkout");
    await expect(missingRow).toHaveAttribute("aria-disabled", "true");
    await captureScreenshot(page, info, `integrated-${touch ? "touch" : "desktop"}-missing`);
    await page.locator("#hub-toggle").click();
    await context(parentId, "NOTES.md", sourceConversation, `${parentId} source notes`, sourceTerminal);

    // Hold an authoritative chat inventory response in the old child, switch,
    // then release it alongside an old-child live event.
    await surface(page, "Chat");
    await chat(page, parentId, { action: "delayNextInventoryList" });
    await chat(page, parentId, { action: "inventoryInvalidate" });
    await expect.poll(async () => (await chat(page, parentId, { action: "stats" })).inventoryListPending).toBe(true);
    await picker(page);
    await page.locator(`#hub-menu a[href="/s/${child.workspaceId}/"]`).click();
    await chat(page, parentId, { action: "item", conversationId: sourceConversation,
      item: { id: "late-source", type: "assistant_message", createdAt: 2, markdown: "late-source-only" } });
    await chat(page, parentId, { action: "releaseInventoryList" });
    await expect.poll(async () => (await chat(page, parentId, { action: "stats" })).inventoryListPending).toBe(false);
    await context(child.workspaceId, "CHILD.md", childConversation, "child-checkout-marker", childTerminal);
    await surface(page, "Chat");
    await expect(page.locator("#chat-items")).toContainText("child conversation only");
    await expect(page.locator("#chat-items")).not.toContainText("late-source-only");
    await captureScreenshot(page, info, `integrated-${touch ? "touch" : "desktop"}-chat`);
    expect(errors).toEqual([]);
    await saveEvidence(info, "integrated-acceptance.json", JSON.stringify({
      realGit: true, realHub: true, realWatchers: true, realPty: true, chat: "deterministic fixture",
      browserTouchEmulation: touch, sourceTerminal, childTerminal, sourceConversation, childConversation,
      apiLiveRefreshes: liveEvents.length, externalMissing: true, independentRoundTrips: true,
    }, null, 2));
    await page.close();
  });
});
