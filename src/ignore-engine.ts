import { promises as fs } from "node:fs";
import path from "node:path";

import ignore, { type Ignore } from "ignore";

export type IgnoreMatcherOptions = {
  rootPath: string;
  respectGitignore: boolean;
  isSingleFileRoot?: boolean;
};

export type IgnoreMatcher = {
  shouldIgnore(relativePath: string): boolean;
  toChokidarIgnored(): (testPath: string) => boolean;
};

// Build an ignore matcher for one watched root. Pattern order matters: we feed
// `.gitignore` first and `.uatuignore` second so that user-controlled `.uatuignore`
// patterns (including `!negation`) override anything inherited from `.gitignore`.
export async function loadIgnoreMatcher(options: IgnoreMatcherOptions): Promise<IgnoreMatcher> {
  const { rootPath, respectGitignore, isSingleFileRoot = false } = options;
  const ig = ignore();

  if (!isSingleFileRoot) {
    if (respectGitignore) {
      await loadPatternFile(ig, path.join(rootPath, ".gitignore"));
    }
    await loadPatternFile(ig, path.join(rootPath, ".uatuignore"));
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
