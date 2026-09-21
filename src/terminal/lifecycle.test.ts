import { describe, expect, test } from "bun:test";

import { createPanelLifecycle, type LifecycleEventTarget } from "./lifecycle";

function target(): LifecycleEventTarget & { visibilityState: string; fire(type: string, init?: Record<string, unknown>): void } {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    visibilityState: "visible",
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter(candidate => candidate !== listener));
    },
    fire(type, init = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ type, ...init } as unknown as Event);
    },
  };
}

function mount() {
  const win = target();
  const doc = target();
  const calls: string[] = [];
  const lifecycle = createPanelLifecycle({
    win,
    doc,
    release: () => calls.push("release"),
    resume: () => calls.push("resume"),
  });
  const setVisibility = (state: "visible" | "hidden") => {
    doc.visibilityState = state;
    doc.fire("visibilitychange");
  };
  return { win, doc, calls, lifecycle, setVisibility };
}

describe("createPanelLifecycle", () => {
  test("pagehide releases whether or not the browser promises a restore, and pageshow resumes once", () => {
    for (const persisted of [true, false]) {
      const page = mount();
      page.win.fire("pagehide", { persisted });
      expect(page.calls).toEqual(["release"]);
      expect(page.lifecycle.suspended()).toBe(true);
      page.win.fire("pageshow", { persisted });
      expect(page.calls).toEqual(["release", "resume"]);
      expect(page.lifecycle.suspended()).toBe(false);
    }
  });

  test("an ordinary background tab neither releases nor resumes", () => {
    const page = mount();
    page.setVisibility("hidden");
    page.setVisibility("visible");
    expect(page.calls).toEqual([]);
  });

  test("a wake-up burst of pageshow and visibilitychange resumes a suspended document exactly once", () => {
    const page = mount();
    page.doc.visibilityState = "hidden";
    page.win.fire("pagehide", { persisted: true });
    page.win.fire("pageshow", { persisted: true });
    page.setVisibility("visible");
    page.win.fire("pageshow", { persisted: true });
    expect(page.calls).toEqual(["release", "resume"]);
  });

  test("a return to the foreground resumes a document that was suspended without a matching pageshow", () => {
    const page = mount();
    page.win.fire("pagehide", { persisted: false });
    page.setVisibility("hidden");
    expect(page.calls).toEqual(["release"]);
    page.setVisibility("visible");
    expect(page.calls).toEqual(["release", "resume"]);
  });

  test("a repeated pagehide releases once; the first-load pageshow is a no-op", () => {
    const page = mount();
    page.win.fire("pageshow", { persisted: false });
    expect(page.calls).toEqual([]);
    page.win.fire("pagehide", { persisted: false });
    page.win.fire("pagehide", { persisted: false });
    expect(page.calls).toEqual(["release"]);
  });

  test("dispose stops listening", () => {
    const page = mount();
    page.lifecycle.dispose();
    page.win.fire("pagehide", { persisted: true });
    page.win.fire("pageshow", { persisted: true });
    expect(page.calls).toEqual([]);
  });
});
