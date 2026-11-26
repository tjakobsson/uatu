// Media zoom: the shared fullscreen viewer (src/zoom/viewer.ts) and inline
// zoom (src/zoom/inline.ts) on the preview's real surfaces — the image file
// preview, images in rendered documents, and Mermaid diagrams.
//
// Viewer: deliberate dismissal only, focus return, raster actual pixels and
// pixelation, vector redraw at the committed scale, and inert SVG.
// Inline, desktop: the overlay toolbar on hover and focus, toolbar zoom and
// drag pan, no layout shift, no wheel handling, and when a click opens the
// viewer. Inline, touch: pinch zooms the media and never the page, one finger
// scrolls the page at fit and pans once zoomed.

import { promises as fs } from "node:fs";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { e2ePort, workspacePath } from "./config";
import { captureScreenshot } from "./evidence";
import { expect, standardBeforeEach, test } from "./fixtures";
import { openTreeFile } from "./tree-helpers";
import {
  expectStageTransform,
  expectTransformClose as expectClose,
  expectTransformMatches,
  readInlineTransform,
  readStageScale,
  readStageTransform,
  type StageTransform,
} from "./transform-helpers";
import { afterAnimationFrames } from "./sync-helpers";
import { DOUBLE_TAP_MAX_GAP_MS } from "../../src/zoom/gestures";
import {
  backdropPoint,
  centreOf,
  checkerboardPng as png,
  expectViewerClosed,
  expectViewerControlsVisible,
  expectViewerOpen,
  mouseDrag,
  pinch,
  recordWheels,
  touchDrag,
  viewerDialog,
} from "./media-viewer-helpers";

// --- Fixtures ---------------------------------------------------------------

// PNGs are seeded through the reset's binary extras (see WorkspaceSeed).
const pngCache = new Map<string, Buffer>();
const cachedPng = (width: number, height: number) => {
  const key = `${width}x${height}`;
  if (!pngCache.has(key)) pngCache.set(key, png(width, height));
  return pngCache.get(key)!;
};

const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500" viewBox="0 0 1000 500">' +
  '<rect width="1000" height="500" fill="#e8eefc"/><path d="M0 0 L1000 500" stroke="#123" stroke-width="2"/>' +
  '<text x="20" y="40" font-size="24">Wide figure</text></svg>';

const BADGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2a7"/></svg>';

// Every way an SVG can run script when it is a document: a <script> element
// and an event-handler attribute. As an <img> neither may run.
const SCRIPT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" ' +
  'onload="top.__svgScriptRan = (top.__svgScriptRan || 0) + 1">' +
  "<script>top.__svgScriptRan = (top.__svgScriptRan || 0) + 1;</script>" +
  '<rect width="200" height="100" fill="teal"/></svg>';

const TRAILING = Array.from({ length: 40 }, (_, i) => `Trailing paragraph ${i}.`).join("\n\n");

const MEDIA_DOC = [
  "# Media",
  "Intro paragraph.",
  "![photo](./photo.png)",
  "After the photo.",
  "![figure](./wide.svg)",
  "After the figure.",
  "See [the target](./target.md) before the diagram.",
  "```mermaid\ngraph TD\n  Watch --> Preview\n  Preview --> Browser\n```",
  "After the diagram.",
  "[![linked photo](./photo.png)](./target.md)",
  "After the linked photo.",
  "![badge](./badge.svg)",
  "After the badge.",
  TRAILING,
].join("\n\n");

// SVGs with only a viewBox have no natural width: unframed, the image fills
// its containing block (and in the file preview, its height cap).
const viewBoxSvg = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
  `<rect width="${width}" height="${height}" fill="#e8eefc"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#123"/></svg>`;

const VIEWBOX_DOC = ["# ViewBox", "Intro paragraph.", "![viewbox figure](./viewbox.svg)", "After the viewBox figure.", TRAILING].join("\n\n");

// Media rendered under 96 CSS px on a side: a wide, short diagram and a badge.
const SMALL_DOC = ["# Small", "```mermaid\ngraph LR\n  A --> B\n```", "After the small diagram.", "![badge](./badge.svg)", "After the badge."].join("\n\n");

// Images sized as a percentage of their containing block, as README authors
// write them: plain, centred, and inside a link.
const PERCENT_DOC = [
  "# Percent",
  "Intro paragraph.",
  '<img src="./photo.png" width="50%" alt="half photo">',
  "After the half photo.",
  '<p align="center"><img src="./photo.png" width="30%" alt="centred photo"></p>',
  "After the centred photo.",
  '<a href="./target.md"><img src="./photo.png" width="40%" alt="linked photo"></a>',
  "After the linked photo.",
  TRAILING,
].join("\n\n");

const DIAGRAM_A = "```mermaid\ngraph TD\n  Alpha[Alpha source] --> Beta[Beta target]\n  Alpha --> Gamma[Gamma side]\n```";
const DIAGRAM_B = "```mermaid\ngraph TD\n  Gamma --> Delta\n  Delta --> Epsilon\n```";
const DIAGRAM_C = "```mermaid\ngraph LR\n  Zeta --> Eta\n```";
const diagramsDoc = (...diagrams: string[]) => ["# Diagrams", ...diagrams.flatMap((d, i) => [d, `After diagram ${i}.`])].join("\n\n");

// Responsive images: the browser picks the <source> (wide-photo.png) over
// the <img>'s own src, plain and as the only content of a link.
const PICTURE_SOURCE = '<source srcset="./wide-photo.png" media="(min-width: 1px)">';
const PICTURE_DOC = [
  "# Picture",
  "Intro paragraph.",
  `<picture>${PICTURE_SOURCE}<img src="./photo.png" alt="responsive photo"></picture>`,
  "After the responsive photo.",
  `<a href="./target.md"><picture>${PICTURE_SOURCE}<img src="./photo.png" alt="linked responsive photo"></picture></a>`,
  "After the linked responsive photo.",
].join("\n\n");

// The browser picks a candidate by its density descriptor (1x at the
// default device pixel ratio).
const DENSITY_PICTURE_DOC = PICTURE_DOC.replace(PICTURE_SOURCE, PICTURE_SOURCE.replace('"./wide-photo.png"', '"./wide-photo.png 1x, ./other-wide-photo.png 2x"'));

const EXTRAS = {
  "diagrams.md": diagramsDoc(DIAGRAM_A, DIAGRAM_B),
  "viewbox.svg": viewBoxSvg(400, 200),
  "tall-viewbox.svg": viewBoxSvg(100, 400),
  "viewbox.md": VIEWBOX_DOC,
  "wide.svg": WIDE_SVG,
  "badge.svg": BADGE_SVG,
  "script.svg": SCRIPT_SVG,
  "media.md": MEDIA_DOC,
  "small.md": SMALL_DOC,
  "percent.md": PERCENT_DOC,
  // A linked image that shares its link with text stays a plain link.
  "mixed-link.md": "# Mixed\n\nIntro paragraph.\n\n[![captioned photo](./photo.png) The photo's caption](./target.md)\n\nAfter the captioned photo.\n",
  // An image just above the small-media limit: its toolbar has the least room.
  "square.md": "# Square\n\nIntro paragraph.\n\n![square](./square.png)\n\nAfter the square.\n",
  "target.md": "# Target\n\nThe linked document.\n",

  "picture.md": PICTURE_DOC,
  // A diagram the reader can scroll far past (beyond the lazy render margin).
  "far-diagram.md": ["# Far", DIAGRAM_A, "After the far diagram.", TRAILING, TRAILING, TRAILING].join("\n\n"),
};

// The PNGs most suites need: the photo documents embed, an image just above
// the small-media limit, the source a responsive image picks and one an edit
// can swap in, and a PNG with no extension (like a GitHub attachment URL).
const MEDIA_PNGS: Record<string, [number, number]> = {
  "photo.png": [640, 480],
  "square.png": [100, 100],
  "wide-photo.png": [800, 400],
  "other-wide-photo.png": [800, 400],
  shot: [640, 480],
};

// Images on another origin: the same workspace through another host name.
// `shot` is a PNG of unknown format there, `photo.png` a known one.
const foreignDoc = () => {
  const origin = `http://localhost:${e2ePort()}`;
  return `# Foreign\n\n![unknown format](${origin}/shot)\n\nBetween.\n\n![foreign png](${origin}/photo.png)\n\nAfter.\n`;
};

// Fixtures only the desktop inline suite opens, seeded there alone. Added to
// the shared set, they push late rows (wide.svg) out of the touch Files tab's
// first rendered window, and the touch suites' row then opens as "File
// unavailable" (seen with 35 files; not yet diagnosed).
const desktopExtras = () => ({
  // Narrow media that can be scrolled to the top of the view.
  "long-square.md": `# Square\n\nIntro paragraph.\n\n![square](./square.png)\n\n${TRAILING}\n`,
  "foreign.md": foreignDoc(),
  // A linked image its author took out of the tab order.
  "untabbed.md": '# Untabbed\n\nSee [the target](./target.md) first.\n\n<a href="./target.md" tabindex="-1"><img src="./photo.png" alt="untabbed photo"></a>\n\nAfter the untabbed photo.\n',
  // An image under the small-media limit whose `hspace` margins widen its box.
  "spaced.md": '# Spaced\n\nIntro paragraph.\n\n<img src="./photo.png" width="80" height="120" hspace="20" alt="spaced photo">\n\nAfter the spaced photo.\n',
  // A zoomable image whose `hspace` margins lie inside its frame at fit.
  "margined.md": '# Margined\n\nIntro paragraph.\n\n<img src="./photo.png" width="320" height="240" hspace="24" alt="margined photo">\n\nAfter the margined photo.\n',
  // A raster <source> for narrow viewports over an SVG fallback, which
  // svg-images suspends off-screen.
  "svg-fallback-picture.md": `# SVG fallback picture\n\n<picture><source srcset="./photo.png" media="(max-width: 1000px)"><img src="./wide.svg" alt="svg fallback photo"></picture>\n\n${TRAILING}\n`,
  "density-picture.md": DENSITY_PICTURE_DOC,
  // A responsive image whose picked source is an SVG in a wide window and its
  // PNG fallback in a narrower one.
  "mixed-picture.md": '# Mixed picture\n\nIntro paragraph.\n\n<picture><source srcset="./wide.svg" media="(min-width: 1000px)"><img src="./photo.png" alt="mixed photo"></picture>\n\nAfter the mixed photo.\n',
});

// The shared baseline (standardBeforeEach), with this file's fixtures, the
// PNGs a test needs and any further text files. Follow ends off, so later
// writes cannot move the selection.
async function seed(
  page: Page,
  request: APIRequestContext,
  pngs: Record<string, [number, number]> = MEDIA_PNGS,
  extras: Record<string, string> = {},
): Promise<void> {
  const files = Object.fromEntries(Object.entries(pngs).map(([name, [width, height]]) => [name, cachedPng(width, height)]));
  await standardBeforeEach(page, request, { extras: { ...EXTRAS, ...extras }, files });
}

// --- Helpers ------------------------------------------------------------------

async function openDiagramViewer(page: Page): Promise<StageTransform> {
  await openTreeFile(page, "diagram.md");
  await page.locator("#preview .mermaid-trigger").click();
  return expectViewerOpen(page);
}

const FIT: StageTransform = { tx: 0, ty: 0, scale: 1 };

// The frame has its rendered size: an image has loaded, a diagram rendered.
async function expectLaidOut(frame: Locator, min = 96): Promise<void> {
  await frame.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const box = await frame.boundingBox();
      return box !== null && box.width >= min && box.height >= min;
    })
    .toBe(true);
}

