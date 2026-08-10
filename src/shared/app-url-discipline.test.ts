// Enforces the base-path-serving spec's single-chokepoint requirement: no
// client module builds a root-relative server URL ("/api/…", "/assets/…",
// "/sw.js", "/manifest.webmanifest") from a string literal — every such URL
// goes through appUrl() in shared/app-url.ts so the whole SPA relocates
// under a base path by changing exactly one value. Server-side modules
// (which match request paths AFTER the base path is stripped) are exempted
// by the allowlist below.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");

// Files allowed to hold root-relative URL literals. Server-side dispatch
// works on stripped, root-relative paths by design; the chokepoint and its
// building blocks obviously contain the strings they exist to handle.
const ALLOWED_FILES = new Set([
  "src/shared/app-url.ts",
  "src/shared/base-path.ts",
  // Hub-level URLs are origin-rooted on purpose: the hub's API lives
  // OUTSIDE the session's base path, so appUrl() must not touch them.
  "src/shell/hub-nav.ts",
  // The legacy-worker cleanup MATCHES a historical script path rather than
  // building a URL to request, and it has to match it at the origin root as
  // well as under the base path — appUrl() can only produce the latter.
  "src/shell/pwa.ts",
  // Server-side route matching / response construction:
  "src/terminal/sessions-route.ts",
  "src/terminal/auth.ts",
  "src/terminal/server.ts",
]);

const ALLOWED_DIRS = ["src/server/", "src/cli/", "src/watchdog/", "src/debug/", "src/hub/"];

// A root-relative URL literal is only an offense when it is not the direct
// argument of the appUrl() chokepoint.
const URL_LITERAL = /(?<!appUrl\()["'`]\/(api\/|api["'`]|assets\/|sw\.js|manifest\.webmanifest)/;

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

describe("client URL construction discipline", () => {
  test("root-relative server URL literals appear only in the chokepoint or server-side modules", () => {
    const offenders: string[] = [];

    for (const absolute of walkTsFiles(SRC_ROOT)) {
      const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
      if (relative.endsWith(".test.ts")) continue;
      if (relative === "src/cli.ts") continue;
      if (ALLOWED_FILES.has(relative)) continue;
      if (ALLOWED_DIRS.some(dir => relative.startsWith(dir))) continue;

      const lines = readFileSync(absolute, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        if (URL_LITERAL.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${trimmed}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
