import { describe, expect, test } from "bun:test";

import {
  CHAT_PANEL_DEFAULT_FRACTION,
  CHAT_PANEL_KEY,
  CHAT_PANEL_MIN_WIDTH,
  CHAT_PREVIEW_MIN_WIDTH,
  DESKTOP_STACKED_BREAKPOINT,
  chatPanelFits,
  chatViewportFits,
  clampChatFraction,
  readChatPanelPreference,
  writeChatPanelPreference,
} from "./surface";

function storageOf(store: Map<string, string> = new Map()): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

describe("chat panel preference", () => {
  test("defaults to collapsed at the default fraction", () => {
    // Collapsed by default: the strip keeps Chat one click away without
    // forcing 40% of a fresh workspace onto an unavailable-state card.
    expect(readChatPanelPreference(null)).toEqual({ open: false, fraction: CHAT_PANEL_DEFAULT_FRACTION });
    expect(readChatPanelPreference(storageOf())).toEqual({ open: false, fraction: CHAT_PANEL_DEFAULT_FRACTION });
  });

  test("round-trips through write and read", () => {
    const storage = storageOf();
    writeChatPanelPreference(storage, { open: true, fraction: 0.55 });
    expect(readChatPanelPreference(storage)).toEqual({ open: true, fraction: 0.55 });
  });

  test("malformed or wrongly-typed storage keeps the defaults", () => {
    for (const raw of ["not json", "42", '"chat"', '{"open":"yes","fraction":"wide"}', '{"fraction":null}']) {
      const storage = storageOf(new Map([[CHAT_PANEL_KEY, raw]]));
      expect(readChatPanelPreference(storage)).toEqual({ open: false, fraction: CHAT_PANEL_DEFAULT_FRACTION });
    }
  });

  test("a persisted fraction is bounded on read", () => {
    const wild = storageOf(new Map([[CHAT_PANEL_KEY, '{"open":true,"fraction":7}']]));
    expect(readChatPanelPreference(wild).fraction).toBeLessThanOrEqual(0.85);
    const sliver = storageOf(new Map([[CHAT_PANEL_KEY, '{"open":true,"fraction":0.001}']]));
    expect(readChatPanelPreference(sliver).fraction).toBeGreaterThanOrEqual(0.15);
    const infinite = storageOf(new Map([[CHAT_PANEL_KEY, '{"open":true,"fraction":null}']]));
    expect(readChatPanelPreference(infinite).fraction).toBe(CHAT_PANEL_DEFAULT_FRACTION);
  });

  test("a throwing storage degrades to the defaults", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readChatPanelPreference(throwing)).toEqual({ open: false, fraction: CHAT_PANEL_DEFAULT_FRACTION });
    expect(() => writeChatPanelPreference(throwing, { open: true, fraction: 0.4 })).not.toThrow();
  });
});

describe("clampChatFraction", () => {
  test("keeps chat at its minimum width on a fitting row", () => {
    const width = 1400;
    expect(clampChatFraction(0.01, width)).toBeCloseTo(CHAT_PANEL_MIN_WIDTH / width);
  });

  test("leaves preview its minimum width on a fitting row", () => {
    const width = 1400;
    expect(clampChatFraction(0.99, width)).toBeCloseTo(1 - CHAT_PREVIEW_MIN_WIDTH / width);
  });

  test("passes through an in-bounds fraction unchanged", () => {
    expect(clampChatFraction(0.4, 1400)).toBe(0.4);
  });

  test("falls back to storage bounds when the row cannot fit both minimums", () => {
    // The guard is about to collapse the panel anyway; the fraction only
    // needs to stay sane for the next fitting viewport.
    expect(clampChatFraction(0.9, 500)).toBe(0.85);
    expect(clampChatFraction(0.05, 500)).toBe(0.15);
    expect(clampChatFraction(0.4, 0)).toBe(0.4);
  });
});

describe("viewport guard", () => {
  test("the work row fits exactly at the sum of both minimums", () => {
    const threshold = CHAT_PANEL_MIN_WIDTH + CHAT_PREVIEW_MIN_WIDTH;
    expect(chatViewportFits(threshold)).toBe(true);
    expect(chatViewportFits(threshold - 1)).toBe(false);
  });

  test("the stacked-layout breakpoint collapses the split regardless of row width", () => {
    // Mirrors styles.css's @media (max-width: 900px): the stacked layout
    // gives up side-by-side chrome, so the attribute must agree with it.
    expect(chatPanelFits(2000, DESKTOP_STACKED_BREAKPOINT)).toBe(false);
    expect(chatPanelFits(2000, DESKTOP_STACKED_BREAKPOINT + 1)).toBe(true);
  });

  test("a narrow work row collapses even on a wide window", () => {
    // A right-docked terminal plus a wide sidebar can starve the row without
    // the window being narrow — the guard watches the row, not the window.
    expect(chatPanelFits(600, 1800)).toBe(false);
  });
});

describe("panel state transitions", () => {
  // Driven through the real module against stubbed globals (the same pattern
  // as active-surface.test.ts): collapse/reopen must round-trip the fraction
  // and flip only the attribute, because the retained fraction is what makes
  // reopening land where the user left it.
  test("collapse and reopen retain the split fraction", async () => {
    const savedDocument = Reflect.get(globalThis, "document");
    const savedWindow = Reflect.get(globalThis, "window");
    const store = new Map<string, string>();
    const attributes: Record<string, string> = {};
    const properties: Record<string, string> = {};
    Reflect.set(globalThis, "document", {
      dispatchEvent: () => true,
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
        style: {
          setProperty: (name: string, value: string) => {
            properties[name] = value;
          },
        },
      },
      querySelector: () => null,
    });
    Reflect.set(globalThis, "window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        get length() {
          return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
    });
    try {
      const { setChatPanelOpen, expandChatPanel, isChatPanelOpen } = await import("./surface");

      setChatPanelOpen(true);
      expect(isChatPanelOpen()).toBe(true);
      expect(attributes["data-chat-panel"]).toBe("open");
      const openFraction = properties["--chat-fraction"];

      setChatPanelOpen(false);
      expect(isChatPanelOpen()).toBe(false);
      expect(attributes["data-chat-panel"]).toBe("collapsed");

      expandChatPanel();
      expect(attributes["data-chat-panel"]).toBe("open");
      expect(properties["--chat-fraction"]).toBe(openFraction);

      // Expanding an already-open panel never collapses it.
      expandChatPanel();
      expect(attributes["data-chat-panel"]).toBe("open");
    } finally {
      Reflect.set(globalThis, "document", savedDocument);
      Reflect.set(globalThis, "window", savedWindow);
    }
  });
});