// A diagram is framed only once it renders, which waits for its pending slot
// to approach the viewport: bring the slot there first.
async function revealDiagram(page: Page): Promise<void> {
  await page.locator("#preview .mermaid").first().scrollIntoViewIfNeeded();
}

async function hoverToolbarButton(frame: Locator, name: string): Promise<Locator> {
  await frame.hover();
  const button = frame.locator(".media-zoom-toolbar").getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  return button;
}

async function zoomInline(frame: Locator, label: "Zoom in" | "Zoom out" | "Fit", times = 1): Promise<StageTransform> {
  for (let i = 0; i < times; i += 1) {
    await (await hoverToolbarButton(frame, label)).click();
  }
  return (await readInlineTransform(frame))!;
}

type Rect = { x: number; y: number; width: number; height: number };

// Rectangles relative to #preview, so a scroll between readings does not
// count as movement.
async function layoutOf(page: Page, frameSelector: string, nextText: string | null, unwrap = false) {
  return page.evaluate(
    ({ frameSelector, nextText, unwrap }) => {
      const preview = document.querySelector("#preview")!.getBoundingClientRect();
      const relative = (element: Element): Rect => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left - preview.left, y: rect.top - preview.top, width: rect.width, height: rect.height };
      };
      const frame = document.querySelector(frameSelector)!;
      let media: Element = frame;
      if (unwrap) {
        // The same document without the integration: the activator back in
        // the frame's place, no frame, no toolbar.
        const activator = frame.querySelector(":scope > .media-zoom-clip > .media-zoom-activator")!;
        frame.replaceWith(activator);
        media = activator.matches(".media-zoom-stage") ? activator : activator.querySelector(".media-zoom-stage")!;
      }
      const next = nextText
        ? Array.from(document.querySelectorAll("#preview p")).find(p => p.textContent?.trim() === nextText) ?? null
        : null;
      return { media: relative(media), next: next ? relative(next) : null };
    },
    { frameSelector, nextText, unwrap },
  );
}

function expectSameLayout(actual: { media: Rect; next: Rect | null }, expected: { media: Rect; next: Rect | null }): void {
  for (const key of ["media", "next"] as const) {
    const a = actual[key];
    const e = expected[key];
    if (!e) {
      expect(a).toBeNull();
      continue;
    }
    for (const side of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(a![side] - e[side]), `${key}.${side}: ${a![side]} vs ${e[side]}`).toBeLessThan(0.02);
    }
  }
}

// Narrow media's inline controls lie beside its box, never over it, and
// inside the visible window, so they hide none of the media and stay in reach.
async function expectControlsBeside(frame: Locator, names: string[]): Promise<void> {
  const box = (await frame.boundingBox())!;
  const window = await frame.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (const name of names) {
    const button = frame.locator(".media-zoom-toolbar").getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const b = (await button.boundingBox())!;
    const overlaps = b.x < box.x + box.width - 0.5 && b.x + b.width > box.x + 0.5 && b.y < box.y + box.height - 0.5 && b.y + b.height > box.y + 0.5;
    expect(overlaps, `${name} at ${JSON.stringify(b)} over ${JSON.stringify(box)}`).toBe(false);
    const visible = b.x >= 0 && b.y >= 0 && b.x + b.width <= window.width && b.y + b.height <= window.height;
    expect(visible, `${name} at ${JSON.stringify(b)} in ${JSON.stringify(window)}`).toBe(true);
  }
}

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

// --- The viewer ----------------------------------------------------------------

test.describe("media viewer dismissal", () => {
  test.beforeEach(async ({ page, request }) => {
    await standardBeforeEach(page, request);
  });

  test("a click on the empty backdrop closes the viewer", async ({ page }) => {
    await openDiagramViewer(page);
    const point = await backdropPoint(page);
    await page.mouse.click(point.x, point.y);
    await expectViewerClosed(page);
  });

  test("a mouse drag that starts on the backdrop does not close the viewer", async ({ page }) => {
    await openDiagramViewer(page);
    const point = await backdropPoint(page);
    await mouseDrag(page, point, 120, 80);
    // The drag panned the diagram, and the viewer is still open.
    expect(await readStageTransform(page)).not.toBeNull();
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });

  test("a slow, short mouse drag that starts and ends on the backdrop does not close the viewer", async ({ page }) => {
    await openDiagramViewer(page);
    const point = await backdropPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    // Ten 1px moves, each a frame apart: within a finger's tap slop, but a drag.
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(point.x + step, point.y);
      await afterAnimationFrames(page);
    }
    await page.mouse.up();
    await afterAnimationFrames(page);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });

  test("a double-click on the backdrop after panning fits the media and keeps the viewer open", async ({ page }) => {
    const fitted = await openDiagramViewer(page);
    const centre = await centreOf(page.locator(".media-viewer-stage"));
    await mouseDrag(page, centre, 0, -600);
    // Below the media, which the drag moved up and almost out of view.
    const viewport = (await page.locator(".media-viewer-viewport").boundingBox())!;
    await page.mouse.dblclick(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await expectStageTransform(page, fitted);
    // Well past the double-click interval, it is still open.
    await page.waitForTimeout(DOUBLE_TAP_MAX_GAP_MS * 2);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });

  test("a click on the media does not close the viewer", async ({ page }) => {
    await openDiagramViewer(page);
    const centre = await centreOf(page.locator(".media-viewer-stage"));
    await page.mouse.click(centre.x, centre.y);
    await afterAnimationFrames(page);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });

  test("Escape and the close control both return focus to the opener", async ({ page }) => {
    await openDiagramViewer(page);
    await page.keyboard.press("Escape");
    await expectViewerClosed(page);
    await expect(page.locator("#preview .mermaid-trigger")).toBeFocused();

    await page.locator("#preview .mermaid-trigger").click();
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await page.locator(".media-viewer-close").click();
    await expectViewerClosed(page);
    await expect(page.locator("#preview .mermaid-trigger")).toBeFocused();
  });
});

test.describe("media viewer dismissal on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await seed(page, request, {});
    await openTouchFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    await frame.tap();
    await expectViewerOpen(page);
  });

  test("a tap on the empty backdrop closes the viewer", async ({ page }) => {
    const point = await backdropPoint(page);
    await page.touchscreen.tap(point.x, point.y);
    await expectViewerClosed(page);
  });

  test("the tap that closes the viewer from its backdrop reaches nothing beneath it", async ({ page }) => {
    // Every click that lands on the page rather than in the viewer.
    await page.evaluate(() => {
      const clicks: string[] = ((window as any).__pageClicks = []);
      document.addEventListener("click", event => {
        const target = event.target as Element;
        if (!target.closest("dialog.media-viewer")) clicks.push(target.tagName);
      }, true);
    });
    const point = await backdropPoint(page);
    await page.touchscreen.tap(point.x, point.y);
    await expectViewerClosed(page);
    await afterAnimationFrames(page, 4);
    expect(await page.evaluate(() => (window as any).__pageClicks)).toEqual([]);
    await expectViewerClosed(page);
  });

  test("a viewer opened straight after it closed shows its media", async ({ page }) => {
    // Close and open again in one task, as a tap whose follow-up click lands
    // on media would, before the dialog's queued close event is dispatched.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(".media-viewer-close")!.click();
      const activator = document.querySelector<HTMLElement>("#preview .image-preview .media-zoom-activator")!;
      activator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await expectViewerOpen(page);
    await afterAnimationFrames(page, 4);
    await expect(page.locator(".media-viewer-stage img")).toHaveCount(1);
    await expect(page.locator(".media-viewer-stage")).toHaveAttribute("data-zoom-state", /./);
  });

  test("opened by a tap, the close control has focus without a ring until a key is pressed", async ({ page }) => {
    const close = page.locator(".media-viewer-close");
    await expect(close).toBeFocused();
    expect(await close.evaluate(el => getComputedStyle(el).outlineStyle)).toBe("none");
    await page.keyboard.press("Shift+Tab");
    const focused = page.locator(".media-viewer-toolbar button:focus");
    expect(await focused.evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("a tap on the media does not close the viewer", async ({ page }) => {
    const centre = await centreOf(page.locator(".media-viewer-stage"));
    await page.touchscreen.tap(centre.x, centre.y);
    await afterAnimationFrames(page);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });

  test("a one-finger drag that starts on the backdrop does not close the viewer", async ({ page }) => {
    const point = await backdropPoint(page);
    const cdp = await page.context().newCDPSession(page);
    await touchDrag(cdp, point, 60, 150);
    expect(await readStageTransform(page)).not.toBeNull();
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });
});

test.describe("the media viewer on a pinch-zoomed page", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("fills the visible viewport, not the larger layout viewport, and keeps every control in it", async ({ page, request }) => {
    await seed(page, request, {});
    await openTouchFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    // The reader has pinch-zoomed the page: the visible area is a quarter of
    // the layout viewport, scrolled away from its origin.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await expect.poll(() => pageScale(page)).toBe(2);
    await touchDrag(cdp, { x: 150, y: 300 }, -80, -120);
    await expect.poll(() => page.evaluate(() => visualViewport!.offsetTop > 0 || visualViewport!.offsetLeft > 0)).toBe(true);

    await frame.locator(".media-zoom-activator").focus();
    await page.keyboard.press("Enter");
    await expectViewerOpen(page);
    const layout = await page.evaluate(() => {
      const vv = window.visualViewport!;
      const dialog = document.querySelector("dialog.media-viewer")!.getBoundingClientRect();
      return {
        visible: { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height },
        dialog: { left: dialog.left, top: dialog.top, right: dialog.right, bottom: dialog.bottom },
      };
    });
    for (const side of ["left", "top", "right", "bottom"] as const) {
      expect(Math.abs(layout.dialog[side] - layout.visible[side]), `dialog ${side}`).toBeLessThan(1);
    }
    await expectViewerControlsVisible(page);
  });
});

