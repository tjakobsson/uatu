// Loads the optional `mono` block from `.uatu.json`. Lives next to (not
// inside) `terminal/config.ts` because the mono face is a global UI concern
// — every monospace surface in the app reads from `--mono-font-family` —
// not specifically a terminal one. Both modules read the same file
// independently, matching how `review/load.ts` and `sidebar/tree-config.ts`
// each own their own slice of `.uatu.json`.

import { promises as fs } from "node:fs";
import path from "node:path";

export type MonoConfig = {
  fontFamily?: string;
};

export type MonoConfigResult = {
  config: MonoConfig;
  warnings: string[];
};

export async function loadMonoConfig(rootPath: string): Promise<MonoConfigResult> {
  const config: MonoConfig = {};
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

  if (!isRecord(parsed) || !isRecord(parsed.mono)) {
    return { config, warnings };
  }

  const mono = parsed.mono;

  if (mono.fontFamily !== undefined) {
    if (typeof mono.fontFamily === "string" && mono.fontFamily.trim()) {
      config.fontFamily = mono.fontFamily.trim();
    } else {
      warnings.push("Ignored mono.fontFamily because it must be a non-empty string.");
    }
  }

  return { config, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
