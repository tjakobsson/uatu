// The Hub dashboard's and Settings' "← Back to <label>" (add-workspace-
// switcher): a session page remembers where it is, per device and Hub user,
// and the Hub's pages offer to go back there in a bar pinned to the top of
// the viewport: a compact pill on desktop, a full-width 44px row on phones.
// Through a real Hub whose children serve the in-memory GitHub fake (#642 is
// "feat(preview): add GitHub PR review"); nothing reaches GitHub.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";

import { captureScreenshot } from "./evidence";
import { expect, openHubMenu, test, type HubE2EInfo } from "./hub-fixtures";
import { centreMiss, expectTouchTarget, focusedElement, tapCentre } from "./pull-request-helpers";

test.use({ hubWorktrees: true, hubGithubFake: true, hubWorkspaces: ["atlas", "beacon"] });

const PR_TITLE = "feat(preview): add GitHub PR review";
const back = (page: Page): Locator => page.getByRole("link", { name: /^Back to / });
const controls = (page: Page): Locator => page.locator("[data-hub-return]");

async function openSession(hub: HubE2EInfo, page: Page, location: string): Promise<void> {
  await page.goto(`${hub.origin}${location}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

// The PR view on Files changed, with its title read (the label names it).
async function openPullRequestFiles(hub: HubE2EInfo, page: Page): Promise<string> {
  const location = "/s/atlas/?pr=642&tab=files";
  await openSession(hub, page, location);
  await expect(page.locator("#preview-title")).toHaveText(PR_TITLE);
  await expect(page.locator("#pr-panel-files")).toBeVisible();
  return location;
}

// Leaves the session the way a reader does: the switcher's footer.
async function leaveThroughFooter(page: Page, link: "Hub dashboard" | "Settings", tap = false): Promise<void> {
  await openHubMenu(page, { tap });
  const footerLink = page.locator("#switcher-footer").getByRole("link", { name: link });
  if (tap) await tapCentre(page, footerLink);
  else await footerLink.click();
  await expect(page).toHaveURL(link === "Settings" ? /\/settings(#.*)?$/ : /\/$/);
}

// The pinned bar is on screen and answers a tap or click at its centre, and
// the Settings pane the footer's anchor scrolled to is not under it.
async function expectPinnedInView(page: Page, settingsAnchor: boolean): Promise<void> {
  const link = back(page);
  await expect(link).toBeVisible();
  const box = (await link.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(await centreMiss(link)).toBeNull();
  if (settingsAnchor) {
    expect(await page.evaluate(() => window.scrollY), "the anchor scrolled the page").toBeGreaterThan(0);
    const bar = (await page.locator("[data-hub-return]").boundingBox())!;
    const pane = (await page.locator("#personal-chat-preferences-pane").boundingBox())!;
    expect(pane.y, "the anchored pane starts below the pinned bar").toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
  }
}

async function expectPullRequestFilesRestored(hub: HubE2EInfo, page: Page, location: string): Promise<void> {
  await expect(page).toHaveURL(`${hub.origin}${location}`);
  await expect(page.locator("#preview-title")).toHaveText(PR_TITLE);
  await expect(page.locator("#pr-panel-files")).toBeVisible();
  await expect(page.locator('[data-pr-tab][aria-selected="true"]')).toContainText("Files changed");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the dashboard names the PR view left through the switcher, and Back restores it exactly", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    const location = await openPullRequestFiles(hub, page);
    await leaveThroughFooter(page, "Hub dashboard");

    await expect(back(page)).toHaveCount(1);
    await expect(back(page)).toHaveAccessibleName(`Back to atlas · #642 ${PR_TITLE}`);
    await expect(back(page)).toHaveAttribute("href", location);
    // Pinned above the brand header, and still there once the page scrolls.
    const barBox = (await page.locator("[data-hub-return]").boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual((await page.locator(".hub-header").boundingBox())!.y);
    await captureScreenshot(page, testInfo, "hub-return-dashboard-desktop");
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expectPinnedInView(page, false);
    await page.setViewportSize({ width: 1280, height: 900 });

    await back(page).click();
    await expectPullRequestFilesRestored(hub, page, location);
  });

  test("Settings offers the same Back, and it restores the PR view", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    const location = await openPullRequestFiles(hub, page);
    await leaveThroughFooter(page, "Settings");

    await expect(back(page)).toHaveAccessibleName(`Back to atlas · #642 ${PR_TITLE}`);
    // The footer's link lands on its pane; the pinned bar is still in view.
    await expectPinnedInView(page, true);
    await captureScreenshot(page, testInfo, "hub-return-settings-desktop");
    await back(page).click();
    await expectPullRequestFilesRestored(hub, page, location);
  });

  test("a document location is named by its path and reopens that document", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openSession(hub, page, "/s/beacon/NOTES.md");
    await expect(page.locator("#preview-path")).toHaveText("NOTES.md");
    await leaveThroughFooter(page, "Hub dashboard");

    await expect(back(page)).toHaveAccessibleName("Back to beacon · NOTES.md");
    await back(page).click();
    await expect(page).toHaveURL(`${hub.origin}/s/beacon/NOTES.md`);
    await expect(page.locator("#preview-path")).toHaveText("NOTES.md");
  });

  test("with nothing remembered there is no Back control on the dashboard, Add workspace or Settings", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    for (const pagePath of ["/", "/clone", "/settings"]) {
      await page.goto(`${hub.origin}${pagePath}`);
      await expect(page.locator(".hub-nav")).toBeVisible();
      await expect(controls(page)).toHaveCount(1);
      for (const control of await controls(page).all()) await expect(control).toBeHidden();
      await expect(back(page)).toHaveCount(0);
    }
  });

  test("Back is keyboard-reachable from the top of the page and opens with Enter", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    const location = await openPullRequestFiles(hub, page);
    await leaveThroughFooter(page, "Hub dashboard");
    await expect(back(page)).toBeVisible();

    await page.keyboard.press("Tab");
    const focused = await focusedElement(page);
    expect(focused.label).toBe(`Back to atlas · #642 ${PR_TITLE}`);
    await expect(back(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expectPullRequestFilesRestored(hub, page, location);
  });

  test("a stopped workspace says so, and going back offers Start, which lands on the same location", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    const location = await openPullRequestFiles(hub, page);
    await leaveThroughFooter(page, "Hub dashboard");
    const stop = await page.evaluate(async () => (await fetch("/api/hub/sessions/atlas/stop", { method: "POST" })).ok);
    expect(stop).toBe(true);
    await page.reload();

    await expect(back(page)).toHaveAccessibleName(`Back to atlas · #642 ${PR_TITLE} (stopped)`);
    await expect(back(page).locator("[data-hub-return-stopped]")).toHaveText("Stopped");
    await back(page).click();
    await expect(page.getByRole("heading", { name: "Session unavailable" })).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();
    await expectPullRequestFilesRestored(hub, page, location);
  });

  test("a workspace forgotten since shows no Back control", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    const folder = await mkdtemp(path.join(os.tmpdir(), "uatu-e2e-gone-"));
    try {
      await page.goto(`${hub.origin}/`);
      const id = await page.evaluate(async folder => {
        const answer = await fetch("/api/hub/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: folder, init: true, start: false }),
        });
        return (await answer.json() as { id: string }).id;
      }, folder);
      const started = await page.evaluate(async id => (await fetch(`/api/hub/sessions/${encodeURIComponent(id)}/start`, { method: "POST" })).ok, id);
      expect(started).toBe(true);
      await openSession(hub, page, `/s/${encodeURIComponent(id)}/`);
      await leaveThroughFooter(page, "Hub dashboard");
      await expect(back(page)).toHaveAccessibleName(`Back to ${path.basename(folder)}`);

      const forgotten = await page.evaluate(async id => {
        const stop = await fetch(`/api/hub/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
        const forget = await fetch(`/api/hub/workspaces/${encodeURIComponent(id)}/forget`, { method: "POST" });
        return stop.ok && forget.ok;
      }, id);
      expect(forgotten).toBe(true);
      await page.reload();
      await expect(page.locator(".hub-nav")).toBeVisible();
      await expect(back(page)).toHaveCount(0);
      for (const control of await controls(page).all()) await expect(control).toBeHidden();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark" });

  test("a pinned 44px row on the dashboard and on Settings reached through the switcher, and a tap restores the PR view", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    const location = await openPullRequestFiles(hub, page);
    await leaveThroughFooter(page, "Hub dashboard", true);

    const row = back(page);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAccessibleName(`Back to atlas · #642 ${PR_TITLE}`);
    // The top of the page: above the brand header, the screen's full width.
    const rowBox = (await row.boundingBox())!;
    const headerBox = (await page.locator(".hub-header").boundingBox())!;
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(headerBox.y);
    expect(rowBox.y).toBeLessThan(20);
    expect(rowBox.width).toBeGreaterThan(330);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(390);
    await expectTouchTarget(row, "Back row");
    await expectPinnedInView(page, false);
    await captureScreenshot(page, testInfo, "hub-return-dashboard-phone");
    await tapCentre(page, row);
    await expectPullRequestFilesRestored(hub, page, location);

    // Settings through the switcher's footer: its anchor scrolls the page,
    // and the row stays pinned in view above the pane.
    await leaveThroughFooter(page, "Settings", true);
    await expectPinnedInView(page, true);
    await expect(row).toHaveAccessibleName(`Back to atlas · #642 ${PR_TITLE}`);
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await captureScreenshot(page, testInfo, "hub-return-settings-phone");
    await tapCentre(page, row);
    await expectPullRequestFilesRestored(hub, page, location);
  });
});
