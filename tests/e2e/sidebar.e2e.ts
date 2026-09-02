import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./fixtures";

import { openChatPanel } from "./chat-helpers";
import { treeRow } from "./tree-helpers";
import { standardBeforeEach, sidebarPanesFitVisibleHeight } from "./fixtures";

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("tree rows render a file-type icon via the library's built-in icon set", async ({ page }) => {
  // The library renders icons as inline SVG inside each row. We just assert
  // that one is present on a Markdown row — the exact sprite is an internal
  // contract we don't pin here.
  await expect(treeRow(page, "README.md").locator("svg")).not.toHaveCount(0);
});

test("sidebar collapse preference persists across reloads", async ({ page }) => {
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#sidebar-expand")).toBeVisible();

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-expand").click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);
});

test("sidebar panes can be hidden, restored, resized, and survive whole-sidebar collapse", async ({ page }) => {
  const overviewPane = page.locator('[data-pane-id="change-overview"]');
  await expect(overviewPane).toBeVisible();

  await overviewPane.getByRole("button", { name: "Hide Change Overview" }).click();
  await expect(overviewPane).toBeHidden();

  await page.locator("#panels-toggle").click();
  await page.locator('#panels-menu label:has-text("Change Overview") input').check();
  await expect(overviewPane).toBeVisible();

  const before = (await overviewPane.boundingBox())?.height ?? 0;
  const resizer = page.locator('[data-pane-resizer="change-overview"]');
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 3);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 45);
  await page.mouse.up();
  const after = (await overviewPane.boundingBox())?.height ?? 0;
  expect(after).toBeGreaterThan(before + 20);
  await expect.poll(sidebarPanesFitVisibleHeight(page)).toBe(true);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await page.locator("#sidebar-expand").click();
  await expect(overviewPane).toBeVisible();

  const sidebarBefore = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  const sidebarResizerBox = await page.locator("#sidebar-resizer").boundingBox();
  expect(sidebarResizerBox).not.toBeNull();
  await page.mouse.move((sidebarResizerBox?.x ?? 0) + 3, (sidebarResizerBox?.y ?? 0) + 20);
  await page.mouse.down();
  await page.mouse.move((sidebarResizerBox?.x ?? 0) + 85, (sidebarResizerBox?.y ?? 0) + 20);
  await page.mouse.up();
  const sidebarAfter = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  expect(sidebarAfter).toBeGreaterThan(sidebarBefore + 50);

  await page.reload();
  await expect(overviewPane).toBeVisible();
  const reloaded = (await overviewPane.boundingBox())?.height ?? 0;
  expect(reloaded).toBeGreaterThan(before + 20);
  const sidebarReloaded = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  expect(sidebarReloaded).toBeGreaterThan(sidebarBefore + 50);
});

test("Files-pane header title does not visually overlap the file count", async ({ page }) => {
  // Wait until the document-count text reflects real workspace contents so
  // the assertion exercises a populated header (the "65 files · 5 binary"
  // shape from the bug report) rather than the empty-tree shape.
  const documentCount = page.locator("#document-count");
  await expect(documentCount).not.toHaveText(/^0 files$/);

  const filesPane = page.locator('[data-pane-id="files"]');
  const title = filesPane.locator(".pane-header h2");
  const count = filesPane.locator("#document-count");

  // At the default sidebar width, the title's right edge must clear the
  // count's left edge with at least a 4px gap (the CSS gap is 0.5rem ≈ 8px;
  // 4px gives subpixel tolerance without admitting overlap).
  const titleRectDefault = await title.boundingBox();
  const countRectDefault = await count.boundingBox();
  expect(titleRectDefault).not.toBeNull();
  expect(countRectDefault).not.toBeNull();
  expect(titleRectDefault!.x + titleRectDefault!.width + 4).toBeLessThanOrEqual(countRectDefault!.x);

  // At the minimum supported sidebar width (320px) the title may have
  // ellipsised — but the rects MUST NOT overlap.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--sidebar-width", "320px");
  });
  // Give layout one frame to settle after the custom-property write.
  await page.waitForFunction(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width").trim() === "320px";
  });
  const titleRectMin = await title.boundingBox();
  const countRectMin = await count.boundingBox();
  expect(titleRectMin).not.toBeNull();
  expect(countRectMin).not.toBeNull();
  expect(titleRectMin!.x + titleRectMin!.width + 4).toBeLessThanOrEqual(countRectMin!.x);
});

