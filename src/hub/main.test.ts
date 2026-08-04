import { describe, expect, test } from "bun:test";

import { passwordFromPipedInput } from "./main";

describe("passwordFromPipedInput", () => {
  test("strips exactly one trailing line terminator", () => {
    expect(passwordFromPipedInput("hunter2\n")).toBe("hunter2");
    expect(passwordFromPipedInput("hunter2\r\n")).toBe("hunter2");
    expect(passwordFromPipedInput("hunter2")).toBe("hunter2");
  });

  test("preserves intentional whitespace — login verification does too", () => {
    expect(passwordFromPipedInput("  padded pw  \n")).toBe("  padded pw  ");
    expect(passwordFromPipedInput(" leading\n")).toBe(" leading");
    // Only the FINAL terminator goes; embedded newlines are part of the password.
    expect(passwordFromPipedInput("multi\nline\n")).toBe("multi\nline");
  });

  test("empty input stays empty (caller rejects it)", () => {
    expect(passwordFromPipedInput("")).toBe("");
    expect(passwordFromPipedInput("\n")).toBe("");
  });
});
