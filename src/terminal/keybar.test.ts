import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { initTerminalKeybar, KEYBAR_ITEMS, KEYBAR_KEYS, selectionSheetKeyRoute } from "./keybar";
import { createStickyCtrl } from "./sticky-ctrl";

describe("KEYBAR_KEYS", () => {
  test("carries the control sequences software keyboards cannot type", () => {
    const bySequence = new Map(KEYBAR_KEYS.map(key => [key.label, key.sequence]));
    expect(bySequence.get("^C")).toBe("\x03");
    expect(bySequence.get("^D")).toBe("\x04");
    expect(bySequence.get("^Z")).toBe("\x1a");
    expect(bySequence.get("esc")).toBe("\x1b");
    expect(bySequence.get("tab")).toBe("\t");
    expect(bySequence.get("↑")).toBe("\x1b[A");
    expect(bySequence.get("↓")).toBe("\x1b[B");
    expect(bySequence.get("→")).toBe("\x1b[C");
    expect(bySequence.get("←")).toBe("\x1b[D");
    expect(bySequence.get("⇞")).toBe("\x1b[5~");
    expect(bySequence.get("⇟")).toBe("\x1b[6~");
    expect(bySequence.get("home")).toBe("\x1b[H");
    expect(bySequence.get("end")).toBe("\x1b[F");
  });

  test("every item has an accessible name", () => {
    for (const item of KEYBAR_ITEMS) {
      expect(item.ariaLabel.length).toBeGreaterThan(2);
    }
  });

  test("includes exactly one ctrl latch, paste action, select action, and switch action", () => {
    expect(KEYBAR_ITEMS.filter(item => item.kind === "ctrl")).toHaveLength(1);
    expect(KEYBAR_ITEMS.filter(item => item.kind === "paste")).toHaveLength(1);
    expect(KEYBAR_ITEMS.filter(item => item.kind === "select")).toHaveLength(1);
    expect(KEYBAR_ITEMS.filter(item => item.kind === "switch")).toHaveLength(1);
  });

  test("leads the row with the switch action", () => {
    expect(KEYBAR_ITEMS[0]!.kind).toBe("switch");
  });
});

function mountKeybar(overrides: { readClipboardText?: (() => Promise<string>) | null } = {}) {
  const { document, window } = parseHTML("<!doctype html><html><body><div id='bar'></div></body></html>");
  (globalThis as { document?: unknown }).document = document;
  const container = document.getElementById("bar") as unknown as HTMLElement;
  const sent: string[] = [];
  const pasted: string[] = [];
  let selectionSheets = 0;
  let selectionOpen = false;
  let switcherOpens = 0;
  let switcherOpen = false;
  const stickyCtrl = createStickyCtrl();
  initTerminalKeybar({
    container,
    sendToActivePane(sequence) {
      sent.push(sequence);
      return true;
    },
    pasteToActivePane(text) {
      pasted.push(text);
      return true;
    },
    showSelectionSheet() {
      selectionSheets += 1;
      selectionOpen = true;
      return true;
    },
    dismissSelectionSheet() {
      if (!selectionOpen) return false;
      selectionOpen = false;
      return true;
    },
    isSelectionSheetOpen() {
      return selectionOpen;
    },
    openSwitcher() {
      switcherOpens += 1;
      switcherOpen = true;
      return true;
    },
    dismissSwitcher() {
      if (!switcherOpen) return false;
      switcherOpen = false;
      return true;
    },
    isSwitcherOpen() {
      return switcherOpen;
    },
    stickyCtrl,
    readClipboardText:
      overrides.readClipboardText === null
        ? undefined
        : overrides.readClipboardText ?? (() => Promise.reject(new Error("denied"))),
  });
  const buttons = [...container.querySelectorAll("button")];
  const buttonFor = (label: string) => {
    const button = buttons.find(b => b.textContent === label);
    expect(button).toBeDefined();
    return button!;
  };
  const press = (label: string) => {
    const event = new (window as unknown as { Event: typeof Event }).Event("pointerdown", {
      cancelable: true,
    });
    buttonFor(label).dispatchEvent(event);
    return { button: buttonFor(label), event };
  };
  const click = (label: string) => {
    buttonFor(label).dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click"));
  };
  const cleanup = () => {
    delete (globalThis as { document?: unknown }).document;
  };
  return {
    buttons,
    container,
    click,
    press,
    pasted,
    sent,
    stickyCtrl,
    selectionSheets: () => selectionSheets,
    switcherOpens: () => switcherOpens,
    isSwitcherOpen: () => switcherOpen,
    cleanup,
  };
}

