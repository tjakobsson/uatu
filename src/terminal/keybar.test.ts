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

function mountKeybar(overrides: { readClipboardText?: () => Promise<string> } = {}) {
  const { document, window } = parseHTML("<!doctype html><html><body><div id='bar'></div></body></html>");
  (globalThis as { document?: unknown }).document = document;
  const container = document.getElementById("bar") as unknown as HTMLElement;
  const sent: string[] = [];
  const stickyCtrl = createStickyCtrl();
  initTerminalKeybar({
    container,
    sendToActivePane(sequence) {
      sent.push(sequence);
      return true;
    },
    stickyCtrl,
    readClipboardText: overrides.readClipboardText ?? (() => Promise.reject(new Error("denied"))),
  });
  const buttons = [...container.querySelectorAll("button")];
  const press = (label: string) => {
    const button = buttons.find(b => b.textContent === label);
    expect(button).toBeDefined();
    button!.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("pointerdown"));
    return button!;
  };
  const cleanup = () => {
    delete (globalThis as { document?: unknown }).document;
  };
  return { buttons, press, sent, stickyCtrl, cleanup };
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
      const ctrl = press("ctrl");
      expect(stickyCtrl.isArmed()).toBe(true);
      expect(ctrl.getAttribute("aria-pressed")).toBe("true");
      press("ctrl");
      expect(stickyCtrl.isArmed()).toBe(false);
      expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    } finally {
      cleanup();
    }
  });

  test("paste writes the clipboard text through the pane path", async () => {
    const { press, sent, cleanup } = mountKeybar({
      readClipboardText: () => Promise.resolve("ls -la\n"),
    });
    try {
      press("paste");
      await Promise.resolve();
      expect(sent).toEqual(["ls -la\n"]);
    } finally {
      cleanup();
    }
  });

  test("a denied or empty clipboard read is inert", async () => {
    const denied = mountKeybar();
    try {
      denied.press("paste");
      await Promise.resolve();
      expect(denied.sent).toEqual([]);
    } finally {
      denied.cleanup();
    }
    const empty = mountKeybar({ readClipboardText: () => Promise.resolve("") });
    try {
      empty.press("paste");
      await Promise.resolve();
      expect(empty.sent).toEqual([]);
    } finally {
      empty.cleanup();
    }
  });
});
