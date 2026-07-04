import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("outline toggle opens a panel listing the AsciiDoc headings", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  const toggle = page.locator("#outline-toggle");
  await expect(toggle).toBeVisible();

  // Closed by default — the panel is not shown until the toggle is clicked.
  await expect(page.locator(".uatu-outline")).toBeHidden();

  await toggle.click();
  await expect(page.locator(".uatu-outline")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  const links = page.locator(".uatu-outline-link");
  await expect(links.first()).toHaveText("AsciiDoc Cheat Sheet");
  // The cheatsheet is heading-rich; a handful is plenty to prove enumeration.
  expect(await links.count()).toBeGreaterThan(5);

  // Close again via the toggle.
  await toggle.click();
  await expect(page.locator(".uatu-outline")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("outline works for Markdown documents too", async ({ page }) => {
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");

  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();
  const links = page.locator(".uatu-outline-link");
  await expect(links.first()).toHaveText("Markdown Cross-Document Links");
  expect(await links.count()).toBe(4);
});

test("Escape closes the open outline", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".uatu-outline")).toBeHidden();
  await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("clicking an entry scrolls to the heading and marks it active", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();

  const tablesLink = page.locator(".uatu-outline-link", { hasText: "Tables" });
  await tablesLink.click();
  await expect(tablesLink).toHaveClass(/is-active/);

  // The "Tables" heading should settle near the top of the scroll viewport.
  // Smooth-scroll is async, so poll until it lands in the upper region (the
  // sticky preview-header occupies the very top, so allow for its offset).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll<HTMLElement>("#preview h2")).find(
          h => (h.textContent ?? "").trim() === "Tables",
        );
        const shell = document.querySelector<HTMLElement>(".preview-shell");
        if (!heading || !shell) return Number.POSITIVE_INFINITY;
        const hr = heading.getBoundingClientRect();
        const sr = shell.getBoundingClientRect();
        return hr.top - sr.top;
      }),
    )
    .toBeLessThan(150);
});

test("scroll-spy highlights the heading scrolled into view", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();

  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".preview-shell");
    shell?.scrollTo({ top: shell.scrollHeight });
  });

  // Scrolled to the very bottom, the *last* heading must be active. The closing
  // sections live in the final screenful with no scroll runway to push them to
  // a top trigger band, so a naive observer would leave the highlight stuck on
  // an earlier heading — this guards that regression.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const links = Array.from(document.querySelectorAll(".uatu-outline-link"));
        const activeIndex = links.findIndex(link => link.classList.contains("is-active"));
        return activeIndex === links.length - 1;
      }),
    )
    .toBe(true);

  // Back at the top, the first heading is active again.
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".preview-shell");
    shell?.scrollTo({ top: 0 });
  });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const links = Array.from(document.querySelectorAll(".uatu-outline-link"));
        return links.findIndex(link => link.classList.contains("is-active"));
      }),
    )
    .toBe(0);
});

test("filter narrows the visible entries without losing tracking", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();

  await page.locator(".uatu-outline-filter").fill("tables");
  const visibleLinks = page.locator(".uatu-outline-link:not([hidden])");
  await expect(visibleLinks).toHaveCount(1);
  await expect(visibleLinks.first()).toHaveText("Tables");

  // Clearing the filter restores every entry.
  await page.locator(".uatu-outline-filter").fill("");
  expect(await page.locator(".uatu-outline-link:not([hidden])").count()).toBeGreaterThan(5);
});

async function panelSize(page: import("@playwright/test").Page): Promise<{ w: number; h: number }> {
  const box = await page.locator(".uatu-outline").boundingBox();
  if (!box) throw new Error("outline panel not visible");
  return { w: Math.round(box.width), h: Math.round(box.height) };
}

