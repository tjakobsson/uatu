import { promises as fs } from "node:fs";
import path from "node:path";

import ignore, { type Ignore } from "ignore";

import { loadTreeConfig } from "./tree-config";

export type IgnoreMatcherOptions = {
  rootPath: string;
  // Session-level CLI decision. When false (user passed --no-gitignore),
  // `.gitignore` is NOT honored regardless of `.uatu.json`. When true (the default),
  // `.uatu.json tree.respectGitignore: false` can still disable `.gitignore` for this root.
  respectGitignore: boolean;
  isSingleFileRoot?: boolean;
};

export type IgnoreMatcher = {
  shouldIgnore(relativePath: string): boolean;
  toChokidarIgnored(): (testPath: string) => boolean;
};

// Always-on built-in defaults — applied even when `.uatu.json` is absent and
// even when `.gitignore` is disabled. Mirrors (and is additional to) the
// server.ts directory-walker `ignoredNames` short-circuit — having these as
// patterns lets `.uatu.json tree.exclude` `!negation` rules interact predictably
// with them, and ensures static-fallback serving honors them too.
const BUILT_IN_DEFAULTS: readonly string[] = Object.freeze([
  // Node / JS output
  "node_modules",
  "dist",
  "build",
  "coverage",
  // Version control
  ".git",
  ".svn",
  ".hg",
  // OS metadata
  ".DS_Store",
  "Thumbs.db",
  // Build / framework caches
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".vercel",
  ".output",
  ".nitro",
  ".svelte-kit",
  ".astro",
  // Python
  ".venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  // JVM
  ".gradle",
  ".m2",
  // Package managers
  ".npm",
  ".yarn",
  ".pnpm-store",
  // Infra
  ".terraform",
  ".serverless",
]) as readonly string[];

// Build an ignore matcher for one watched root. Pattern application order:
//   1. Built-in defaults (always)
//   2. `.gitignore` (when honored: CLI didn't pass --no-gitignore AND .uatu.json doesn't disable)
//   3. `.uatu.json tree.exclude` (user-controlled; goes LAST so `!negation` overrides .gitignore)
export async function loadIgnoreMatcher(options: IgnoreMatcherOptions): Promise<IgnoreMatcher> {
  const { rootPath, respectGitignore: cliRespectGitignore, isSingleFileRoot = false } = options;
  const ig = ignore();

  ig.add([...BUILT_IN_DEFAULTS]);

  if (!isSingleFileRoot) {
    const { config } = await loadTreeConfig(rootPath);

    const respectGitignore = cliRespectGitignore && config.respectGitignore;
    if (respectGitignore) {
      await loadPatternFile(ig, path.join(rootPath, ".gitignore"));
    }

    if (config.exclude.length > 0) {
      ig.add(config.exclude);
    }
  }

  const shouldIgnore = (relativePath: string): boolean => {
    if (!relativePath || relativePath === ".") {
      return false;
    }
    return ig.ignores(relativePath);
  };

  return {
    shouldIgnore,
    toChokidarIgnored(): (testPath: string) => boolean {
      return (testPath: string) => {
        if (testPath === rootPath) {
          return false;
        }
        const rel = path.relative(rootPath, testPath);
        if (!rel || rel.startsWith("..")) {
          return false;
        }
        return shouldIgnore(rel.split(path.sep).join("/"));
      };
    },
  };
}

async function loadPatternFile(ig: Ignore, filePath: string): Promise<void> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    ig.add(contents);
  } catch {
    // Missing or unreadable — skip silently.
  }
}
