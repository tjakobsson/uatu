import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import fc from "fast-check";
import os from "node:os";
import path from "node:path";

import { loadIgnoreMatcher } from "./engine";

// Property-based: the matcher gates what the watcher and tree ever see, so
// its decisions must be deterministic and the always-on defaults must hold
// at any depth for arbitrary surrounding path segments.

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

async function makeMatcher() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-prop-"));
  tempDirectories.push(rootPath);
  return loadIgnoreMatcher({ rootPath, respectGitignore: true });
}

// Path segments the engine's contract covers: relative POSIX paths. "." and
// ".." are excluded — the engine is only ever handed root-relative walks.
const segment = fc
  .stringMatching(/^[A-Za-z0-9À-ÿ_.@ -]{1,12}$/)
  .filter(s => s !== "." && s !== ".." && s.trim() === s);

const relativePath = fc.array(segment, { minLength: 1, maxLength: 6 }).map(parts => parts.join("/"));

describe("loadIgnoreMatcher properties", () => {
  test("decisions are deterministic for arbitrary relative paths", async () => {
    const matcher = await makeMatcher();
    fc.assert(
      fc.property(relativePath, candidate => {
        const first = matcher.shouldIgnore(candidate);
        expect(matcher.shouldIgnore(candidate)).toBe(first);
      }),
    );
  });

  test("built-in defaults hold at any depth", async () => {
    const matcher = await makeMatcher();
    const prefix = fc.array(segment, { maxLength: 3 });
    const suffix = fc.array(segment, { maxLength: 3 });
    fc.assert(
      fc.property(prefix, fc.constantFrom("node_modules", ".git", "dist"), suffix, (before, builtIn, after) => {
        const candidate = [...before, builtIn, ...after].join("/");
        expect(matcher.shouldIgnore(candidate)).toBe(true);
      }),
    );
  });

  test("a file and the chokidar adapter agree for arbitrary paths", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-prop-"));
    tempDirectories.push(rootPath);
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    const chokidarIgnored = matcher.toChokidarIgnored();
    fc.assert(
      fc.property(relativePath, candidate => {
        expect(chokidarIgnored(path.join(rootPath, candidate))).toBe(
          matcher.shouldIgnore(candidate),
        );
      }),
    );
  });
});
