// Token-usage arithmetic and merge semantics shared by the server adapter and
// the client projection. Both sides consume the same event stream, so the
// rules for combining usage with what is already held must be written once —
// two copies drifting apart would make the live stream and the snapshot
// disagree about the same conversation.

import type { AssistantMessageItem, TokenUsage } from "./types";

/**
 * Every token component a `TokenUsage` can carry, as one list. Summing,
 * comparing, and validating all enumerate the components; a new one the agent
 * starts reporting is added here and every consumer follows, instead of each
 * copy of the list silently missing it. `costUsd` is deliberately not a
 * component: it is money, not tokens, so a token sum must not add it.
 */
export const TOKEN_USAGE_COMPONENTS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

/**
 * Everything a usage report says was spent, output and reasoning included.
 * This is a spend figure — unlike the context readout, which asks how full
 * the window is right now and so counts only what occupies it.
 */
export function totalTokens(usage: TokenUsage): number {
  return TOKEN_USAGE_COMPONENTS.reduce((sum, key) => sum + (usage[key] ?? 0), 0);
}

/**
 * Dollars as the readouts show them: cents for anything a reader would
 * budget, four places below ten cents so a cheap turn does not round to
 * nothing.
 */
export function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.1 ? 4 : 2 });
}

/** Tokens occupying the model's context window right now. */
export function contextTokens(usage: TokenUsage): number {
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * Component-by-component equality; absent components must match too. Cost
 * is compared as well — it rides the same record, and a restatement that
 * only moved the price is still a change.
 */
export function sameUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return TOKEN_USAGE_COMPONENTS.every(key => left[key] === right[key]) && left.costUsd === right.costUsd;
}

/**
 * What an assistant-message upsert keeps from the item it replaces. A
 * usage-only upsert (empty markdown is the producer's signal — see
 * `usageUpsert` in normalization.ts) updates the dedicated message-level
 * carrier. Keeping its original timestamp prevents cumulative restatements
 * from resorting the timeline, which is ordered by `createdAt`.
 */
export function mergeAssistantMessage(current: AssistantMessageItem, incoming: AssistantMessageItem): AssistantMessageItem {
  const usageOnly = incoming.markdown === "";
  return {
    ...current,
    ...incoming,
    createdAt: usageOnly ? current.createdAt : incoming.createdAt,
    markdown: incoming.markdown || current.markdown,
    model: incoming.model ?? current.model,
    ...(current.usage || incoming.usage ? { usage: { ...current.usage, ...incoming.usage } } : {}),
  };
}
