import { describe, expect, test } from "bun:test";

import { boundedSet } from "./bounded-map";

describe("boundedSet", () => {
  test("evicts the stalest key past the ceiling and reports it", () => {
    const map = new Map<string, number>();
    expect(boundedSet(map, "a", 1, 2)).toBeUndefined();
    expect(boundedSet(map, "b", 2, 2)).toBeUndefined();
    expect(boundedSet(map, "c", 3, 2)).toBe("a");
    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  test("updating a key refreshes its recency, so the hot entry is never the one evicted", () => {
    const map = new Map<string, number>();
    boundedSet(map, "hot", 1, 2);
    boundedSet(map, "idle", 2, 2);
    // The hot key was inserted first but written again — the idle one drops.
    boundedSet(map, "hot", 3, 2);
    expect(boundedSet(map, "new", 4, 2)).toBe("idle");
    expect([...map.keys()]).toEqual(["hot", "new"]);
    expect(map.get("hot")).toBe(3);
  });
});
