import { describe, expect, test } from "bun:test";

import { paneParticipatesInStack } from "./pane-stack";

describe("paneParticipatesInStack", () => {
  test("visible expanded panes participate", () => {
    expect(paneParticipatesInStack({ visible: true, collapsed: false })).toBe(true);
  });

  test("hidden and collapsed panes do not", () => {
    expect(paneParticipatesInStack({ visible: false, collapsed: false })).toBe(false);
    expect(paneParticipatesInStack({ visible: true, collapsed: true })).toBe(false);
  });
});
