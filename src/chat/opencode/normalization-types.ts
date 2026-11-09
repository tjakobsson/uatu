import { isLiveConversationStatus, type ConversationStatus } from "../types";

/** Native text completion seals Markdown syntax, not the parent message/turn. */
export const OPENCODE_TEXT_END = Symbol("opencode-text-end");
export type OpenCodeTextIdentity = { [OPENCODE_TEXT_END]?: true };

/** A failed native step is not an execution end. Immutable on each frame. */
export const OPENCODE_STEP_LIVE = Symbol("opencode-step-live");
export type OpenCodeStepStatus = { [OPENCODE_STEP_LIVE]?: true };

/** Visual capture only; public composer/worker status keeps its native value. */
export function isVisualTurnLive(value: { status: ConversationStatus } & OpenCodeStepStatus): boolean {
  return value.status === "failed" && value[OPENCODE_STEP_LIVE] === true || isLiveConversationStatus(value.status);
}
