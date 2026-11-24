import { describe, expect, test } from "bun:test";

import { bodyLengthCheck } from "./github-contract";

describe("bodyLengthCheck", () => {
  test("stays quiet well under the limit", () => {
    expect(bodyLengthCheck(0)).toEqual({ counter: null, tooLong: null });
    expect(bodyLengthCheck(58_000)).toEqual({ counter: null, tooLong: null });
  });

  test("counts near the limit, and allows the limit itself", () => {
    expect(bodyLengthCheck(60_000)).toEqual({ counter: "60,000 / 65,536", tooLong: null });
    expect(bodyLengthCheck(65_536)).toEqual({ counter: "65,536 / 65,536", tooLong: null });
  });

  test("refuses past the limit, saying by how much", () => {
    expect(bodyLengthCheck(65_600)).toEqual({ counter: "65,600 / 65,536", tooLong: "Too long by 64 characters: GitHub takes at most 65,536." });
    expect(bodyLengthCheck(65_537).tooLong).toBe("Too long by 1 character: GitHub takes at most 65,536.");
  });
});
