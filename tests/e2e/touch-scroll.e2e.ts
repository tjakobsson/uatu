// Touch-mode scroll and surface integrity.
//
// Everything here is invisible on desktop, which is why it shipped broken:
// `.preview-shell` is the scroll container in the desktop layout, so scrolling
// it works and every desktop test passes. Touch mode lays it out
// `overflow: visible` and the page scrolls instead, turning every
// `scrollTop`/`scrollTo` on the shell into a silent no-op and leaving the
// sticky-header reservation on an element that no longer participates.
//
// The assertions therefore watch `window.scrollY` — the page's own scroll
// position — rather than the shell's, because the whole point is which
// element moved.

import { expect, test } from "./fixtures";
import { waitForPreviewToSettle } from "./fixtures";
import { treeRow } from "./tree-helpers";

// iPhone 13 Pro portrait, same emulation as mobile.e2e.ts: hasTouch + isMobile
// make Chromium report a coarse pointer, which defaults the UI mode to touch.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const FIND = "ControlOrMeta+f";
const SEARCH = "ControlOrMeta+Shift+f";

// A document tall enough that its later content is far below the fold on a
// 844px-high viewport, with a unique word near the bottom to search for and
// headings to jump to.
const TALL_DOC = [
  "# Tall Document",
  "",
  "## Opening",
  "",
  ...Array.from({ length: 120 }, (_, index) => `Filler paragraph number ${index} with ordinary prose.`).flatMap(
    line => [line, ""],
  ),
  "## Landing Zone",
  "",
  "The unique marker is chrysoberyl and it sits far below the fold.",
  "",
  ...Array.from({ length: 40 }, (_, index) => `Trailing paragraph ${index}.`).flatMap(line => [line, ""]),
  // A cross-document link, so a document switch can be driven from INSIDE the
  // preview. Going via the Files tab would not test anything: hiding the
  // preview surface collapses the page height and the browser clamps
  // `window.scrollY` on its own, so the assertion would pass with the bug
  // still present.
  "[Onward to the second document](tall-two.md)",
  "",
].join("\n");

// The link target has to be TALL as well. Navigating to a short document lets
// the browser clamp `window.scrollY` to the new, smaller maximum all by
// itself — which lands on 0 whether or not the app reset the scroll, and the
// assertion proves nothing.
const TALL_DOC_TWO = [
  "# Second Document",
  "",
  ...Array.from({ length: 160 }, (_, index) => `Second-document paragraph ${index}.`).flatMap(line => [line, ""]),
].join("\n");

const FIXTURES = { "tall-doc.md": TALL_DOC, "tall-two.md": TALL_DOC_TWO };

async function bootTouch(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await request.post("/__e2e/reset", { data: { extras: FIXTURES } });
  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await waitForPreviewToSettle(page);
}

// Open the tall document from the Files tab and land back on Preview.
async function openTallDoc(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#touch-tab-files").click();
  await treeRow(page, "tall-doc.md").click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  await expect(page.locator("#preview-title")).toHaveText("Tall Document");
  await waitForPreviewToSettle(page);
}

const pageScrollY = (page: import("@playwright/test").Page) => page.evaluate(() => window.scrollY);

// `scrollIntoView({ behavior: "smooth" })` animates, and mid-animation the
// target is still far from its landing spot — an assertion taken too early
// reads a position that says nothing about where the scroll was aimed.
async function settleScroll(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = window as unknown as { __y?: number; __still?: number };
      const y = window.scrollY;
      state.__still = state.__y === y ? (state.__still ?? 0) + 1 : 0;
      state.__y = y;
      return (state.__still ?? 0) > 4;
    },
    null,
    { polling: 100, timeout: 15_000 },
  );
  await page.evaluate(() => {
    const state = window as unknown as { __y?: number; __still?: number };
    state.__y = undefined;
    state.__still = 0;
  });
}

// Put a heading just below the top of the viewport, so the scroll spy has
// unambiguously passed its activation point.
//
// Deliberately NOT "scroll to the bottom and expect the last heading". That
// proxy is unreliable: the page reflows taller as the docked outline reserves
// its content gutter, so a `scrollTo(scrollHeight)` lands short of the moving
// maximum and the last heading never crosses the trigger line — which reads as
// a tracking bug when it is really a measurement race. Positioning relative to
// the heading itself is immune to document-height drift.
async function scrollHeadingIntoTriggerZone(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  await page.evaluate(async heading => {
    const find = () =>
      [...document.querySelectorAll("#preview h1, #preview h2, #preview h3")].find(element =>
        element.textContent?.includes(heading),
      );
    if (!find()) throw new Error(`no heading matching ${heading}`);
    // Iterate rather than aim once. Scrolling can itself change the layout —
    // opening the docked outline reserves a content gutter, which re-wraps
    // prose and moves every heading — so a position computed before the scroll
    // is stale by the time the scroll lands. Re-aim until the heading is
    // actually where it needs to be. 8px below the viewport top puts it above
    // the trigger line, which sits just under the sticky header.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const top = find()!.getBoundingClientRect().top;
      if (Math.abs(top - 8) <= 2) return;
      window.scrollTo({ top: window.scrollY + top - 8 });
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    }
  }, text);
  await settleScroll(page);
}

