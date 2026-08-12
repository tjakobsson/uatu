// Which presentation the outline takes, and what each one owes the reader.
//
// The rail was unconditional, and on a 390px phone its reserved gutter left the
// document a 114px text column — an `<h1>` breaking mid-word and a page 2.5x
// taller than the same document with the outline closed. Below a width
// threshold the outline is a fullscreen sheet instead; above it the rail is
// untouched, which `outline.e2e.ts` continues to assert at desktop width.
//
// EVERY presentation assertion here goes through `expectPresentation`, which
// checks properties only ONE of the two can hold — a `position` of `fixed`
// versus `absolute`, and a reserved gutter versus none. "The panel is visible"
// would pass in both presentations and prove nothing, which is the failure mode
// this repo has already hit twice in other suites.

import fs from "node:fs/promises";

import { expect, test } from "./fixtures";
import { waitForPreviewToSettle } from "./fixtures";
import { treeRow } from "./tree-helpers";
import { workspacePath } from "./config";

type Page = import("@playwright/test").Page;
type Request = import("@playwright/test").APIRequestContext;

// Enough headings that the outline list overflows its own scrollport (so
// "reveal the active entry" is a real assertion rather than a tautology), and
// enough filler that late headings sit far below the fold.
const SECTIONS = 24;
const OUTLINE_DOC = [
  "# Outline Fixture",
  "",
  ...Array.from({ length: SECTIONS }, (_, index) => [
    `## Section ${index}`,
    "",
    ...Array.from({ length: 8 }, (_, p) => `Paragraph ${p} of section ${index} with ordinary prose.`).flatMap(
      line => [line, ""],
    ),
  ]).flat(),
  // A cross-document link so a document change can be driven from inside the
  // preview, without a tab round-trip standing in for the thing under test.
  "[Onward to the second fixture](outline-two.md)",
  "",
].join("\n");

const OUTLINE_DOC_TWO = [
  "# Second Fixture",
  "",
  ...Array.from({ length: 6 }, (_, index) => [
    `## Second Section ${index}`,
    "",
    ...Array.from({ length: 6 }, (_, p) => `Second paragraph ${p}.`).flatMap(line => [line, ""]),
  ]).flat(),
].join("\n");

const FIXTURES = { "outline-doc.md": OUTLINE_DOC, "outline-two.md": OUTLINE_DOC_TWO };

async function boot(page: Page, request: Request): Promise<void> {
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
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await waitForPreviewToSettle(page);
}

async function openFixtureDoc(page: Page): Promise<void> {
  await page.locator("#touch-tab-files").click();
  await treeRow(page, "outline-doc.md").click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  await expect(page.locator("#preview-title")).toHaveText("Outline Fixture");
  await waitForPreviewToSettle(page);
}

// The width of the document's actual text column, net of the gutter the rail
// reserves. This is the number the whole change is about: it read 114px on a
// phone before, and must now be identical open and closed below the threshold.
function textColumnWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const preview = document.querySelector<HTMLElement>("#preview")!;
    const style = getComputedStyle(preview);
    return Math.round(
      preview.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    );
  });
}

// `scrollIntoView({ behavior: "smooth" })` animates, and mid-animation the
// target is still thousands of pixels from where it was aimed — an assertion
// taken too early reads a position that says nothing. Same helper shape as
// touch-scroll.e2e.ts, for the same reason.
async function settleScroll(page: Page): Promise<void> {
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

// Mutually exclusive by construction. Both presentations are `position: fixed`
// (that is the #231 geometry fix, not a presentation difference), so the
// discriminators are the two things only one of them can do: a sheet spans the
// full preview surface and reserves NO gutter; a rail is a fraction of that
// width and reserves one. Neither set of assertions can pass while the other
// presentation is showing.
async function expectPresentation(page: Page, expected: "rail" | "sheet"): Promise<void> {
  const panel = page.locator(".uatu-outline");
  await expect(panel).toHaveAttribute("data-presentation", expected);
  const observed = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".uatu-outline")!;
    const shell = document.querySelector<HTMLElement>(".preview-shell")!;
    return {
      panelWidth: element.getBoundingClientRect().width,
      surfaceWidth: shell.getBoundingClientRect().width,
      docked: shell.classList.contains("is-outline-docked"),
    };
  });
  if (expected === "sheet") {
    expect(Math.abs(observed.panelWidth - observed.surfaceWidth)).toBeLessThanOrEqual(2);
    expect(observed.docked).toBe(false);
  } else {
    expect(observed.panelWidth).toBeLessThanOrEqual(observed.surfaceWidth - 200);
    expect(observed.docked).toBe(true);
  }
}

