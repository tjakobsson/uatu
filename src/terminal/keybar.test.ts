import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { initTerminalKeybar, KEYBAR_KEYS } from "./keybar";

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
  });

  test("every key has an accessible name", () => {
    for (const key of KEYBAR_KEYS) {
      expect(key.ariaLabel.length).toBeGreaterThan(2);
    }
  });
});

describe("initTerminalKeybar", () => {
  test("renders one button per key and sends the sequence on pointerdown", () => {
    const { document, window } = parseHTML("<!doctype html><html><body><div id='bar'></div></body></html>");
    (globalThis as { document?: unknown }).document = document;
    try {
      const container = document.getElementById("bar") as unknown as HTMLElement;
      const sent: string[] = [];
      initTerminalKeybar({
        container,
        sendToActivePane(sequence) {
          sent.push(sequence);
          return true;
        },
      });

      const buttons = [...container.querySelectorAll("button")];
      expect(buttons).toHaveLength(KEYBAR_KEYS.length);

      const ctrlC = buttons.find(button => button.textContent === "^C");
      expect(ctrlC).toBeDefined();
      ctrlC!.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("pointerdown"));
      expect(sent).toEqual(["\x03"]);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