test.describe("the media viewer on a narrow touch screen", () => {
  test.use({ viewport: { width: 320, height: 844 }, hasTouch: true, isMobile: true });

  test("a linked raster image's six controls stay inside the visible viewport", async ({ page, request }, testInfo) => {
    await seed(page, request);
    await openTouchFile(page, "media.md");
    const linked = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > img[alt="linked photo"])');
    await expectLaidOut(linked);
    await linked.tap();
    await expectViewerOpen(page);
    await expect(page.locator(".media-viewer-toolbar button")).toHaveCount(6);
    await expectViewerControlsVisible(page);
    await captureScreenshot(page, testInfo, "media-zoom-viewer-touch");
  });
});

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`raster media at device pixel ratio ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });

    test("a 3000×2000 PNG reaches 1:1 actual pixels and renders pixelated above native size", async ({ page, request }, testInfo) => {
      await seed(page, request, { "screenshot.png": [3000, 2000] });
      await openTreeFile(page, "screenshot.png");
      const frame = page.locator("#preview .image-preview .media-zoom-frame");
      await expectLaidOut(frame);
      await frame.click();
      await expectViewerOpen(page);

      const image = page.locator(".media-viewer-stage img");
      const rendering = () => image.evaluate(el => getComputedStyle(el).imageRendering);
      // Fitted, the image is shown below native size: smoothed.
      expect(await readStageScale(page)).toBeLessThan(1 / deviceScaleFactor);
      expect(await rendering()).not.toBe("pixelated");

      await page.locator('.media-viewer-toolbar [aria-label="1:1 actual pixels"]').click();
      await readStageTransform(page);
      const devicePixels = await image.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { width: rect.width * devicePixelRatio, height: rect.height * devicePixelRatio, dpr: devicePixelRatio };
      });
      expect(devicePixels.dpr).toBe(deviceScaleFactor);
      expect(Math.abs(devicePixels.width - 3000)).toBeLessThan(0.5);
      expect(Math.abs(devicePixels.height - 2000)).toBeLessThan(0.5);
      if (deviceScaleFactor === 1) await captureScreenshot(page, testInfo, "media-zoom-viewer-raster-actual-pixels");

      // One step above native size: sharp pixel blocks.
      await page.locator('.media-viewer-toolbar [aria-label="Zoom in"]').click();
      await readStageTransform(page);
      expect(await rendering()).toBe("pixelated");
      if (deviceScaleFactor === 1) await captureScreenshot(page, testInfo, "media-zoom-viewer-raster-pixelated");
    });

    test("a raster at fit stays smooth, inline and in the viewer, and renders pixelated only once zoomed in past native size", async ({ page, request }) => {
      await seed(page, request);
      await openTreeFile(page, "media.md");
      const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="photo"])');
      await expectLaidOut(frame);
      const image = frame.locator("img");
      const pixelated = (target: Locator) => target.evaluate(el => getComputedStyle(el).imageRendering === "pixelated");
      // The 640px photo at fit covers more device pixels than it has on a 2×
      // screen, and is still smooth there.
      const width = await image.evaluate(el => el.getBoundingClientRect().width);
      expect(width * deviceScaleFactor > 640.5).toBe(deviceScaleFactor === 2);
      expect(await pixelated(image)).toBe(false);
      // One step in: 1.25× the fit width, past 640 device pixels either way.
      await zoomInline(frame, "Zoom in");
      expect(width * 1.25 * deviceScaleFactor).toBeGreaterThan(640.5);
      await expect.poll(() => pixelated(image)).toBe(true);
      await zoomInline(frame, "Fit");
      await expect.poll(() => pixelated(image)).toBe(false);

      // The viewer fits the photo above its native size, smooth, until zoomed in.
      await frame.click();
      await expectViewerOpen(page);
      const viewed = page.locator(".media-viewer-stage img");
      const fitted = (await readStageTransform(page))!;
      expect(fitted.scale).toBeGreaterThan(1);
      expect(await pixelated(viewed)).toBe(false);
      await page.locator('.media-viewer-toolbar [aria-label="Zoom in"]').click();
      await expect.poll(async () => (await readStageTransform(page))?.scale ?? 0).toBeGreaterThan(fitted.scale);
      expect(await pixelated(viewed)).toBe(true);
      await page.locator('.media-viewer-toolbar [aria-label="Fit to screen"]').click();
      await expectStageTransform(page, fitted);
      expect(await pixelated(viewed)).toBe(false);
    });
  });
}

test.describe("SVG media in the viewer", () => {
  test.beforeEach(async ({ page, request }) => {
    await seed(page, request, {});
  });

  test("closing returns focus to the expand control that opened the viewer", async ({ page }) => {
    await openTreeFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    for (const dismiss of ["Escape", "close"] as const) {
      const expand = await hoverToolbarButton(frame, "Open fullscreen viewer");
      await expand.click();
      await expectViewerOpen(page);
      if (dismiss === "Escape") await page.keyboard.press("Escape");
      else await page.locator(".media-viewer-close").click();
      await expectViewerClosed(page);
      await expect(expand).toBeFocused();
    }
  });

  test("tall media fits clear of the toolbar, which never covers it", async ({ page }) => {
    await openTreeFile(page, "tall-viewbox.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    await frame.click();
    await expectViewerOpen(page);
    const stage = (await page.locator(".media-viewer-stage").boundingBox())!;
    const toolbar = (await page.locator(".media-viewer-toolbar").boundingBox())!;
    expect(stage.y + stage.height).toBeLessThanOrEqual(toolbar.y + 0.5);
    expect(stage.y).toBeGreaterThanOrEqual(0);
  });

  test("the toolbar shows the zoom level relative to fit, and arrow keys pan", async ({ page }) => {
    await openTreeFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    await frame.locator(".media-zoom-activator").focus();
    await page.keyboard.press("Enter");
    const fitted = await expectViewerOpen(page);
    const level = page.locator(".media-viewer-toolbar .media-viewer-zoom-level");
    await expect(level).toHaveText("100%");
    // Opened from the keyboard, close shows its focus ring.
    expect(await page.locator(".media-viewer-close").evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("+");
    await expect(level).toHaveText("125%");
    await expect(page.locator(".media-viewer-status")).toHaveText("Zoom 125%");
    const zoomed = (await readStageTransform(page))!;
    await page.keyboard.press("ArrowRight");
    await expectStageTransform(page, { ...zoomed, tx: zoomed.tx - 40 });
    await page.keyboard.press("0");
    await expectStageTransform(page, fitted);
  });

  test("media in the viewer has an edge and a shadow, and fit and expand look different in both toolbars", async ({ page }) => {
    await openTreeFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    const glyph = (locator: Locator) => locator.evaluate(el => getComputedStyle(el, "::before").content);
    await frame.hover();
    const inlineFit = await glyph(frame.locator('[data-zoom-action="fit"]'));
    const inlineExpand = await glyph(frame.locator('[data-zoom-action="expand"]'));
    expect(inlineFit).not.toBe(inlineExpand);
    await frame.click();
    await expectViewerOpen(page);
    expect(await glyph(page.locator('.media-viewer-toolbar [aria-label="Fit to screen"]'))).toBe(inlineFit);
    expect(await page.locator(".media-viewer-stage").evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  });

  test("a window resize fits fitted media to the new size and keeps zoomed media's scale", async ({ page }) => {
    await openTreeFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    await frame.click();
    await expectViewerOpen(page);
    // wide.svg is 1000×500; the viewer fits it with a 32px margin.
    await page.setViewportSize({ width: 600, height: 700 });
    await expect.poll(async () => (await readStageTransform(page))?.scale).toBeCloseTo((600 - 32) / 1000, 3);

    await page.keyboard.press("+");
    const zoomed = (await readStageTransform(page))!;
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(async () => (await page.locator(".media-viewer-viewport").boundingBox())?.width).toBe(900);
    expect((await readStageTransform(page))!.scale).toBeCloseTo(zoomed.scale, 3);
  });

  test("an SVG at 6× is laid out at base × scale, not scaled by transform", async ({ page }) => {
    await openTreeFile(page, "wide.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    await frame.click();
    await expectViewerOpen(page);
    await expect(page.locator('.media-viewer-toolbar [aria-label="1:1 actual pixels"]')).toHaveCount(0);

    const zoomIn = page.locator('.media-viewer-toolbar [aria-label="Zoom in"]');
    let scale = await readStageScale(page);
    while (scale < 6) {
      await zoomIn.click();
      scale = await readStageScale(page);
    }
    const layout = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".media-viewer-stage")!;
      const image = stage.querySelector("img")!;
      return {
        stageWidth: stage.offsetWidth,
        imageWidth: image.clientWidth,
        imageHeight: image.clientHeight,
        transform: getComputedStyle(stage).transform,
      };
    });
    expect(Math.abs(layout.stageWidth - 1000 * scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.imageWidth - 1000 * scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.imageHeight - 500 * scale)).toBeLessThanOrEqual(1);
    // At rest only the translation remains: no scale() stretches the bitmap.
    expect(layout.transform).toMatch(/^matrix\(1, 0, 0, 1, /);
  });

  test("an SVG containing a script stays an <img> inline and in the viewer, and its script never runs", async ({ page }) => {
    await openTreeFile(page, "script.svg");
    const frame = page.locator("#preview .image-preview .media-zoom-frame");
    await expectLaidOut(frame);
    await zoomInline(frame, "Zoom in", 2);
    await (await hoverToolbarButton(frame, "Open fullscreen viewer")).click();
    await expectViewerOpen(page);
    await expect.poll(() => page.locator(".media-viewer-stage img").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(200);
    await page.locator('.media-viewer-toolbar [aria-label="Zoom in"]').click();
    await readStageTransform(page);

    const result = await page.evaluate(() => {
      const stage = document.querySelector(".media-viewer-stage")!;
      const inline = document.querySelector("#preview .image-preview .media-zoom-frame")!;
      return {
        stage: Array.from(stage.children).map(child => child.tagName),
        inline: inline.querySelector(".media-zoom-stage")!.tagName,
        embedded: document.querySelectorAll(
          ".media-viewer-stage :is(svg, object, iframe, embed), #preview :is(object, iframe, embed)",
        ).length,
        ran: (window as unknown as { __svgScriptRan?: number }).__svgScriptRan ?? 0,
      };
    });
    expect(result.stage).toEqual(["IMG"]);
    expect(result.inline).toBe("IMG");
    expect(result.embedded).toBe(0);
    expect(result.ran).toBe(0);
  });
});

// --- Inline zoom on desktop ---------------------------------------------------

type Surface = {
  name: string;
  file: string;
  frame: string;
  activator: string;
  // The paragraph after the media, for documents.
  next: string | null;
  // The viewer's image source, for images.
  source: RegExp | null;
  diagram?: boolean;
};

const SURFACES: Surface[] = [
  {
    name: "a PNG file",
    file: "photo.png",
    frame: "#preview .image-preview .media-zoom-frame",
    activator: "#preview .image-preview img",
    next: null,
    source: /\/photo\.png\?revision=/,
  },
  {
    name: "an SVG file",
    file: "wide.svg",
    frame: "#preview .image-preview .media-zoom-frame",
    activator: "#preview .image-preview img",
    next: null,
    source: /\/wide\.svg\?revision=/,
  },
  {
    name: "a document PNG",
    file: "media.md",
    frame: '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="photo"])',
    activator: '#preview img[alt="photo"]',
    next: "After the photo.",
    source: /\/photo\.png\?revision=/,
  },
  {
    name: "a document SVG",
    file: "media.md",
    frame: '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="figure"])',
    activator: '#preview img[alt="figure"]',
    next: "After the figure.",
    source: /\/wide\.svg\?revision=/,
  },
  {
    name: "a Mermaid diagram",
    file: "media.md",
    frame: "#preview .mermaid > .media-zoom-frame",
    activator: "#preview .mermaid-trigger",
    next: "After the diagram.",
    source: null,
    diagram: true,
  },
];

test.describe("inline zoom on desktop", () => {
  test.beforeEach(async ({ page, request }) => {
    await seed(page, request, MEDIA_PNGS, desktopExtras());
  });

  for (const surface of SURFACES) {
    test(`${surface.name}: the toolbar shows on hover and focus; +, −, fit and drag work without moving anything`, async ({ page }, testInfo) => {
      await openTreeFile(page, surface.file);
      if (surface.diagram) await revealDiagram(page);
      const frame = page.locator(surface.frame);
      await expectLaidOut(frame);
      const toolbar = frame.locator(".media-zoom-toolbar");

      await expect(toolbar).toBeHidden();
      await frame.hover();
      for (const name of ["Zoom out", "Zoom in", "Fit", "Open fullscreen viewer"]) {
        await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
      }
      const evidence = surface.name === "a document PNG";
      if (evidence) await captureScreenshot(page, testInfo, "media-zoom-inline-toolbar");
      await page.mouse.move(1, 1);
      await expect(toolbar).toBeHidden();
      await page.locator(surface.activator).focus();
      await expect(toolbar).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      const atFit = await layoutOf(page, surface.frame, surface.next);
      expectClose(await readInlineTransform(frame), FIT);

      const zoomed = await zoomInline(frame, "Zoom in", 3);
      expect(zoomed.scale).toBeCloseTo(1.25 ** 3, 3);
      if (evidence) await captureScreenshot(page, testInfo, "media-zoom-inline-zoomed");
      expectSameLayout(await layoutOf(page, surface.frame, surface.next), atFit);
      // The zoomed media is clipped to the box.
      expect(await frame.locator(":scope > .media-zoom-clip").evaluate(el => getComputedStyle(el).overflow)).toBe("hidden");
      expect(await frame.locator(":scope > .media-zoom-clip").boundingBox()).toEqual(await frame.boundingBox());

      const zoomedOut = await zoomInline(frame, "Zoom out");
      expect(zoomedOut.scale).toBeCloseTo(1.25 ** 2, 3);

      // Dragging pans by the pointer's movement.
      await mouseDrag(page, await centreOf(frame), -20, -16);
      const dragged = (await readInlineTransform(frame))!;
      expect(dragged.scale).toBeCloseTo(zoomedOut.scale, 3);
      expect(dragged.tx).toBeCloseTo(zoomedOut.tx - 20, 0);
      expect(dragged.ty).toBeCloseTo(zoomedOut.ty - 16, 0);
      expectSameLayout(await layoutOf(page, surface.frame, surface.next), atFit);
      await expectViewerClosed(page);

      expectClose(await zoomInline(frame, "Fit"), FIT);
      expectSameLayout(await layoutOf(page, surface.frame, surface.next), atFit);
      // And the same document without the integration lays out identically.
      expectSameLayout(await layoutOf(page, surface.frame, surface.next, true), atFit);
    });

    test(`${surface.name}: the wheel scrolls and never zooms; a click opens the viewer only at fit; closing keeps the inline zoom`, async ({ page }, testInfo) => {
      await openTreeFile(page, surface.file);
      if (surface.diagram) await revealDiagram(page);
      const frame = page.locator(surface.frame);
      await expectLaidOut(frame);
      const wheels = await recordWheels(page);

      // A click at fit opens the viewer, on the real source.
      await frame.click();
      await expectViewerOpen(page);
      if (surface.source) {
        await expect(page.locator(".media-viewer-stage img")).toHaveAttribute("src", surface.source);
      } else {
        await expect(page.locator(".media-viewer-stage svg")).toHaveCount(1);
      }
      if (surface.diagram) await captureScreenshot(page, testInfo, "media-zoom-viewer-mermaid-desktop");
      await page.keyboard.press("Escape");
      await expectViewerClosed(page);

      const zoomed = await zoomInline(frame, "Zoom in", 2);

      // The wheel over zoomed media keeps its default: the document scrolls.
      const scrollTop = () => page.locator(".preview-shell").evaluate(el => el.scrollTop);
      const before = await scrollTop();
      await frame.hover();
      await page.mouse.wheel(0, 120);
      await expect.poll(wheels).toEqual([false]);
      if (surface.next) await expect.poll(scrollTop).toBeGreaterThan(before);
      expectClose(await readInlineTransform(frame), zoomed);

      // Ctrl+wheel (a trackpad pinch) does not zoom it either.
      await frame.hover();
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      await expect.poll(async () => (await wheels()).length).toBe(2);
      expectClose(await readInlineTransform(frame), zoomed);

      // Zoomed, a click or a drag does not open the viewer.
      await frame.click();
      await afterAnimationFrames(page);
      await expectViewerClosed(page);
      expectClose(await readInlineTransform(frame), zoomed);
      await mouseDrag(page, await centreOf(frame), 10, 10);
      const panned = (await readInlineTransform(frame))!;
      await afterAnimationFrames(page);
      await expectViewerClosed(page);

      // Expand opens the viewer at fit; zooming there and closing leaves the
      // inline zoom as it was.
      await (await hoverToolbarButton(frame, "Open fullscreen viewer")).click();
      const opened = await expectViewerOpen(page);
      await page.keyboard.press("0");
      await expectStageTransform(page, opened);
      await page.keyboard.press("+");
      expect(await readStageScale(page)).toBeGreaterThan(opened.scale);
      await page.keyboard.press("Escape");
      await expectViewerClosed(page);
      expectClose(await readInlineTransform(frame), panned);
    });
  }

  test("a 16×16 badge has no toolbar and opens the viewer", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="badge"])');
    await frame.scrollIntoViewIfNeeded();
    // Past the deferred-loading placeholder, at its real size.
    await expect.poll(async () => await frame.boundingBox()).toMatchObject({ width: 16, height: 16 });
    await frame.hover();
    await expect(frame).toHaveClass(/\bis-small\b/);
    await expect(frame.locator(".media-zoom-toolbar")).toBeHidden();
    await page.locator('#preview img[alt="badge"]').focus();
    await expect(frame.locator(".media-zoom-toolbar")).toBeHidden();

    await frame.click();
    await expectViewerOpen(page);
    await expect(page.locator(".media-viewer-stage img")).toHaveAttribute("src", /\/badge\.svg\?revision=/);
  });

  test("an image under the small-media limit stays small media inside margins that widen its box", async ({ page }) => {
    await openTreeFile(page, "spaced.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="spaced photo"])');
    const image = frame.locator("img");
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect.poll(async () => (await image.boundingBox())?.width).toBeCloseTo(80, 0);
    // The margins are inside the frame: it is over the limit, the image is not.
    expect((await frame.boundingBox())!.width).toBeGreaterThanOrEqual(96);
    await expect(frame).toHaveClass(/\bis-small\b/);
    await frame.hover();
    await expect(frame.locator(".media-zoom-toolbar")).toBeHidden();
    await image.click();
    await expectViewerOpen(page);
  });

  test("an image with margins zooms in its own box: panned to either corner it still covers that box, and nothing moves", async ({ page }) => {
    await openTreeFile(page, "margined.md");
    const selector = '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="margined photo"])';
    const frame = page.locator(selector);
    await expectLaidOut(frame);
    // Rectangles relative to #preview: the frame (the clip), the image, and
    // the paragraph after it.
    const geometry = () =>
      page.evaluate(selector => {
        const preview = document.querySelector("#preview")!.getBoundingClientRect();
        const relative = (element: Element): Rect => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left - preview.left, y: rect.top - preview.top, width: rect.width, height: rect.height };
        };
        const frame = document.querySelector(selector)!;
        const next = Array.from(document.querySelectorAll("#preview p")).find(p => p.textContent?.trim() === "After the margined photo.")!;
        return { frame: relative(frame), media: relative(frame.querySelector("img")!), next: relative(next) };
      }, selector);
    const atFit = await geometry();
    expect(atFit.media.width).toBeCloseTo(320, 0);

    await zoomInline(frame, "Zoom in", 3);
    // Zoomed, the clip is the box the image had at fit, and nothing moved.
    const zoomed = await geometry();
    expectSameLayout({ media: zoomed.frame, next: zoomed.next }, { media: atFit.media, next: atFit.next });

    for (const [dx, dy] of [[400, 400], [-800, -800]]) {
      await mouseDrag(page, await centreOf(frame), dx, dy);
      await readInlineTransform(frame);
      const { frame: clip, media } = await geometry();
      const covers =
        media.x <= clip.x + 0.5 && media.y <= clip.y + 0.5 &&
        media.x + media.width >= clip.x + clip.width - 0.5 && media.y + media.height >= clip.y + clip.height - 0.5;
      expect(covers, `${JSON.stringify(media)} covers ${JSON.stringify(clip)}`).toBe(true);
    }
    expectClose(await zoomInline(frame, "Fit"), FIT);
    const back = await geometry();
    expectSameLayout({ media: back.media, next: back.next }, { media: atFit.media, next: atFit.next });
  });

  test("a responsive image whose picked source changes format brings that format's actions to an open viewer", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openTreeFile(page, "mixed-picture.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > picture > img[alt="mixed photo"])');
    await expectLaidOut(frame);
    await expectPicked(frame.locator("img"), /\/wide\.svg$/);
    await frame.click();
    await expectViewerOpen(page);
    const viewerImage = page.locator(".media-viewer-stage img");
    const actualPixels = page.locator(".media-viewer-toolbar").getByRole("button", { name: "1:1 actual pixels" });
    await expect(viewerImage).toHaveAttribute("src", /\/wide\.svg$/);
    await expect(actualPixels).toHaveCount(0);

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(viewerImage).toHaveAttribute("src", /\/photo\.png\?revision=/);
    await expect(actualPixels).toHaveCount(1);
    await expect(viewerDialog(page)).toHaveAttribute("data-media-kind", "raster");

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(viewerImage).toHaveAttribute("src", /\/wide\.svg$/);
    await expect(actualPixels).toHaveCount(0);
    await expect(viewerDialog(page)).toHaveAttribute("data-media-kind", "svg-image");
  });

  test("a linked image its author took out of the tab order is still reached by Tab and opens the viewer on Enter", async ({ page }) => {
    await openTreeFile(page, "untabbed.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > img[alt="untabbed photo"])');
    await expectLaidOut(frame);
    await page.locator("#preview a", { hasText: "the target" }).focus();
    await page.keyboard.press("Tab");
    await expect(frame.locator(":scope > .media-zoom-clip > a")).toBeFocused();
    await page.keyboard.press("Enter");
    await expectViewerOpen(page);
    await expect(page.locator("#preview-path")).toHaveText("untabbed.md");
  });

  test("narrow media shows its toolbar beside its box, never over it, at fit and zoomed", async ({ page }) => {
    await openTreeFile(page, "square.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="square"])');
    await expectLaidOut(frame);
    const controls = ["Zoom out", "Zoom in", "Fit", "Open fullscreen viewer"];
    await frame.hover();
    await expectControlsBeside(frame, controls);
    await zoomInline(frame, "Zoom in", 2);
    await frame.hover();
    // Zoomed, the media is clipped to its box, and the toolbar is not.
    await expectControlsBeside(frame, controls);
    // Each control is reachable: zoom out twice is back at fit.
    expectClose(await zoomInline(frame, "Zoom out", 2), FIT);
  });

  test("narrow media at the top of the view shows its toolbar below it rather than under the header", async ({ page }) => {
    await openTreeFile(page, "long-square.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="square"])');
    await expectLaidOut(frame);
    // Scroll the image up to just below the preview's sticky header.
    await frame.evaluate(element => {
      const shell = document.querySelector(".preview-shell")!;
      const header = document.querySelector(".preview-header")!.getBoundingClientRect();
      shell.scrollTop += element.getBoundingClientRect().top - header.bottom - 4;
    });
    const centre = await centreOf(frame);
    await page.mouse.move(centre.x, centre.y);
    const toolbar = frame.locator(".media-zoom-toolbar");
    await expect(toolbar).toBeVisible();
    const box = (await frame.boundingBox())!;
    expect((await toolbar.boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height - 0.5);
    await expectControlsBeside(frame, ["Zoom in"]);
  });

  // Hover applies before any pointer event reaches the page, so media found
  // small only on hover would flash its toolbar (and could take a click on it)
  // for the length of the toolbar's hide transition.
  test("small media is classified before it is hovered, so its toolbar never shows, even briefly", async ({ page }) => {
    await openTreeFile(page, "small.md");
    await revealDiagram(page);
    const frames = {
      diagram: page.locator("#preview .mermaid > .media-zoom-frame"),
      badge: page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="badge"])'),
    };
    for (const [name, frame] of Object.entries(frames)) {
      await frame.scrollIntoViewIfNeeded();
      await expect
        .poll(async () => {
          const box = await frame.boundingBox();
          return box !== null && box.width > 0 && box.height > 0 && Math.min(box.width, box.height) < 96;
        }, { message: `${name} is laid out under 96px on a side` })
        .toBe(true);
      await expect(frame, name).toHaveClass(/\bis-small\b/);

      // Sample the toolbar every frame from before the hover until well past
      // the hide transition.
      await frame.evaluate(element => {
        const toolbar = element.querySelector(".media-zoom-toolbar")!;
        const start = performance.now();
        (window as unknown as { __toolbarSeen: Promise<boolean> }).__toolbarSeen = new Promise(resolve => {
          let seen = false;
          const sample = () => {
            seen ||= getComputedStyle(toolbar).visibility === "visible";
            if (performance.now() - start > 400) resolve(seen);
            else requestAnimationFrame(sample);
          };
          sample();
        });
      });
      await frame.hover();
      expect(await page.evaluate(() => (window as unknown as { __toolbarSeen: Promise<boolean> }).__toolbarSeen), name).toBe(false);
      await page.mouse.move(0, 0);
    }
  });

  test("a linked image opens the viewer, and Open link loads the in-app document", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > img[alt="linked photo"])');
    await expectLaidOut(frame);
    await frame.click();
    await expectViewerOpen(page);
    // The link was not followed.
    await expect(page.locator("#preview-path")).toHaveText("media.md");

    await page.locator(".media-viewer-toolbar").getByRole("button", { name: "Open link" }).click();
    await expectViewerClosed(page);
    await expect(page.locator("#preview-path")).toHaveText("target.md");
    await expect(page.locator("#preview h1")).toHaveText("Target");
  });

  test("an image sharing its link with other content stays a plain link: no zoom, no viewer, and a click follows the link", async ({ page }) => {
    await openTreeFile(page, "mixed-link.md");
    const image = page.locator('#preview img[alt="captioned photo"]');
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(page.locator("#preview .media-zoom-frame")).toHaveCount(0);
    await expect(page.locator("#preview .media-zoom-toolbar")).toHaveCount(0);
    await image.click();
    await expect(page.locator("#preview-path")).toHaveText("target.md");
    await expectViewerClosed(page);
  });

  test("a responsive <picture> image zooms inline and opens the viewer on the source the browser picked", async ({ page }) => {
    await openTreeFile(page, "picture.md");
    // The <picture> is framed whole, so its <img> stays its direct child.
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > picture > img[alt="responsive photo"])');
    await expectLaidOut(frame);
    const image = frame.locator("img");
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).currentSrc)).toMatch(/\/wide-photo\.png$/);
    await expect(frame.getByRole("button", { name: "responsive photo", exact: true })).toHaveCount(1);
    const zoomed = await zoomInline(frame, "Zoom in", 2);
    expect(zoomed.scale).toBeCloseTo(1.25 ** 2, 3);
    expectClose(await zoomInline(frame, "Fit"), FIT);

    await frame.click();
    await expectViewerOpen(page);
    await expect(page.locator(".media-viewer-stage img")).toHaveAttribute("src", /\/wide-photo\.png$/);
    await expect(page.locator(".media-viewer-toolbar").getByRole("button", { name: "Open link" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectViewerClosed(page);

    // A link holding only a <picture> is its activator, and Open link follows it.
    const linked = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > picture > img[alt="linked responsive photo"])');
    await expectLaidOut(linked);
    await linked.click();
    await expectViewerOpen(page);
    await expect(page.locator("#preview-path")).toHaveText("picture.md");
    await page.locator(".media-viewer-toolbar").getByRole("button", { name: "Open link" }).click();
    await expectViewerClosed(page);
    await expect(page.locator("#preview-path")).toHaveText("target.md");
  });

  test("a cross-origin image of unknown format opens as vector; a cross-origin PNG keeps actual pixels", async ({ page }) => {
    await openTreeFile(page, "foreign.md");
    const foreign = await page.locator('#preview img[alt="foreign png"]').evaluate(el => (el as HTMLImageElement).src);
    expect(new URL(foreign).origin).not.toBe(new URL(page.url()).origin);
    const actualPixels = page.locator('.media-viewer-toolbar [aria-label="1:1 actual pixels"]');
    for (const [alt, offered] of [["unknown format", false], ["foreign png", true]] as const) {
      const frame = page.locator(`#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="${alt}"])`);
      await expectLaidOut(frame);
      await frame.click();
      await expectViewerOpen(page);
      await expect(actualPixels).toHaveCount(offered ? 1 : 0);
      if (!offered) {
        // Enlarged well past its natural size, it is still smoothed.
        for (let i = 0; i < 8; i += 1) await page.keyboard.press("+");
        await readStageTransform(page);
        expect(await page.locator(".media-viewer-stage img").evaluate(el => getComputedStyle(el).imageRendering)).not.toBe("pixelated");
      }
      await page.keyboard.press("Escape");
      await expectViewerClosed(page);
    }
  });

  test("Tab reaches a diagram as one named button, Enter opens the viewer, and Tab continues into its controls", async ({ page }) => {
    await openTreeFile(page, "media.md");
    await revealDiagram(page);
    const frame = page.locator("#preview .mermaid > .media-zoom-frame");
    await expectLaidOut(frame);
    await page.locator("#preview a", { hasText: "the target" }).focus();
    await page.keyboard.press("Tab");
    const trigger = page.getByRole("button", { name: "Open diagram in fullscreen viewer", exact: true });
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveClass(/mermaid-trigger/);

    await page.keyboard.press("Tab");
    await expect(frame.getByRole("button", { name: "Zoom out", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(trigger).toBeFocused();

    await page.keyboard.press("Enter");
    await expectViewerOpen(page);
    await expect(page.locator(".media-viewer-stage svg")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("a responsive image resets to fit when an edit swaps which candidate its descriptors pick", async ({ page }) => {
    await openTreeFile(page, "density-picture.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > picture > img[alt="responsive photo"])');
    const image = frame.locator("img");
    await expectLaidOut(frame);
    await expectPicked(image, /\/wide-photo\.png$/);
    await zoomInline(frame, "Zoom in", 2);

    // The same URLs in the same order; only the descriptors changed.
    await fs.writeFile(workspacePath("density-picture.md"), DENSITY_PICTURE_DOC.replace("wide-photo.png 1x, ./other-wide-photo.png 2x", "wide-photo.png 0.5x, ./other-wide-photo.png 1x"));
    await expectPicked(image, /\/other-wide-photo\.png$/);
    await afterAnimationFrames(page);
    expectClose(await readInlineTransform(frame), FIT);
  });

  test("an open viewer follows an off-screen responsive image to the raster source the browser picks over its suspended SVG fallback", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Every applied document update syncs an open viewer too, so the test
    // counts them: the follow must come from the image's own load.
    let documentUpdates = 0;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.eventSourceMessageReceived", event => {
      if (/"kind":"(patch|snapshot)"/.test(event.data)) documentUpdates += 1;
    });
    await openTreeFile(page, "svg-fallback-picture.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > picture > img[alt="svg fallback photo"])');
    const image = frame.locator("img");
    await expectLaidOut(frame);
    await expectPicked(image, /\/wide\.svg\?revision=/);
    await frame.click();
    await expectViewerOpen(page);
    const viewerImage = page.locator(".media-viewer-stage img");
    await expect(viewerImage).toHaveAttribute("src", /\/wide\.svg\?revision=/);

    // Scrolled away, the fallback holds its placeholder; a narrower window
    // then picks the raster <source>.
    await page.locator(".preview-shell").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(image).toHaveAttribute("src", /^data:/);
    await page.setViewportSize({ width: 900, height: 800 });
    await expectPicked(image, /\/photo\.png$/);
    const updatesAtLoad = documentUpdates;
    await expect(viewerImage).toHaveAttribute("src", /\/photo\.png$/);
    expect(documentUpdates).toBe(updatesAtLoad);
  });
});

// --- Inline zoom on touch ----------------------------------------------------

// Open a file from the Files tab; picking a document switches to Preview.
async function openTouchFile(page: Page, path: string): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await page.locator("#touch-tab-files").click();
  await openTreeFile(page, path);
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
}

const pageScale = (page: Page) => page.evaluate(() => window.visualViewport?.scale ?? 1);
const pageScrollY = (page: Page) => page.evaluate(() => window.scrollY);

const TOUCH_SURFACES = [
  { name: "a document image", file: "media.md", frame: '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="photo"])' },
  { name: "a Mermaid diagram", file: "media.md", frame: "#preview .mermaid > .media-zoom-frame", diagram: true },
  { name: "the image file preview", file: "photo.png", frame: "#preview .image-preview .media-zoom-frame" },
];

test.describe("inline zoom on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await seed(page, request);
  });

  for (const surface of TOUCH_SURFACES) {
    test(`${surface.name}: a pinch zooms the media and not the page; fit and expand show only when zoomed`, async ({ page }) => {
      await openTouchFile(page, surface.file);
      if (surface.diagram) await revealDiagram(page);
      const frame = page.locator(surface.frame);
      await expectLaidOut(frame);
      const toolbar = frame.locator(".media-zoom-toolbar");
      await expect(toolbar).toBeHidden();

      const cdp = await page.context().newCDPSession(page);
      await pinch(cdp, await centreOf(frame), 40, 120);
      const zoomed = (await readInlineTransform(frame))!;
      expect(zoomed.scale).toBeGreaterThan(1.5);
      await afterAnimationFrames(page);
      expect(await pageScale(page)).toBe(1);

      await expect(toolbar.getByRole("button", { name: "Fit", exact: true })).toBeVisible();
      await expect(toolbar.getByRole("button", { name: "Open fullscreen viewer", exact: true })).toBeVisible();
      await expect(toolbar.getByRole("button", { name: "Zoom in", exact: true })).toBeHidden();
      await expect(toolbar.getByRole("button", { name: "Zoom out", exact: true })).toBeHidden();

      // A tap on zoomed media does not open the viewer.
      await frame.tap();
      await afterAnimationFrames(page);
      await expectViewerClosed(page);

      await toolbar.getByRole("button", { name: "Fit", exact: true }).tap();
      expectClose(await readInlineTransform(frame), FIT);
      await expect(toolbar).toBeHidden();

      // At fit, a tap opens the viewer.
      await frame.tap();
      await expectViewerOpen(page);
    });
  }

  test("keyboard focus shows the whole toolbar, while a tap at fit and the viewer it opens leave it hidden", async ({ page }) => {
    await openTouchFile(page, "media.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="figure"])');
    await expectLaidOut(frame);
    const toolbar = frame.locator(".media-zoom-toolbar");
    const button = (name: string) => toolbar.getByRole("button", { name, exact: true });

    // A tap at fit opens the viewer; closing it returns focus without the toolbar.
    await frame.tap();
    await expectViewerOpen(page);
    const backdrop = await backdropPoint(page);
    await page.touchscreen.tap(backdrop.x, backdrop.y);
    await expectViewerClosed(page);
    await afterAnimationFrames(page);
    await expect(toolbar).toBeHidden();

    // From the next link, Shift+Tab reaches the figure; Tab moves into its controls.
    await page.locator("#preview a", { hasText: "the target" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "figure", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "figure", exact: true })).toHaveAccessibleDescription("Opens in the fullscreen viewer");
    await expect(page.getByRole("group", { name: "Zoom controls for figure" })).toHaveCount(1);
    for (const name of ["Zoom out", "Zoom in", "Fit", "Open fullscreen viewer"]) await expect(button(name)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(button("Zoom out")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button("Zoom in")).toBeFocused();
    await page.keyboard.press("Enter");
    expect((await readInlineTransform(frame))!.scale).toBeCloseTo(1.25, 3);
  });

  test("narrow media shows fit and expand beside its box once zoomed", async ({ page }) => {
    await openTouchFile(page, "square.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="square"])');
    await expectLaidOut(frame);
    const cdp = await page.context().newCDPSession(page);
    await pinch(cdp, await centreOf(frame), 20, 80);
    expect((await readInlineTransform(frame))!.scale).toBeGreaterThan(1.5);
    await expectControlsBeside(frame, ["Fit", "Open fullscreen viewer"]);
    await frame.locator(".media-zoom-toolbar").getByRole("button", { name: "Fit", exact: true }).tap();
    expectClose(await readInlineTransform(frame), FIT);
  });

  test("a one-finger pan that reaches the zoomed media's edge goes on scrolling the page", async ({ page }) => {
    await openTouchFile(page, "media.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="photo"])');
    await expectLaidOut(frame);
    const cdp = await page.context().newCDPSession(page);
    await pinch(cdp, await centreOf(frame), 40, 80);
    const zoomed = (await readInlineTransform(frame))!;
    expect(zoomed.scale).toBeGreaterThan(1.3);
    const box = (await frame.boundingBox())!;
    const before = await pageScrollY(page);
    // Up by far more than the media has left below its box.
    const reach = -(box.height * zoomed.scale - box.height + zoomed.ty);
    await touchDrag(cdp, await centreOf(frame), 0, reach - 150, 16);
    const panned = (await readInlineTransform(frame))!;
    expect(panned.ty).toBeCloseTo(box.height - box.height * panned.scale, 0);
    await expect.poll(() => pageScrollY(page)).toBeGreaterThan(before + 100);
  });

  test("one finger scrolls the page at fit, and pans without scrolling once zoomed", async ({ page }) => {
    await openTouchFile(page, "media.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="photo"])');
    await expectLaidOut(frame);
    const cdp = await page.context().newCDPSession(page);

    const before = await pageScrollY(page);
    await touchDrag(cdp, await centreOf(frame), 0, -160);
    await expect.poll(() => pageScrollY(page)).toBeGreaterThan(before + 40);
    expectClose(await readInlineTransform(frame), FIT);

    await frame.scrollIntoViewIfNeeded();
    await pinch(cdp, await centreOf(frame), 40, 140);
    const zoomed = (await readInlineTransform(frame))!;
    expect(zoomed.scale).toBeGreaterThan(1.5);

    const scrolled = await pageScrollY(page);
    await touchDrag(cdp, await centreOf(frame), -30, -40);
    const panned = (await readInlineTransform(frame))!;
    expect(panned.scale).toBeCloseTo(zoomed.scale, 3);
    expect(panned.tx).toBeCloseTo(zoomed.tx - 30, 0);
    expect(panned.ty).toBeCloseTo(zoomed.ty - 40, 0);
    await afterAnimationFrames(page);
    expect(await pageScrollY(page)).toBe(scrolled);
    expect(await pageScale(page)).toBe(1);
    await expectViewerClosed(page);
  });
});

// --- ViewBox-only SVGs ---------------------------------------------------------

// An SVG with only a viewBox has no natural width, so unframed it fills its
// containing block. The frame is shrink-to-fit, which gives it none: framed
// naively, the image collapses to nothing. It must lay out exactly as it does
// unframed — loaded, suspended off-screen and reloaded (svg-images.ts swaps a
// placeholder in and out), in the document and in the file preview.
const VIEWBOX_DOC_FRAME = '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="viewbox figure"])';
const FILE_FRAME = "#preview .image-preview .media-zoom-frame";

async function expectViewBoxDocument(page: Page): Promise<void> {
  const frame = page.locator(VIEWBOX_DOC_FRAME);
  const image = page.locator('#preview img[alt="viewbox figure"]');
  await expectLaidOut(frame);
  const loaded = await layoutOf(page, VIEWBOX_DOC_FRAME, "After the viewBox figure.");
  expect(loaded.media.width).toBeGreaterThan(300);

  // Scrolled away the real source is suspended, and back it is reloaded.
  await page.locator("#preview p", { hasText: "Trailing paragraph 39." }).scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute("src", /^data:/);
  await frame.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute("src", /\/viewbox\.svg\?revision=/);
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).complete)).toBe(true);
  await expectLaidOut(frame);
  expectSameLayout(await layoutOf(page, VIEWBOX_DOC_FRAME, "After the viewBox figure."), loaded);
  // And the same document without the integration lays out identically.
  expectSameLayout(await layoutOf(page, VIEWBOX_DOC_FRAME, "After the viewBox figure.", true), loaded);
}

