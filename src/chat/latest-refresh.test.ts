import { describe, expect, test } from "bun:test";

import { LatestRefresh } from "./latest-refresh";

describe("LatestRefresh", () => {
  test("an older refresh answering after a newer one is not current", async () => {
    const refreshes = new LatestRefresh();
    const installed: string[] = [];
    const read = (value: string, ms: number) => {
      const current = refreshes.begin("opencode");
      return new Promise<void>(resolve => setTimeout(() => {
        if (current()) installed.push(value);
        resolve();
      }, ms));
    };
    // The pre-reload read starts first and answers last.
    await Promise.all([read("before reload", 30), read("after reload", 5)]);
    expect(installed).toEqual(["after reload"]);
  });

  test("keys are independent, and a lone refresh stays current", () => {
    const refreshes = new LatestRefresh();
    const opencode = refreshes.begin("opencode");
    const claude = refreshes.begin("claude");
    expect(opencode()).toBe(true);
    expect(claude()).toBe(true);
    refreshes.begin("opencode");
    expect(opencode()).toBe(false);
    expect(claude()).toBe(true);
  });
});
