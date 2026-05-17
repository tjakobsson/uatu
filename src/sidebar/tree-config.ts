// Loads the optional `tree` block from `.uatu.json`. Lives next to (not inside)
// `terminal-config.ts` and `review-load.ts` because each block has its own
// validation rules and the modules read the same file independently — merging
// them would just create coupling for no payoff.

import { promises as fs } from "node:fs";
import path from "node:path";

export type TreeConfig = {
  exclude: string[];
  respectGitignore: boolean;
};

export type TreeConfigResult = {
  config: TreeConfig;
  warnings: string[];
};

export const DEFAULT_TREE_CONFIG: Readonly<TreeConfig> = Object.freeze({
  exclude: [] as string[],
  respectGitignore: true,
});

export async function loadTreeConfig(rootPath: string): Promise<TreeConfigResult> {
  const config: TreeConfig = {
    exclude: [],
    respectGitignore: DEFAULT_TREE_CONFIG.respectGitignore,
  };
  const warnings: string[] = [];

  const filePath = path.join(rootPath, ".uatu.json");
  const source = await fs.readFile(filePath, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Could not read .uatu.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  });

  if (!source) return { config, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // review-load.ts already surfaces a parse warning; don't double-warn.
    return { config, warnings };
  }

  if (!isRecord(parsed) || parsed.tree === undefined) {
    return { config, warnings };
  }

  if (!isRecord(parsed.tree)) {
    warnings.push("Ignored .uatu.json tree because it must be an object.");
    return { config, warnings };
  }

  const tree = parsed.tree;

  if (tree.exclude !== undefined) {
    if (Array.isArray(tree.exclude) && tree.exclude.every(value => typeof value === "string")) {
      config.exclude = (tree.exclude as string[]).map(pattern => pattern.trim()).filter(Boolean);
    } else {
      warnings.push("Ignored .uatu.json tree.exclude because it must be a string array.");
    }
  }

  if (tree.respectGitignore !== undefined) {
    if (typeof tree.respectGitignore === "boolean") {
      config.respectGitignore = tree.respectGitignore;
    } else {
      warnings.push("Ignored .uatu.json tree.respectGitignore because it must be a boolean.");
    }
  }

  return { config, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
