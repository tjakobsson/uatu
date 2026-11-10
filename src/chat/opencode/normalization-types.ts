import { isLiveConversationStatus, type ConversationStatus } from "../types";

/** Native text completion seals Markdown syntax, not the parent message/turn. */
export const OPENCODE_TEXT_END = Symbol("opencode-text-end");
export type OpenCodeTextIdentity = { [OPENCODE_TEXT_END]?: true };

/** This frame's start is only the first observed delta/end, not a native part
 * start. A retained row already owns its start; syntax completion must not
 * replace that established value with this subscription-local fallback. */
export const OPENCODE_TEXT_START_FALLBACK = Symbol("opencode-text-start-fallback");
export type OpenCodeTextStart = { readonly [OPENCODE_TEXT_START_FALLBACK]?: boolean };

/** Snapshot-owned execution membership, independent of API-message completion.
 * true: no native execution end follows this row; false: a native end seals it.
 * Copy the primitive when replacing a row; never mutate an earlier frame. */
export const OPENCODE_EXECUTION_LIVE = Symbol("opencode-execution-live");
export type OpenCodeExecutionIdentity = { readonly [OPENCODE_EXECUTION_LIVE]?: boolean };

/** A failed native step is not an execution end. Immutable on each frame. */
export const OPENCODE_STEP_LIVE = Symbol("opencode-step-live");
export type OpenCodeStepStatus = { [OPENCODE_STEP_LIVE]?: true };

/** V1 source-local idle alias, witnessed after that source's latest idle status
 * and before a subsequent busy/retry status, ahead of cross-stream deduplication.
 * It repeats an already queued idle status; it cannot end a newer visual turn.
 * No execution identity or timestamp is inferred from the session/user ids. */
export const OPENCODE_COMPLETION_ALIAS = Symbol("opencode-completion-alias");
/** Ordered projection-owned continuation, copied into snapshots/status frames. */
export const OPENCODE_ALIAS_LIVE = Symbol("opencode-alias-live");
export type OpenCodeCompletionAlias = { readonly [OPENCODE_COMPLETION_ALIAS]?: true; readonly [OPENCODE_ALIAS_LIVE]?: true };

/** Visual capture only; public composer/worker status keeps its native value. */
export function isVisualTurnLive(value: { status: ConversationStatus } & OpenCodeStepStatus & OpenCodeCompletionAlias): boolean {
  return value.status === "completed" && value[OPENCODE_ALIAS_LIVE] === true
    || value.status === "failed" && value[OPENCODE_STEP_LIVE] === true || isLiveConversationStatus(value.status);
}
