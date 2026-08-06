import { describe, expect, test } from "bun:test";

import { paneParticipatesInStack } from "./pane-stack";

describe("paneParticipatesInStack", () => {
  test("visible expanded panes participate", () => {
    expect(paneParticipatesInStack({ visible: true, collapsed: false, promoted: false })).toBe(true);
  });

  test("hidden and collapsed panes do not", () => {
    expect(paneParticipatesInStack({ visible: false, collapsed: false, promoted: false })).toBe(false);
    expect(paneParticipatesInStack({ visible: true, collapsed: true, promoted: false })).toBe(false);
  });

  test("a pane promoted to the phone file-browser overlay is excluded", () => {
    expect(paneParticipatesInStack({ visible: true, collapsed: false, promoted: true })).toBe(false);
  });
});