async function expectViewBoxFile(page: Page): Promise<void> {
  const frame = page.locator(FILE_FRAME);
  await expectLaidOut(frame);
  const atFit = await layoutOf(page, FILE_FRAME, null);
  expectSameLayout(await layoutOf(page, FILE_FRAME, null, true), atFit);
}

test.describe("viewBox-only SVGs on desktop", () => {
  test.beforeEach(async ({ page, request }) => {
    await seed(page, request, {});
  });

  test("a document SVG keeps its unframed box, loaded and after scrolling away and back", async ({ page }) => {
    await openTreeFile(page, "viewbox.md");
    await expectViewBoxDocument(page);
  });

  for (const file of ["viewbox.svg", "tall-viewbox.svg", "viewbox.md"]) {
    test(`opening ${file} reports no ResizeObserver loop`, async ({ page }) => {
      // Sizing a frame inside its own size notification makes the browser
      // report a loop as a page error (Bun's dev overlay shows it full-page).
      await page.addInitScript(() => {
        const errors: string[] = ((window as any).__pageErrors = []);
        window.addEventListener("error", event => errors.push(event.message));
      });
      // Loaded with the page (the file's own URL), as well as opened in it.
      await openTreeFile(page, file);
      await page.reload();
      const frame = page.locator(file.endsWith(".md") ? VIEWBOX_DOC_FRAME : FILE_FRAME);
      await expectLaidOut(frame);
      await afterAnimationFrames(page, 4);
      expect(await page.evaluate(() => (window as any).__pageErrors)).toEqual([]);
    });
  }

  for (const file of ["viewbox.svg", "tall-viewbox.svg"]) {
    test(`the ${file} file preview keeps its unframed box, and zooming keeps it`, async ({ page }) => {
      await openTreeFile(page, file);
      const frame = page.locator(FILE_FRAME);
      await expectLaidOut(frame);
      const atFit = await layoutOf(page, FILE_FRAME, null);
      expect((await zoomInline(frame, "Zoom in", 2)).scale).toBeCloseTo(1.25 ** 2, 3);
      expectSameLayout(await layoutOf(page, FILE_FRAME, null), atFit);
      expectClose(await zoomInline(frame, "Fit"), FIT);
      await expectViewBoxFile(page);
    });
  }
});