test("outline docks: reflows the document and fills the preview height", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();

  // Always docked — the preview reserves a gutter so content clears the panel.
  await expect(page.locator(".preview-shell")).toHaveClass(/is-outline-docked/);
  const layout = await page.evaluate(() => {
    const panel = document.querySelector(".uatu-outline")?.getBoundingClientRect();
    const shell = document.querySelector(".preview-shell")?.getBoundingClientRect();
    const heading = document.querySelector<HTMLElement>("#preview h1, #preview h2");
    if (!panel || !shell || !heading) return null;
    return {
      clears: heading.getBoundingClientRect().right <= panel.left + 1,
      bottomNearShell: panel.bottom <= shell.bottom + 1 && panel.bottom > shell.bottom - 48,
      tall: panel.height > shell.height * 0.6,
    };
  });
  expect(layout).not.toBeNull();
  expect(layout!.clears).toBe(true);
  expect(layout!.bottomNearShell).toBe(true);
  expect(layout!.tall).toBe(true);
});

test("left-edge resizer changes the width (docked edge fixed); width persists", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();
  const before = await panelSize(page);
  const rightBefore = await page.evaluate(
    () => document.querySelector(".uatu-outline")!.getBoundingClientRect().right,
  );

  const handle = page.locator(".uatu-outline-resizer");
  const hb = (await handle.boundingBox())!;
  // Drag the left edge leftward → wider; the docked right edge must not move.
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 120, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = await panelSize(page);
  expect(after.w).toBeGreaterThan(before.w + 80);
  const rightAfter = await page.evaluate(
    () => document.querySelector(".uatu-outline")!.getBoundingClientRect().right,
  );
  expect(Math.round(rightAfter)).toBe(Math.round(rightBefore));

  // Width persists across reload.
  await page.reload();
  await expect(treeRow(page, "README.md")).toBeVisible();
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  const reloaded = await panelSize(page);
  expect(Math.abs(reloaded.w - after.w)).toBeLessThan(6);
});

test("closing the outline releases the document gutter", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await page.locator("#outline-toggle").click();
  await expect(page.locator(".preview-shell")).toHaveClass(/is-outline-docked/);

  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeHidden();
  await expect(page.locator(".preview-shell")).not.toHaveClass(/is-outline-docked/);
});

test("outline stays over the preview when the terminal is right-docked", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();

  // Right-dock the terminal first — this turns .main-stack into a row with the
  // terminal occupying the right side, where the overlay used to wrongly anchor.
  // (Dock before opening the outline so the overlay doesn't cover the dock
  // toggle during setup.)
  await page.locator("#terminal-toggle").click();
  await expect(page.locator("#terminal-panel")).toBeVisible();
  await page.locator("#terminal-dock-toggle").click();
  await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");

  await page.locator("#outline-toggle").click();
  await expect(page.locator(".uatu-outline")).toBeVisible();

  // The overlay must anchor inside the preview-shell and clear the terminal.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const panel = document.querySelector(".uatu-outline")?.getBoundingClientRect();
        const shell = document.querySelector(".preview-shell")?.getBoundingClientRect();
        const term = document.querySelector("#terminal-panel")?.getBoundingClientRect();
        if (!panel || !shell || !term) return false;
        const withinShell = panel.right <= shell.right + 1 && panel.left >= shell.left - 1;
        const clearOfTerminal = panel.right <= term.left + 1;
        return withinShell && clearOfTerminal;
      }),
    )
    .toBe(true);
});

test("action bar is gated to Rendered view", async ({ page }) => {
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  await expect(page.locator("#outline-toggle")).toBeVisible();
  await expect(page.locator("#copy-source-action")).toBeVisible();

  // Source view: both action-bar buttons hide (no rendered headings, and the
  // outline/copy affordances are Rendered-view only).
  await page.locator("#view-source").click();
  await expect(page.locator("#outline-toggle")).toBeHidden();
  await expect(page.locator("#copy-source-action")).toBeHidden();

  // Back to Rendered: both return.
  await page.locator("#view-rendered").click();
  await expect(page.locator("#outline-toggle")).toBeVisible();
  await expect(page.locator("#copy-source-action")).toBeVisible();
});

test("copy-source copies the raw document text to the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
  // Wait for the document SWITCH, not just the button: #copy-source-action
  // is already visible for the initially-loaded README, and copying before
  // the switch lands grabs the wrong document (recurring CI flake).
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");
  await expect(page.locator("#copy-source-action")).toBeVisible();

  await page.locator("#copy-source-action").click();
  await expect(page.locator("#copy-source-action")).toHaveClass(/is-copied/);

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("= AsciiDoc Cheat Sheet");
  expect(clipboard).toContain(":toc:");
});
