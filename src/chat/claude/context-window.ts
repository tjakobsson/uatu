import type { ContextWindowMetadata } from "../types";

export type ClaudeWindowAnswer = { model?: string; limit: number; details: Pick<ContextWindowMetadata, "kind" | "compactionThreshold"> };

const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Control replies use camelCase; structured /context replies use snake_case.
 * Neither maxTokens nor rawMaxTokens claims to be hard model capacity. */
export function claudeWindowAnswer(value: unknown): ClaudeWindowAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const limit = positive(raw.maxTokens) ?? positive(raw.rawMaxTokens) ?? positive(raw.raw_max_tokens);
  if (!limit) return undefined;
  const over = raw.over_limit as { kind?: unknown } | undefined;
  const compactionThreshold = raw.isAutoCompactEnabled === true ? positive(raw.autoCompactThreshold) : undefined;
  return {
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    limit,
    details: {
      kind: over?.kind === "compaction_window" ? "compaction" : "effective",
      ...(compactionThreshold ? { compactionThreshold } : {}),
    },
  };
}

export type WindowDiagnostic = {
  phase: "catalog" | "session";
  source: "catalog" | "session";
  selected?: string;
  resolved?: string;
  epoch: number;
  outcome: "confirmed" | "failed" | "timeout" | "mismatch" | "stale" | "unsupported";
  limit?: number;
};
