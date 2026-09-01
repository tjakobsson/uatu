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
  { selection: claudeModelSelection("claude-fable-5"), provider: "Anthropic", name: "Fable 5", variants: [...FULL_EFFORT], contextLimit: 200_000, imageInput: true },
  { selection: claudeModelSelection("claude-opus-5"), provider: "Anthropic", name: "Opus 5", variants: [...FULL_EFFORT], contextLimit: 200_000, imageInput: true },
  { selection: claudeModelSelection("claude-sonnet-5"), provider: "Anthropic", name: "Sonnet 5", variants: [...FULL_EFFORT], contextLimit: 200_000, imageInput: true },
  { selection: claudeModelSelection("claude-haiku-4-5-20251001"), provider: "Anthropic", name: "Haiku 4.5", variants: [...STANDARD_EFFORT], contextLimit: 200_000, imageInput: true },
];

export function findClaudeModel(modelId: string): ChatModel | undefined {
  return CLAUDE_MODELS.find(model => model.selection.modelId === modelId);
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
