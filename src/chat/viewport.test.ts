import { describe, expect, test } from "bun:test";
import { chatViewportMetrics, ChatViewportController } from "./viewport";
import { parseHTML } from "linkedom";

describe("chat visual viewport geometry", () => {
  test("reserves the visible touch bar and reclaims it when the keyboard covers it", () => {
    expect(chatViewportMetrics(800, 0, 800, 70)).toEqual({ height: 730, tabInset: 70, keyboardVisible: false });
    expect(chatViewportMetrics(500, 0, 800, 70)).toEqual({ height: 500, tabInset: 0, keyboardVisible: true });
  });

  test("accounts for a panned iOS visual viewport", () => {
    expect(chatViewportMetrics(500, 40, 800, 70)).toEqual({ height: 500, tabInset: 0, keyboardVisible: true });
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
});
