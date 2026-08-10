// Loads the `ignore` block from `.uatu.json` — the single block the file
// carries: content-scoping facts about the repository (exclude patterns +
// gitignore respect). Owned by `src/ignore/` because the ignore engine is
// the config's only consumer; the returned `warnings` are the single source
// of `.uatu.json` warnings (read, parse, and shape), surfaced in the Change
// Overview via `collectConfigWarnings`.

import { promises as fs } from "node:fs";
import path from "node:path";

export type IgnoreConfig = {
  exclude: string[];
  respectGitignore: boolean;
};

export type IgnoreConfigResult = {
  config: IgnoreConfig;
  warnings: string[];
};

export const DEFAULT_IGNORE_CONFIG: Readonly<IgnoreConfig> = Object.freeze({
  exclude: [] as string[],
  respectGitignore: true,
});

export async function loadIgnoreConfig(rootPath: string): Promise<IgnoreConfigResult> {
  const config: IgnoreConfig = {
    exclude: [],
    respectGitignore: DEFAULT_IGNORE_CONFIG.respectGitignore,
  };
  const warnings: string[] = [];

  const filePath = path.join(rootPath, ".uatu.json");
  const source = await fs.readFile(filePath, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Could not read .uatu.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  });

  // Only absence is silent — an existing-but-empty file falls through to
  // JSON.parse so it warns like any other malformed content.
  if (source === null) return { config, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    warnings.push(`Invalid .uatu.json: ${error instanceof Error ? error.message : String(error)}`);
    return { config, warnings };
  }

  if (!isRecord(parsed) || parsed.ignore === undefined) {
    return { config, warnings };
  }

  if (!isRecord(parsed.ignore)) {
    warnings.push("Ignored .uatu.json ignore because it must be an object.");
    return { config, warnings };
  }

  const block = parsed.ignore;

  if (block.exclude !== undefined) {
    if (Array.isArray(block.exclude) && block.exclude.every(value => typeof value === "string")) {
      config.exclude = (block.exclude as string[]).map(pattern => pattern.trim()).filter(Boolean);
    } else {
      warnings.push("Ignored .uatu.json ignore.exclude because it must be a string array.");
    }
  }

  if (block.respectGitignore !== undefined) {
    if (typeof block.respectGitignore === "boolean") {
      config.respectGitignore = block.respectGitignore;
    } else {
      warnings.push("Ignored .uatu.json ignore.respectGitignore because it must be a boolean.");
    }
  }

  return { config, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
