import { isLiveConversationStatus, type ConversationStatus } from "../types";

/** Native text completion seals Markdown syntax, not the parent message/turn. */
export const OPENCODE_TEXT_END = Symbol("opencode-text-end");
export type OpenCodeTextIdentity = { [OPENCODE_TEXT_END]?: true };

/** Snapshot-owned execution membership, independent of API-message completion.
 * true: no native execution end follows this row; false: a native end seals it.
 * Copy the primitive when replacing a row; never mutate an earlier frame. */
export const OPENCODE_EXECUTION_LIVE = Symbol("opencode-execution-live");
export type OpenCodeExecutionIdentity = { readonly [OPENCODE_EXECUTION_LIVE]?: boolean };

/** A failed native step is not an execution end. Immutable on each frame. */
export const OPENCODE_STEP_LIVE = Symbol("opencode-step-live");
export type OpenCodeStepStatus = { [OPENCODE_STEP_LIVE]?: true };

/** Visual capture only; public composer/worker status keeps its native value. */
export function isVisualTurnLive(value: { status: ConversationStatus } & OpenCodeStepStatus): boolean {
  return value.status === "failed" && value[OPENCODE_STEP_LIVE] === true || isLiveConversationStatus(value.status);
}