// The #231 assertion, and the reason this change folds that fix in: the panel
// must be pinned to what is VISIBLE, never sized from a document-tall box.
async function expectPinnedToViewport(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".uatu-outline")!;
    const rect = element.getBoundingClientRect();
    return { top: rect.top, height: rect.height, viewportHeight: window.innerHeight };
  });
  // Before the fix this read 12,395px on iPad and 57,220px on iPhone.
  expect(geometry.height).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.top + geometry.height).toBeLessThanOrEqual(geometry.viewportHeight + 1);
}

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("phone width resolves to the sheet", () => {
  // iPhone 13 Pro portrait, the viewport the 114px column was measured on.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await boot(page, request);
    await openFixtureDoc(page);
  });

  test("opening the outline leaves the document's text column untouched", async ({ page }) => {
    const closed = await textColumnWidth(page);

    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    // The headline assertion. Before this change the same measurement went
    // from 315px to 114px, and the document rendered 2.5x taller for it.
    expect(await textColumnWidth(page)).toBe(closed);
    await expectPinnedToViewport(page);
  });

  test("selecting a heading jumps to it and dismisses the sheet", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    // 44px rows mean the sheet seats about fifteen entries, so a mid-document
    // heading sits on the list's clip boundary and has to be scrolled to —
    // exactly as a reader would. Without this the click lands on the neighbour
    // that is painted at the target's coordinates.
    const entry = page.locator(".uatu-outline-link", { hasText: "Section 12" });
    await entry.scrollIntoViewIfNeeded();
    await entry.click();

    // aria-pressed, not visibility: the tab-scoped CSS can hide the panel too,
    // so asserting on visibility alone could pass without the sheet having
    // been dismissed at all.
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "false");

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await settleScroll(page);
    const geometry = await page.evaluate(() => {
      const heading = [...document.querySelectorAll("#preview h2")].find(element =>
        element.textContent?.includes("Section 12"),
      );
      const header = document.querySelector(".preview-header");
      if (!heading || !header) return null;
      return {
        headingTop: heading.getBoundingClientRect().top,
        headerBottom: header.getBoundingClientRect().bottom,
      };
    });
    expect(geometry).not.toBeNull();
    // Landed, and landed clear of the sticky header rather than under it.
    expect(geometry!.headingTop).toBeGreaterThanOrEqual(geometry!.headerBottom);
    expect(geometry!.headingTop).toBeLessThan(geometry!.headerBottom + 120);
  });

  test("opening another document dismisses the sheet", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    // Via the Files tab, because an open sheet covers the preview by design —
    // an in-preview link is genuinely unclickable while it is showing, which is
    // the modality working rather than a defect.
    //
    // The tab route is still a real assertion: `aria-pressed` reflects the
    // module's own open state, which `setOpen` writes. The tab-scoped CSS can
    // hide the panel, but it cannot touch this attribute — so a pass here means
    // the dismissal ran, not that something merely became invisible.
    await page.locator("#touch-tab-files").click();
    await treeRow(page, "outline-two.md").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await expect(page.locator("#preview-title")).toHaveText("Second Fixture");

    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("a live remount of the same document does not dismiss the sheet", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "true");

    // The guard on the dismissal rule: a watched file changing re-renders the
    // SAME document, which must not be mistaken for opening a different one.
    await fs.writeFile(
      workspacePath("outline-doc.md"),
      `${OUTLINE_DOC}\n\n## Appended Section\n\nNew prose.\n`,
      "utf8",
    );
    await expect(page.locator(".uatu-outline-link", { hasText: "Appended Section" })).toHaveCount(1);

    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("the filter is not focused on open, and still focuses when tapped", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    // Focusing it would raise the iOS software keyboard over the very list the
    // panel was opened to read.
    expect(await page.evaluate(() => document.activeElement?.className ?? "")).not.toContain(
      "uatu-outline-filter",
    );

    await page.locator(".uatu-outline-filter").click();
    expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain(
      "uatu-outline-filter",
    );
  });

  test("heading rows and the close control meet the 44px touch target", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    const rowHeight = await page
      .locator(".uatu-outline-link")
      .first()
      .evaluate(element => element.getBoundingClientRect().height);
    expect(rowHeight).toBeGreaterThanOrEqual(44);

    const close = await page
      .locator(".uatu-outline-close")
      .evaluate(element => element.getBoundingClientRect());
    expect(close.width).toBeGreaterThanOrEqual(44);
    expect(close.height).toBeGreaterThanOrEqual(44);
  });

  test("the find bar opens ON TOP of the sheet, not behind it", async ({ page }) => {
    // The sheet is a stacking neighbour of the preview find bar
    // (`.find-slot`, z-index 4), which lives inside `.preview-shell`. An
    // earlier revision gave the sheet z-index 35 to outrank the touch Files
    // and Terminal surfaces — an overlap that cannot occur, since the sheet is
    // `display: none` off the Preview tab — and the cost was that ⌘F opened
    // the find bar invisibly underneath it while still swallowing the
    // keystroke, leaving no affordance at all.
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator("#find-query")).toBeVisible();

    const stacking = await page.evaluate(() => {
      // `.find-bar-inner`, not `#find-bar`: the outer element is a zero-height
      // wrapper inside the zero-height sticky slot, so hit-testing its centre
      // samples a point the bar does not occupy and reports whatever is
      // painted behind it.
      const bar = document.querySelector<HTMLElement>(".find-bar-inner")!;
      const box = bar.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        // Named so a failure says WHAT is covering the bar, not just "false".
        topmost: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "none",
        coveredByOutline: hit ? !!hit.closest(".uatu-outline") : false,
        barHeight: box.height,
      };
    });
    // Guards the hit-test itself: a zero-height box would make the assertion
    // below pass or fail for reasons unrelated to stacking.
    expect(stacking.barHeight).toBeGreaterThan(0);
    expect(stacking.coveredByOutline).toBe(false);
  });

  test("the sheet renders no resize handle", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");
    await expect(page.locator(".uatu-outline-resizer")).toBeHidden();
  });

  test("opening partway through a document reveals the active entry", async ({ page }) => {
    // Put a late heading in the trigger zone so the spy marks it active.
    await page.evaluate(async () => {
      const find = () =>
        [...document.querySelectorAll("#preview h2")].find(element =>
          element.textContent?.includes("Section 18"),
        );
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const top = find()!.getBoundingClientRect().top;
        if (Math.abs(top - 8) <= 2) return;
        window.scrollTo({ top: window.scrollY + top - 8 });
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      }
    });
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    const visible = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".uatu-outline-list")!;
      const active = list.querySelector<HTMLElement>(".uatu-outline-link.is-active");
      if (!active) return null;
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      return {
        label: active.textContent,
        within: activeRect.top >= listRect.top - 1 && activeRect.bottom <= listRect.bottom + 1,
        listScrollTop: list.scrollTop,
      };
    });
    expect(visible).not.toBeNull();
    // The list had to scroll for this to be true — the active entry is far
    // enough down that it starts outside the scrollport.
    expect(visible!.listScrollTop).toBeGreaterThan(0);
    expect(visible!.within).toBe(true);
  });
});