describe("initTerminalKeybar", () => {
  test("renders one button per item and sends the sequence on pointerdown", () => {
    const { buttons, press, sent, cleanup } = mountKeybar();
    try {
      expect(buttons).toHaveLength(KEYBAR_ITEMS.length);
      press("^C");
      press("⇟");
      expect(sent).toEqual(["\x03", "\x1b[6~"]);
    } finally {
      cleanup();
    }
  });

  test("ctrl button toggles the latch and mirrors it via aria-pressed", () => {
    const { press, stickyCtrl, cleanup } = mountKeybar();
    try {
      const ctrl = press("ctrl").button;
      expect(stickyCtrl.isArmed()).toBe(true);
      expect(ctrl.getAttribute("aria-pressed")).toBe("true");
      press("ctrl");
      expect(stickyCtrl.isArmed()).toBe(false);
      expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    } finally {
      cleanup();
    }
  });

  test("paste waits for click, preserves focus on press, and runs exactly once", async () => {
    let reads = 0;
    const { click, press, pasted, sent, cleanup } = mountKeybar({
      readClipboardText: () => {
        reads += 1;
        return Promise.resolve("ls -la\n");
      },
    });
    try {
      const { event } = press("paste");
      expect(event.defaultPrevented).toBe(true);
      expect(reads).toBe(0);
      expect(pasted).toEqual([]);
      click("paste");
      await Promise.resolve();
      expect(reads).toBe(1);
      expect(pasted).toEqual(["ls -la\n"]);
      expect(sent).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("semantic keyboard-style click activation uses the same paste path", async () => {
    const mounted = mountKeybar({ readClipboardText: () => Promise.resolve("pwd") });
    try {
      mounted.click("paste");
      await Promise.resolve();
      expect(mounted.pasted).toEqual(["pwd"]);
    } finally {
      mounted.cleanup();
    }
  });

  test("select waits for click and toggles to Done while the sheet is open", () => {
    const mounted = mountKeybar();
    try {
      const { event } = mounted.press("select");
      expect(event.defaultPrevented).toBe(true);
      expect(mounted.selectionSheets()).toBe(0);
      mounted.click("select");
      expect(mounted.selectionSheets()).toBe(1);
      expect(mounted.sent).toEqual([]);
      const done = mounted.buttons.find(button => button.textContent === "done")!;
      expect(done.getAttribute("aria-label")).toBe("Done selecting terminal text");
      expect(done.getAttribute("aria-pressed")).toBe("true");
      expect(done.classList.contains("is-selection-done")).toBe(true);
      expect(mounted.container.dataset.selectionMode).toBe("true");
      expect(mounted.buttons.find(button => button.textContent === "^C")!.disabled).toBe(true);
      expect(mounted.buttons.find(button => button.textContent === "paste")!.disabled).toBe(true);
      expect(mounted.buttons.find(button => button.textContent === "esc")!.disabled).toBe(false);
      mounted.click("done");
      expect(done.textContent).toBe("select");
      expect(done.getAttribute("aria-pressed")).toBe("false");
      expect(done.classList.contains("is-selection-done")).toBe(false);
      expect(mounted.container.dataset.selectionMode).toBe("false");
      expect(mounted.buttons.filter(button => !button.hidden).every(button => !button.disabled)).toBe(true);
    } finally {
      mounted.cleanup();
    }
  });

  test("switch opens the switcher on click and mirrors it via aria-expanded", () => {
    const mounted = mountKeybar();
    try {
      const { event, button } = mounted.press("⇄");
      // Press preserves terminal focus and does nothing else; the sheet opens
      // from the release-time activation, same as paste.
      expect(event.defaultPrevented).toBe(true);
      expect(mounted.switcherOpens()).toBe(0);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      mounted.click("⇄");
      expect(mounted.switcherOpens()).toBe(1);
      expect(mounted.isSwitcherOpen()).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(mounted.sent).toEqual([]);
    } finally {
      mounted.cleanup();
    }
  });

  test("switch toggles the sheet closed instead of opening a second one", () => {
    const mounted = mountKeybar();
    try {
      mounted.click("⇄");
      mounted.click("⇄");
      expect(mounted.switcherOpens()).toBe(1);
      expect(mounted.isSwitcherOpen()).toBe(false);
      expect(mounted.buttons.find(b => b.textContent === "⇄")!.getAttribute("aria-expanded"))
        .toBe("false");
    } finally {
      mounted.cleanup();
    }
  });

  test("switch is unavailable while the selection transcript is open", () => {
    const mounted = mountKeybar();
    try {
      mounted.click("select");
      expect(mounted.buttons.find(b => b.textContent === "⇄")!.disabled).toBe(true);
      mounted.click("done");
      expect(mounted.buttons.find(b => b.textContent === "⇄")!.disabled).toBe(false);
    } finally {
      mounted.cleanup();
    }
  });

  test("every clipboard failure form is inert", async () => {
    const cases = [
      mountKeybar({ readClipboardText: null }),
      mountKeybar({ readClipboardText: () => { throw new Error("blocked"); } }),
      mountKeybar(),
      mountKeybar({ readClipboardText: () => Promise.resolve("") }),
    ];
    for (const mounted of cases) {
      try {
        expect(() => mounted.click("paste")).not.toThrow();
        await Promise.resolve();
        expect(mounted.pasted).toEqual([]);
        expect(mounted.sent).toEqual([]);
      } finally {
        mounted.cleanup();
      }
    }
  });
});

describe("selectionSheetKeyRoute", () => {
  test("sends every sequence in normal mode", () => {
    expect(selectionSheetKeyRoute(false, "\x1b")).toBe("send");
    expect(selectionSheetKeyRoute(false, "\x03")).toBe("send");
  });

  test("dismisses on Escape and blocks other PTY input in selection mode", () => {
    expect(selectionSheetKeyRoute(true, "\x1b")).toBe("dismiss");
    expect(selectionSheetKeyRoute(true, "\x03")).toBe("block");
  });
});
