import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { initTerminalKeybar, KEYBAR_ITEMS, KEYBAR_KEYS } from "./keybar";
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

  test("includes exactly one ctrl latch and one paste action", () => {
    expect(KEYBAR_ITEMS.filter(item => item.kind === "ctrl")).toHaveLength(1);
    expect(KEYBAR_ITEMS.filter(item => item.kind === "paste")).toHaveLength(1);
  });
});

function mountKeybar(overrides: { readClipboardText?: (() => Promise<string>) | null } = {}) {
  const { document, window } = parseHTML("<!doctype html><html><body><div id='bar'></div></body></html>");
  (globalThis as { document?: unknown }).document = document;
  const container = document.getElementById("bar") as unknown as HTMLElement;
  const sent: string[] = [];
  const pasted: string[] = [];
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
  return { buttons, click, press, pasted, sent, stickyCtrl, cleanup };
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