test.describe("tablet width keeps the rail", () => {
  // iPad portrait: coarse pointer, and wide enough for the rail beside a
  // readable column — 470px of prose, measured.
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await boot(page, request);
    await openFixtureDoc(page);
  });

  test("the outline docks and reserves its gutter", async ({ page }) => {
    const closed = await textColumnWidth(page);

    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    // The rail's whole premise: the document reflows beside it. Narrower than
    // closed, but still a readable column rather than the phone's 114px.
    const open = await textColumnWidth(page);
    expect(open).toBeLessThan(closed);
    expect(open).toBeGreaterThan(380);
  });

  test("selecting a heading leaves the rail open", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    await page.locator(".uatu-outline-link", { hasText: "Section 12" }).click();

    // The rail sits beside the document, so it stays — the sheet's dismissal
    // rule must not have leaked into the presentation that does not need it.
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("opening another document leaves the rail open", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    await page.locator("#preview a", { hasText: "Onward to the second fixture" }).click();
    await expect(page.locator("#preview-title")).toHaveText("Second Fixture");

    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("touch targets hold in the rail too", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    // Gated on the pointer, not the presentation: an iPad showing the rail
    // still has no cursor.
    const rowHeight = await page
      .locator(".uatu-outline-link")
      .first()
      .evaluate(element => element.getBoundingClientRect().height);
    expect(rowHeight).toBeGreaterThanOrEqual(44);
  });

  test("the rail stays pinned to the visible area as the document scrolls", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");
    await expectPinnedToViewport(page);

    // #231's symptom, and the reason iPad looked wrong while desktop looked
    // fine: the rail was sized from a shell that is document-tall in touch
    // mode, so scrolling carried the panel off the top of the screen and left
    // its empty lower reaches behind.
    await page.evaluate(() => window.scrollTo(0, 2200));
    await settleScroll(page);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

    await expectPinnedToViewport(page);

    // ...and the dismissal the panel used to cover is reachable again. This is
    // the assertion that made #231 a trap rather than a cosmetic complaint.
    const toggleCovered = await page.evaluate(() => {
      const toggle = document.querySelector<HTMLElement>("#outline-toggle")!;
      const box = toggle.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !(hit === toggle || toggle.contains(hit));
    });
    expect(toggleCovered).toBe(false);

    await page.locator("#outline-toggle").click();
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("a stored width from a bigger display is capped to protect the reading column", async ({
    page,
  }) => {
    // The presentation rule asks about the rail's DEFAULT footprint so that
    // dragging never flips it mid-drag — which leaves a stored width free to
    // break the same promise from the other side. A 500px rail saved on a
    // desktop would otherwise be reapplied verbatim here and leave ~270px of
    // prose on an 834px tablet.
    await page.evaluate(() => {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index)!;
        if (key.endsWith("uatu:outline-width")) {
          window.localStorage.setItem(key, "500");
          return;
        }
      }
      // No key yet on a fresh profile — write one under the same namespace the
      // app uses, resolved from any existing presentation-scoped key.
      window.localStorage.setItem("uatu:presentation:v1:%2F:uatu:outline-width", "500");
    });
    await page.reload();
    await waitForPreviewToSettle(page);
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    const panelWidth = await page
      .locator(".uatu-outline")
      .evaluate(element => element.getBoundingClientRect().width);
    expect(panelWidth).toBeLessThan(500);
    // The promise the whole change rests on, restated as an assertion.
    expect(await textColumnWidth(page)).toBeGreaterThanOrEqual(380);
  });

  test("the rail keeps its resize handle", async ({ page }) => {
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");
    await expect(page.locator(".uatu-outline-resizer")).toBeVisible();
  });
});

