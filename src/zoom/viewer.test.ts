import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { DOUBLE_TAP_MAX_GAP_MS } from "./gestures";
import { FIT_MARGIN, KEY_PAN_STEP, KEY_PAN_STEP_LARGE, MAX_SCALE, PAN_KEEP_VISIBLE } from "./transform";

type Harness = {
  window: Window & typeof globalThis;
  document: Document;
  viewer: typeof import("./viewer");
  restore(): void;
};

const GLOBALS = ["window", "document", "Event", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio", "visualViewport"];

// Browsers queue a dialog's close event as a task; by default it fires at
// once here, and `deferCloseEvents` holds it until `flushCloseEvents`.
let queuedCloseEvents: (() => void)[] | null = null;
function deferCloseEvents(): void {
  queuedCloseEvents = [];
}
function flushCloseEvents(): void {
  const queued = queuedCloseEvents ?? [];
  queuedCloseEvents = null;
  for (const fire of queued) fire();
}

// linkedom has no <dialog> behaviour; give it the two methods and the `open`
// reflection the viewer relies on, and fire `close` the way browsers do.
// linkedom's element classes are shared by every document in the process (a
// dialog is a plain HTMLElement), so the patch is undone after each harness:
// left in place, a getter-only `open` breaks `details.open = true` in any test
// file that runs later in the same process. Returns the undo.
function polyfillDialog(window: any): () => void {
  const proto = Object.getPrototypeOf(window.document.createElement("dialog"));
  const saved = ["open", "showModal", "close"].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const undo = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else Reflect.deleteProperty(proto, key);
    }
  };
  Object.defineProperty(proto, "open", {
    configurable: true,
    get(this: Element) {
      return this.hasAttribute("open");
    },
  });
  proto.showModal = function (this: Element) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: Element) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    const fire = () => this.dispatchEvent(new window.Event("close"));
    if (queuedCloseEvents) queuedCloseEvents.push(fire);
    else fire();
  };
  return undo;
}

