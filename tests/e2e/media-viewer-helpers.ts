// Driving media zoom from any surface (the preview's media, chat's visuals
// and attachments): the shared fullscreen viewer (src/zoom/viewer.ts), and
// the pointer, touch and wheel input both it and inline zoom take.

import { crc32, deflateSync } from "node:zlib";
import { expect, type CDPSession, type Locator, type Page } from "@playwright/test";

import { readStageTransform, type StageTransform } from "./transform-helpers";

export const viewerDialog = (page: Page) => page.locator("dialog.media-viewer");

// Open, with the media in and fitted; returns the fitted transform.
export async function expectViewerOpen(page: Page): Promise<StageTransform> {
  await expect(viewerDialog(page)).toHaveAttribute("open", "");
  // An image is fitted only once it has loaded; until then the stage has no state.
  await expect(page.locator(".media-viewer-stage")).toHaveAttribute("data-zoom-state", /./);
  const fitted = await readStageTransform(page);
  expect(fitted).not.toBeNull();
  return fitted!;
}

// Closed, or never opened (the dialog is created on first open).
export async function expectViewerClosed(page: Page): Promise<void> {
  await expect(page.locator("dialog.media-viewer[open]")).toHaveCount(0);
}

// A point on the empty backdrop: the middle of the widest gap left, right or
// above the media (below it is the toolbar).
export async function backdropPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const viewport = document.querySelector(".media-viewer-viewport")!.getBoundingClientRect();
    const stage = document.querySelector(".media-viewer-stage")!.getBoundingClientRect();
    const gaps = [
      { size: stage.left - viewport.left, x: (viewport.left + stage.left) / 2, y: stage.top + stage.height / 2 },
      { size: viewport.right - stage.right, x: (stage.right + viewport.right) / 2, y: stage.top + stage.height / 2 },
      { size: stage.top - viewport.top, x: stage.left + stage.width / 2, y: (viewport.top + stage.top) / 2 },
    ];
    return gaps.sort((a, b) => b.size - a.size)[0]!;
  });
  expect(point.size).toBeGreaterThan(12);
  return { x: point.x, y: point.y };
}

// The centre of the media in the viewer.
export async function viewerMediaPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".media-viewer-stage").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Every viewer control lies inside the visible viewport (the area a reader
// pinch-zoomed into, or the whole window) and inside the toolbar, whose box
// is what keeps the controls clear of the device's safe areas.
export async function expectViewerControlsVisible(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const vv = window.visualViewport;
    const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    return {
      visible: vv
        ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }
        : { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
      toolbar: box(document.querySelector(".media-viewer-toolbar")!.getBoundingClientRect()),
      controls: Array.from(document.querySelectorAll(".media-viewer-toolbar button")).map(button => ({
        name: button.getAttribute("aria-label"),
        ...box(button.getBoundingClientRect()),
      })),
    };
  });
  type Box = { left: number; top: number; right: number; bottom: number };
  const within = (inner: Box, outer: Box) =>
    inner.left >= outer.left - 0.5 && inner.top >= outer.top - 0.5 &&
    inner.right <= outer.right + 0.5 && inner.bottom <= outer.bottom + 0.5;
  expect(layout.controls.length).toBeGreaterThan(0);
  for (const control of layout.controls) {
    expect(within(control, layout.visible), `${control.name} ${JSON.stringify(control)} in ${JSON.stringify(layout.visible)}`).toBe(true);
    expect(within(control, layout.toolbar), `${control.name} ${JSON.stringify(control)} in toolbar ${JSON.stringify(layout.toolbar)}`).toBe(true);
  }
}

// --- Fixtures -------------------------------------------------------------------

// A width × height checkerboard PNG, for raster media of a known size.
export function checkerboardPng(width: number, height: number, cell = 40): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      raw.fill(dark ? 0x34 : 0xdc, y * row + 1 + x * 3, y * row + 4 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Input ---------------------------------------------------------------------

export type Point = { x: number; y: number };

export async function centreOf(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function mouseDrag(page: Page, from: Point, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 3 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 3 });
  await page.mouse.up();
}

// One finger dragged by (dx, dy), through CDP: Playwright's touchscreen only taps.
export async function touchDrag(cdp: CDPSession, from: Point, dx: number, dy: number, steps = 8): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps, id: 1 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Two fingers on either side of `centre`, `from` px apart, spreading to `to`.
export async function pinch(cdp: CDPSession, centre: Point, from: number, to: number, steps = 6): Promise<void> {
  const points = (gap: number) => [
    { x: centre.x - gap / 2, y: centre.y, id: 1 },
    { x: centre.x + gap / 2, y: centre.y, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * step) / steps) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Record, from now on, whether each wheel event reaching the window had its
// default prevented. Returns a reader of the record so far.
export async function recordWheels(page: Page): Promise<() => Promise<boolean[]>> {
  await page.evaluate(() => {
    const scope = window as unknown as { __wheels: boolean[] };
    scope.__wheels = [];
    // Bubble phase on window: sees whether anything nearer prevented it.
    window.addEventListener("wheel", event => scope.__wheels.push(event.defaultPrevented), { passive: true });
  });
  return () => page.evaluate(() => (window as unknown as { __wheels: boolean[] }).__wheels);
}
