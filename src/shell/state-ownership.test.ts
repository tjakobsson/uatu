// Enforces the module-structure spec's appState field-ownership requirement:
// direct assignment (`appState.<field> = …`) is allowed only inside the
// field's owning module (or a colocated test). Every module that needs to
// mutate a field it doesn't own calls the owner's exported mutator instead.
// The map below is the authoritative ownership table; ARCHITECTURE.md's
// state-lifecycle section mirrors it for human readers.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FIELD_OWNERS: Record<string, string> = {
  selectedId: "src/shell/selection.ts",
  previewMode: "src/shell/selection.ts",
  followEnabled: "src/shell/follow.ts",
  roots: "src/shell/events.ts",
  repositories: "src/shell/events.ts",
  scope: "src/shell/events.ts",
  staleHint: "src/shell/stale-hint-mount.ts",
  viewMode: "src/preview/view-mode.ts",
  wrap: "src/preview/view-mode.ts",
  viewLayout: "src/preview/layout.ts",
  splitRatio: "src/preview/layout.ts",
  diffStyle: "src/preview/diff.ts",
  panes: "src/sidebar/panes.ts",
  filesPaneFilter: "src/sidebar/files-filter.ts",
  gitLogLimit: "src/sidebar/git-log.ts",
  compareTarget: "src/sidebar/change-overview.ts",
};

const SRC_ROOT = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(absolute);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield absolute;
    }
  }
}

describe("appState field ownership", () => {
  test("direct assignment appears only in each field's owner module (or a test)", () => {
    const assignmentPattern = /appState\.([A-Za-z]+) = [^=]/g;
    const violations: string[] = [];

    for (const filePath of walkTsFiles(SRC_ROOT)) {
      const relative = path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
      if (relative.endsWith(".test.ts")) {
        continue;
      }
      const contents = readFileSync(filePath, "utf8");
      for (const match of contents.matchAll(assignmentPattern)) {
        const field = match[1]!;
        const owner = FIELD_OWNERS[field];
        if (!owner) {
          violations.push(`${relative}: appState.${field} has no entry in the ownership map`);
          continue;
        }
        if (relative !== owner) {
          violations.push(
            `${relative}: appState.${field} is owned by ${owner} — call its mutator instead`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the ownership map covers every appState field", () => {
    const stateSource = readFileSync(path.join(SRC_ROOT, "shell", "state.ts"), "utf8");
    const declaration = stateSource.slice(stateSource.indexOf("export const appState = {"));
    const fieldPattern = /^  ([A-Za-z]+):/gm;
    const declaredFields = [...declaration.matchAll(fieldPattern)].map(match => match[1]!);
    expect(declaredFields.length).toBeGreaterThan(0);
    for (const field of declaredFields) {
      expect(FIELD_OWNERS[field]).toBeDefined();
    }
  });
});
