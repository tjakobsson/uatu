// Keeps `src/zoom/` a leaf feature: surfaces opt in by passing what they know
// (a real image source, a link, where to return focus), so the zoom code
// never reaches into the preview, chat or the app shell. That is also what
// keeps zoom ephemeral by construction — without an import of the shell's
// state or storage modules there is no path that could persist it.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ZOOM_DIR = import.meta.dir;
const SRC_ROOT = path.resolve(ZOOM_DIR, "..");
const SELF = path.basename(import.meta.path);

// `shell/` as a whole is off limits; the state and storage modules are named
// so a failure says exactly which persistence path was reached for.
const FORBIDDEN_FOLDERS = ["preview/", "chat/", "shell/"];
const NAMED_SHELL_MODULES = [
  "shell/state",
  "shell/storage",
  "shell/personal-state",
  "shell/presentation-storage",
];

const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|(?:^|[\s;(])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

// The `src/`-relative targets of a module's relative imports that leave the
// zoom boundary, given the module's own path under `src/zoom/`.
function forbiddenImports(source: string, file = "zoom/module.ts"): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || !specifier.startsWith(".")) {
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const named = NAMED_SHELL_MODULES.find(module => target === module || target.startsWith(`${module}.`));
    if (named || FORBIDDEN_FOLDERS.some(folder => target.startsWith(folder))) {
      found.push(target);
    }
  }
  return found;
}

function zoomModules(): string[] {
  return readdirSync(ZOOM_DIR, { recursive: true, encoding: "utf8" })
    .filter(name => name.endsWith(".ts") && name !== SELF)
    .map(name => path.posix.join("zoom", name.split(path.sep).join("/")));
}

describe("src/zoom/ import boundary", () => {
  test("the checker flags imports of preview/, chat/ and the shell's state and storage", () => {
    for (const specifier of [
      "../preview/svg-images",
      "../chat/ui",
      "../shell/state",
      "../shell/storage",
      "../shell/personal-state",
      "../shell/presentation-storage",
      "../shell/ui-mode",
    ]) {
      expect(forbiddenImports(`import { x } from "${specifier}";`)).toHaveLength(1);
      expect(forbiddenImports(`export { x } from '${specifier}';`)).toHaveLength(1);
      expect(forbiddenImports(`import "${specifier}";`)).toHaveLength(1);
      expect(forbiddenImports(`const m = await import("${specifier}");`)).toHaveLength(1);
    }
    expect(
      forbiddenImports(`import {\n  a,\n  type B,\n} from "../shell/state";`),
    ).toEqual(["shell/state"]);
  });

  test("the checker allows imports inside zoom/ and of shared/", () => {
    expect(forbiddenImports(`import { clamp } from "./transform";`)).toEqual([]);
    expect(forbiddenImports(`import type { Size } from "./transform";`)).toEqual([]);
    expect(forbiddenImports(`import { escapeHtml } from "../shared/html";`)).toEqual([]);
    expect(forbiddenImports(`import { expect } from "bun:test";`)).toEqual([]);
  });

  test("no module in src/zoom/ crosses the boundary", () => {
    const modules = zoomModules();
    expect(modules.length).toBeGreaterThan(0);
    const violations = modules.flatMap(file =>
      forbiddenImports(readFileSync(path.join(SRC_ROOT, file), "utf8"), file).map(
        target => `${file} → ${target}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
