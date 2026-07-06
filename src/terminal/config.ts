// Loads the optional `terminal` block from `.uatu.json`. Lives next to (not
// inside) `review-load.ts` because terminal config is global per-uatu-instance
// rather than per-repo, and merging the two parsers would just create coupling
// for no payoff. Both modules read the same file independently.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { TerminalClipboardPolicy } from "../shared/types";

export type TerminalConfig = {
  fontFamily?: string;
  fontSize?: number;
  clipboard?: TerminalClipboardPolicy;
};

const CLIPBOARD_POLICIES: readonly TerminalClipboardPolicy[] = ["notify", "confirm", "silent", "off"];

export type TerminalConfigResult = {
  config: TerminalConfig;
  warnings: string[];
};

const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 32;

export async function loadTerminalConfig(rootPath: string): Promise<TerminalConfigResult> {
  const config: TerminalConfig = {};
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
  } catch (error) {
    // review-load.ts already surfaces a parse warning; don't double-warn.
    return { config, warnings };
  }

  if (!isRecord(parsed) || !isRecord(parsed.terminal)) {
    return { config, warnings };
  }

  const terminal = parsed.terminal;

  if (terminal.fontFamily !== undefined) {
    if (typeof terminal.fontFamily === "string" && terminal.fontFamily.trim()) {
      config.fontFamily = terminal.fontFamily.trim();
    } else {
      warnings.push("Ignored terminal.fontFamily because it must be a non-empty string.");
    }
  }

  if (terminal.fontSize !== undefined) {
    const size = Number(terminal.fontSize);
    if (Number.isFinite(size) && size >= TERMINAL_FONT_SIZE_MIN && size <= TERMINAL_FONT_SIZE_MAX) {
      config.fontSize = size;
    } else {
      warnings.push(
        `Ignored terminal.fontSize because it must be a number between ${TERMINAL_FONT_SIZE_MIN} and ${TERMINAL_FONT_SIZE_MAX}.`,
      );
    }
  }

  if (terminal.clipboard !== undefined) {
    const policy = typeof terminal.clipboard === "string" ? terminal.clipboard.trim() : terminal.clipboard;
    if (typeof policy === "string" && (CLIPBOARD_POLICIES as readonly string[]).includes(policy)) {
      config.clipboard = policy as TerminalClipboardPolicy;
    } else {
      // Omitting the key (rather than forcing a value) lets the client apply
      // its own `notify` default — same effective fallback, one owner.
      warnings.push('Ignored terminal.clipboard because it must be "notify", "confirm", "silent", or "off".');
    }
  }

  return { config, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
