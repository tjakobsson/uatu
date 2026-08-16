import { describe, expect, test } from "bun:test";
import { chatViewportMetrics } from "./viewport";

describe("chat visual viewport geometry", () => {
  test("reserves the visible touch bar and reclaims it when the keyboard covers it", () => {
    expect(chatViewportMetrics(800, 0, 800, 70)).toEqual({ height: 730, tabInset: 70, keyboardVisible: false });
    expect(chatViewportMetrics(500, 0, 800, 70)).toEqual({ height: 500, tabInset: 0, keyboardVisible: true });
  });

  test("accounts for a panned iOS visual viewport", () => {
    expect(chatViewportMetrics(500, 40, 800, 70)).toEqual({ height: 500, tabInset: 0, keyboardVisible: true });
  });
});