test.describe("viewBox-only SVGs on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await seed(page, request, {});
  });

  test("a document SVG keeps its unframed box, loaded and after scrolling away and back", async ({ page }) => {
    await openTouchFile(page, "viewbox.md");
    await expectViewBoxDocument(page);
  });

  for (const file of ["viewbox.svg", "tall-viewbox.svg"]) {
    test(`the ${file} file preview keeps its unframed box`, async ({ page }) => {
      await openTouchFile(page, file);
      await expectViewBoxFile(page);
    });
  }
});

// --- Percentage widths ----------------------------------------------------------

// An image with a percentage width is sized against its containing block. The
// shrink-to-fit frame must not become that block, or the image would size
// against itself: framed, every such image must keep its unframed box.
const PERCENT_IMAGES = [
  { alt: "half photo", next: "After the half photo." },
  { alt: "centred photo", next: "After the centred photo." },
  { alt: "linked photo", next: "After the linked photo." },
];

async function expectPercentImagesUnchanged(page: Page): Promise<void> {
  for (const { alt, next } of PERCENT_IMAGES) {
    const selector = `#preview .media-zoom-frame:has(img[alt="${alt}"])`;
    await expectLaidOut(page.locator(selector), 40);
    const framed = await layoutOf(page, selector, next);
    const unframed = await layoutOf(page, selector, next, true);
    // The frame is the image's box.
    expect(framed.media.width, alt).toBeGreaterThan(40);
    expectSameLayout(framed, unframed);
  }
}

