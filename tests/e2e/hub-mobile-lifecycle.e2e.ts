import type { Page } from "@playwright/test";
import type { TerminalSessionInfo } from "../../src/terminal/server";
import { test, expect, loginHub, hubPost } from "./hub-mobile-fixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function terminal(page: Page) {
  const tab = page.getByRole("tab", { name: "Terminal", exact: true });
  if (!(await tab.isVisible())) await page.locator("#navigation-handle").click();
  await tab.click();
}

async function command(page: Page, text: string) {
  const pane = page.locator(".terminal-pane-host").first();
  await expect(pane).toHaveAttribute("data-terminal-ready", "true");
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("independent Hub workspaces preserve real PTYs across navigation and never take over another client", async ({ page, context, hub }) => {
  test.setTimeout(150_000);
  const manifest = await page.request.get(`${hub.origin}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({ name: "UatuCode Hub", start_url: "/", scope: "/", display: "standalone" });
  await loginHub(page, hub);
  const ids: string[] = [];
  for (const [name, path] of Object.entries(hub.workspaces)) {
    const result = await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path, displayName: name.toUpperCase(), start: true });
    ids.push(result.workspace.id);
  }
  const [a, b] = ids as [string, string];
  const inventory = async (id: string): Promise<TerminalSessionInfo[]> => {
    const response = await page.request.get(`${hub.origin}/s/${id}/api/terminal/sessions`);
    expect(response.ok(), "real Hub PTY backend must be available for this regression").toBe(true);
    return (await response.json()).sessions;
  };
  const creations: string[] = [];
  const terminalUrls: URL[] = [];
  const forbiddenMutations: string[] = [];
  const observe = (client: Page) => {
    client.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.endsWith("/api/terminal/sessions")) creations.push(path);
      if (request.method() === "DELETE" || (request.method() === "POST" && /\/(stop|forget)$/.test(path))) forbiddenMutations.push(path);
    });
    client.on("websocket", socket => {
      const url = new URL(socket.url());
      if (url.pathname.endsWith("/api/terminal")) terminalUrls.push(url);
    });
  };
  observe(page);
  const second = await context.newPage();
  observe(second);
  await page.goto(`${hub.origin}/s/${a}/docs/guide.md`);
  await second.goto(`${hub.origin}/s/${b}/docs/guide.md`);
  await expect(page.locator("#preview")).toContainText("Guide A");
  await expect(second.locator("#preview")).toContainText("Guide B");
  expect(await inventory(a)).toEqual([]);
  expect(await inventory(b)).toEqual([]);
  // Full document navigation in A must not navigate an already-open B client.
  await page.goto(`${hub.origin}/s/${a}/README.md`);
  await expect(page.locator("#preview")).toContainText("Workspace A");
  await expect(second).toHaveURL(`${hub.origin}/s/${b}/docs/guide.md`);
  await expect(second.locator("#preview")).toContainText("Guide B");
  await terminal(page);
  await command(page, "UATU_HUB_MARKER=alive; printf 'ready_%s_end\\n' \"$UATU_HUB_MARKER\"");
  await expect(page.locator(".terminal-pane-host")).toContainText("ready_alive_end");
  await terminal(second);
  await command(second, "UATU_HUB_MARKER=other; printf 'ready_%s_end\\n' \"$UATU_HUB_MARKER\"");
  await expect(second.locator(".terminal-pane-host")).toContainText("ready_other_end");
  const aSession = (await inventory(a))[0]!;
  const bSession = (await inventory(b))[0]!;
  expect(aSession.id).not.toBe(bSession.id);
  expect(aSession.attached).toBe(true);
  expect(bSession.attached).toBe(true);

  await command(page, "sleep 2; printf 'detached_%s_end\\n' \"$UATU_HUB_MARKER\"");
  if (!(await page.locator("#navigation-hub").isVisible())) await page.locator("#navigation-handle").click();
  await page.locator("#navigation-hub").click();
  await expect(page).toHaveURL(`${hub.origin}/`);
  await expect.poll(async () => (await inventory(a)).map(session => ({ id: session.id, attached: session.attached }))).toEqual([{ id: aSession.id, attached: false }]);
  await page.waitForTimeout(2300);
  expect((await inventory(b)).map(session => ({ id: session.id, attached: session.attached }))).toEqual([{ id: bSession.id, attached: true }]);
  await expect(page.locator("#sessions")).toContainText("detached");
  await expect(page.locator("#hub-return")).toContainText("Return to A");
  await page.locator("#hub-return").click();
  // Return lands in workspace A. Once there, the workspace selects its default
  // document and advances the URL to it, exactly as arriving at `/s/<id>/`
  // directly does, so assert the workspace rather than racing that push.
  await expect(page).toHaveURL(new RegExp(`^${hub.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s/${a}/`));
  await terminal(page);
  await expect(page.locator(".terminal-pane-host")).toContainText("detached_alive_end");
  await command(page, "printf 'restored_%s_end\\n' \"$UATU_HUB_MARKER\"");
  await expect(page.locator(".terminal-pane-host")).toContainText("restored_alive_end");
  expect((await inventory(a)).map(session => session.id)).toEqual([aSession.id]);

  const third = await context.newPage();
  observe(third);
  await third.goto(`${hub.origin}/s/${a}/README.md`);
  await terminal(third);
  await expect(third.locator("#terminal-switcher")).toBeVisible();
  await expect(third.locator("#terminal-switcher")).toContainText("attached elsewhere");
  await expect(third.locator(".terminal-switcher-takeover")).toHaveCount(1);
  await expect(page.locator(".terminal-taken")).toHaveCount(0);
  await command(page, "printf 'owner_%s_end\\n' \"$UATU_HUB_MARKER\"");
  await expect(page.locator(".terminal-pane-host")).toContainText("owner_alive_end");
  expect((await inventory(a)).map(session => session.id)).toEqual([aSession.id]);
  expect(creations.sort()).toEqual([`/s/${a}/api/terminal/sessions`, `/s/${b}/api/terminal/sessions`].sort());
  expect(terminalUrls.length).toBeGreaterThanOrEqual(3);
  expect(terminalUrls.every(url => !url.searchParams.has("t") && url.searchParams.get("takeover") !== "1")).toBe(true);
  expect(forbiddenMutations).toEqual([]);
  await third.close();
  await second.close();
});
