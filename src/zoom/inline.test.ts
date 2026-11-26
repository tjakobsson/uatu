import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { KEY_PAN_STEP } from "./transform";

import {
  ACTIVATOR_CLASS,
  attachInlineZoom,
  CLIP_CLASS,
  createInlineFrame,
  createZoomCarry,
  FRAME_CLASS,
  inlineFrameHtml,
  STAGE_CLASS,
  type InlineZoom,
} from "./inline";

type Rect = { width: number; height: number };

type ResizeCallback = (entries: { target: Element; contentRect: Rect }[]) => void;

// The global animation frame as this file found it, put back after each test.
const originalFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");

afterEach(() => {
  if (originalFrame) Object.defineProperty(globalThis, "requestAnimationFrame", originalFrame);
  else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
});

// linkedom has no ResizeObserver. This one reports a target's box as soon as
// it is observed, as a browser's first notification does; `resize` reports a
// target's box again, as a browser does when it changes.
function dom(body: string) {
  const { window, document } = parseHTML(`<html><body>${body}</body></html>`);
  const observed = new Set<{ target: Element; callback: ResizeCallback }>();
  const notify = (entry: { target: Element; callback: ResizeCallback }) =>
    entry.callback([{ target: entry.target, contentRect: entry.target.getBoundingClientRect() }]);
  (window as any).ResizeObserver = class {
    constructor(private readonly callback: ResizeCallback) {}
    observe(target: Element) {
      const entry = { target, callback: this.callback };
      observed.add(entry);
      notify(entry);
    }
    disconnect() {
      for (const entry of observed) if (entry.callback === this.callback) observed.delete(entry);
    }
  };
  const resize = (target: Element) => {
    for (const entry of observed) if (entry.target === target) notify(entry);
  };
  // Animation frames run only when a test says the next frame has come.
  // linkedom's window reads through to the global object, so the stub goes
  // there and is undone after each test, or later files never get a frame.
  let frames: (() => void)[] = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: () => void) => frames.push(callback),
  });
  const nextFrame = () => {
    const due = frames;
    frames = [];
    for (const callback of due) callback();
  };
  return { window: window as any, document: document as unknown as Document, resize, nextFrame, observing: () => observed.size };
}

// linkedom does no layout; give an element the box a browser would.
function setRect(element: Element, rect: Rect): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, x: 0, y: 0, right: rect.width, bottom: rect.height, ...rect }),
  });
}

// Lay out a frame at fit: the frame and the media on its stage share a box.
function layOut(frame: Element, rect: Rect): void {
  setRect(frame, rect);
  setRect(frame.querySelector(`.${STAGE_CLASS}`)!, rect);
}

// Record every listener registered on the given elements, with its options.
function recordListeners(elements: Element[]) {
  const registered: { type: string; options: unknown }[] = [];
  for (const element of elements) {
    const original = element.addEventListener.bind(element);
    (element as any).addEventListener = (type: string, listener: any, options?: unknown) => {
      registered.push({ type, options });
      original(type, listener, options as any);
    };
  }
  return registered;
}

function event(window: any, type: string, init: Record<string, unknown> = {}): Event {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ isTrusted: true, ...init })) {
    Object.defineProperty(e, key, { configurable: true, value });
  }
  return e;
}

function toolbarLabels(frame: Element): string[] {
  return Array.from(frame.querySelectorAll(".media-zoom-toolbar button")).map(b => b.getAttribute("aria-label") ?? "");
}

function nestedControls(root: Element): number {
  return root.querySelectorAll("button button, button a, a button, a a, [role=button] button").length;
}

function control(frame: Element, label: string): HTMLButtonElement {
  return frame.querySelector(`.media-zoom-toolbar [aria-label="${label}"]`) as HTMLButtonElement;
}

