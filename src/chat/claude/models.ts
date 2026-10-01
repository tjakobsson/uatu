import { escapeRegexLiteral } from "../../shared/match-pattern";
import type { ChatModel } from "../types";
import { claudeModelSelection } from "./normalization";

/**
 * The Claude Code model manifest (D5): the picker an install that cannot
 * answer falls back to, with effort tiers following the SDK's own
 * documentation of which models accept `xhigh`/`max`. Its windows are only
 * the fallback for a model Claude Code has not stated a window for: the
 * catalog probe asks Claude Code for every offered model's window before any
 * turn (provider.ts), and a session's own report wins after that
 * (context-readout.ts). The figures are what Claude Code stated when probed
 * on 2026-10-01 (CLI 2.1.281): Opus 5, Sonnet 5, Fable 5 and the 5.5/5.1
 * generation run the enlarged window on their plain ids; Haiku 4.5 runs the
 * 200k standard.
 */
const FULL_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
const STANDARD_EFFORT = ["low", "medium", "high"] as const;

export const CLAUDE_MODELS: ChatModel[] = [
  // The CLI's default resolves to Opus 5 (probed 2026-09-09), so the
  // sentinel row carries that window until the live catalog says otherwise.
  { selection: claudeModelSelection("default"), provider: "Anthropic", name: "Default (recommended)", default: true, detail: "Claude Code's own model choice", variants: [...FULL_EFFORT], contextLimit: 1_000_000, imageInput: true },
  // Fable 5 runs the enlarged window (probed 2026-09-02), fallback or not.
  { selection: claudeModelSelection("claude-fable-5"), provider: "Anthropic", name: "Fable 5", variants: [...FULL_EFFORT], contextLimit: 1_000_000, imageInput: true },
  { selection: claudeModelSelection("claude-opus-5"), provider: "Anthropic", name: "Opus 5", variants: [...FULL_EFFORT], contextLimit: 1_000_000, imageInput: true },
  { selection: claudeModelSelection("claude-sonnet-5"), provider: "Anthropic", name: "Sonnet 5", variants: [...FULL_EFFORT], contextLimit: 1_000_000, imageInput: true },
  { selection: claudeModelSelection("claude-haiku-4-5-20251001"), provider: "Anthropic", name: "Haiku 4.5", variants: [...STANDARD_EFFORT], contextLimit: 200_000, imageInput: true },
];

// The group label under which the app-only set is offered: a heading of its
// own in the picker so the catalog's rows stay first and unmistakable (D3).
export const MORE_MODELS_GROUP = "More models";

/**
 * Models the Claude apps offer that Claude Code's catalog omits (D3).
 * UatuCode's own list, maintained by hand: ids are the full wire ids the
 * CLI accepts as `model`; windows are the fallback figures (probed
 * 2026-10-01: Fable 5, Opus 4.8 and Opus 4.7 run the enlarged window, Sonnet
 * 4.6 the standard one; Opus 4.6 was last probed at the standard one on
 * 2026-09-02) and are replaced by what Claude Code states when the catalog is
 * read; effort tiers follow the SDK's EffortLevel notes (`xhigh` on Fable 5
 * and Opus 4.7+; `max` on select models only).
 */
const moreModel = (modelId: string, name: string, contextLimit: number, variants: readonly string[]): ChatModel => ({
  selection: claudeModelSelection(modelId),
  provider: MORE_MODELS_GROUP,
  name,
  variants: [...variants],
  contextLimit,
  imageInput: true,
  detail: moreModelDetail(modelId, contextLimit),
});

/** A "More models" row's detail line, restated whenever its window is. */
export function moreModelDetail(modelId: string, contextLimit: number): string {
  return `${modelId} · ${windowLabel(contextLimit)} context · offered by the Claude apps`;
}

/** 1_000_000 → "1M", 2_500_000 → "2.5M", 200_000 → "200k". */
export function windowLabel(contextLimit: number): string {
  if (contextLimit >= 1_000_000) return `${Number((contextLimit / 1_000_000).toFixed(1))}M`;
  return `${Math.round(contextLimit / 1_000)}k`;
}

export const CLAUDE_MORE_MODELS: ChatModel[] = [
  moreModel("claude-fable-5", "Fable 5", 1_000_000, FULL_EFFORT),
  moreModel("claude-opus-4-8", "Opus 4.8", 1_000_000, FULL_EFFORT),
  moreModel("claude-opus-4-7", "Opus 4.7", 1_000_000, ["low", "medium", "high", "xhigh"]),
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

// Fallback windows for ids no manifest row carries — the generation the live
// catalog serves under its aliases ("sonnet" → claude-sonnet-5-5). Probed
// 2026-10-01; Claude Code's own statement replaces them when it can answer.
const FALLBACK_WINDOWS: Readonly<Record<string, number>> = {
  "claude-sonnet-5-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
};

export function findClaudeModel(modelId: string): ChatModel | undefined {
  return [...CLAUDE_MODELS, ...CLAUDE_MORE_MODELS].find(model => model.selection.modelId === modelId);
}

/**
 * The fallback window for a model Claude Code has not stated one for (the
 * live ModelInfo carries no context-window field): the "[1m]" variant
 * marker anywhere in its ids means the enlarged window; failing that, the
 * manifest's figure for the id; failing that, the 200k standard. The
 * "default" sentinel names no model of its own, so only its resolved id
 * speaks for it.
 */
export function claudeContextWindow(...ids: Array<string | undefined>): number {
  if (ids.some(id => id?.includes("[1m]"))) return 1_000_000;
  for (const id of ids) {
    if (!id || id === "default") continue;
    const bare = stripWindowMarker(id);
    const known = findClaudeModel(bare)?.contextLimit ?? FALLBACK_WINDOWS[bare];
    if (known !== undefined) return known;
  }
  return 200_000;
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