test("collapsed rail exposes a Follow toggle driving the same state as the chip", async ({ page }) => {
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.locator("#sidebar-collapse").click();
  const railFollow = page.locator("#rail-follow-toggle");
  await expect(railFollow).toBeVisible();
  await expect(railFollow).toHaveAttribute("aria-pressed", "false");

  await railFollow.click();
  await expect(railFollow).toHaveAttribute("aria-pressed", "true");

  // Expanding shows the chip agreeing with the value set from the rail;
  // collapsing again keeps the rail in sync.
  await page.locator("#sidebar-expand").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#sidebar-collapse").click();
  await expect(railFollow).toHaveAttribute("aria-pressed", "true");
  await page.locator("#sidebar-expand").click();
});

test("desktop never renders the touch chrome or size steppers", async ({ page }) => {
  await expect(page.locator("#touch-tab-bar")).toBeHidden();
  await expect(page.locator("#ui-mode-toggle")).toBeHidden();
  await expect(page.locator("#preview-text-increase")).toBeHidden();
  await expect(page.locator("#preview-text-decrease")).toBeHidden();
});

test("declutter defaults: fresh clients hide Git Log; the panes menu no longer lists Selection Inspector", async ({ page }) => {
  // standardBeforeEach cleared localStorage, so this is a fresh client.
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="files"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeHidden();

  await page.locator("#panels-toggle").click();
  await expect(page.locator('#panels-menu label:has-text("Git Log")')).toBeVisible();
  await expect(page.locator('#panels-menu label:has-text("Selection Inspector")')).toHaveCount(0);
  await page.locator("#panels-toggle").click();

  // The retired pane left no DOM behind.
  await expect(page.locator('[data-pane-id="selection-inspector"]')).toHaveCount(0);
});

test("Usage pane: hidden by default, one toggle away in the panels menu, revealed by the readout's pin, and persistent across reload", async ({ page, request }) => {
  const usagePane = page.locator('[data-pane-id="usage"]');
  await expect(usagePane).toBeHidden();

  // Like Git Log: available from the menu, empty until a turn reports.
  await page.locator("#panels-toggle").click();
  const option = page.locator('#panels-menu label:has-text("Usage") input');
  await expect(option).toBeVisible();
  await option.check();
  await expect(usagePane).toBeVisible();
  await expect(usagePane.locator(".pane-empty")).toHaveText("Plan usage appears here after a Claude Code turn.");
  await usagePane.getByRole("button", { name: "Collapse Usage" }).click();
  await expect(usagePane).toHaveClass(/is-collapsed/);
  await usagePane.getByRole("button", { name: "Expand Usage" }).click();
  await usagePane.getByRole("button", { name: "Hide Usage" }).click();
  await expect(usagePane).toBeHidden();
  await page.locator("#panels-toggle").click();

  // A Claude conversation with a plan report: the readout's pin reveals the
  // pane with the figures, and only the Usage pane's state changes.
  await control(request, { action: "agents", count: 2 });
  const seeded = await control(request, {
    action: "seed", agent: "claude", title: "Plan pin",
    items: [{ id: "context:report:1", type: "context_report", createdAt: 3, total: 24_000, max: 200_000, plan: { subscription: "pro", fiveHour: { utilization: 9, resetsAt: Date.now() + 3_600_000 }, sevenDay: { utilization: 25, resetsAt: Date.now() + 4 * 86_400_000 } } }],
  }) as { conversation: { id: string } };
  // The chat API is behind the workspace credential, which the token query
  // parameter installs (the same path the chat tests boot through).
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
  await page.locator("#chat-plan-usage-summary").click();
  await page.locator("#chat-plan-pin").click();
  await expect(usagePane).toBeVisible();
  await expect(usagePane.locator(".usage-pane-head")).toHaveText(/^Pro plan · as of /);
  await expect(usagePane.locator(".plan-row-label")).toHaveText(["Session", "Week"]);
  await expect(page.locator('[data-pane-id="git-log"]')).toBeHidden();
  await expect(page.locator('[data-pane-id="files"]')).toBeVisible();

  await page.reload();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(usagePane).toBeVisible();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeHidden();
});

test("legacy stored pane state with a selection-inspector entry boots cleanly", async ({ page }) => {
  await page.evaluate(() => {
    // Plant a pre-removal arrangement under the presentation-storage key
    // shape: stale selection-inspector entry plus git-log explicitly on.
    const prefix = `uatu:presentation:v1:${encodeURIComponent("/")}:`;
    window.localStorage.setItem(
      `${prefix}uatu:sidebar-panes`,
      JSON.stringify({
        "selection-inspector": { visible: true, collapsed: false, height: 160 },
        "git-log": { visible: true, collapsed: false, height: 140 },
      }),
    );
  });
  await page.reload();

  // Boot succeeded, the stored git-log visibility is honored, and the stale
  // entry is inert.
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator('[data-pane-id="git-log"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="selection-inspector"]')).toHaveCount(0);
});