describe("inline frame structure", () => {
  test("a plain image becomes a named button, with the toolbar as its sibling", () => {
    const { document } = dom('<p id="p"><img id="i" alt="Architecture" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);

    expect(frame.classList.contains(FRAME_CLASS)).toBe(true);
    expect(frame.parentElement?.id).toBe("p");
    // The media sits in a clip, the box a zoom is clipped to; the toolbar
    // beside it is not clipped, so it can sit outside narrow media.
    expect(Array.from(frame.children).map(child => child.className)).toEqual([CLIP_CLASS, "media-zoom-toolbar"]);
    expect(image.parentElement!.className).toBe(CLIP_CLASS);
    expect(image.getAttribute("role")).toBe("button");
    expect(image.getAttribute("tabindex")).toBe("0");
    // The alt stays the name, and a description says what activating it does.
    expect(image.getAttribute("aria-label")).toBeNull();
    expect(image.getAttribute("aria-description")).toBe("Opens in the fullscreen viewer");
    expect(frame.querySelector(".media-zoom-toolbar")!.getAttribute("aria-label")).toBe("Zoom controls for Architecture");
    expect(toolbarLabels(frame)).toEqual(["Zoom out", "Zoom in", "Fit", "Open fullscreen viewer"]);
    expect(nestedControls(frame)).toBe(0);
    // Toolbar glyphs come from CSS: the frame adds no text for Find to index.
    expect(frame.textContent).toBe("");
  });

  test("a frame offers no inline controls until a controller has measured it", () => {
    const { document } = dom(`<p><img id="i" alt="Shot" src="a.png"></p><p>${inlineFrameHtml(`<button class="${ACTIVATOR_CLASS}"><img class="${STAGE_CLASS}" alt="chart" src="b.png"></button>`)}</p>`);
    const image = document.getElementById("i") as HTMLImageElement;
    expect(createInlineFrame(image, image).classList.contains("is-small")).toBe(true);
    expect(document.querySelectorAll(`.${FRAME_CLASS}.is-small`).length).toBe(2);
  });

  test("an image without alt text gets an accessible name", () => {
    const { document } = dom('<p><img id="i" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    expect(image.getAttribute("aria-label")).toBe("Open image in fullscreen viewer");
    // The name says it all already.
    expect(image.hasAttribute("aria-description")).toBe(false);
    expect(frame.querySelector(".media-zoom-toolbar")!.getAttribute("aria-label")).toBe("Zoom controls");
  });

  test("a linked image keeps the link as its activator and the toolbar outside it", () => {
    const { document } = dom('<p><a id="l" href="other.md"><img id="i" alt="Logo" src="a.png"></a></p>');
    const link = document.getElementById("l") as HTMLAnchorElement;
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(link, image);

    expect(Array.from(frame.children).map(child => child.className)).toEqual([CLIP_CLASS, "media-zoom-toolbar"]);
    expect(link.parentElement!.className).toBe(CLIP_CLASS);
    expect(link.getAttribute("aria-description")).toBe("Opens in the fullscreen viewer");
    expect(frame.querySelector(".media-zoom-toolbar")!.getAttribute("aria-label")).toBe("Zoom controls for Logo");
    expect(image.parentElement).toBe(link);
    expect(image.hasAttribute("role")).toBe(false);
    expect(link.querySelector("button")).toBeNull();
    expect(nestedControls(frame.parentElement!)).toBe(0);
  });

  test("a linked image its author took out of the tab order is put back in it, as its one control", () => {
    const { document } = dom('<p><a id="l" href="other.md" tabindex="-1"><img id="i" alt="Logo" src="a.png"></a></p>');
    const link = document.getElementById("l") as HTMLAnchorElement;
    createInlineFrame(link, document.getElementById("i")!);
    expect(link.hasAttribute("tabindex")).toBe(false);
  });

  test("a diagram trigger keeps its name, and framing is idempotent", () => {
    const { document } = dom(
      '<div class="mermaid"><button id="b" class="mermaid-trigger" aria-label="Open diagram in fullscreen viewer"><svg viewBox="0 0 10 10"></svg></button></div>',
    );
    const button = document.getElementById("b") as HTMLButtonElement;
    const svg = button.querySelector("svg")!;
    const frame = createInlineFrame(button, svg, "diagram");
    expect(createInlineFrame(button, svg, "diagram")).toBe(frame);
    expect(frame.querySelector(".media-zoom-toolbar")!.getAttribute("aria-label")).toBe("Zoom controls for diagram");
    // Its name already says that it opens the viewer.
    expect(button.hasAttribute("aria-description")).toBe(false);
    expect(document.querySelectorAll(`.${FRAME_CLASS}`).length).toBe(1);
    expect(document.querySelectorAll(".media-zoom-toolbar").length).toBe(1);
    expect(button.getAttribute("aria-label")).toBe("Open diagram in fullscreen viewer");
    expect(button.hasAttribute("role")).toBe(false);
    expect(nestedControls(document.body as unknown as Element)).toBe(0);
  });

  test("the HTML form matches the DOM-built frame and takes a controller", () => {
    const button = (id: string) =>
      `<button id="${id}" type="button" class="${ACTIVATOR_CLASS}" aria-label="Enlarge chart"><img class="${STAGE_CLASS}" alt="chart" src="a.png"></button>`;
    const { document } = dom(`<p id="built">${button("b1")}</p><p id="html">${inlineFrameHtml(button("b2"), "chart")}</p>`);
    const b1 = document.getElementById("b1") as HTMLButtonElement;
    const built = createInlineFrame(b1, b1.querySelector("img")!);
    const rendered = document.querySelector<HTMLElement>(`#html > .${FRAME_CLASS}`)!;
    expect(rendered.outerHTML.replace('id="b2"', 'id="b1"')).toBe(built.outerHTML);
    expect(nestedControls(rendered)).toBe(0);
    attachInlineZoom(rendered, { kind: "raster", open: () => {} });
    expect(rendered.getAttribute("data-zoom-state")).toBe(JSON.stringify({ tx: 0, ty: 0, scale: 1 }));
  });
});

describe("inline controller", () => {
  function setup(rect: Rect = { width: 400, height: 300 }) {
    const { window, document, resize, observing } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    layOut(frame, rect);
    const toolbarButtons = Array.from(frame.querySelectorAll("button"));
    const listeners = recordListeners([frame, image, ...toolbarButtons]);
    let opened = 0;
    const zoom = attachInlineZoom(frame, { kind: "raster", open: () => { opened += 1; } });
    return { window, document, image, frame, zoom, listeners, resize, observing, opens: () => opened };
  }

  test("dispose stops observing the frame and its container, so a replaced frame is not kept alive", () => {
    const { frame, zoom, observing } = setup();
    control(frame, "Zoom in").click();
    // The frame's own box and its container's (see watchSize), and its
    // container's width while zoomed.
    expect(observing()).toBe(3);
    const state = zoom.snapshot();
    zoom.dispose();
    expect(observing()).toBe(0);
    // What it carried is still readable for the copy that replaces it.
    expect(zoom.snapshot()).toEqual(state);
  });

  test("registers no wheel listener, and its touch listeners are not passive", () => {
    const { listeners } = setup();
    expect(listeners.map(l => l.type)).not.toContain("wheel");
    const touch = listeners.filter(l => l.type.startsWith("touch"));
    expect(touch.map(l => l.type).sort()).toEqual(["touchcancel", "touchend", "touchmove", "touchstart"]);
    for (const listener of touch) {
      expect(listener.options).toEqual({ passive: false });
    }
  });

  test("attaching twice returns the same controller", () => {
    const { frame, zoom } = setup();
    expect(attachInlineZoom(frame, { kind: "raster", open: () => {} })).toBe(zoom);
  });

  test("touch-action lets one finger scroll at fit, and none once zoomed", () => {
    const { frame } = setup();
    expect(frame.style.touchAction).toBe("pan-x pan-y");
    expect(JSON.parse(frame.getAttribute("data-zoom-state")!)).toEqual({ tx: 0, ty: 0, scale: 1 });

    control(frame, "Zoom in").click();
    expect(frame.classList.contains("is-zoomed")).toBe(true);
    expect(frame.style.touchAction).toBe("none");
    const zoomed = JSON.parse(frame.getAttribute("data-zoom-state")!);
    expect(zoomed.scale).toBeCloseTo(1.25);
    // Anchored on the centre of the box.
    expect(zoomed.tx).toBeCloseTo(-50);
    expect(zoomed.ty).toBeCloseTo(-37.5);
    // The frame keeps its at-fit box while the media scales inside it.
    expect(frame.style.width).toBe("400px");
    expect(frame.style.height).toBe("300px");

    control(frame, "Fit").click();
    expect(frame.classList.contains("is-zoomed")).toBe(false);
    expect(frame.style.touchAction).toBe("pan-x pan-y");
    expect(frame.style.width).toBe("");
    expect(JSON.parse(frame.getAttribute("data-zoom-state")!)).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  test("an image with a percentage width hands the percentage to its frame", () => {
    const { document } = dom('<p><img id="i" alt="Half" src="a.png" width="50%"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    attachInlineZoom(frame, { kind: "raster", open: () => {} });
    expect(frame.classList.contains("is-fluid")).toBe(true);
    expect(frame.style.getPropertyValue("--media-zoom-fluid-width")).toBe("50%");
  });

  test("a viewBox-only image that loaded while hidden is made fluid on the frame after it is shown", () => {
    const { window, document, resize, nextFrame } = dom('<div id="tab"><img id="i" alt="Chart" src="chart.svg"></div>');
    // linkedom computes no styles; this image has no borders or padding.
    window.getComputedStyle = () => ({ getPropertyValue: () => "" });
    const image = document.getElementById("i") as HTMLImageElement;
    const tab = document.getElementById("tab")!;
    // Loaded, with no natural width of its own to lay out at.
    Object.defineProperty(image, "complete", { configurable: true, value: true });
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 800 });
    Object.defineProperty(image, "clientWidth", { configurable: true, value: 0 });
    // Inside a hidden tab: not rendered.
    Object.defineProperty(image, "getClientRects", { configurable: true, value: () => [] });
    const frame = createInlineFrame(image, image);
    attachInlineZoom(frame, { kind: "svg-image", open: () => {} });
    expect(frame.classList.contains("is-fluid")).toBe(false);

    // The tab is shown. The collapsed frame's own box stays empty; its
    // container's box is what changes.
    Object.defineProperty(image, "getClientRects", { configurable: true, value: () => [{ width: 0, height: 0 }] });
    setRect(image, { width: 0, height: 0 });
    resize(tab);
    // Not inside the size notification: resizing the observed frame there
    // makes the browser report a ResizeObserver loop.
    expect(frame.classList.contains("is-fluid")).toBe(false);
    nextFrame();
    expect(frame.classList.contains("is-fluid")).toBe(true);
  });

  test("zoom out never goes below fit", () => {
    const { frame } = setup();
    control(frame, "Zoom out").click();
    expect(frame.classList.contains("is-zoomed")).toBe(false);
    expect(JSON.parse(frame.getAttribute("data-zoom-state")!)).toEqual({ tx: 0, ty: 0, scale: 1 });
    control(frame, "Zoom in").click();
    control(frame, "Zoom out").click();
    expect(frame.classList.contains("is-zoomed")).toBe(false);
  });

  test("small media is marked once measured, before any interaction, and keeps the browser's touch handling", () => {
    const { frame, resize } = setup({ width: 80, height: 20 });
    expect(frame.classList.contains("is-small")).toBe(true);
    expect(frame.style.touchAction).toBe("");

    // The box grows (an image loads): measured again, it gets inline zoom.
    layOut(frame, { width: 96, height: 96 });
    resize(frame);
    expect(frame.classList.contains("is-small")).toBe(false);
    expect(frame.style.touchAction).toBe("pan-x pan-y");

    layOut(frame, { width: 96, height: 95 });
    resize(frame);
    expect(frame.classList.contains("is-small")).toBe(true);
  });

  test("small media is measured by the media itself, not by margins inside its frame", () => {
    const { frame, image, resize } = setup();
    // `hspace` margins: the frame is over the limit, the image under it.
    setRect(frame, { width: 120, height: 120 });
    setRect(image, { width: 80, height: 120 });
    resize(frame);
    expect(frame.classList.contains("is-small")).toBe(true);
    control(frame, "Zoom in").click();
    expect(frame.classList.contains("is-zoomed")).toBe(false);
  });

  test("a click at fit opens the viewer; a click when zoomed does not", () => {
    const { window, frame, image, opens } = setup();
    image.dispatchEvent(event(window, "click", { detail: 1 }));
    expect(opens()).toBe(1);

    control(frame, "Zoom in").click();
    image.dispatchEvent(event(window, "click", { detail: 1 }));
    expect(opens()).toBe(1);

    control(frame, "Open fullscreen viewer").click();
    expect(opens()).toBe(2);
    // Opening the viewer leaves the inline zoom alone.
    expect(frame.classList.contains("is-zoomed")).toBe(true);
  });

  test("the viewer is told which control opened it: the media, or expand", () => {
    const { window, document } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    layOut(frame, { width: 400, height: 300 });
    const openers: HTMLElement[] = [];
    attachInlineZoom(frame, { kind: "raster", open: opener => openers.push(opener) });
    image.dispatchEvent(event(window, "click", { detail: 1 }));
    image.dispatchEvent(event(window, "keydown", { key: "Enter" }));
    control(frame, "Open fullscreen viewer").click();
    expect(openers).toEqual([image, image, control(frame, "Open fullscreen viewer")]);
  });

  test("Enter and Space on an image activator open the viewer", () => {
    const { window, image, opens } = setup();
    const enter = event(window, "keydown", { key: "Enter" });
    image.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    image.dispatchEvent(event(window, "keydown", { key: " " }));
    expect(opens()).toBe(2);
  });

  test("a programmatic click passes through untouched", () => {
    const { window, image, opens } = setup();
    const click = event(window, "click", { detail: 0, isTrusted: false });
    image.dispatchEvent(click);
    expect(opens()).toBe(0);
    expect(click.defaultPrevented).toBe(false);
  });

  test("a pinch whose midpoint moves carries the media point under the fingers with it", () => {
    const { window, image, zoom } = setup();
    const touch = (identifier: number, clientX: number, clientY: number) => ({ identifier, clientX, clientY, target: image });
    const fingers = (type: string, touches: object[], changedTouches: object[]) =>
      image.dispatchEvent(event(window, type, { touches, changedTouches, timeStamp: 0 }));
    // 100px apart around (200, 150), then 200px apart around (200, 180).
    const start = [touch(1, 150, 150), touch(2, 250, 150)];
    fingers("touchstart", start, start);
    const moved = [touch(1, 100, 180), touch(2, 300, 180)];
    fingers("touchmove", moved, moved);
    // At fit the point under (200, 150) is (200, 150): at 2× it now sits
    // under the new midpoint (200, 180).
    const t = zoom.transform();
    expect(t.scale).toBeCloseTo(2, 9);
    expect(t.tx).toBeCloseTo(200 - 200 * 2, 9);
    expect(t.ty).toBeCloseTo(180 - 150 * 2, 9);
  });

  test("modifier clicks on a linked image keep the browser's link behaviour", () => {
    const { window, document } = dom('<p><a id="l" href="other.md"><img id="i" alt="Logo" src="a.png"></a></p>');
    const link = document.getElementById("l") as HTMLAnchorElement;
    const frame = createInlineFrame(link, document.getElementById("i")!);
    layOut(frame, { width: 400, height: 300 });
    let opened = 0;
    attachInlineZoom(frame, { kind: "raster", open: () => { opened += 1; } });

    const modified = event(window, "click", { detail: 1, metaKey: true });
    link.dispatchEvent(modified);
    expect(opened).toBe(0);
    expect(modified.defaultPrevented).toBe(false);

    const plain = event(window, "click", { detail: 1 });
    link.dispatchEvent(plain);
    expect(opened).toBe(1);
    // The link is not followed.
    expect(plain.defaultPrevented).toBe(true);
  });
});

describe("inline controls for narrow media", () => {
  test("media narrower than the compact width gets its toolbar outside its box, wider media inside", () => {
    for (const [width, compact] of [[134, true], [199, true], [200, false], [400, false]] as const) {
      const { document } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
      const image = document.getElementById("i") as HTMLImageElement;
      const frame = createInlineFrame(image, image);
      layOut(frame, { width, height: 300 });
      attachInlineZoom(frame, { kind: "raster", open: () => {} });
      expect(frame.classList.contains("is-compact")).toBe(compact);
    }
  });
});

describe("inline zoom by keyboard and its level", () => {
  function setup() {
    const { window, document } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    layOut(frame, { width: 400, height: 300 });
    const zoom = attachInlineZoom(frame, { kind: "raster", open: () => {} });
    const key = (key: string, shiftKey = false) => {
      const e = event(window, "keydown", { key, shiftKey });
      image.dispatchEvent(e);
      return e;
    };
    const status = () => document.querySelector("body > .media-zoom-status")?.textContent ?? null;
    return { window, document, image, frame, zoom, key, status };
  }

  test("arrow keys on zoomed media pan it without scrolling the page; at fit they keep their default", () => {
    const { frame, zoom, key } = setup();
    expect(key("ArrowRight").defaultPrevented).toBe(false);
    for (let i = 0; i < 3; i += 1) control(frame, "Zoom in").click();
    const start = zoom.transform();
    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(zoom.transform()).toEqual({ ...start, tx: start.tx - KEY_PAN_STEP });
    key("ArrowUp", true);
    // Up shows what is above: the media moves down, until its top edge.
    expect(zoom.transform()).toEqual({ ...start, tx: start.tx - KEY_PAN_STEP, ty: 0 });
  });

  test("zoom out is unavailable at fit and zoom in at the maximum, and both stay focusable", () => {
    const { frame } = setup();
    const unavailable = (label: string) => control(frame, label).getAttribute("aria-disabled") === "true";
    expect(unavailable("Zoom out")).toBe(true);
    expect(unavailable("Zoom in")).toBe(false);
    for (let i = 0; i < 20; i += 1) control(frame, "Zoom in").click();
    expect(unavailable("Zoom in")).toBe(true);
    expect(unavailable("Zoom out")).toBe(false);
    expect(control(frame, "Zoom in").disabled).toBe(false);
    control(frame, "Fit").click();
    expect(unavailable("Zoom out")).toBe(true);
    expect(unavailable("Zoom in")).toBe(false);
  });

  test("a level its controls set is announced politely, relative to fit; a pinch announces nothing", () => {
    const { window, image, frame, status } = setup();
    control(frame, "Zoom in").click();
    expect(status()).toBe("Zoom 125%");
    const region = (image.ownerDocument as Document).querySelector("body > .media-zoom-status")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    control(frame, "Fit").click();
    expect(status()).toBe("Zoom 100%");
    const touch = (identifier: number, clientX: number) => ({ identifier, clientX, clientY: 150, target: image });
    const fingers = (type: string, touches: object[]) => image.dispatchEvent(event(window, type, { touches, changedTouches: touches, timeStamp: 0 }));
    fingers("touchstart", [touch(1, 150), touch(2, 250)]);
    fingers("touchmove", [touch(1, 100), touch(2, 300)]);
    expect(status()).toBe("Zoom 100%");
  });
});

describe("zoom carried across re-renders", () => {
  // One framed image with a controller, laid out at `rect`.
  function media(rect: Rect = { width: 400, height: 300 }) {
    const { document } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    layOut(frame, rect);
    const zoom = attachInlineZoom(frame, { kind: "raster", open: () => {} });
    return { frame, zoom };
  }

  function zoomed(rect?: Rect): InlineZoom {
    const { frame, zoom } = media(rect);
    control(frame, "Zoom in").click();
    control(frame, "Zoom in").click();
    return zoom;
  }

  const FIT = { tx: 0, ty: 0, scale: 1 };

  // A carry that has mounted `session` once, as the preview does on each render.
  function carryFor(session: string, identities: string[]) {
    const carry = createZoomCarry();
    expect(carry.begin(session)).toBe(false);
    carry.mounted(identities);
    return carry;
  }

  test("matched media gets its scale and pan back, relative to its new box", () => {
    const before = zoomed();
    const carry = carryFor("doc", ["img:a"]);
    expect(carry.begin("doc")).toBe(true);
    carry.save([["img:a", before]]);
    expect(carry.mounted(["img:a"]).has("img:a")).toBe(true);

    const same = media();
    expect(carry.restore("img:a", same.zoom)).toBe(true);
    expect(same.zoom.transform()).toEqual(before.transform());
    expect(same.frame.getAttribute("data-zoom-state")).toBe(JSON.stringify(before.transform()));

    // Restoring consumes the saved zoom.
    expect(carry.restore("img:a", media().zoom)).toBe(false);
  });

  test("the pan follows the box when the same shape is laid out larger", () => {
    const before = zoomed();
    const carry = carryFor("doc", ["img:a"]);
    carry.begin("doc");
    carry.save([["img:a", before]]);
    carry.mounted(["img:a"]);
    const larger = media({ width: 800, height: 600 });
    expect(carry.restore("img:a", larger.zoom)).toBe(true);
    const { tx, ty, scale } = before.transform();
    expect(larger.zoom.transform().scale).toBeCloseTo(scale);
    expect(larger.zoom.transform().tx).toBeCloseTo(tx * 2);
    expect(larger.zoom.transform().ty).toBeCloseTo(ty * 2);
  });

  test("a changed aspect ratio resets to fit; within 1% it carries", () => {
    const carry = carryFor("doc", ["img:a", "img:b"]);
    carry.begin("doc");
    carry.save([["img:a", zoomed()], ["img:b", zoomed()]]);
    carry.mounted(["img:a", "img:b"]);

    const reshaped = media({ width: 400, height: 400 });
    expect(carry.restore("img:a", reshaped.zoom)).toBe(false);
    expect(reshaped.zoom.transform()).toEqual(FIT);
    expect(reshaped.frame.classList.contains("is-zoomed")).toBe(false);

    // 400×302 is 0.7% off 400×300.
    const nearly = media({ width: 400, height: 302 });
    expect(carry.restore("img:b", nearly.zoom)).toBe(true);
    expect(nearly.zoom.transform().scale).toBeCloseTo(1.25 ** 2);
  });

  test("a change in diagram count drops every diagram's zoom, and only theirs", () => {
    const carry = carryFor("doc", ["mermaid:0", "mermaid:1", "img:a"]);
    carry.begin("doc");
    // An unrendered diagram has no controller yet, and still counts.
    carry.save([["mermaid:0", zoomed()], ["mermaid:1", null], ["img:a", zoomed()]]);
    const matched = carry.mounted(["mermaid:0", "mermaid:1", "mermaid:2", "img:a"]);
    expect([...matched].sort()).toEqual(["img:a"]);
    expect(carry.restore("mermaid:0", media().zoom)).toBe(false);
    expect(carry.restore("img:a", media().zoom)).toBe(true);

    // The same count matches diagrams by position.
    const steady = carryFor("doc", ["mermaid:0", "mermaid:1"]);
    steady.begin("doc");
    steady.save([["mermaid:0", null], ["mermaid:1", zoomed()]]);
    expect(steady.mounted(["mermaid:0", "mermaid:1"]).has("mermaid:1")).toBe(true);
    expect(steady.restore("mermaid:1", media().zoom)).toBe(true);
  });

  test("media missing from the new render is not matched, and new media starts at fit", () => {
    const carry = carryFor("doc", ["img:a"]);
    carry.begin("doc");
    carry.save([["img:a", zoomed()]]);
    const matched = carry.mounted(["img:b"]);
    expect(matched.has("img:a")).toBe(false);
    expect(matched.has("img:b")).toBe(true);
    const fresh = media();
    expect(carry.restore("img:b", fresh.zoom)).toBe(false);
    expect(fresh.zoom.transform()).toEqual(FIT);
    // Gone for good: it does not come back if the media returns later.
    carry.mounted(["img:a", "img:b"]);
    expect(carry.restore("img:a", media().zoom)).toBe(false);
  });

  test("media back at fit forgets an earlier saved zoom", () => {
    const carry = carryFor("doc", ["img:a"]);
    const { frame, zoom } = media();
    control(frame, "Zoom in").click();
    carry.begin("doc");
    carry.save([["img:a", zoom]]);
    control(frame, "Fit").click();
    carry.begin("doc");
    carry.save([["img:a", zoom]]);
    carry.mounted(["img:a"]);
    expect(carry.restore("img:a", media().zoom)).toBe(false);
  });

  test("a different session discards everything, including on the way back", () => {
    const carry = carryFor("doc", ["img:a"]);
    carry.begin("doc");
    carry.save([["img:a", zoomed()]]);
    expect(carry.begin("other")).toBe(false);
    // The body on screen still belongs to the old session: nothing is saved.
    carry.save([["img:a", zoomed()]]);
    carry.mounted(["img:a"]);
    expect(carry.restore("img:a", media().zoom)).toBe(false);

    expect(carry.begin("doc")).toBe(false);
    carry.mounted(["img:a"]);
    expect(carry.restore("img:a", media().zoom)).toBe(false);

    // And clearing is a session change of its own.
    carry.begin("doc");
    carry.save([["img:a", zoomed()]]);
    carry.clear();
    expect(carry.begin("doc")).toBe(false);
  });
});

describe("inline zoom across a source swapped in place", () => {
  function zoomedImage() {
    const { document } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    const frame = createInlineFrame(image, image);
    layOut(frame, { width: 400, height: 300 });
    const zoom = attachInlineZoom(frame, { kind: "raster", open: () => {} });
    control(frame, "Zoom in").click();
    return { frame, zoom };
  }

  test("refit keeps the zoom when the shape holds and returns to fit when it changed", () => {
    const kept = zoomedImage();
    const before = kept.zoom.transform();
    kept.zoom.refit();
    expect(kept.zoom.transform()).toEqual(before);

    const reshaped = zoomedImage();
    layOut(reshaped.frame, { width: 400, height: 100 });
    reshaped.zoom.refit();
    expect(reshaped.zoom.transform()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  test("at fit there is nothing to carry", () => {
    const { frame, zoom } = zoomedImage();
    control(frame, "Fit").click();
    expect(zoom.snapshot()).toBeNull();
  });
});

describe("carried zoom and the media's own shape", () => {
  function naturally(image: HTMLImageElement, width: number, height: number): void {
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  }

  // A framed image laid out at `rect` whose loaded source is `natural`.
  function media(rect: Rect, natural: Rect) {
    const { document } = dom('<p><img id="i" alt="Shot" src="a.png" width="400" height="300"></p>');
    const image = document.getElementById("i") as HTMLImageElement;
    naturally(image, natural.width, natural.height);
    const frame = createInlineFrame(image, image);
    layOut(frame, rect);
    const zoom = attachInlineZoom(frame, { kind: "raster", open: () => {} });
    return { image, frame, zoom };
  }

  test("a source of another shape laid out in the same box resets to fit", () => {
    const before = media({ width: 400, height: 300 }, { width: 400, height: 300 });
    control(before.frame, "Zoom in").click();
    const state = before.zoom.snapshot()!;
    // Explicit width and height hold the box while the image itself turned wide.
    const after = media({ width: 400, height: 300 }, { width: 1200, height: 300 });
    expect(after.zoom.restore(state)).toBe(false);
    expect(after.zoom.transform()).toEqual({ tx: 0, ty: 0, scale: 1 });

    const same = media({ width: 400, height: 300 }, { width: 800, height: 600 });
    expect(same.zoom.restore(state)).toBe(true);
  });

  test("a source swapped in place for one of another shape returns to fit", () => {
    const { image, frame, zoom } = media({ width: 400, height: 300 }, { width: 400, height: 300 });
    control(frame, "Zoom in").click();
    naturally(image, 1200, 300);
    zoom.refit();
    expect(zoom.transform()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  test("a carried zoom is not applied to a copy now below the small-media size", () => {
    const before = media({ width: 400, height: 300 }, { width: 400, height: 300 });
    control(before.frame, "Zoom in").click();
    const after = media({ width: 80, height: 60 }, { width: 400, height: 300 });
    expect(after.zoom.restore(before.zoom.snapshot()!)).toBe(false);
    expect(after.frame.classList.contains("is-small")).toBe(true);
    expect(after.frame.classList.contains("is-zoomed")).toBe(false);
  });
});

describe("raster pixels inline", () => {
  // linkedom's window writes through to the global object: undo it after each test.
  const keys = ["devicePixelRatio", "visualViewport"] as const;
  let saved: (PropertyDescriptor | undefined)[] = [];
  beforeEach(() => {
    saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  });
  afterEach(() => {
    keys.forEach((key, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  });

  function atFit(natural: number, displayed: number, devicePixelRatio: number, kind: "raster" | "svg-image" = "raster") {
    const { window, document } = dom('<p><img id="i" alt="Shot" src="a.png"></p>');
    window.devicePixelRatio = devicePixelRatio;
    window.visualViewport = null;
    const image = document.getElementById("i") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: natural });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: natural });
    const frame = createInlineFrame(image, image);
    layOut(frame, { width: displayed, height: displayed });
    attachInlineZoom(frame, { kind, open: () => {} });
    return frame;
  }

  test("at fit a raster stays smooth, even when it already covers more device pixels than it has", () => {
    expect(atFit(200, 200, 2).classList.contains("is-pixelated")).toBe(false);
    expect(atFit(200, 200, 1).classList.contains("is-pixelated")).toBe(false);
  });

  test("zoomed in past fit, a raster renders sharp once it covers more device pixels than it has", () => {
    // 400px natural at 200 CSS px on a 2× screen: 1.25× is 500 device px.
    const enlarged = atFit(400, 200, 2);
    control(enlarged, "Zoom in").click();
    expect(enlarged.classList.contains("is-pixelated")).toBe(true);
    // 400px natural at 200 CSS px on a 1× screen: 1.25× is 250 device px.
    const reduced = atFit(400, 200, 1);
    control(reduced, "Zoom in").click();
    expect(reduced.classList.contains("is-pixelated")).toBe(false);
    const vector = atFit(200, 200, 2, "svg-image");
    control(vector, "Zoom in").click();
    expect(vector.classList.contains("is-pixelated")).toBe(false);
  });

  test("a source a srcset picked is measured by its own bitmap, not its density-corrected width", () => {
    const { window, document } = dom('<p><img id="i" alt="Shot" src="fallback.png"></p>');
    window.devicePixelRatio = 1;
    window.visualViewport = null;
    const image = document.getElementById("i") as HTMLImageElement;
    // An 800px-wide "2x" candidate reports 400 natural px.
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 400 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 200 });
    Object.defineProperty(image, "currentSrc", { configurable: true, value: "http://127.0.0.1/dense.png" });
    const probes: HTMLImageElement[] = [];
    const create = document.createElement.bind(document);
    (document as any).createElement = (tag: string) => {
      const element = create(tag);
      if (tag === "img") probes.push(element as HTMLImageElement);
      return element;
    };
    const frame = createInlineFrame(image, image);
    layOut(frame, { width: 400, height: 200 });
    attachInlineZoom(frame, { kind: "raster", open: () => {} });
    image.dispatchEvent(new window.Event("load"));
    expect(probes.map(probe => probe.getAttribute("src"))).toEqual(["http://127.0.0.1/dense.png"]);
    Object.defineProperty(probes[0]!, "naturalWidth", { configurable: true, value: 800 });
    probes[0]!.dispatchEvent(new window.Event("load"));

    // 1.25× is 500 device px, below the bitmap's 800.
    control(frame, "Zoom in").click();
    expect(frame.classList.contains("is-pixelated")).toBe(false);
    // 1.25⁴× is about 977, past it.
    for (let step = 0; step < 3; step += 1) control(frame, "Zoom in").click();
    expect(frame.classList.contains("is-pixelated")).toBe(true);
  });

  test("returning to fit restores smoothing", () => {
    const frame = atFit(200, 200, 2);
    control(frame, "Zoom in").click();
    expect(frame.classList.contains("is-pixelated")).toBe(true);
    control(frame, "Fit").click();
    expect(frame.classList.contains("is-pixelated")).toBe(false);
  });
});

describe("accessible names of image activators", () => {
  test("an image-only link with no name of its own gets the fallback name", () => {
    const { document } = dom('<p><a id="l" href="other.md"><img id="i" alt="" src="a.png"></a></p>');
    const link = document.getElementById("l") as HTMLAnchorElement;
    createInlineFrame(link, document.getElementById("i")!);
    expect(link.getAttribute("aria-label")).toBe("Open image in fullscreen viewer");
  });

  test("authored names are kept: the image's alt, the link's label, its title", () => {
    for (const markup of [
      '<a id="l" href="o.md"><img id="i" alt="Logo" src="a.png"></a>',
      '<a id="l" href="o.md" aria-label="Project home"><img id="i" alt="" src="a.png"></a>',
      '<a id="l" href="o.md" title="Project home"><img id="i" src="a.png"></a>',
    ]) {
      const { document } = dom(`<p>${markup}</p>`);
      const link = document.getElementById("l") as HTMLAnchorElement;
      const before = link.getAttribute("aria-label");
      createInlineFrame(link, document.getElementById("i")!);
      expect(link.getAttribute("aria-label")).toBe(before);
    }
  });
});
