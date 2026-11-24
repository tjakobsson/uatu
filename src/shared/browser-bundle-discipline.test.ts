// Guards the browser bundle against static Node built-in imports. `bun build
// --compile` keeps an `import … from "node:fs"` in a client module as a real
// import in the page's script; the browser cannot fetch `node:fs`, the whole
// script fails to load, and the page never leaves "Connecting". The e2e
// server's bundler stubs such imports instead, so only the compiled-binary
// smoke test would notice. This walks the page's static import graph from its
// entry (src/index.html loads src/app.ts) and fails on any reachable module
// that imports a Node built-in. Type-only imports are erased and allowed; a
// module that needs Node at run time looks it up where the runtime has it
// (see shared/version.ts).

import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = path.join(SRC_ROOT, "app.ts");
// The session contract is server-only: the Hub and the workspace session
// share it, the page never does. A pure-TypeScript contract file would pass
// the Node built-in check, so reaching the folder at all is the offence.
const SESSION_CONTRACT = path.join(SRC_ROOT, "session-contract") + path.sep;

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;
// `typeof import("…")` is a type position and erased; only value imports count.
const DYNAMIC_IMPORT = /(?<!typeof\s)\bimport\(\s*["']([^"']+)["']\s*\)/g;
const NODE_BUILTINS = new Set([
  "fs", "path", "os", "child_process", "crypto", "net", "tls", "http", "https",
  "stream", "url", "util", "zlib", "worker_threads", "readline", "events", "buffer",
]);

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  const base = specifier.split("/")[0]!;
  return NODE_BUILTINS.has(base);
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

test("no module reachable from the page's entry imports a Node built-in or the session contract", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const contractImporters: string[] = [];
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers: { specifier: string; typeOnly: boolean }[] = [];
    for (const match of source.matchAll(IMPORT)) {
      specifiers.push({ specifier: match[3]!, typeOnly: Boolean(match[2]) });
    }
    for (const match of source.matchAll(DYNAMIC_IMPORT)) specifiers.push({ specifier: match[1]!, typeOnly: false });
    for (const { specifier, typeOnly } of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier);
        if (resolved && !typeOnly) queue.push(resolved);
        // Type-only imports count here too: the contract's types describe a
        // private agreement the page has no part in.
        if (resolved?.startsWith(SESSION_CONTRACT)) {
          contractImporters.push(`${path.relative(SRC_ROOT, file)} imports "${specifier}"`);
        }
      } else if (!typeOnly && isNodeBuiltin(specifier)) {
        offenders.push(`${path.relative(SRC_ROOT, file)} imports "${specifier}"`);
      }
    }
  }
  expect(seen.size).toBeGreaterThan(50);
  expect(offenders).toEqual([]);
  expect(contractImporters).toEqual([]);
});

test("the session-contract check resolves the folder it guards", () => {
  expect(existsSync(path.join(SESSION_CONTRACT, "paths.ts"))).toBe(true);
});
