import { describe, expect, it } from "bun:test";

import { pasteToActiveTerminal } from "./panel-paste";

describe("pasteToActiveTerminal", () => {
  it("resolves and pastes into the active attached pane at call time", () => {
    const pasted: string[] = [];
    let focused = 0;
    const handle = {
      isAttached: () => true,
      paste: (text: string) => pasted.push(text),
      focus: () => { focused += 1; },
    };
    let active = false;

    expect(pasteToActiveTerminal(() => active ? handle : null, "first")).toBe(false);
    active = true;
    expect(pasteToActiveTerminal(() => active ? handle : null, "second")).toBe(true);
    expect(pasted).toEqual(["second"]);
    expect(focused).toBe(1);
  });

  it("is inert when the active pane is detached", () => {
    let pasted = false;
    let focused = false;
    const handle = {
      isAttached: () => false,
      paste: () => { pasted = true; },
      focus: () => { focused = true; },
    };

    expect(pasteToActiveTerminal(() => handle, "text")).toBe(false);
    expect(pasted).toBe(false);
    expect(focused).toBe(false);
  });
});
