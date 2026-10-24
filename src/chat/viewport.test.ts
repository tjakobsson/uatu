import { describe, expect, test } from "bun:test";
import { chatViewportMetrics, ChatViewportController } from "./viewport";
import { parseHTML } from "linkedom";

const TOUCH_MARKUP = '<html data-ui-mode="touch" data-active-tab="chat"><body><section></section><form></form></body></html>';
const GLOBALS = ["window", "document", "visualViewport", "innerHeight", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] as const;

/** A controller over a fake visual viewport, with frames and timers in hand. */
function harness(markup = TOUCH_MARKUP) {
  const { document, window } = parseHTML(markup);
  const previous = GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("window", window);
  define("document", document);
  define("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  define("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  define("setTimeout", (callback: () => void) => { timers.set(++sequence, callback); return sequence; });
  define("clearTimeout", (id: number) => { timers.delete(id); });
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const surface = document.querySelector("section")! as unknown as HTMLElement;
  let requests = 0;
  const controller = new ChatViewportController(surface, document.querySelector("form")! as unknown as HTMLElement, () => requests++);
  return {
    controller, viewport, surface, frames, timers,
    root: document.documentElement,
    requests: () => requests,
    style: (name: string) => surface.style.getPropertyValue(name),
    viewportEvent: (name: string) => viewport.dispatchEvent(new Event(name)),
    documentEvent: (name: string) => document.dispatchEvent(new window.Event(name)),
    windowEvent: (name: string) => window.dispatchEvent(new window.Event(name)),
    hide: () => { visibility = "hidden"; },
    show: () => { visibility = "visible"; },
    runFrames: () => { for (const callback of [...frames.values()]) { frames.clear(); callback(0); } },
    runTimers: () => { for (const callback of [...timers.values()]) { timers.clear(); callback(); } },
    restore: () => {
      controller.stop();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe("chat visual viewport geometry", () => {
  test("physical-minimum outer scrolling survives viewport and foreground resyncs only while active", () => {
    const f = harness();
    try {
      f.viewport.height = 200;
      f.surface.setAttribute("data-work-overflow", "");
      f.surface.scrollTop = 100;
      f.controller.start();
      expect(f.surface.scrollTop).toBe(100);
      for (const event of ["resize", "scroll"]) {
        f.viewportEvent(event);
        f.runFrames();
        expect(f.surface.scrollTop).toBe(100);
      }
      for (const event of ["resize", "focus", "pageshow"]) {
        f.windowEvent(event);
        f.runFrames(); f.runTimers();
        expect(f.surface.scrollTop).toBe(100);
      }
      f.documentEvent("visibilitychange");
      f.runFrames(); f.runTimers();
      expect(f.surface.scrollTop).toBe(100);
      f.surface.removeAttribute("data-work-overflow");
      f.viewportEvent("resize"); f.runFrames();
      expect(f.surface.scrollTop).toBe(0);
      // Normal touch caret reveal must still be prevented from panning chrome.
      f.surface.scrollTop = 50;
      f.windowEvent("focus"); f.runFrames(); f.runTimers();
      expect(f.surface.scrollTop).toBe(0);
      f.viewport.height = 800;
      f.viewportEvent("resize"); f.runFrames();
      expect(f.surface.scrollTop).toBe(0);
    } finally { f.restore(); }
  });

  test("reserves the visible touch bar and reclaims it when the keyboard covers it", () => {
    expect(chatViewportMetrics(800, 0, 800, 70)).toEqual({ height: 730, tabInset: 70, keyboardVisible: false });
    expect(chatViewportMetrics(500, 0, 800, 70)).toEqual({ height: 500, tabInset: 0, keyboardVisible: true });
  });

  test("accounts for a panned iOS visual viewport", () => {
    expect(chatViewportMetrics(500, 40, 800, 70)).toEqual({ height: 500, tabInset: 0, keyboardVisible: true });
  });

  test("a keyboard that pans the page rather than occluding it is still a keyboard", () => {
    expect(chatViewportMetrics(508, 266, 844, 0)).toEqual({ height: 508, tabInset: 0, keyboardVisible: true });
  });

  test("viewport changes request the shared owner only while Chat is visible", () => {
    const { document, window } = parseHTML('<html data-ui-mode="desktop" data-chat-panel="open"><body><section></section><form></form></body></html>');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
      let requests = 0;
      const controller = new ChatViewportController(document.querySelector("section")! as unknown as HTMLElement,
        document.querySelector("form")! as unknown as HTMLElement, () => requests++);
      controller.apply();
      expect(requests).toBe(1);
      expect(document.querySelector("section")!.style.getPropertyValue("--chat-visual-height")).toBe("");
      document.documentElement.setAttribute("data-chat-panel", "collapsed");
      controller.apply();
      expect(requests).toBe(1);
      document.documentElement.setAttribute("data-ui-mode", "touch");
      document.documentElement.setAttribute("data-active-tab", "chat");
      controller.apply();
      expect(requests).toBe(2);
      expect(document.querySelector("section")!.style.getPropertyValue("--chat-visual-height")).toBe("800px");
      document.documentElement.setAttribute("data-ui-mode", "desktop");
      controller.apply();
      expect(document.querySelector("section")!.style.getPropertyValue("--chat-visual-height")).toBe("");
      expect(document.querySelector("section")!.style.getPropertyValue("--chat-visual-top")).toBe("");
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("switching from touch to desktop while editing corrects even with a simultaneous pan", () => {
    const f = harness();
    try {
      f.root.setAttribute("data-chat-editing", "");
      f.viewport.height = 500;
      f.controller.apply();
      expect(f.requests()).toBe(1);

      f.root.setAttribute("data-ui-mode", "desktop");
      f.root.setAttribute("data-chat-panel", "open");
      f.viewport.offsetTop = 100;
      f.controller.apply();
      expect(f.requests()).toBe(2);
      for (const property of ["--chat-visual-height", "--chat-visual-top", "--chat-keyboard-inset"]) {
        expect(f.style(property)).toBe("");
      }

      // Returning to touch establishes fresh geometry; only later pure pans
      // should be suppressed, not the mode transition itself.
      f.root.setAttribute("data-ui-mode", "touch");
      f.viewport.offsetTop = 120;
      f.controller.apply();
      expect(f.requests()).toBe(3);
      expect(f.style("--chat-visual-height")).toBe("500px");
      expect(f.style("--chat-visual-top")).toBe("120px");
      f.viewport.offsetTop = 140;
      f.controller.apply();
      expect(f.requests()).toBe(3);
    } finally {
      f.restore();
    }
  });

  for (const mode of ["touch", "desktop"]) test(`pinch zoom leaves ${mode} geometry and keyboard state browser-owned`, () => {
    const f = harness();
    try {
      f.root.setAttribute("data-ui-mode", mode);
      f.root.setAttribute("data-chat-panel", "open");
      f.controller.apply();
      const normalHeight = f.style("--chat-visual-height");
      const normalTop = f.style("--chat-visual-top");
      expect(f.root.hasAttribute("data-chat-keyboard")).toBe(false);

      f.viewport.scale = 2;
      f.viewport.height = 400;
      f.viewport.offsetTop = 100;
      f.controller.apply();
      expect(f.root.hasAttribute("data-chat-keyboard")).toBe(false);
      expect(f.style("--chat-visual-height")).toBe(normalHeight);
      expect(f.style("--chat-visual-top")).toBe(normalTop);
      expect(f.requests()).toBe(1);

      // Return to normal scale with a real keyboard present. Its smaller
      // viewport is application-owned again and must not be ignored.
      f.viewport.scale = 1;
      f.viewport.height = 500;
      f.controller.apply();
      expect(f.root.hasAttribute("data-chat-keyboard")).toBe(true);
      expect(f.requests()).toBe(2);
      f.viewport.scale = 2;
      f.viewport.height = 250;
      f.controller.apply();
      expect(f.root.hasAttribute("data-chat-keyboard")).toBe(true);
      expect(f.requests()).toBe(2);
    } finally {
      f.restore();
    }
  });

  test("a foreground return re-derives geometry the platform never announced", () => {
    const f = harness();
    try {
      f.controller.start();
      expect(f.requests()).toBe(1);
      f.viewport.height = 400;
      f.viewportEvent("resize");
      f.runFrames();
      expect(f.style("--chat-visual-height")).toBe("400px");
      expect(f.requests()).toBe(2);
      f.hide();
      f.documentEvent("visibilitychange");
      expect(f.requests()).toBe(2);
      // The platform restores the page with the keyboard gone and no event.
      f.viewport.height = 800;
      f.show();
      f.documentEvent("visibilitychange");
      expect(f.style("--chat-visual-height")).toBe("800px");
      expect(f.requests()).toBe(3);
      // The second resync replaced the first one's outstanding passes.
      expect(f.frames.size).toBe(1);
      expect(f.timers.size).toBe(1);
      f.runFrames();
      f.runTimers();
      expect(f.style("--chat-visual-height")).toBe("800px");
    } finally {
      f.restore();
    }
  });

  test("a correction withheld while hidden is replayed once, not on every later apply", () => {
    const f = harness();
    try {
      f.controller.apply();
      expect(f.requests()).toBe(1);
      f.root.setAttribute("data-chat-editing", "");
      f.hide();
      f.viewport.offsetTop = 40;
      f.controller.apply();
      expect(f.requests()).toBe(1);
      f.show();
      f.viewport.offsetTop = 80;
      f.controller.apply();
      expect(f.requests()).toBe(2);
      f.viewport.offsetTop = 120;
      f.controller.apply();
      expect(f.requests()).toBe(2);
    } finally {
      f.restore();
    }
  });

  test("stop leaves no listener, frame, or timer behind", () => {
    const f = harness();
    try {
      f.controller.start();
      f.viewportEvent("scroll");
      f.documentEvent("visibilitychange");
      expect(f.frames.size).toBe(2);
      expect(f.timers.size).toBe(1);
      f.controller.stop();
      expect(f.frames.size).toBe(0);
      expect(f.timers.size).toBe(0);
      const seen = f.requests();
      f.viewport.height = 300;
      f.viewportEvent("resize");
      f.viewportEvent("scroll");
      f.windowEvent("resize");
      f.windowEvent("focus");
      f.windowEvent("pageshow");
      f.documentEvent("visibilitychange");
      expect(f.frames.size).toBe(0);
      expect(f.timers.size).toBe(0);
      expect(f.requests()).toBe(seen);
    } finally {
      f.restore();
    }
  });

  test("a burst of viewport events costs one frame and one correction", () => {
    const f = harness();
    try {
      f.controller.start();
      expect(f.requests()).toBe(1);
      for (const top of [10, 20, 30, 40, 50]) {
        f.viewport.offsetTop = top;
        f.viewportEvent("scroll");
      }
      expect(f.frames.size).toBe(1);
      f.runFrames();
      expect(f.requests()).toBe(2);
      expect(f.style("--chat-visual-top")).toBe("50px");
    } finally {
      f.restore();
    }
  });

  test("an apply that changes nothing writes no custom property", () => {
    const f = harness();
    try {
      f.controller.apply();
      expect(f.style("--chat-visual-height")).toBe("800px");
      expect(f.style("--chat-visual-top")).toBe("0px");
      f.surface.style.removeProperty("--chat-visual-height");
      f.surface.style.removeProperty("--chat-visual-top");
      f.controller.apply();
      expect(f.style("--chat-visual-height")).toBe("");
      expect(f.style("--chat-visual-top")).toBe("");
    } finally {
      f.restore();
    }
  });

  test("while a request is answered the surface keeps the layout height the keyboard covers", () => {
    const f = harness();
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
      f.viewport.height = 460;
      f.controller.apply();
      // Not answering: the surface is the visible band, as it always was.
      expect(f.style("--chat-visual-height")).toBe("460px");
      expect(f.style("--chat-keyboard-inset")).toBe("0px");
      expect(f.root.hasAttribute("data-chat-keyboard")).toBe(true);

      // Answering: the surface keeps the layout height, so the composer and
      // the pinned tracks are under the keyboard rather than gone, and the
      // 384px it covers is what the transcript reserves as scroll room. The
      // keyboard is still read from the real metrics.
      f.root.setAttribute("data-chat-answering", "");
      f.controller.apply();
      expect(f.style("--chat-visual-height")).toBe("844px");
      expect(f.style("--chat-keyboard-inset")).toBe("384px");
      expect(f.root.hasAttribute("data-chat-keyboard")).toBe(true);

      // A platform that pans instead of occluding: the top still tracks the
      // visible band, and what the keyboard covers is unchanged by the pan.
      f.viewport.height = 508;
      f.viewport.offsetTop = 266;
      f.controller.apply();
      expect(f.style("--chat-visual-top")).toBe("266px");
      expect(f.style("--chat-visual-height")).toBe("844px");
      expect(f.style("--chat-keyboard-inset")).toBe("336px");

      f.root.removeAttribute("data-chat-answering");
      f.controller.apply();
      expect(f.style("--chat-visual-height")).toBe("508px");
      expect(f.style("--chat-keyboard-inset")).toBe("0px");
    } finally {
      f.restore();
    }
  });

  test("a simultaneous resize and pan while answering still corrects the focused field", () => {
    const f = harness();
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      f.root.setAttribute("data-chat-answering", "");
      f.root.setAttribute("data-chat-editing", "");
      f.viewport.height = 460;
      f.controller.start();
      expect(f.requests()).toBe(1);

      f.viewport.height = 360;
      f.viewport.offsetTop = 100;
      f.viewportEvent("resize");
      f.viewportEvent("scroll");
      expect(f.frames.size).toBe(1);
      f.runFrames();
      expect(f.requests()).toBe(2);
      expect(f.style("--chat-visual-height")).toBe("844px");
      expect(f.style("--chat-visual-top")).toBe("100px");
      expect(f.style("--chat-keyboard-inset")).toBe("484px");

      // A real pan-only caret movement must still leave the transcript alone.
      f.viewport.offsetTop = 120;
      f.viewportEvent("scroll");
      f.runFrames();
      expect(f.requests()).toBe(2);
    } finally {
      f.restore();
    }
  });

  test("a pan while editing moves the surface without moving the conversation", () => {
    const f = harness();
    try {
      f.controller.apply();
      expect(f.requests()).toBe(1);
      f.root.setAttribute("data-chat-editing", "");
      f.viewport.offsetTop = 120;
      f.controller.apply();
      f.viewport.offsetTop = 180;
      f.controller.apply();
      expect(f.requests()).toBe(1);
      expect(f.style("--chat-visual-top")).toBe("180px");
      f.viewport.height = 500;
      f.controller.apply();
      expect(f.requests()).toBe(2);
      expect(f.style("--chat-visual-height")).toBe("500px");
    } finally {
      f.restore();
    }
  });
});
