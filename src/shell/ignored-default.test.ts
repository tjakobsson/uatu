import { expect, test } from "bun:test";
import { resolveIgnoredVisibility } from "./ignored-default";

test("personal ignored visibility wins over initial legacy defaults", () => {
  for (const initial of [true, false, undefined, null, "false"]) {
    expect(resolveIgnoredVisibility(true, initial)).toBe(true);
    expect(resolveIgnoredVisibility(false, initial)).toBe(false);
  }
  expect(resolveIgnoredVisibility(undefined, false)).toBe(false);
  expect(resolveIgnoredVisibility(undefined, true)).toBe(true);
  for (const invalid of [undefined, null, "false", 0]) expect(resolveIgnoredVisibility(invalid, invalid)).toBe(true);
});
