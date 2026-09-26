// Decision C's own browser (2026-09-19 live test). The defect the user hit on
// an iPhone — "Existing branch" showing a branch list that could not be used,
// with Create disabled for ever — is a WebKit rule Chromium does not share:
// canceling a touch `pointerdown` tells WebKit the gesture was not a tap, so
// it never synthesizes the compatibility `click` the option (and every footer
// button) relied on. Chromium fires that click either way, which is why every
// touch journey in worktree-ui.e2e.ts stayed green while the real phone could
// not create a worktree at all.
//
// `browserName` cannot be overridden per describe (it forces a new worker), so
// this one journey lives in its own file. WebKit is already installed by
// `bun run e2e:install`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

import { test, expect, openHubMenu } from "./hub-fixtures";
import { captureScreenshot } from "./evidence";

const exec = promisify(execFile);
test.use({
  hubWorktrees: true,
  hubWorkspaces: ["orbit-webkit"],
  browserName: "webkit",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Uatu Test", "-c", "user.email=uatu@example.test", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
}

async function fork(page: Page, parentId: string, mode: string): Promise<void> {
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") {
    await page.getByRole("tab", { name: "Files", exact: true }).click();
  }
  await openHubMenu(page);
  await page.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true }).click();
  await page.getByRole("menuitem", { name: mode, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("worktree dialog on an iOS-shaped WebKit", () => {
  test("the existing-branch list opens expanded, a tap commits a branch, and Cancel closes", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parentId = "orbit-webkit";
    const parent = hub.workspaces.find(workspace => workspace.id === parentId)!;
    await git(parent.path, ["branch", "webkit/tap"]).catch(() => undefined);
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);
    await fork(page, parentId, "Existing branch");
    const dialog = page.getByRole("dialog");

    // Expanded, with every local and remote ref, before anything is typed.
    await expect(dialog.locator('[role="listbox"]')).toBeVisible();
    await expect(dialog.getByRole("option")).not.toHaveCount(0);
    expect(await dialog.getByRole("option").count()).toBeGreaterThan(0);
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    await captureScreenshot(page, info, "worktree-ui-webkit-existing-list");

    // Tapping the field keeps the list open.
    await dialog.getByRole("combobox").tap();
    await expect(dialog.locator('[role="listbox"]')).toBeVisible();

    // Tapping an option commits it and enables Create.
    await dialog.getByRole("option", { name: "webkit/tap Local", exact: true }).tap();
    await expect(dialog.locator("[name=selection]")).toHaveValue("local:webkit/tap");
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await captureScreenshot(page, info, "worktree-ui-webkit-existing-chosen");

    // And the footer's own buttons are tappable too.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  // Decision F6 in the engine that actually shipped it: iOS Safari is where
  // the user found a picker taller than the screen with nothing to scroll.
  // `-webkit-overflow-scrolling` and `overscroll-behavior` are WebKit's own
  // concerns, so the bounded, scrollable menu is proved here too.
  test("a picker taller than the screen scrolls, and Sign out stays reachable", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parentId = "orbit-webkit";
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    const created = await page.evaluate(async (source: string) => {
      const results: boolean[] = [];
      for (const branch of Array.from({ length: 14 }, (_, index) => `deep/${String(index + 1).padStart(2, "0")}`)) {
        const response = await fetch("/api/hub/worktrees/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceWorkspaceId: source, mode: "new-branch", branch, base: { kind: "local", ref: "main" }, start: false }),
        });
        results.push(((await response.json()) as { ok?: boolean }).ok === true);
      }
      return results;
    }, parentId);
    expect(created.every(Boolean)).toBe(true);

    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page.getByRole("tab", { name: "Files", exact: true }).tap();
    await openHubMenu(page, { tap: true });
    const menu = page.locator("#hub-menu");
    const viewport = page.viewportSize()!;
    const metrics = await menu.evaluate(node => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      top: node.getBoundingClientRect().top,
      overflowY: getComputedStyle(node).overflowY,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.top + metrics.clientHeight).toBeLessThanOrEqual(viewport.height);

    await menu.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const signOut = menu.getByText("Sign out", { exact: true });
    await expect(signOut).toBeInViewport();
    await captureScreenshot(page, info, "worktree-ui-webkit-selector-scrolled");
    expect(errors).toEqual([]);
    await page.close();
  });
});