test.describe("percentage-width images", () => {
  test.beforeEach(async ({ page, request }) => {
    await seed(page, request);
  });

  test("on desktop, each keeps its unframed box, and zooming keeps it", async ({ page }) => {
    await openTreeFile(page, "percent.md");
    const selector = '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="half photo"])';
    const frame = page.locator(selector);
    await expectLaidOut(frame);
    const atFit = await layoutOf(page, selector, "After the half photo.");
    expect((await zoomInline(frame, "Zoom in", 2)).scale).toBeCloseTo(1.25 ** 2, 3);
    expectSameLayout(await layoutOf(page, selector, "After the half photo."), atFit);
    expectClose(await zoomInline(frame, "Fit"), FIT);
    expectSameLayout(await layoutOf(page, selector, "After the half photo."), atFit);
    await expectPercentImagesUnchanged(page);
  });
});

test.describe("percentage-width images on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await seed(page, request);
  });

  test("each keeps its unframed box", async ({ page }) => {
    await openTouchFile(page, "percent.md");
    await expectPercentImagesUnchanged(page);
  });
});

// --- Zoom across edits and navigation -------------------------------------------

// The committed inline zoom matches `expected`, once a re-render has restored it.
async function expectInlineTransform(frame: Locator, expected: StageTransform): Promise<void> {
  await expectTransformMatches(() => readInlineTransform(frame), expected);
}

// The viewer is at fit: fitting again changes nothing.
async function expectViewerAtFit(page: Page): Promise<StageTransform> {
  const shown = (await readStageTransform(page))!;
  await page.keyboard.press("0");
  await expectStageTransform(page, shown);
  return shown;
}

// An image element has loaded the given source.
async function expectLoaded(image: Locator, src: string): Promise<void> {
  await expect
    .poll(() => image.evaluate((el, src) => (el as HTMLImageElement).src === src && (el as HTMLImageElement).complete, src))
    .toBe(true);
}

// A responsive image has loaded the source the browser picked.
async function expectPicked(image: Locator, source: RegExp): Promise<void> {
  await expect
    .poll(() => image.evaluate(el => {
      const image = el as HTMLImageElement;
      return image.complete && image.naturalWidth > 0 ? image.currentSrc : "";
    }))
    .toMatch(source);
}

const MEDIA_FRAMES = {
  photo: '#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="photo"])',
  diagram: "#preview .mermaid > .media-zoom-frame",
};