async function harness(): Promise<Harness> {
  const { window, document } = parseHTML(
    '<html><body><div id="preview"><a id="link" href="/docs/other.md"><img id="thumb" alt="Thumb" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></div></body></html>',
  );
  const undoDialog = polyfillDialog(window);
  const saved = GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const values: Record<string, unknown> = {
    window,
    document,
    Event: window.Event,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    devicePixelRatio: 1,
    // linkedom's window reads through to the global object, so a test that
    // gives the page a pinch zoom sets it here, and it is undone with the rest.
    visualViewport: null,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // A fresh module instance per harness, so its one dialog belongs to this document.
  const viewer = (await import(`./viewer?harness=${Math.random()}`)) as typeof import("./viewer");
  return {
    window: window as unknown as Window & typeof globalThis,
    document: document as unknown as Document,
    viewer,
    restore() {
      undoDialog();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function toolbarLabels(document: Document): string[] {
  return Array.from(document.querySelectorAll(".media-viewer-toolbar button")).map(
    button => button.getAttribute("aria-label") ?? "",
  );
}

function mermaidSvg(document: Document): SVGElement {
  const holder = document.createElement("div");
  holder.innerHTML =
    '<svg id="mermaid-1" viewBox="0 0 400 200"><style>#mermaid-1 .node{fill:#eee}</style><defs><marker id="arrow"></marker></defs><path marker-end="url(#arrow)"></path></svg>';
  return holder.querySelector("svg") as unknown as SVGElement;
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(() => {
  flushCloseEvents();
  // As a reader would close it, whichever open a test left it on.
  h.document.querySelector<HTMLDialogElement>("dialog.media-viewer")?.close();
  h.restore();
});

describe("media viewer toolbar", () => {
  test("a Mermaid diagram gets zoom out, zoom in, fit and close", () => {
    const trigger = h.document.createElement("button");
    h.document.body.appendChild(trigger);
    h.viewer.openMediaViewer({ kind: "mermaid", svg: mermaidSvg(h.document) }, { returnFocusTo: trigger });
    expect(toolbarLabels(h.document)).toEqual([
      "Zoom out",
      "Zoom in",
      "Fit to screen",
      "Close diagram viewer",
    ]);
    expect(h.document.querySelector("dialog.media-viewer")?.getAttribute("aria-label")).toBe("Diagram viewer");
  });

  test("raster media adds 1:1 actual pixels before close", () => {
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png", alt: "Shot" }, {});
    expect(toolbarLabels(h.document)).toEqual([
      "Zoom out",
      "Zoom in",
      "Fit to screen",
      "1:1 actual pixels",
      "Close image viewer",
    ]);
  });

  test("SVG media has no actual-pixels action", () => {
    h.viewer.openMediaViewer({ kind: "svg-image", src: "http://localhost/figure.svg" }, {});
    expect(toolbarLabels(h.document)).not.toContain("1:1 actual pixels");
  });

  test("linked media adds Open link after the zoom actions; unlinked media has none", () => {
    const link = h.document.getElementById("link") as unknown as HTMLAnchorElement;
    const linked = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png", link }, {});
    expect(toolbarLabels(h.document)).toEqual([
      "Zoom out",
      "Zoom in",
      "Fit to screen",
      "1:1 actual pixels",
      "Open link",
      "Close image viewer",
    ]);
    linked.close();
    h.viewer.openMediaViewer({ kind: "svg-image", src: "http://localhost/figure.svg" }, {});
    expect(toolbarLabels(h.document)).not.toContain("Open link");
  });

  test("Open link closes the viewer and then clicks the link itself", () => {
    const link = h.document.getElementById("link") as unknown as HTMLAnchorElement;
    const events: string[] = [];
    link.addEventListener("click", event => {
      event.preventDefault();
      events.push(`click:${h.document.querySelector("dialog.media-viewer")?.hasAttribute("open")}`);
    });
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png", link }, {});
    const openLink = h.document.querySelector<HTMLButtonElement>(
      '.media-viewer-toolbar [aria-label="Open link"]',
    )!;
    openLink.click();
    expect(events).toEqual(["click:false"]);
  });
});

describe("media viewer stage", () => {
  test("an image opens from the supplied real source, never a placeholder, and stays an <img>", () => {
    const thumb = h.document.getElementById("thumb") as unknown as HTMLImageElement;
    h.viewer.openMediaViewer(
      { kind: "svg-image", src: "http://localhost/docs/figure.svg?revision=3", alt: "Figure" },
      { returnFocusTo: thumb },
    );
    const stage = h.document.querySelector(".media-viewer-stage")!;
    const content = Array.from(stage.children);
    expect(content).toHaveLength(1);
    expect(content[0]!.tagName).toBe("IMG");
    expect(content[0]!.getAttribute("src")).toBe("http://localhost/docs/figure.svg?revision=3");
    expect(content[0]!.getAttribute("src")).not.toBe(thumb.getAttribute("src"));
    expect(content[0]!.getAttribute("alt")).toBe("Figure");
    expect(stage.querySelector("svg, object, iframe, embed")).toBeNull();
  });

  test("a Mermaid diagram is cloned with namespaced ids, leaving the inline SVG alone", () => {
    const svg = mermaidSvg(h.document);
    h.viewer.openMediaViewer({ kind: "mermaid", svg }, {});
    const clone = h.document.querySelector(".media-viewer-stage > svg")!;
    expect(clone).not.toBe(svg as unknown as Element);
    expect(svg.getAttribute("id")).toBe("mermaid-1");
    const rootId = clone.getAttribute("id")!;
    expect(rootId).not.toBe("mermaid-1");
    expect(rootId.endsWith("mermaid-1")).toBe(true);
    const markerId = clone.querySelector("marker")!.getAttribute("id")!;
    expect(clone.querySelector("path")!.getAttribute("marker-end")).toBe(`url(#${markerId})`);
    expect(clone.querySelector("style")!.textContent).toContain(`#${rootId} .node`);
    // The clone carries its viewBox size so it does not fall back to 300×150.
    expect(clone.getAttribute("width")).toBe("400");
    expect(clone.getAttribute("height")).toBe("200");
  });

  test("a caption is shown as text when the surface gives one, and absent otherwise", () => {
    const name = '<img src=x onerror="alert(1)">.png';
    const captioned = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png", alt: "Shot", caption: name }, {});
    const caption = h.document.querySelector<HTMLElement>(".media-viewer-caption")!;
    expect(caption.hidden).toBe(false);
    expect(caption.textContent).toBe(name);
    expect(caption.children).toHaveLength(0);
    captioned.close();
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png", alt: "Shot" }, {});
    expect(h.document.querySelector<HTMLElement>(".media-viewer-caption")!.hidden).toBe(true);
    expect(h.document.querySelector<HTMLElement>(".media-viewer-caption")!.textContent).toBe("");
  });

  test("the stage reports no committed state until the media is fitted", () => {
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png" }, {});
    const stage = h.document.querySelector(".media-viewer-stage")!;
    expect(stage.hasAttribute("data-zoom-state")).toBe(false);
    expect(stage.hasAttribute("data-zoom-pending")).toBe(true);
  });
});

describe("closing the media viewer", () => {
  test("returns focus to the element that opened it, then runs afterClose", () => {
    const thumb = h.document.getElementById("thumb") as unknown as HTMLImageElement;
    const calls: string[] = [];
    thumb.focus = () => calls.push("focus");
    const session = h.viewer.openMediaViewer(
      { kind: "raster", src: "http://localhost/shot.png" },
      { returnFocusTo: thumb, afterClose: () => calls.push("afterClose") },
    );
    session.close();
    expect(calls).toEqual(["focus", "afterClose"]);
    expect(h.document.querySelector("dialog.media-viewer")!.hasAttribute("open")).toBe(false);
    expect(h.document.querySelector(".media-viewer-stage")!.children.length).toBe(0);
  });

  test("does not focus an opener that has left the document", () => {
    const thumb = h.document.getElementById("thumb") as unknown as HTMLImageElement;
    let focused = false;
    thumb.focus = () => {
      focused = true;
    };
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png" }, { returnFocusTo: thumb });
    thumb.remove();
    session.close();
    expect(focused).toBe(false);
  });

  test("the close control closes the viewer", () => {
    h.viewer.openMediaViewer({ kind: "mermaid", svg: mermaidSvg(h.document) }, {});
    h.document.querySelector<HTMLButtonElement>(".media-viewer-close")!.click();
    expect(h.document.querySelector("dialog.media-viewer")!.hasAttribute("open")).toBe(false);
  });

  test("an open before the last close's event arrives keeps its own content and hooks", () => {
    deferCloseEvents();
    const calls: string[] = [];
    const first = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/a.png" }, { afterClose: () => calls.push("a") });
    first.close();
    // A tap's follow-up click opening media straight away, in the same task.
    const second = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/b.png" }, { afterClose: () => calls.push("b") });
    flushCloseEvents();
    expect(h.document.querySelector("dialog.media-viewer")!.hasAttribute("open")).toBe(true);
    expect(h.document.querySelector(".media-viewer-stage img")!.getAttribute("src")).toBe("http://localhost/b.png");
    expect(calls).toEqual(["a"]);
    second.close();
    flushCloseEvents();
    expect(calls).toEqual(["a", "b"]);
  });

  test("a touch on the viewer never ends in a click on what lies beneath it", () => {
    h.viewer.openMediaViewer({ kind: "mermaid", svg: mermaidSvg(h.document) }, {});
    const end = new h.window.Event("touchend", { bubbles: true, cancelable: true });
    h.document.querySelector(".media-viewer-viewport")!.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);
  });

  test("a second open replaces the first opener's hooks", () => {
    const calls: string[] = [];
    const first = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/a.png" }, { afterClose: () => calls.push("a") });
    const second = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/b.png" }, { afterClose: () => calls.push("b") });
    expect(h.document.querySelector(".media-viewer-stage img")!.getAttribute("src")).toBe("http://localhost/b.png");
    // The first open's handle no longer reaches the viewer.
    first.close();
    expect(h.document.querySelector("dialog.media-viewer")!.hasAttribute("open")).toBe(true);
    second.close();
    expect(calls).toEqual(["b"]);
  });
});

describe("a viewer session across re-renders", () => {
  function diagram(viewBox: string, label: string): SVGElement {
    const holder = h.document.createElement("div");
    holder.innerHTML = `<svg viewBox="${viewBox}"><text>${label}</text></svg>`;
    return holder.querySelector("svg") as unknown as SVGElement;
  }

  // linkedom does no layout: give the viewport the box a browser would.
  function sizeViewport(width = 800, height = 600): void {
    const viewport = h.document.querySelector(".media-viewer-viewport")!;
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, x: 0, y: 0, right: width, bottom: height, width, height }),
    });
  }

  // A pointer event as the viewport receives it, from a touch screen unless
  // another pointer type is given.
  function pointer(type: string, id: number, x: number, y: number, time: number, pointerType = "touch"): void {
    const event = new h.window.Event(type, { bubbles: true });
    for (const [key, value] of Object.entries({ pointerId: id, clientX: x, clientY: y, timeStamp: time, pointerType, button: 0 })) {
      Object.defineProperty(event, key, { value });
    }
    h.document.querySelector(".media-viewer-viewport")!.dispatchEvent(event);
  }

  const state = () => JSON.parse(h.document.querySelector(".media-viewer-stage")!.getAttribute("data-zoom-state")!);
  const press = (label: string) =>
    h.document.querySelector<HTMLButtonElement>(`.media-viewer-toolbar [aria-label="${label}"]`)!.click();

  test("acts only on the open that returned it", () => {
    const first = h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
    expect(first.isOpen()).toBe(true);
    const second = h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "Two") }, {});
    expect(first.isOpen()).toBe(false);
    first.replace({ kind: "mermaid", svg: diagram("0 0 400 200", "Stale") });
    first.close();
    expect(h.document.querySelector(".media-viewer-stage text")!.textContent).toBe("Two");
    expect(second.isOpen()).toBe(true);
    second.close();
    expect(second.isOpen()).toBe(false);
  });

  test("a re-rendered diagram is re-cloned at the same scale and pan while its shape holds, and fits when it changed", () => {
    const session = h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
    sizeViewport();
    press("Zoom in");
    press("Zoom in");
    const zoomed = state();

    session.replace({ kind: "mermaid", svg: diagram("0 0 400 200", "Two") });
    expect(h.document.querySelector(".media-viewer-stage text")!.textContent).toBe("Two");
    expect(state()).toEqual(zoomed);

    session.replace({ kind: "mermaid", svg: diagram("0 0 400 400", "Three") });
    expect(h.document.querySelector(".media-viewer-stage text")!.textContent).toBe("Three");
    const reshaped = state();
    press("Fit to screen");
    expect(reshaped).toEqual(state());
    expect(reshaped).not.toEqual(zoomed);
  });

  test("media too large for the minimum scale opens whole at fit, and zoom out stays there", () => {
    h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 3000 2000", "Huge") }, {});
    sizeViewport(390, 844);
    press("Fit to screen");
    const fitted = state();
    expect(fitted.scale).toBeCloseTo((390 - 32) / 3000, 6);
    expect(fitted.tx).toBeGreaterThanOrEqual(0);
    expect(fitted.tx + 3000 * fitted.scale).toBeLessThanOrEqual(390);
    press("Zoom out");
    expect(state().scale).toBeCloseTo(fitted.scale, 6);
  });

  test("a pinch whose midpoint moves carries the media point under the fingers with it", () => {
    h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
    sizeViewport();
    press("Fit to screen");
    const start = state();
    // Fingers 100px apart around (400, 300), then 200px apart around (450, 330).
    pointer("pointerdown", 1, 350, 300, 0);
    pointer("pointerdown", 2, 450, 300, 0);
    const under = { u: (400 - start.tx) / start.scale, v: (300 - start.ty) / start.scale };
    pointer("pointermove", 1, 350, 330, 16);
    pointer("pointermove", 2, 550, 330, 16);
    pointer("pointerup", 1, 350, 330, 32);
    pointer("pointerup", 2, 550, 330, 32);
    press("Zoom in");
    press("Zoom out");
    const after = state();
    expect(after.scale).toBeCloseTo(start.scale * 2, 6);
    expect((450 - after.tx) / after.scale).toBeCloseTo(under.u, 4);
    expect((330 - after.ty) / after.scale).toBeCloseTo(under.v, 4);
  });

  test("orphan keeps the content on show, at fit, without its link", () => {
    const link = h.document.getElementById("link") as unknown as HTMLAnchorElement;
    const session = h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One"), link }, {});
    sizeViewport();
    press("Fit to screen");
    const fitted = state();
    press("Zoom in");
    expect(toolbarLabels(h.document)).toContain("Open link");
    session.orphan();
    expect(state()).toEqual(fitted);
    expect(h.document.querySelector(".media-viewer-stage text")!.textContent).toBe("One");
    expect(toolbarLabels(h.document)).not.toContain("Open link");
  });

  test("a re-render that keeps the toolbar's actions leaves its controls in place", () => {
    const link = h.document.getElementById("link") as unknown as HTMLAnchorElement;
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png", link }, {});
    const controls = Array.from(h.document.querySelectorAll(".media-viewer-toolbar button"));
    const removed: string[] = [];
    for (const button of controls) {
      const original = button.remove.bind(button);
      (button as any).remove = () => {
        removed.push(button.getAttribute("aria-label")!);
        original();
      };
    }
    session.replace({ kind: "raster", src: "http://localhost/shot.png", link });
    expect(Array.from(h.document.querySelectorAll(".media-viewer-toolbar button"))).toEqual(controls);
    session.replace({ kind: "raster", src: "http://localhost/shot.png" });
    expect(removed).toEqual(["Open link"]);
    expect(toolbarLabels(h.document)).toEqual(["Zoom out", "Zoom in", "Fit to screen", "1:1 actual pixels", "Close image viewer"]);
    session.replace({ kind: "raster", src: "http://localhost/shot.png", link });
    expect(toolbarLabels(h.document)).toEqual(["Zoom out", "Zoom in", "Fit to screen", "1:1 actual pixels", "Open link", "Close image viewer"]);
  });

  test("an unchanged image source keeps its image, and the link and focus target follow the new copy", () => {
    const link = h.document.getElementById("link") as unknown as HTMLAnchorElement;
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png?revision=1" }, {});
    const image = h.document.querySelector(".media-viewer-stage img");
    session.replace({ kind: "raster", src: "http://localhost/shot.png?revision=1", link });
    expect(h.document.querySelector(".media-viewer-stage img")).toBe(image);
    expect(toolbarLabels(h.document)).toContain("Open link");

    // A new source is loaded before it replaces what is shown.
    session.replace({ kind: "raster", src: "http://localhost/shot.png?revision=2" });
    expect(h.document.querySelector(".media-viewer-stage img")).toBe(image);
    expect(toolbarLabels(h.document)).not.toContain("Open link");
  });

  // Every <img> the viewer creates, so a test can finish loading one.
  function recordImages(): HTMLImageElement[] {
    const created: HTMLImageElement[] = [];
    const original = h.document.createElement.bind(h.document);
    (h.document as any).createElement = (tag: string, ...rest: unknown[]) => {
      const element = (original as any)(tag, ...rest);
      if (tag === "img") created.push(element);
      return element;
    };
    return created;
  }

  function finishLoading(image: HTMLImageElement, width: number, height: number): void {
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
    image.dispatchEvent(new h.window.Event("load"));
  }

  test("a replacement in another format brings that format's actions once it is swapped in, and focus on a control that goes moves to close", () => {
    runFrames();
    const images = recordImages();
    // A <picture> whose picked source turns from a PNG into an SVG and back.
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png" }, {});
    sizeViewport();
    finishLoading(images[0]!, 640, 480);
    const dialog = h.document.querySelector<HTMLElement>("dialog.media-viewer")!;
    // linkedom has no focus: track it by hand, on 1:1 to begin with.
    let focused: Element | null = h.document.querySelector('.media-viewer-toolbar [aria-label="1:1 actual pixels"]');
    Object.defineProperty(h.document, "activeElement", { configurable: true, get: () => focused });
    for (const button of Array.from(h.document.querySelectorAll<HTMLButtonElement>(".media-viewer-toolbar button, .media-viewer-button"))) {
      button.focus = () => {
        focused = button;
      };
    }

    session.replace({ kind: "svg-image", src: "http://localhost/figure.svg" });
    // Until the replacement has loaded, the PNG and its actions stay.
    expect(toolbarLabels(h.document)).toContain("1:1 actual pixels");
    finishLoading(images[1]!, 640, 480);
    expect(toolbarLabels(h.document)).toEqual(["Zoom out", "Zoom in", "Fit to screen", "Close image viewer"]);
    expect(dialog.dataset.mediaKind).toBe("svg-image");
    expect(focused?.getAttribute("aria-label")).toBe("Close image viewer");
    expect(h.document.querySelector(".media-viewer-stage")!.classList.contains("is-pixelated")).toBe(false);

    session.replace({ kind: "raster", src: "http://localhost/shot.png?revision=2" });
    finishLoading(images[2]!, 640, 480);
    expect(toolbarLabels(h.document)).toEqual(["Zoom out", "Zoom in", "Fit to screen", "1:1 actual pixels", "Close image viewer"]);
    expect(dialog.dataset.mediaKind).toBe("raster");
  });

  test("a replacement still loading when its media goes is never swapped in", () => {
    const images = recordImages();
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png?revision=1" }, {});
    sizeViewport();
    finishLoading(images[0]!, 640, 480);
    const shown = h.document.querySelector(".media-viewer-stage img");
    session.replace({ kind: "raster", src: "http://localhost/shot.png?revision=2" });
    session.orphan();
    finishLoading(images[1]!, 640, 480);
    expect(h.document.querySelector(".media-viewer-stage img")).toBe(shown);
    // A later copy of the same source is loaded afresh, not taken as pending.
    session.replace({ kind: "raster", src: "http://localhost/shot.png?revision=2" });
    expect(images).toHaveLength(3);
  });

  // Run animation-frame callbacks at once, as the next frame would.
  function runFrames(): void {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => {
      callback(0);
      return 0;
    };
  }

  test("media removed while its first load is in flight is still shown, at fit", () => {
    runFrames();
    const images = recordImages();
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png?revision=1" }, {});
    sizeViewport();
    session.orphan();
    finishLoading(images[0]!, 640, 480);
    const stage = h.document.querySelector<HTMLElement>(".media-viewer-stage")!;
    expect(stage.querySelector("img")).toBe(images[0]!);
    expect(stage.style.visibility).toBe("");
    const fitted = state();
    press("Zoom in");
    press("Fit to screen");
    expect(state()).toEqual(fitted);
  });

  test("a request for the source on show abandons a different replacement still loading", () => {
    runFrames();
    const images = recordImages();
    const session = h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/a.png" }, {});
    sizeViewport();
    finishLoading(images[0]!, 640, 480);
    session.replace({ kind: "raster", src: "http://localhost/b.png" });
    session.replace({ kind: "raster", src: "http://localhost/a.png" });
    finishLoading(images[1]!, 640, 480);
    expect(h.document.querySelector(".media-viewer-stage img")).toBe(images[0]!);
    // B requested again loads afresh rather than counting as pending.
    session.replace({ kind: "raster", src: "http://localhost/b.png" });
    expect(images).toHaveLength(3);
  });

  test("actual pixels is reachable below the usual minimum scale", () => {
    runFrames();
    (h.window as any).devicePixelRatio = 3;
    (h.window as any).visualViewport = {
      scale: 2, width: 800, height: 600, offsetLeft: 0, offsetTop: 0,
      addEventListener() {}, removeEventListener() {},
    };
    const images = recordImages();
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png" }, {});
    sizeViewport();
    finishLoading(images[0]!, 640, 480);
    press("1:1 actual pixels");
    // One natural pixel per device pixel: 1 / (3 × 2).
    expect(state().scale).toBeCloseTo(1 / 6, 6);
    // Zoom out from there stays there; it does not jump back up to 0.2.
    press("Zoom out");
    expect(state().scale).toBeCloseTo(1 / 6, 6);
  });

  test("raster media fitted above its native size stays smooth until the reader zooms in past fit", () => {
    runFrames();
    (h.window as any).devicePixelRatio = 2;
    const images = recordImages();
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/small.png" }, {});
    sizeViewport();
    // A 200×100 image fits 800×600 at 3.84×: enlarged, yet smooth at fit.
    finishLoading(images[0]!, 200, 100);
    const stage = h.document.querySelector(".media-viewer-stage")!;
    expect(state().scale).toBeGreaterThan(1);
    expect(stage.classList.contains("is-pixelated")).toBe(false);
    press("Zoom in");
    expect(stage.classList.contains("is-pixelated")).toBe(true);
    press("Zoom out");
    // Back at the fit scale by steps is fit too.
    expect(stage.classList.contains("is-pixelated")).toBe(false);
    press("Zoom in");
    press("Fit to screen");
    expect(stage.classList.contains("is-pixelated")).toBe(false);
    // 1:1 is below fit here: not zoomed in past fit, so smooth.
    press("1:1 actual pixels");
    expect(stage.classList.contains("is-pixelated")).toBe(false);
  });

  describe("dismissal by a tap", () => {
    // A 400×200 diagram fitted into 800×600 spans x 16–784, y 108–492.
    function fitted(): void {
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport();
      press("Fit to screen");
    }
    const dialogOpen = () => h.document.querySelector("dialog.media-viewer")!.hasAttribute("open");
    function tapAt(id: number, from: [number, number], to: [number, number], time: number): void {
      pointer("pointerdown", id, from[0], from[1], time);
      pointer("pointermove", id, to[0], to[1], time + 16);
      pointer("pointerup", id, to[0], to[1], time + 32);
    }

    // A backdrop tap closes once no second press can pair with it.
    const settle = () => Bun.sleep(DOUBLE_TAP_MAX_GAP_MS + 40);

    test("a tap that starts and ends on the backdrop closes the viewer once it has settled", async () => {
      fitted();
      tapAt(1, [400, 60], [404, 58], 0);
      expect(dialogOpen()).toBe(true);
      await settle();
      expect(dialogOpen()).toBe(false);
    });

    test("a double-tap on the backdrop fits the media and keeps the viewer open", async () => {
      fitted();
      press("Zoom in");
      // Zoomed in, the media spans y 60–540: above it is backdrop.
      tapAt(1, [400, 30], [400, 30], 0);
      tapAt(2, [402, 32], [402, 32], 120);
      await settle();
      expect(dialogOpen()).toBe(true);
      expect(state()).toEqual({ tx: 16, ty: 108, scale: 1.92 });
    });

    test("a double-click on the backdrop fits the media and keeps the viewer open", async () => {
      fitted();
      press("Zoom in");
      for (const time of [0, 120]) {
        pointer("pointerdown", 1, 400, 30, time, "mouse");
        pointer("pointerup", 1, 400, 30, time + 16, "mouse");
      }
      h.document.querySelector(".media-viewer-viewport")!.dispatchEvent(new h.window.Event("dblclick", { bubbles: true, cancelable: true }));
      await settle();
      expect(dialogOpen()).toBe(true);
      expect(state()).toEqual({ tx: 16, ty: 108, scale: 1.92 });
    });

    test("a press that starts on the media and ends just past its edge does not close", () => {
      fitted();
      tapAt(1, [400, 112], [400, 102], 0);
      expect(dialogOpen()).toBe(true);
    });

    test("a press that starts on the backdrop and ends on the media does not close", () => {
      fitted();
      tapAt(1, [400, 102], [400, 112], 0);
      expect(dialogOpen()).toBe(true);
    });

    test("a tap while the media is still loading closes the viewer, and a drag does not", async () => {
      h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png" }, {});
      sizeViewport();
      // Nothing is on show yet: the whole viewport is empty backdrop.
      pointer("pointerdown", 1, 400, 300, 0);
      pointer("pointermove", 1, 480, 300, 16);
      pointer("pointerup", 1, 480, 300, 32);
      expect(dialogOpen()).toBe(true);
      tapAt(2, [400, 300], [402, 300], 600);
      await settle();
      expect(dialogOpen()).toBe(false);
    });

    test("a backdrop tap straight after a tap on the media closes rather than pairing into a double-tap", async () => {
      fitted();
      tapAt(1, [400, 112], [400, 112], 0);
      expect(dialogOpen()).toBe(true);
      tapAt(2, [400, 96], [400, 96], 100);
      await settle();
      expect(dialogOpen()).toBe(false);
    });
  });

  test("a re-render that keeps the displayed size never carries a scale outside the zoom range", () => {
    const session = h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 256 128", "Large") }, {});
    sizeViewport();
    for (let i = 0; i < 20; i += 1) press("Zoom in");
    expect(state().scale).toBeCloseTo(8, 6);
    session.replace({ kind: "mermaid", svg: diagram("0 0 32 16", "Small") });
    const carried = state();
    expect(carried.scale).toBeLessThanOrEqual(8);
    press("Zoom in");
    expect(state().scale).toBeGreaterThanOrEqual(carried.scale);
  });

  test("actual pixels and pixelation count the page's pinch zoom as well as the device pixel ratio", () => {
    (h.window as any).visualViewport = {
      scale: 2, width: 800, height: 600, offsetLeft: 0, offsetTop: 0,
      addEventListener() {}, removeEventListener() {},
    };
    const images = recordImages();
    h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/shot.png" }, {});
    sizeViewport();
    finishLoading(images[0]!, 3000, 2000);
    const stage = h.document.querySelector(".media-viewer-stage")!;
    press("1:1 actual pixels");
    // One natural pixel per device pixel: 1 / (devicePixelRatio 1 × page zoom 2).
    expect(state().scale).toBeCloseTo(0.5, 6);
    expect(stage.classList.contains("is-pixelated")).toBe(false);
    press("Zoom in");
    expect(stage.classList.contains("is-pixelated")).toBe(true);
  });

  describe("when the viewport changes size", () => {
    // linkedom has no ResizeObserver: this one hands the test each callback.
    function observeResizes(): () => void {
      const callbacks: (() => void)[] = [];
      (h.window as any).ResizeObserver = class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      };
      return () => {
        for (const callback of callbacks) callback();
      };
    }

    test("media at fit fits the new size", () => {
      const resized = observeResizes();
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport(800, 600);
      press("Fit to screen");
      sizeViewport(390, 844);
      resized();
      const fitted = state();
      expect(fitted.scale).toBeCloseTo((390 - 32) / 400, 6);
      expect(fitted.tx).toBeCloseTo(16, 6);
    });

    test("zoom out never enlarges media whose kept scale the larger viewport puts below its minimum", () => {
      const resized = observeResizes();
      // Fits a 480px-wide viewport at (480 - 32) / 3000 ≈ 0.149, under MIN_SCALE.
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 3000 2000", "Large") }, {});
      sizeViewport(480, 800);
      press("Fit to screen");
      press("Zoom in");
      press("Zoom out");
      const kept = state().scale;
      expect(kept).toBeCloseTo((480 - 32) / 3000, 6);
      // Wider, the media fits above MIN_SCALE, so the range starts at 0.2.
      sizeViewport(1600, 1200);
      resized();
      expect(state().scale).toBeCloseTo(kept, 6);
      press("Zoom out");
      expect(state().scale).toBeLessThanOrEqual(kept + 1e-9);
      press("Zoom in");
      expect(state().scale).toBeGreaterThan(kept);
    });

    test("zoomed media keeps its scale and is brought back within the pan bound", () => {
      const resized = observeResizes();
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport(1600, 1200);
      press("Fit to screen");
      press("Zoom in");
      // Pan the media to the far right of the wide viewport.
      pointer("pointerdown", 1, 100, 100, 0);
      pointer("pointermove", 1, 1500, 100, 16);
      pointer("pointerup", 1, 1500, 100, 32);
      press("Zoom in");
      press("Zoom out");
      const zoomed = state();
      expect(zoomed.tx).toBeGreaterThan(390);
      sizeViewport(390, 844);
      resized();
      const bounded = state();
      expect(bounded.scale).toBeCloseTo(zoomed.scale, 6);
      expect(bounded.tx).toBeLessThanOrEqual(390 - PAN_KEEP_VISIBLE);
    });
  });

  describe("keyboard pan", () => {
    const key = (init: { key: string; shiftKey?: boolean }) => {
      const event = new h.window.Event("keydown", { bubbles: true, cancelable: true });
      for (const [name, value] of Object.entries({ shiftKey: false, ...init })) Object.defineProperty(event, name, { value });
      h.document.querySelector(".media-viewer-close")!.dispatchEvent(event);
      return event;
    };

    test("arrow keys move the view a step the way they point, and Shift moves it further", () => {
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport();
      press("Fit to screen");
      press("Zoom in");
      press("Zoom in");
      const start = state();
      // Like scrolling: ArrowRight brings what is to the right into view.
      expect(key({ key: "ArrowRight" }).defaultPrevented).toBe(true);
      expect(state()).toEqual({ ...start, tx: start.tx - KEY_PAN_STEP });
      key({ key: "ArrowDown" });
      expect(state()).toEqual({ ...start, tx: start.tx - KEY_PAN_STEP, ty: start.ty - KEY_PAN_STEP });
      key({ key: "ArrowLeft", shiftKey: true });
      key({ key: "ArrowUp", shiftKey: true });
      expect(state()).toEqual({ ...start, tx: start.tx - KEY_PAN_STEP + KEY_PAN_STEP_LARGE, ty: start.ty - KEY_PAN_STEP + KEY_PAN_STEP_LARGE });
    });
  });

  describe("zoom level", () => {
    const level = () => h.document.querySelector(".media-viewer-zoom-level")!.textContent;
    const status = () => h.document.querySelector(".media-viewer-status")!.textContent;
    const disabled = (label: string) =>
      h.document.querySelector(`.media-viewer-toolbar [aria-label="${label}"]`)!.getAttribute("aria-disabled") === "true";

    test("the toolbar shows the zoom relative to fit, and announces changes made by its controls and keys", () => {
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport();
      press("Fit to screen");
      expect(level()).toBe("100%");
      press("Zoom in");
      expect(level()).toBe("125%");
      expect(status()).toBe("Zoom 125%");
      press("Fit to screen");
      expect(status()).toBe("Zoom 100%");
    });

    test("a gesture updates the level shown but announces nothing", () => {
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport();
      press("Fit to screen");
      const announced = status();
      pointer("pointerdown", 1, 350, 300, 0);
      pointer("pointerdown", 2, 450, 300, 0);
      pointer("pointermove", 2, 550, 300, 16);
      pointer("pointerup", 1, 350, 300, 32);
      pointer("pointerup", 2, 550, 300, 32);
      expect(level()).toBe("200%");
      expect(status()).toBe(announced);
    });

    test("zoom in and zoom out are marked unavailable at the limits, and stay focusable", () => {
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 400 200", "One") }, {});
      sizeViewport();
      press("Fit to screen");
      expect(disabled("Zoom in")).toBe(false);
      expect(disabled("Zoom out")).toBe(false);
      for (let i = 0; i < 20; i += 1) press("Zoom in");
      expect(state().scale).toBe(MAX_SCALE);
      expect(disabled("Zoom in")).toBe(true);
      expect(h.document.querySelector<HTMLButtonElement>('.media-viewer-toolbar [aria-label="Zoom in"]')!.disabled).toBe(false);
      for (let i = 0; i < 40; i += 1) press("Zoom out");
      expect(disabled("Zoom out")).toBe(true);
      expect(disabled("Zoom in")).toBe(false);
    });
  });

  describe("fit leaves room for the toolbar and the caption", () => {
    function placeBands(captionBottom: number | null, toolbarTop: number): void {
      const at = (selector: string, top: number, bottom: number) =>
        Object.defineProperty(h.document.querySelector(selector)!, "getBoundingClientRect", {
          configurable: true,
          value: () => ({ left: 300, right: 500, x: 300, y: top, top, bottom, width: 200, height: bottom - top }),
        });
      at(".media-viewer-toolbar", toolbarTop, toolbarTop + 44);
      if (captionBottom !== null) at(".media-viewer-caption", captionBottom - 24, captionBottom);
    }

    test("tall media fits between the caption and the toolbar", () => {
      h.viewer.openMediaViewer({ kind: "mermaid", svg: diagram("0 0 200 400", "Tall") }, {});
      sizeViewport();
      placeBands(null, 540);
      press("Fit to screen");
      // 540px above the toolbar, less the fit margin.
      const fitted = state();
      expect(fitted.scale).toBeCloseTo((540 - FIT_MARGIN) / 400, 6);
      expect(fitted.ty).toBeCloseTo((540 - 400 * fitted.scale) / 2, 6);
    });

    test("a caption takes its band off the top", () => {
      h.viewer.openMediaViewer({ kind: "raster", src: "http://localhost/tall.png", caption: "tall.png" }, {});
      runFrames();
      sizeViewport();
      placeBands(40, 540);
      const images = Array.from(h.document.querySelectorAll<HTMLImageElement>(".media-viewer-stage img"));
      Object.defineProperty(images[0]!, "naturalWidth", { configurable: true, value: 200 });
      Object.defineProperty(images[0]!, "naturalHeight", { configurable: true, value: 400 });
      images[0]!.dispatchEvent(new h.window.Event("load"));
      const fitted = state();
      expect(fitted.scale).toBeCloseTo((500 - FIT_MARGIN) / 400, 6);
      expect(fitted.ty).toBeCloseTo(40 + (500 - 400 * fitted.scale) / 2, 6);
    });
  });
});
