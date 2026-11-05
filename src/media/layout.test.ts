import { describe, expect, test } from "bun:test";
import { mediaLayoutGeometry } from "./layout";

describe("media layout reservation", () => {
  test("reserves a measured player separately from the safe-area-bearing tabs", () => {
    expect(mediaLayoutGeometry(844, 844, 0, 90, 112)).toEqual({
      occluded: 0, tabInset: 90, dockBottom: 90, bottomInset: 202, usableHeight: 642,
    });
  });
  test("keeps the player above a keyboard while reclaiming covered tabs", () => {
    expect(mediaLayoutGeometry(844, 480, 40, 90, 112)).toEqual({
      occluded: 324, tabInset: 0, dockBottom: 324, bottomInset: 436, usableHeight: 368,
    });
  });
  test("reserves only the visible part of a partially covered tab bar", () => {
    expect(mediaLayoutGeometry(844, 800, 0, 90, 112)).toEqual({
      occluded: 44, tabInset: 46, dockBottom: 90, bottomInset: 202, usableHeight: 642,
    });
  });
  test("desktop has no tab reservation and short bands do not become negative", () => {
    expect(mediaLayoutGeometry(900, 900, 0, 0, 80).usableHeight).toBe(820);
    expect(mediaLayoutGeometry(320, 120, 0, 0, 160).usableHeight).toBe(0);
  });
});