test.beforeEach(async ({ page, request }) => {
  await bootTouch(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("find reveals a match by scrolling the page, not the shell", async ({ page }) => {
  // #181's mechanism: revealRange used to mutate `.preview-shell.scrollTop`,
  // which does nothing here. The highlight painted and the reader never moved.
  await openTallDoc(page);
  expect(await pageScrollY(page)).toBe(0);

  await page.keyboard.press(FIND);
  await expect(page.locator("#find-query")).toBeVisible();
  await page.locator("#find-query").fill("chrysoberyl");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");

  await expect.poll(() => pageScrollY(page)).toBeGreaterThan(0);

  // And the match is genuinely on screen, not merely "scrolled somewhere".
  const visible = await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const current = registry.get("uatu-find-current");
    const range = current ? [...current][0] : null;
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
  });
  expect(visible).not.toBeNull();
  expect(visible!.top).toBeGreaterThanOrEqual(0);
  expect(visible!.bottom).toBeLessThanOrEqual(visible!.viewport);
});

test("an outline jump clears the sticky preview header", async ({ page }) => {
  // #183: `scrollIntoView({ block: "start" })` honours the SCROLL CONTAINER's
  // scroll-padding. The 9rem reservation used to sit only on `.preview-shell`,
  // so when the page scrolls the heading landed under the sticky chrome.
  await openTallDoc(page);
  await page.locator("#outline-toggle").click();

  const landing = page.locator(".uatu-outline-link", { hasText: "Landing Zone" });
  await expect(landing).toBeVisible();
  await landing.click();

  await expect.poll(() => pageScrollY(page)).toBeGreaterThan(0);
  await settleScroll(page);

  const geometry = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("#preview h2")].find(
      element => element.textContent?.includes("Landing Zone"),
    );
    const header = document.querySelector(".preview-header");
    if (!heading || !header) return null;
    return {
      headingTop: heading.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
    };
  });
  expect(geometry).not.toBeNull();
  // The whole bug: headingTop used to be ABOVE headerBottom, i.e. underneath
  // the frosted header.
  expect(geometry!.headingTop).toBeGreaterThanOrEqual(geometry!.headerBottom);
  // ...and it has to actually be the landing spot. Without an upper bound this
  // assertion also passes when the heading is somewhere far below the fold,
  // which is exactly how it passed against the unfixed source.
  expect(geometry!.headingTop).toBeLessThan(geometry!.headerBottom + 80);
});

test("opening a different document lands at the top of the page", async ({ page }) => {
  // Two things this test has to avoid, both of which make the browser reset
  // the scroll for us and hide the bug: switching via the Files tab (hiding
  // the preview collapses the page height) and navigating to a short document
  // (the new, smaller scroll maximum clamps the offset). So: an in-preview
  // link, to another tall document.
  await openTallDoc(page);
  await page.evaluate(() => window.scrollTo({ top: 1500 }));
  await expect.poll(() => pageScrollY(page)).toBeGreaterThan(1000);

  await page.locator("#preview a", { hasText: "Onward to the second document" }).click();
  await expect(page.locator("#preview-title")).toHaveText("Second Document");
  await waitForPreviewToSettle(page);

  await expect.poll(() => pageScrollY(page)).toBe(0);
});

test("⌘F from the Files tab brings Preview forward before mounting the bar", async ({ page }) => {
  // #191: the bar used to mount inside the hidden preview while native find
  // stayed suppressed, so the shortcut did nothing at all.
  await openTallDoc(page);
  await page.locator("#touch-tab-files").click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");

  await page.keyboard.press(FIND);

  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  await expect(page.locator("#find-query")).toBeVisible();
  await expect(page.locator("#find-query")).toBeFocused();
});

test("⇧⌘F from the Preview tab brings the Files tab forward with search focused", async ({ page }) => {
  // #192: openSearchPane expanded the sidebar and focused an input that
  // `html[data-ui-mode="touch"] .sidebar { display: none }` kept invisible.
  await openTallDoc(page);
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");

  await page.keyboard.press(SEARCH);

  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
  await expect(page.locator("#search-query")).toBeVisible();
  await expect(page.locator("#search-query")).toBeFocused();
});

