import { test, expect } from "./worktree-demo-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";
import type { Page, TestInfo } from "@playwright/test";

async function ready(page: Page) { await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected"); }
async function surface(page: Page, name: "Files" | "Preview" | "Chat" | "Terminal") {
  await ready(page);
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.getByRole("tab", { name, exact: true }).click();
  else if (name === "Chat" && await page.locator("#chat-expand").isVisible()) await page.locator("#chat-expand").click();
  else if (name === "Terminal" && !await page.locator(".terminal-pane").first().isVisible()) await page.locator("#terminal-toggle").click();
}
async function picker(page: Page) {
  await surface(page, "Files");
  await page.getByText("SIMULATION · scenarios and reset", { exact: true }).click();
  await page.getByRole("button", { name: "Review simulated inventory / recovery / folder safety" }).click();
  await expect(page.getByRole("heading", { name: "Repository worktrees", exact: true })).toBeVisible();
}
async function inspectContext(page: Page, id: string, title: string, document: string, conversation: string, info?: TestInfo) {
  await ready(page);
  await expect(page).toHaveURL(new RegExp(`/s/${id}/`));
  await surface(page, "Files");
  await expect(page.locator(`[data-item-path="${document}"]`)).toHaveAttribute("aria-selected", "true");
  if (info) await captureScreenshot(page, info, `${id}-files`);
  await surface(page, "Preview");
  await expect(page.locator("#preview")).toContainText(`${title} ${document === "NOTES.md" ? "notes" : "workspace"}`);
  if (info) await captureScreenshot(page, info, `${id}-preview`);
  await surface(page, "Chat");
  await expect(page.locator("#chat-conversation-select")).toHaveValue(conversation);
  await expect(page.locator("#chat-items")).toContainText(`belongs to ${id} only`);
  const composer = await page.locator("#chat-send").boundingBox();
  const chrome = await page.locator("#demo-controls").boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(chrome!.y + 1);
  if (info) await captureScreenshot(page, info, `${id}-chat`);
  await surface(page, "Terminal");
  await expect(page.locator('[data-terminal-ready="true"]').first()).toBeVisible();
  if (info) await captureScreenshot(page, info, `${id}-terminal`);
  return page.locator('.terminal-pane[data-active="true"]').getAttribute("data-session-id");
}

for (const narrow of [false, true]) test.describe(narrow ? "touch workspace contexts" : "desktop workspace contexts", () => {
  test.use({ viewport: narrow ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: narrow, isMobile: narrow });

  test("create/start/open, picker and browser-history round trips restore independent files, preview, terminal and chat", async ({ page }, info) => {
    const errors: string[] = [], origins = new Set<string>();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => origins.add(new URL(request.url()).origin));
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/s/atlas/"); await surface(page, "Files");
    await page.locator('[data-item-path="NOTES.md"]').click();
    await surface(page, "Chat");
    const sourceConversation = "demo-atlas:conversation-1";
    await page.locator("#chat-conversation-select").selectOption(sourceConversation);
    const sourceTerminal = await inspectContext(page, "atlas", "Atlas", "NOTES.md", sourceConversation, info);
    await picker(page); await captureScreenshot(page, info, "source-actual-picker");
    await page.getByRole("link", { name: "Create worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('[data-worktree-confirmation]')).toContainText("Created feature/checkout");
    await expect(page).toHaveURL(/\/s\/atlas\//);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/atlas-created-1\//);
    await ready(page); await surface(page, "Chat");
    const destinationConversation = "demo-atlas-created-1:conversation-2";
    await page.locator("#chat-conversation-select").selectOption(destinationConversation);
    const destinationTerminal = await inspectContext(page, "atlas-created-1", "feature/checkout", "README.md", destinationConversation, info);
    expect(destinationTerminal).not.toBe(sourceTerminal);
    await page.goBack();
    expect(await inspectContext(page, "atlas", "Atlas", "NOTES.md", sourceConversation)).toBe(sourceTerminal);
    await expect(page.locator("#operation-status")).toHaveCount(0);
    await page.goForward();
    expect(await inspectContext(page, "atlas-created-1", "feature/checkout", "README.md", destinationConversation)).toBe(destinationTerminal);
    await picker(page);
    await page.locator('[data-workspace="atlas"]').getByRole("link", { name: "Open", exact: true }).click();
    expect(await inspectContext(page, "atlas", "Atlas", "NOTES.md", sourceConversation)).toBe(sourceTerminal);
    const before = { url: page.url(), terminal: sourceTerminal, conversation: sourceConversation };
    await picker(page); await page.request.post("/__demo/discover");
    await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
    await page.request.post("/__demo/reconnect");
    await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
    await page.getByRole("button", { name: "Close worktrees" }).click();
    expect(await inspectContext(page, "atlas", "Atlas", "NOTES.md", sourceConversation)).toBe(sourceTerminal);
    expect(page.url()).toBe(before.url);
    const state = await page.request.get("/__demo/ledger").then(response => response.json());
    for (const workspace of state.contexts) {
      expect(workspace.conversations).toHaveLength(2);
      for (const conversation of workspace.conversations) expect(conversation.id.startsWith(`demo-${workspace.id}:`)).toBe(true);
      expect(workspace.terminals.every((terminal: { output: string }) => terminal.output.includes(state.rows.find((row: { id: string }) => row.id === workspace.id).path))).toBe(true);
    }
    expect(origins.size).toBe(1); expect(errors).toEqual([]);
    expect(await page.locator("iframe").count()).toBe(0);
    await saveEvidence(info, "round-trip-and-ledger.json", JSON.stringify({ simulation: true, browserTouchEmulation: narrow, nativeMacOS: "untested", sourceTerminal, destinationTerminal, sourceConversation, destinationConversation, state }, null, 2));
  });

  test("late source reads/events cannot replace another workspace; reset fences pending reads and history", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/s/atlas/"); await ready(page);
    await page.request.post("/api/hub/sessions/atlas-sidebar/start");
    await surface(page, "Chat"); await page.locator("#chat-conversation-select").selectOption("demo-atlas:conversation-2");
    for (const route of ["/api/chat/conversations", "/api/terminal/sessions"]) await page.request.post("/__demo/delay", { data: { ws: "atlas", route, ms: 5000 } });
    await page.request.post("/__demo/inventory", { data: { ws: "atlas" } });
    await surface(page, "Terminal");
    await page.request.post("/__demo/delay", { data: { ws: "atlas", route: "/api/document", ms: 3000 } });
    await surface(page, "Files"); await page.locator('[data-item-path="NOTES.md"]').click();
    await expect.poll(async () => (await page.request.get("/__demo/ledger").then(response => response.json())).ledger.filter((entry: { outcome: string }) => entry.outcome === "pending delayed read").length).toBe(3);
    await picker(page); await page.locator('[data-workspace="atlas-sidebar"]').getByRole("link", { name: "Open", exact: true }).click();
    await surface(page, "Chat"); await page.locator("#chat-conversation-select").selectOption("demo-atlas-sidebar:conversation-2");
    const terminal = await inspectContext(page, "atlas-sidebar", "feature/sidebar", "README.md", "demo-atlas-sidebar:conversation-2");
    await page.request.post("/__demo/late-event", { data: { ws: "atlas" } });
    await expect.poll(async () => (await page.request.get("/__demo/ledger").then(response => response.json())).ledger.filter((entry: { outcome: string }) => entry.outcome === "200 delayed read").length).toBe(3);
    expect(await inspectContext(page, "atlas-sidebar", "feature/sidebar", "README.md", "demo-atlas-sidebar:conversation-2")).toBe(terminal);
    await page.request.post("/__demo/delay", { data: { ws: "atlas-sidebar", route: "/api/chat/conversations", ms: 5000 } });
    const pending = page.request.get("/s/atlas-sidebar/api/chat/conversations");
    await expect.poll(async () => (await page.request.get("/__demo/ledger").then(response => response.json())).ledger.some((entry: { path: string; outcome: string }) => entry.path.includes("atlas-sidebar/api/chat/conversations") && entry.outcome === "pending delayed read")).toBe(true);
    await page.getByText("SIMULATION · scenarios and reset", { exact: true }).click();
    const generation = (await page.request.get("/__demo/generation").then(response => response.json())).generation;
    await page.getByRole("button", { name: "Reset scenario" }).click();
    expect((await pending).status()).toBe(409);
    await page.waitForURL(url => url.searchParams.get("demoGeneration") === String(generation + 1));
    await ready(page); await surface(page, "Preview");
    await expect(page.locator("#preview")).toContainText("Atlas workspace");
    await page.goBack(); await ready(page); await surface(page, "Preview");
    await expect(page).toHaveURL(/\/s\/atlas\//);
    await expect(page.locator("#preview")).toContainText("Atlas workspace");
    await surface(page, "Chat");
    await expect(page.locator("#chat-conversation-select")).toHaveValue("demo-atlas:conversation-1");
    const state = await page.request.get("/__demo/ledger").then(response => response.json());
    expect(state.contexts.map((workspace: { id: string }) => workspace.id)).toEqual(["atlas"]);
    expect(state.rows.find((row: { id: string }) => row.id === "atlas-sidebar").running).toBe(false);
    await saveEvidence(info, "late-response-and-reset.json", JSON.stringify({ simulation: true, sourceReadArrivedAfterNavigation: true, sourceLiveEventIgnored: true, pendingReadCancelled: true, resetHistoryRestoredInitialSource: true, state }, null, 2));
  });
});
