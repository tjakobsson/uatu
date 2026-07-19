import { describe, expect, test } from "bun:test";

import {
  dispatchColorScheme,
  onColorSchemeChange,
  themeColorFor,
  type ColorScheme,
} from "./theme";

describe("themeColorFor", () => {
  test("light keeps the pre-theme-system brand navy", () => {
    expect(themeColorFor("light")).toBe("#0a1c38");
  });

  test("dark matches the dark chrome background token", () => {
    expect(themeColorFor("dark")).toBe("#0d1117");
  });
});

describe("scheme change subscription", () => {
  test("subscribers hear dispatches until unsubscribed", () => {
    const seen: ColorScheme[] = [];
    const unsubscribe = onColorSchemeChange((scheme) => {
      seen.push(scheme);
    });
    dispatchColorScheme("dark");
    dispatchColorScheme("light");
    unsubscribe();
    dispatchColorScheme("dark");
    expect(seen).toEqual(["dark", "light"]);
  });

  test("one listener unsubscribing does not silence others", () => {
    const first: ColorScheme[] = [];
    const second: ColorScheme[] = [];
    const unsubscribeFirst = onColorSchemeChange((scheme) => first.push(scheme));
    const unsubscribeSecond = onColorSchemeChange((scheme) => second.push(scheme));
    unsubscribeFirst();
    dispatchColorScheme("dark");
    unsubscribeSecond();
    expect(first).toEqual([]);
    expect(second).toEqual(["dark"]);
  });
});
