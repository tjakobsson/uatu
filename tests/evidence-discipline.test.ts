// Tests never name a change folder. A change's screenshots folder is PR
// evidence assembled at PR time (see tests/e2e/evidence.ts); the folder
// moves to the archive when the change ships, and a test that wrote into
// it broke CI for every later pull request. Main specs under
// openspec/specs/ are stable and may be cited in comments.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TESTS_ROOT = path.resolve(import.meta.dir);
const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
const SELF = path.resolve(import.meta.path);
// Spelled in two parts so this file does not flag itself.
const FORBIDDEN = ["open", "spec/changes"].join("");

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("evidence discipline", () => {
  test("no test file names a change folder", () => {
    const offenders = typescriptFiles(TESTS_ROOT)
      .filter(file => file !== SELF && readFileSync(file, "utf8").includes(FORBIDDEN))
      .map(file => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
