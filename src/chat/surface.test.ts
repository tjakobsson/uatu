import { describe, expect, test } from "bun:test";
import { readMainSurfacePreference } from "../shell/state";

describe("main surface persistence", () => {
  test("defaults to Preview and accepts only the persisted Chat value", () => {
    expect(readMainSurfacePreference(null)).toBe("preview");
    expect(readMainSurfacePreference({ getItem: () => "chat" })).toBe("chat");
    expect(readMainSurfacePreference({ getItem: () => "terminal" })).toBe("preview");
  });
});
