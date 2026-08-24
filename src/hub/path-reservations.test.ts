import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  isPathAtOrBelow,
  normalizeAbsolutePath,
  PathReservationCoordinator,
  pathsOverlap,
} from "./path-reservations";

describe("path relationships", () => {
  test("normalizes paths before comparing equal and ancestor relationships", () => {
    const root = path.resolve("/tmp/uatu-paths");
    expect(normalizeAbsolutePath(path.join(root, "child", ".."))).toBe(root);
    expect(isPathAtOrBelow(path.join(root, "."), root)).toBe(true);
    expect(isPathAtOrBelow(path.join(root, "nested", "workspace"), root)).toBe(true);
    expect(pathsOverlap(root, path.join(root, "nested"))).toBe(true);
  });

  test("compares components rather than string prefixes", () => {
    const root = path.resolve("/tmp/uatu-paths/repo");
    expect(isPathAtOrBelow(`${root}-two`, root)).toBe(false);
    expect(isPathAtOrBelow(path.dirname(root), root)).toBe(false);
    expect(pathsOverlap(root, `${root}-two`)).toBe(false);
  });

  test("honors platform separators at component boundaries", () => {
    const root = path.resolve("/tmp/uatu-paths/separator");
    expect(isPathAtOrBelow(`${root}${path.sep}child`, `${root}${path.sep}`)).toBe(true);
    expect(isPathAtOrBelow(`${root}ish${path.sep}child`, root)).toBe(false);
  });
});

describe("PathReservationCoordinator", () => {
  test("rejects equal, ancestor, and descendant reservations but permits siblings", () => {
    const coordinator = new PathReservationCoordinator();
    const reservation = coordinator.acquire(["/tmp/uatu-reserved/group/repo"]);
    expect(reservation).toBeDefined();
    expect(coordinator.acquire(["/tmp/uatu-reserved/group/repo"])).toBeUndefined();
    expect(coordinator.acquire(["/tmp/uatu-reserved/group"])).toBeUndefined();
    expect(coordinator.acquire(["/tmp/uatu-reserved/group/repo/nested"])).toBeUndefined();
    expect(coordinator.acquire(["/tmp/uatu-reserved/group/repo-two"])).toBeDefined();
  });

  test("acquires multiple paths atomically and releases idempotently", () => {
    const coordinator = new PathReservationCoordinator();
    const blocker = coordinator.acquire(["/tmp/uatu-reserved/destination"]);
    expect(coordinator.acquire(["/tmp/uatu-reserved/free", "/tmp/uatu-reserved/destination/child"])).toBeUndefined();
    expect(coordinator.isReserved("/tmp/uatu-reserved/free")).toBe(false);

    blocker?.release();
    blocker?.release();
    const reservation = coordinator.acquire(["/tmp/uatu-reserved/free", "/tmp/uatu-reserved/destination/child"]);
    expect(reservation?.paths).toEqual([
      path.resolve("/tmp/uatu-reserved/free"),
      path.resolve("/tmp/uatu-reserved/destination/child"),
    ]);
    reservation?.release();
    expect(coordinator.isReserved("/tmp/uatu-reserved/destination")).toBe(false);
  });
});
