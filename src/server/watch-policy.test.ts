import { expect, test } from "bun:test";
import { Stats } from "node:fs";
import { createWatchPolicy } from "./watch-policy";
import type { IgnoreMatcher } from "../ignore/engine";

const matcher: IgnoreMatcher = {
  shouldIgnore: (relative, directory) => relative === "generated" && directory === true || relative === ".uatu.json" || relative.endsWith(".log"),
  toChokidarIgnored: () => () => false,
};
test("watch policy prunes directories, secrets, and symlinks and deduplicates hidden counts", () => {
  const policy = createWatchPolicy({ kind: "dir", absolutePath: "/repo" }, matcher);
  const directory = Object.assign(Object.create(Stats.prototype) as Stats, { mode: 0o40755 });
  const symlink = Object.assign(Object.create(Stats.prototype) as Stats, { mode: 0o120777 });
  expect(policy.ignored("/repo/generated", directory)).toBe(true);
  expect(policy.ignored("/repo/generated", directory)).toBe(true);
  expect(policy.ignored("/repo/log.log")).toBe(true);
  expect(policy.hidden.size).toBe(2);
  expect(policy.ignored("/repo/.git/objects")).toBe(true);
  expect(policy.ignored("/repo/.env")).toBe(true);
  expect(policy.ignored("/repo/node_modules")).toBe(true);
  expect(policy.ignored("/repo/link", symlink)).toBe(true);
  expect(policy.hidden.size).toBe(2);
  expect(policy.ignored("/repo/.uatu.json")).toBe(false);
  expect(policy.accepts("/repo/.uatu.json")).toBe(false);
});
test("single-file roots keep ancestors traversable without exposing sibling files", () => {
  const policy = createWatchPolicy({ kind: "file", absolutePath: "/repo/readme.md", parentDir: "/repo" }, matcher);
  expect(policy.ignored("/repo")).toBe(false);
  expect(policy.ignored("/repo/readme.md")).toBe(false);
  expect(policy.ignored("/repo/other.md")).toBe(true);
  expect(policy.accepts("/repo")).toBe(false);
});
