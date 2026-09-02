import { escapeRegexLiteral } from "../../shared/match-pattern";
import type { ChatModel } from "../types";
import { claudeModelSelection } from "./normalization";

/**
 * The Claude Code model manifest (D5): no catalog API exists before a session
 * runs, so the offered models and their effort levels are declared here and
 * maintained by hand. Effort tiers follow the SDK's own documentation of
 * which models accept `xhigh`/`max`; the 200k context window is the
 * published standard for these models.
 */
const FULL_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
const STANDARD_EFFORT = ["low", "medium", "high"] as const;

export const CLAUDE_MODELS: ChatModel[] = [
  { selection: claudeModelSelection("default"), provider: "Anthropic", name: "Default (recommended)", default: true, detail: "Claude Code's own model choice", variants: [...FULL_EFFORT], contextLimit: 200_000, imageInput: true },
  // Fable 5 runs the enlarged window (probed 2026-09-02), fallback or not.
  { selection: claudeModelSelection("claude-fable-5"), provider: "Anthropic", name: "Fable 5", variants: [...FULL_EFFORT], contextLimit: 1_000_000, imageInput: true },
  { selection: claudeModelSelection("claude-opus-5"), provider: "Anthropic", name: "Opus 5", variants: [...FULL_EFFORT], contextLimit: 200_000, imageInput: true },
  { selection: claudeModelSelection("claude-sonnet-5"), provider: "Anthropic", name: "Sonnet 5", variants: [...FULL_EFFORT], contextLimit: 200_000, imageInput: true },
  { selection: claudeModelSelection("claude-haiku-4-5-20251001"), provider: "Anthropic", name: "Haiku 4.5", variants: [...STANDARD_EFFORT], contextLimit: 200_000, imageInput: true },
];

// The group label under which the app-only set is offered: a heading of its
// own in the picker so the catalog's rows stay first and unmistakable (D3).
export const MORE_MODELS_GROUP = "More models";

/**
 * Models the Claude apps offer that Claude Code's catalog omits (D3).
 * UatuCode's own list, maintained by hand: ids are the full wire ids the
 * CLI accepts as `model`, windows were probed on 2026-09-02 (Opus 4.8 and
 * Fable 5 run the enlarged window; Opus 4.7/4.6 and Sonnet 4.6 the
 * standard one), effort tiers follow the SDK's EffortLevel notes (`xhigh`
 * on Fable 5 and Opus 4.7+; `max` on select models only).
 */
const moreModel = (modelId: string, name: string, contextLimit: number, variants: readonly string[]): ChatModel => ({
  selection: claudeModelSelection(modelId),
  provider: MORE_MODELS_GROUP,
  name,
  variants: [...variants],
  contextLimit,
  imageInput: true,
  detail: `${modelId} · ${contextLimit >= 1_000_000 ? "1M" : `${Math.round(contextLimit / 1_000)}k`} context · offered by the Claude apps`,
});

export const CLAUDE_MORE_MODELS: ChatModel[] = [
  moreModel("claude-fable-5", "Fable 5", 1_000_000, FULL_EFFORT),
  moreModel("claude-opus-4-8", "Opus 4.8", 1_000_000, FULL_EFFORT),
  moreModel("claude-opus-4-7", "Opus 4.7", 200_000, ["low", "medium", "high", "xhigh"]),
  moreModel("claude-opus-4-6", "Opus 4.6", 200_000, STANDARD_EFFORT),
  moreModel("claude-sonnet-4-6", "Sonnet 4.6", 200_000, STANDARD_EFFORT),
];

/**
 * The catalog with the app-only set appended under its own group. A catalog
 * id is never shadowed: an entry whose id — or whose resolved id, with or
 * without the window marker — the catalog already offers is left out, so
 * one model is one row wherever the CLI already lists it.
 */
export function withMoreModels(catalog: ChatModel[]): ChatModel[] {
  const known = new Set<string>();
  for (const model of catalog) {
    for (const id of [model.selection.modelId, model.resolvesTo?.modelId]) {
      if (!id) continue;
      known.add(id);
      known.add(stripWindowMarker(id));
    }
  }
  return [...catalog, ...CLAUDE_MORE_MODELS.filter(model => !known.has(model.selection.modelId))];
}

export function findClaudeModel(modelId: string): ChatModel | undefined {
  return [...CLAUDE_MODELS, ...CLAUDE_MORE_MODELS].find(model => model.selection.modelId === modelId);
}

/**
 * The live ModelInfo carries no context-window field: the only wire signal
 * for the enlarged window is the "[1m]" variant marker somewhere in the
 * model id, and the published 200k standard is the base for everything
 * else.
 */
export function claudeContextWindow(...ids: Array<string | undefined>): number {
  return ids.some(id => id?.includes("[1m]")) ? 1_000_000 : 200_000;
}

/** "claude-opus-5[1m]" → "claude-opus-5": the id without its window marker. */
export function stripWindowMarker(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

const WINDOW_MARKER = /\s*\((\d+[MK] context)\)\s*$/i;

/**
 * A catalog row's name with its version (D2). The CLI's `displayName`
 * omits the version ("Opus (1M context)", "Fable"); the version lives in
 * the `description`'s leading segment ("Fable 5.1 · Most capable…") and,
 * failing that, in the resolved wire id ("claude-haiku-4-5-20251001").
 * A display name that already carries a digit outside the window marker
 * is kept as is; the marker is preserved either way.
 */
export function versionedModelName(displayName: string, description: string | undefined, resolvedModel: string | undefined): string {
  const marker = WINDOW_MARKER.exec(displayName)?.[1];
  const base = displayName.replace(WINDOW_MARKER, "").trim();
  if (!base || /\d/.test(base)) return displayName;
  const suffix = marker ? ` (${marker})` : "";
  // "Opus 5 with 1M context · Best for…" → the version right after the
  // family name in the first segment.
  const leading = (description ?? "").split(" · ")[0] ?? "";
  const fromDescription = new RegExp(`(?:^|\\s)${escapeRegexLiteral(base)}\\s+(\\d+(?:\\.\\d+)*)(?=\\s|$)`, "i").exec(leading)?.[1];
  if (fromDescription) return `${base} ${fromDescription}${suffix}`;
  const fromId = versionFromModelId(resolvedModel);
  if (fromId) return `${base} ${fromId}${suffix}`;
  return displayName;
}

/** "claude-haiku-4-5-20251001" → "4.5"; "claude-fable-5-1" → "5.1"; "claude-opus-5[1m]" → "5". */
function versionFromModelId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const stripped = stripWindowMarker(id);
  const match = /^claude-[a-z]+-(\d+(?:-\d+)*?)(?:-\d{8})?$/.exec(stripped);
  return match ? match[1]!.replaceAll("-", ".") : undefined;
}