test.describe("desktop stacking against the sheet", () => {
  // Desktop, fine pointer. Right-docking the terminal narrows the preview from
  // 954px to 590px, which resolves to the sheet — the case where the sheet has
  // desktop chrome to coexist with rather than a tab bar.
  test.use({ viewport: { width: 1280, height: 720 } });

  test("a fullscreen terminal comes up over the sheet", async ({ page, request }) => {
    await boot(page, request);
    await treeRow(page, "outline-doc.md").click();
    await expect(page.locator("#preview-title")).toHaveText("Outline Fixture");

    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");

    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    // The terminal's fullscreen layer is z-index 5. While the sheet sat at 35
    // it stayed underneath, so entering fullscreen looked like it did nothing.
    await page.locator("#terminal-fullscreen").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "fullscreen");

    const terminalOnTop = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("#terminal-panel")!;
      const box = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return panel.contains(hit) || hit === panel;
    });
    expect(terminalOnTop).toBe(true);
  });
});

test.describe("crossing the threshold", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("an open panel swaps presentation on resize and stays open", async ({ page, request }) => {
    await boot(page, request);
    await openFixtureDoc(page);

    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");

    // Widen past the threshold with the panel open.
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "true");
    await expectPresentation(page, "rail");

    // ...and back. The panel survives both crossings rather than closing.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "true");
    await expectPresentation(page, "sheet");
  });

  test("a document change while Preview is hidden is judged on current width, not stale state", async ({
    page,
    request,
  }) => {
    // The preview shell is `display: none` whenever another touch tab is
    // active, so it measures 0 wide — and `refreshOutline()` still runs there,
    // because a follow-mode file event switches documents without bringing
    // Preview forward. An earlier revision answered that unmeasurable moment
    // with the last resolved presentation, which goes stale the instant the
    // width changes while hidden. This is that sequence.
    await boot(page, request);

    // Start wide, so the RAIL is what is open and the stale value would be
    // "rail" — the value that suppresses the sheet's dismissal rule.
    await page.setViewportSize({ width: 834, height: 1112 });
    await openFixtureDoc(page);
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    // Follow on, from the Files surface that owns the chip.
    await page.locator("#touch-tab-files").click();
    const follow = page.locator("#follow-toggle");
    if ((await follow.getAttribute("aria-pressed")) !== "true") {
      await follow.click();
    }
    await expect(follow).toHaveAttribute("aria-pressed", "true");

    // Narrow to phone width while the shell is hidden and unmeasurable.
    await page.setViewportSize({ width: 390, height: 844 });

    // A watched-file event switches the document and deliberately does NOT
    // steal the Files tab, so the outline is refreshed against a hidden shell.
    await fs.writeFile(
      workspacePath("outline-two.md"),
      `${OUTLINE_DOC_TWO}\n\nFollowed while browsing files.\n`,
      "utf8",
    );
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");

    await page.locator("#touch-tab-preview").click();
    await expect(page.locator("#preview-title")).toHaveText("Second Fixture");

    // Phone width means a sheet, and the document changed — so it must not be
    // left covering a document the user never opened it on. Asserted before
    // reopening, because a dismissed panel has no presentation to measure.
    await expect(page.locator("#outline-toggle")).toHaveAttribute("aria-pressed", "false");

    // And the width that drove that decision really is sheet-width: had the
    // stale "rail" been used, the dismissal above would have been skipped.
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "sheet");
  });

  test("returning to the rail restores the width chosen before the sheet", async ({ page, request }) => {
    await boot(page, request);
    await openFixtureDoc(page);
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.locator("#outline-toggle").click();
    await expectPresentation(page, "rail");

    // Drag the rail wider, then read back what actually took effect.
    const handle = page.locator(".uatu-outline-resizer");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y + 120, { steps: 8 });
    await page.mouse.up();
    const resized = await page
      .locator(".uatu-outline")
      .evaluate(element => Math.round(element.getBoundingClientRect().width));
    expect(resized).toBeGreaterThan(288);

    // Into the sheet, where the stored width has no meaning, and back out.
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPresentation(page, "sheet");
    await page.setViewportSize({ width: 900, height: 1000 });
    await expectPresentation(page, "rail");

    const restored = await page
      .locator(".uatu-outline")
      .evaluate(element => Math.round(element.getBoundingClientRect().width));
    expect(Math.abs(restored - resized)).toBeLessThanOrEqual(2);
  });
});