test.describe("zoom across edits and navigation", () => {
  test.beforeEach(async ({ page, request }) => {
    await seed(page, request);
  });

  // Zoom the PNG file inline and pan it, then open the viewer from expand and
  // zoom there: both states to carry.
  async function zoomPhotoFile(page: Page) {
    await openTreeFile(page, "photo.png");
    const frame = page.locator(FILE_FRAME);
    await expectLaidOut(frame);
    await zoomInline(frame, "Zoom in", 2);
    await mouseDrag(page, await centreOf(frame), -20, -10);
    const inline = (await readInlineTransform(frame))!;
    await (await hoverToolbarButton(frame, "Open fullscreen viewer")).click();
    await expectViewerOpen(page);
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;
    const src = (await page.locator(".media-viewer-stage img").getAttribute("src"))!;
    return { frame, inline, viewed, src };
  }

  // Rewrite photo.png and wait until the viewer and the inline image show it.
  async function rewritePhoto(page: Page, frame: Locator, previous: string, image: Buffer): Promise<string> {
    await fs.writeFile(workspacePath("photo.png"), image);
    const viewerImage = page.locator(".media-viewer-stage img");
    await expect(viewerImage).not.toHaveAttribute("src", previous);
    const next = (await viewerImage.getAttribute("src"))!;
    expect(next).toMatch(/\/photo\.png\?revision=/);
    await expectLoaded(frame.locator("img"), next);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    return next;
  }

  test("a zoomed PNG rewritten with the same aspect keeps its zoom, inline and in the viewer", async ({ page }) => {
    const { frame, inline, viewed, src } = await zoomPhotoFile(page);
    await rewritePhoto(page, frame, src, png(640, 480, 20));
    await expectStageTransform(page, viewed);
    expectClose(await readInlineTransform(frame), inline);
    await page.keyboard.press("Escape");
    await expectViewerClosed(page);
    expectClose(await readInlineTransform(frame), inline);
  });

  test("a PNG rewritten with a different aspect resets to fit, inline and in the viewer", async ({ page }) => {
    const { frame, viewed, src } = await zoomPhotoFile(page);
    await rewritePhoto(page, frame, src, png(640, 320));
    await expect.poll(() => page.locator(".media-viewer-stage img").evaluate(el => (el as HTMLImageElement).naturalHeight)).toBe(320);
    const fitted = await expectViewerAtFit(page);
    expect(fitted.scale).not.toBeCloseTo(viewed.scale, 3);
    await expectInlineTransform(frame, FIT);
  });

  test("editing a document keeps the inline zoom of its images and diagrams", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const photo = page.locator(MEDIA_FRAMES.photo);
    await expectLaidOut(photo);
    const photoZoom = await zoomInline(photo, "Zoom in", 2);
    await revealDiagram(page);
    const diagram = page.locator(MEDIA_FRAMES.diagram);
    await expectLaidOut(diagram);
    const diagramZoom = await zoomInline(diagram, "Zoom in", 3);

    await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("Intro paragraph.", "Intro paragraph, edited."));
    await expect(page.locator("#preview")).toContainText("Intro paragraph, edited.");
    await expectInlineTransform(photo, photoZoom);
    await revealDiagram(page);
    await expectInlineTransform(diagram, diagramZoom);
  });

  // Track every ResizeObserver that watches a zoom frame or a frame's
  // container, so a replaced copy still being watched shows up. Returns the
  // count of observers still watching a detached target.
  async function trackZoomObservers(page: Page): Promise<() => Promise<number>> {
    await page.addInitScript(() => {
      const Native = window.ResizeObserver;
      const live = new Set<{ targets: Set<Element> }>();
      class Tracked extends Native {
        targets = new Set<Element>();
        observe(target: Element, options?: ResizeObserverOptions) {
          if (target.matches(".media-zoom-frame") || target.querySelector(":scope > .media-zoom-frame")) {
            this.targets.add(target);
            live.add(this);
          }
          super.observe(target, options);
        }
        unobserve(target: Element) {
          this.targets.delete(target);
          super.unobserve(target);
        }
        disconnect() {
          this.targets.clear();
          live.delete(this);
          super.disconnect();
        }
      }
      window.ResizeObserver = Tracked;
      (window as unknown as { detachedZoomObservers(): number }).detachedZoomObservers = () =>
        Array.from(live).filter(observer => Array.from(observer.targets).some(target => !target.isConnected)).length;
    });
    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    return () => page.evaluate(() => (window as unknown as { detachedZoomObservers(): number }).detachedZoomObservers());
  }

  test("an edit releases the observers of the media it replaced", async ({ page }) => {
    const detached = await trackZoomObservers(page);
    await openTreeFile(page, "media.md");
    const photo = page.locator(MEDIA_FRAMES.photo);
    await expectLaidOut(photo);
    const photoZoom = await zoomInline(photo, "Zoom in", 2);
    expect(await detached()).toBe(0);
    for (const edit of [1, 2]) {
      await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("Intro paragraph.", `Intro paragraph, edit ${edit}.`));
      await expect(page.locator("#preview")).toContainText(`Intro paragraph, edit ${edit}.`);
      // The new copy carries the zoom, so it watches its own container.
      await expectInlineTransform(photo, photoZoom);
      expect(await detached()).toBe(0);
    }
  });

  test("a preview with no zoomable media releases the observers of the media it replaced", async ({ page }) => {
    const detached = await trackZoomObservers(page);
    await openTreeFile(page, "media.md");
    const photo = page.locator(MEDIA_FRAMES.photo);
    await expectLaidOut(photo);
    await zoomInline(photo, "Zoom in", 2);
    await revealDiagram(page);
    await expectLaidOut(page.locator(MEDIA_FRAMES.diagram));
    expect(await detached()).toBe(0);
    // Diff replaces the body with no zoomable media of its own.
    await page.locator("#view-diff").click();
    await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#preview .media-zoom-frame")).toHaveCount(0);
    expect(await detached()).toBe(0);
  });

  test("an edit that keeps the diagram count keeps the viewer on the second diagram, re-rendered, at its scale and pan", async ({ page }) => {
    await openTreeFile(page, "diagrams.md");
    const frames = page.locator(MEDIA_FRAMES.diagram);
    await expect(frames).toHaveCount(2);
    await frames.nth(1).click();
    await expectViewerOpen(page);
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;

    // A fill changes what the diagram shows, not its geometry.
    const styled = DIAGRAM_B.replace("\n```", "\n  style Delta fill:#fde68a\n```");
    await fs.writeFile(workspacePath("diagrams.md"), diagramsDoc(DIAGRAM_A, styled));
    await expect(page.locator(".media-viewer-stage svg [style*='fde68a']").first()).toBeAttached();
    await expect(page.locator(".media-viewer-stage svg")).toContainText("Epsilon");
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expectStageTransform(page, viewed);
  });

  test("adding a diagram resets every diagram, and an open viewer stays on its diagram at fit", async ({ page }) => {
    await openTreeFile(page, "diagrams.md");
    const frames = page.locator(MEDIA_FRAMES.diagram);
    await expect(frames).toHaveCount(2);
    await zoomInline(frames.nth(0), "Zoom in", 2);
    await frames.nth(1).click();
    await expectViewerOpen(page);
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;
    // Marks the clone on show, to tell it from any later clone.
    await page.locator(".media-viewer-stage svg").evaluate(el => el.setAttribute("data-test-shown", ""));

    await fs.writeFile(workspacePath("diagrams.md"), diagramsDoc(DIAGRAM_A, DIAGRAM_B, DIAGRAM_C));
    await expect(page.locator("#preview .mermaid svg")).toHaveCount(3);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expect(page.locator(".media-viewer-stage svg[data-test-shown]")).toHaveCount(1);
    const fitted = await expectViewerAtFit(page);
    expect(fitted.scale).not.toBeCloseTo(viewed.scale, 3);

    await page.keyboard.press("Escape");
    await expectViewerClosed(page);
    for (const index of [0, 1, 2]) expectClose(await readInlineTransform(frames.nth(index)), FIT);
  });

  test("a theme change re-renders diagrams with their inline zoom, and an open viewer keeps its transform", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openTreeFile(page, "diagrams.md");
    const frames = page.locator(MEDIA_FRAMES.diagram);
    await expect(frames).toHaveCount(2);
    const inline = await zoomInline(frames.nth(0), "Zoom in", 2);
    await frames.nth(0).evaluate(el => el.setAttribute("data-test-before-theme", ""));
    await frames.nth(1).click();
    await expectViewerOpen(page);
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;
    await page.locator(".media-viewer-stage svg").evaluate(el => el.setAttribute("data-test-before-theme", ""));

    await page.emulateMedia({ colorScheme: "dark" });
    // Both diagrams rendered again, and the viewer took the new clone.
    await expect(page.locator("#preview .mermaid svg")).toHaveCount(2);
    await expect(page.locator("#preview [data-test-before-theme]")).toHaveCount(0);
    await expect(page.locator(".media-viewer-stage svg:not([data-test-before-theme])")).toHaveCount(1);
    await expectStageTransform(page, viewed);
    await page.keyboard.press("Escape");
    await expectViewerClosed(page);
    await expectInlineTransform(frames.nth(0), inline);
  });

  test("a diagram whose theme redraw is still queued keeps its inline zoom through an edit", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openTreeFile(page, "far-diagram.md");
    const frame = page.locator(MEDIA_FRAMES.diagram);
    await expectLaidOut(frame);
    const zoomed = await zoomInline(frame, "Zoom in", 2);

    // Far below the diagram, a theme change queues its redraw: it waits,
    // frameless, to come near the viewport again.
    await page.locator("#preview p", { hasText: "Trailing paragraph 39." }).last().scrollIntoViewIfNeeded();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("#preview .mermaid > .media-zoom-frame")).toHaveCount(0);
    await fs.writeFile(
      workspacePath("far-diagram.md"),
      ["# Far", DIAGRAM_A, "After the far diagram, edited.", TRAILING, TRAILING, TRAILING].join("\n\n"),
    );
    await expect(page.locator("#preview")).toContainText("After the far diagram, edited.");

    await revealDiagram(page);
    await expectLaidOut(frame);
    await expectInlineTransform(frame, zoomed);
  });

  test("an image removed by an edit leaves the viewer open, on what it showed, at fit", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const photo = page.locator(MEDIA_FRAMES.photo);
    await expectLaidOut(photo);
    await photo.click();
    await expectViewerOpen(page);
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;
    const src = await page.locator(".media-viewer-stage img").getAttribute("src");

    // Every image of photo.png goes.
    await fs.writeFile(
      workspacePath("media.md"),
      MEDIA_DOC.replace("![photo](./photo.png)", "").replace("[![linked photo](./photo.png)](./target.md)", ""),
    );
    await expect(page.locator("#preview img[alt='photo']")).toHaveCount(0);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expect(page.locator(".media-viewer-stage img")).toHaveAttribute("src", src!);
    const fitted = await expectViewerAtFit(page);
    expect(fitted.scale).not.toBeCloseTo(viewed.scale, 3);
  });

  test("a zoomed image an edit moved off-screen keeps its zoom through a second edit before it loads", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const figure = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="figure"])');
    await expectLaidOut(figure);
    const zoomed = await zoomInline(figure, "Zoom in", 2);

    const pushedDown = MEDIA_DOC.replace("After the photo.", `After the photo.\n\n${TRAILING}\n\n${TRAILING}`);
    await fs.writeFile(workspacePath("media.md"), pushedDown);
    await expect(page.locator("#preview")).toContainText("Trailing paragraph 39.");
    // Off-screen, the new copy holds its placeholder and has not loaded.
    const figureImage = page.locator('#preview img[alt="figure"]');
    await expect.poll(() => figureImage.evaluate(el => el.getAttribute("src")!.startsWith("data:"))).toBe(true);
    await fs.writeFile(workspacePath("media.md"), pushedDown.replace("Intro paragraph.", "Intro paragraph, edited."));
    await expect(page.locator("#preview")).toContainText("Intro paragraph, edited.");

    await expectLaidOut(figure);
    await expectInlineTransform(figure, zoomed);
  });

  test("a live edit that replaces the media returns focus to its new expand control", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const photo = page.locator(MEDIA_FRAMES.photo);
    await expectLaidOut(photo);
    await (await hoverToolbarButton(photo, "Open fullscreen viewer")).click();
    await expectViewerOpen(page);
    // Away from the media, so hover cannot show its toolbar once the viewer closes.
    await page.mouse.move(1, 1);
    await photo.evaluate(el => el.setAttribute("data-test-before-edit", ""));

    await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("Intro paragraph.", "Intro paragraph, edited."));
    await expect(page.locator("#preview")).toContainText("Intro paragraph, edited.");
    await expect(page.locator("#preview [data-test-before-edit]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectViewerClosed(page);
    await expect(photo.locator('[data-zoom-action="expand"]')).toBeFocused();
  });

  test("an open viewer shows its diagram's re-render even when the edit moved the diagram off-screen", async ({ page }) => {
    await openTreeFile(page, "diagrams.md");
    const frames = page.locator(MEDIA_FRAMES.diagram);
    await expect(frames).toHaveCount(2);
    await frames.nth(1).click();
    await expectViewerOpen(page);
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;

    const styled = DIAGRAM_B.replace("\n```", "\n  style Delta fill:#fde68a\n```");
    const pushedDown = diagramsDoc(DIAGRAM_A, styled).replace("After diagram 0.", `After diagram 0.\n\n${TRAILING}\n\n${TRAILING}`);
    await fs.writeFile(workspacePath("diagrams.md"), pushedDown);
    await expect(page.locator("#preview")).toContainText("Trailing paragraph 39.");
    // The second diagram now sits far beyond the lazy queue's reach.
    const top = await page.locator("#preview .mermaid").nth(1).evaluate(el => el.getBoundingClientRect().top / innerHeight);
    expect(top).toBeGreaterThan(2);
    await expect(page.locator(".media-viewer-stage svg [style*='fde68a']").first()).toBeAttached();
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expectStageTransform(page, viewed);
  });

  test("an open viewer follows its SVG to a new revision even when an edit moved the image off-screen", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const figure = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > img[alt="figure"])');
    await expectLaidOut(figure);
    await figure.click();
    await expectViewerOpen(page);
    const viewerImage = page.locator(".media-viewer-stage img");
    const src = (await viewerImage.getAttribute("src"))!;

    await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("After the photo.", `After the photo.\n\n${TRAILING}\n\n${TRAILING}`));
    // Off-screen, the inline figure holds its placeholder, so it never loads.
    await expect
      .poll(() => page.locator('#preview img[alt="figure"]').evaluate(el => el.getAttribute("src")!.startsWith("data:")))
      .toBe(true);
    await fs.writeFile(workspacePath("wide.svg"), WIDE_SVG.replace("#e8eefc", "#fde68a"));
    await expect(viewerImage).not.toHaveAttribute("src", src);
    await expect(viewerImage).toHaveAttribute("src", /\/wide\.svg\?revision=/);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
  });

  test("a live edit keeps keyboard focus on the viewer control that held it", async ({ page }) => {
    await openTreeFile(page, "diagrams.md");
    const frames = page.locator(MEDIA_FRAMES.diagram);
    await expect(frames).toHaveCount(2);
    await frames.nth(1).click();
    await expectViewerOpen(page);
    const zoomIn = page.locator('.media-viewer-toolbar [aria-label="Zoom in"]');
    await zoomIn.focus();

    const styled = DIAGRAM_B.replace("\n```", "\n  style Delta fill:#fde68a\n```");
    await fs.writeFile(workspacePath("diagrams.md"), diagramsDoc(DIAGRAM_A, styled));
    await expect(page.locator(".media-viewer-stage svg [style*='fde68a']").first()).toBeAttached();
    await expect(zoomIn).toBeFocused();
  });

  test("an edit that removes a linked image drops Open link from the viewer, and its focus moves to close", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const linked = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > img[alt="linked photo"])');
    await expectLaidOut(linked);
    await linked.click();
    await expectViewerOpen(page);
    const openLink = page.locator(".media-viewer-toolbar").getByRole("button", { name: "Open link" });
    await openLink.focus();

    await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("[![linked photo](./photo.png)](./target.md)", ""));
    await expect(page.locator("#preview img[alt='linked photo']")).toHaveCount(0);
    await expect(openLink).toHaveCount(0);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expect(page.locator(".media-viewer-close")).toBeFocused();
  });

  test("an edit that removes one copy of an image leaves the viewer and inline zoom on the copy that stays", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const linked = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > img[alt="linked photo"])');
    await expectLaidOut(linked);
    const zoomed = await zoomInline(linked, "Zoom in", 2);
    await (await hoverToolbarButton(linked, "Open fullscreen viewer")).click();
    await expectViewerOpen(page);
    const openLink = page.locator(".media-viewer-toolbar").getByRole("button", { name: "Open link" });
    await expect(openLink).toHaveCount(1);

    // The unlinked copy of the same source, earlier in the document, goes.
    await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("![photo](./photo.png)", ""));
    await expect(page.locator("#preview img[alt='photo']")).toHaveCount(0);
    await expectLaidOut(linked);
    await expectInlineTransform(linked, zoomed);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expect(openLink).toHaveCount(1);
  });

  test("an edit that removes the copy the viewer shows never moves the viewer onto another copy", async ({ page }) => {
    await openTreeFile(page, "media.md");
    const photo = page.locator(MEDIA_FRAMES.photo);
    await expectLaidOut(photo);
    await photo.click();
    await expectViewerOpen(page);
    const openLink = page.locator(".media-viewer-toolbar").getByRole("button", { name: "Open link" });
    await expect(openLink).toHaveCount(0);

    // The linked copy of the same source, later in the document, stays.
    await fs.writeFile(workspacePath("media.md"), MEDIA_DOC.replace("![photo](./photo.png)", "").replace("Intro paragraph.", "Intro paragraph, edited."));
    await expect(page.locator("#preview")).toContainText("Intro paragraph, edited.");
    await expectLaidOut(page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > a > img[alt="linked photo"])'));
    await afterAnimationFrames(page);
    await expect(viewerDialog(page)).toHaveAttribute("open", "");
    await expect(openLink).toHaveCount(0);
  });

  test("a responsive image keeps its zoom through an edit, and resets when the edit replaces the source it shows", async ({ page }) => {
    await openTreeFile(page, "picture.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > picture > img[alt="responsive photo"])');
    const image = frame.locator("img");
    await expectLaidOut(frame);
    await expectPicked(image, /\/wide-photo\.png$/);
    const zoomed = await zoomInline(frame, "Zoom in", 2);

    await fs.writeFile(workspacePath("picture.md"), PICTURE_DOC.replace("Intro paragraph.", "Intro paragraph, edited."));
    await expect(page.locator("#preview")).toContainText("Intro paragraph, edited.");
    await expectPicked(image, /\/wide-photo\.png$/);
    await expectInlineTransform(frame, zoomed);

    // Same shape, same fallback: only the source the browser picks changed.
    await fs.writeFile(workspacePath("picture.md"), PICTURE_DOC.replace(PICTURE_SOURCE, PICTURE_SOURCE.replace("wide-photo", "other-wide-photo")));
    await expectPicked(image, /\/other-wide-photo\.png$/);
    await afterAnimationFrames(page);
    expectClose(await readInlineTransform(frame), FIT);
  });

  test("an open viewer follows a responsive image through an edit to the source the browser picked, never its fallback", async ({ page }) => {
    await openTreeFile(page, "picture.md");
    const frame = page.locator('#preview .media-zoom-frame:has(> .media-zoom-clip > picture > img[alt="responsive photo"])');
    await expectLaidOut(frame);
    await expectPicked(frame.locator("img"), /\/wide-photo\.png$/);
    await frame.click();
    await expectViewerOpen(page);
    const viewerImage = page.locator(".media-viewer-stage img");
    await expect(viewerImage).toHaveAttribute("src", /\/wide-photo\.png$/);
    await page.keyboard.press("+");
    const viewed = (await readStageTransform(page))!;
    // Uncached, the new copy's picked source is known only once the browser
    // has selected it, after the mount (a cached one is known at once).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    const fallbackRequests: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/photo.png") fallbackRequests.push(request.url());
    });

    await fs.writeFile(workspacePath("picture.md"), PICTURE_DOC.replace("Intro paragraph.", "Intro paragraph, edited."));
    await expect(page.locator("#preview")).toContainText("Intro paragraph, edited.");
    await expectPicked(frame.locator("img"), /\/wide-photo\.png$/);
    await afterAnimationFrames(page);
    expect(fallbackRequests).toEqual([]);
    await expect(viewerImage).toHaveAttribute("src", /\/wide-photo\.png$/);
    await expectStageTransform(page, viewed);
  });

  test("Follow moving to another file closes the viewer, and returning shows fit", async ({ page }) => {
    await openTreeFile(page, "photo.png");
    await page.locator("#follow-toggle").click();
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    // The newest change is the photo's, so Follow stays on it.
    await fs.writeFile(workspacePath("photo.png"), png(640, 480, 20));
    await expect(page.locator("#preview-path")).toHaveText("photo.png");
    const frame = page.locator(FILE_FRAME);
    await expectLaidOut(frame);
    await zoomInline(frame, "Zoom in", 2);
    await (await hoverToolbarButton(frame, "Open fullscreen viewer")).click();
    await expectViewerOpen(page);

    await fs.writeFile(workspacePath("target.md"), "# Target\n\nChanged, so Follow selects it.\n");
    await expect(page.locator("#preview-path")).toHaveText("target.md");
    await expectViewerClosed(page);

    await openTreeFile(page, "photo.png");
    await expectLaidOut(frame);
    expectClose(await readInlineTransform(frame), FIT);
  });

  test("Follow to a file still loading closes the viewer at once, the old media opens nothing, and a return before it mounts shows fit", async ({ page }) => {
    await openTreeFile(page, "photo.png");
    await page.locator("#follow-toggle").click();
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    // The newest change is the photo's, so Follow stays on it.
    await fs.writeFile(workspacePath("photo.png"), png(640, 480, 20));
    await expect(page.locator("#preview-path")).toHaveText("photo.png");
    const frame = page.locator(FILE_FRAME);
    await expectLaidOut(frame);
    await zoomInline(frame, "Zoom in", 2);
    await (await hoverToolbarButton(frame, "Open fullscreen viewer")).click();
    await expectViewerOpen(page);

    // target.md's document response is held until the end of the test.
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    let requested = false;
    const documentApi = (url: URL) => url.pathname.endsWith("/api/document");
    await page.route(documentApi, async route => {
      requested = true;
      await held;
      await route.continue().catch(() => {});
    });
    await fs.writeFile(workspacePath("target.md"), "# Target\n\nChanged, so Follow selects it.\n");
    await expect.poll(() => requested).toBe(true);
    await expectViewerClosed(page);
    await expect(page.locator("#preview-path")).toHaveText("photo.png");
    // The photo stays on screen while target.md loads, but it is no longer
    // the selection: it opens no viewer.
    await frame.click();
    await afterAnimationFrames(page);
    await expectViewerClosed(page);
    // Nor does it zoom.
    expectClose(await zoomInline(frame, "Zoom in"), FIT);

    await openTreeFile(page, "photo.png");
    await expectLaidOut(frame);
    expectClose(await readInlineTransform(frame), FIT);
    // Selected again and kept in place, it is the selection's media again.
    await frame.click();
    await expectViewerOpen(page);
    await page.keyboard.press("Escape");
    await expectViewerClosed(page);
    release();
    await page.unroute(documentApi);
  });

  test("a reload shows fit, and no zoom value reaches storage or the URL", async ({ page, request }) => {
    await openTreeFile(page, "photo.png");
    const frame = page.locator(FILE_FRAME);
    await expectLaidOut(frame);
    const zoomed = await zoomInline(frame, "Zoom in", 2);
    const saved = JSON.stringify(zoomed);
    const stored = async () => {
      const personal = await (await request.get("/api/personal-state")).text();
      const browser = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      return personal + browser;
    };
    const before = await stored();
    expect(before).not.toMatch(/zoom/i);
    expect(before).not.toContain(saved);

    await page.reload();
    await expect(page.locator("#preview-path")).toHaveText("photo.png");
    await expectLaidOut(frame);
    expectClose(await readInlineTransform(frame), FIT);
    expect(await stored()).not.toMatch(/zoom/i);
  });
});