// --- Device-pass items, mechanised -----------------------------------------
//
// tasks.md §7.5 and §7.6 were written as things to eyeball on a phone. Both are
// really geometry and event wiring, which a browser can assert far more
// reliably than a person squinting at a 390px screen — so they are pinned here
// and the device pass only has to confirm, not discover.

test("a revealed target at the end of the document clears the bottom tab bar", async ({ page }) => {
  // §7.5. Reveals bias toward the top, so the only target that could land under
  // the fixed tab bar is one in the last screenful, where there is no scroll
  // runway left to lift it. `.app-shell` reserves `--tab-bar-total` as padding
  // for exactly this reason; the assertion is that the reservation holds.
  await openTallDoc(page);

  await page.keyboard.press(FIND);
  await expect(page.locator("#find-query")).toBeVisible();
  // The very last paragraph of the document.
  await page.locator("#find-query").fill("Trailing paragraph 39.");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");
  await settleScroll(page);

  const geometry = await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const current = registry.get("uatu-find-current");
    const range = current ? [...current][0] : null;
    const bar = document.querySelector("#touch-tab-bar");
    if (!range || !bar) return null;
    return { matchBottom: range.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.matchBottom).toBeLessThanOrEqual(geometry!.barTop);
});

test("active-heading tracking follows page scrolling in touch mode", async ({ page }) => {
  // §7.6, first half. The scroll spy used to listen on `.preview-shell`, which
  // never emits when the page is the scroller — so the highlight froze on
  // whichever heading was active at mount.
  await openTallDoc(page);
  await page.locator("#outline-toggle").click();

  const active = page.locator(".uatu-outline-link.is-active");
  await expect(active).toHaveText("Tall Document");

  // Scroll the last heading past the trigger line; it must become active.
  await scrollHeadingIntoTriggerZone(page, "Landing Zone");
  await expect(active).toHaveText("Landing Zone");

  // ...and back, proving it tracks rather than latching once.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await settleScroll(page);
  await expect(active).toHaveText("Tall Document");
});

test("switching UI mode mid-session keeps every scroll path working", async ({ page }) => {
  // §7.6, second half. The effective scroll container changes underneath a live
  // session, with no remount and no scroll event on the old container — so both
  // the reveal path and the scroll spy have to re-resolve rather than hold a
  // reference captured at boot.
  await openTallDoc(page);
  // The outline has to be OPEN for this: its active-heading highlight is only
  // an observable claim while the panel is on screen, and asserting against the
  // hidden list would be asserting about something no reader can see.
  await page.locator("#outline-toggle").click();

  // Touch mode: the page scrolls.
  await page.keyboard.press(FIND);
  await page.locator("#find-query").fill("chrysoberyl");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");
  await expect.poll(() => pageScrollY(page)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  // Switch to desktop mode WITHOUT reloading. The toggle lives in the sidebar
  // chrome, which in touch mode renders inside the Files tab.
  await page.locator("#touch-tab-files").click();
  await page.locator("#ui-mode-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
  await page.evaluate(() => window.scrollTo({ top: 0 }));

  // Desktop mode at this viewport is the ≤900px stacked layout, which ALSO
  // scrolls the page — so the reveal must still move `window.scrollY`, and the
  // scroll spy must still be listening to something that fires.
  await page.keyboard.press(FIND);
  await page.locator("#find-query").fill("chrysoberyl");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");
  await expect.poll(() => pageScrollY(page)).toBeGreaterThan(0);

  // And the scroll spy must still be listening to something that fires. The
  // regression this guards is a DEAD LISTENER — one bound to an element that
  // stopped being the scroller — so the claim is that the highlight still
  // moves, not that it lands on a particular heading. Which heading is right
  // for a given offset is already pinned by the touch-mode test above; pinning
  // it again here would only couple this test to the exact document height,
  // which the docked outline's content gutter reflows underneath it.
  // Opened here and only here — the outline's highlight is only an observable
  // claim while the panel is on screen, and toggling twice would close it and
  // leave the assertion reading a stale, hidden list.
  await page.locator("#outline-toggle").click();
  const active = page.locator(".uatu-outline-link.is-active");
  // Opening the docked outline reserves a content gutter and reflows the page,
  // which moves the scroll position under any request issued in the same beat.
  // Let that land before asking the page to go anywhere.
  await settleScroll(page);

  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await settleScroll(page);
  await expect(active).toHaveText("Tall Document");

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  await settleScroll(page);
  await expect(active).toHaveText("Landing Zone");
});
