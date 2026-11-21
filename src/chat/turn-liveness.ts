import { isLiveConversationStatus, type ConversationStatus } from "./types";

// Agent-neutral turn liveness for image capture. Each agent's normalizer
// writes these in-process annotations; the adapter and the router read only
// them, never an agent's own markers. They survive object spreads and are
// dropped by JSON, so none of them is part of a wire contract.

/** The reply's Markdown is final for capture, independently of its turn.
 * "ended": the agent reported an explicit text end. "completion": the reply's
 * `completedAt` ends its text block but not its turn. A reply with neither
 * never treats a completion time as sealing its text. */
export const CHAT_TEXT_SEAL = Symbol("chat-text-seal");
export type ChatTextSeal = { readonly [CHAT_TEXT_SEAL]?: "ended" | "completion" };

export function isTextSealed(item: { completedAt?: number } & ChatTextSeal): boolean {
  const seal = item[CHAT_TEXT_SEAL];
  return seal === "ended" || seal === "completion" && item.completedAt !== undefined;
}

/** Turn token: a reply's own execution evidence. Open means the execution that
 * produced the reply is still running, closed means it ended, and a reply
 * without a token has no evidence (see `isReplyLive`).
 *
 * A normalizer may attach one token to every reply of a turn and close it at
 * the turn's end. Only the adapter's projection freezes, copies, seals or
 * preserves tokens.
 * - "provisional": the producer may close it ahead of the frames still queued
 *   for ordered projection, so only the in-order status sequence seals it
 *   there. Snapshots and history adopt the producer's value.
 * - "authoritative": stored evidence, adopted wherever it appears and in
 *   either direction. Only stored history rows carry it, and a reply never
 *   carries both kinds. Its producer never changes it: replace the row,
 *   never the token. */
export const CHAT_TURN = Symbol("chat-turn");
export type ChatTurnToken = { completed: boolean; readonly authority: "provisional" | "authoritative" };
export type ChatTurnIdentity = { readonly [CHAT_TURN]?: ChatTurnToken };

/** A new open token for one turn's replies; its producer closes it at the turn's end. */
export function provisionalTurn(): ChatTurnToken {
  return { completed: false, authority: "provisional" };
}

/** Authoritative evidence that a reply's execution is still running, or has
 * ended. A fresh token per reply: only the adapter's projection freezes it. */
export function executionEvidence(live: boolean): ChatTurnIdentity {
  return { [CHAT_TURN]: { completed: !live, authority: "authoritative" } };
}

/** Execution live: yes, no, or unknown when the reply carries no evidence. */
export function executionLive(item: object): boolean | undefined {
  const turn = (item as ChatTurnIdentity)[CHAT_TURN];
  return turn === undefined ? undefined : !turn.completed;
}

/** Whether a missing image may still appear for this reply. Text completion is
 * distinct from the execution that may still run a file-producing tool, so
 * execution evidence overrides `completedAt`. `orderedProjection` is the live
 * event path: its frames can carry a provisional token the producer already
 * closed, and must wait for their ordered status instead. Without evidence the
 * reply is live while the conversation streams, unless it has a completion
 * time that is not text-only. */
export function isReplyLive(item: { completedAt?: number } & ChatTextSeal & ChatTurnIdentity, streaming: boolean, orderedProjection = false): boolean {
  const turn = item[CHAT_TURN];
  if (turn) return streaming && (orderedProjection && turn.authority === "provisional" || !turn.completed);
  return streaming && (item[CHAT_TEXT_SEAL] === "completion" || item.completedAt === undefined);
}

/** On a failed status that is not a repeat: the failure is not the end of its
 * turn (a retryable failed step). On any other status it is ignored. */
export const CHAT_TURN_CONTINUES = Symbol("chat-turn-continues");
/** On a completed status: it restates one already ordered, so it is not a
 * capture boundary. It neither seals a newer turn's replies nor finalizes
 * their captures; the public status still drives settlement and held-message
 * delivery. On any other status it is ignored. */
export const CHAT_STATUS_REPEAT = Symbol("chat-status-repeat");
/** Written only by the adapter's projection, on a completed status or summary:
 * a repeat arrived while the turn was live, so that turn continues. */
export const CHAT_REPEAT_CONTINUES = Symbol("chat-repeat-continues");
export type ChatStatusLiveness = {
  readonly [CHAT_TURN_CONTINUES]?: true;
  readonly [CHAT_STATUS_REPEAT]?: true;
  readonly [CHAT_REPEAT_CONTINUES]?: true;
};

/** The statuses that end a turn, unless a failure continues it or a repeat
 * restates one already ordered. */
export function isTerminalStatus(status: ConversationStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

/** Visual capture only; public composer/worker status keeps its native value.
 * It reads the continuation the projection derives from a repeat, never the
 * repeat flag itself. */
export function isVisualTurnLive(value: { status: ConversationStatus } & ChatStatusLiveness): boolean {
  return value.status === "failed" && value[CHAT_TURN_CONTINUES] === true
    || value.status === "completed" && value[CHAT_REPEAT_CONTINUES] === true
    || isLiveConversationStatus(value.status);
}

const REPLY_FACTS: readonly PropertyKey[] = [CHAT_TURN, CHAT_TEXT_SEAL, "completedAt"];

/** The sparse merge of a reply's facts (its turn token, its text seal and the
 * `completedAt` the completion seal relies on): a later item's facts win when
 * it carries them, and one it omits or carries as an explicit undefined keeps
 * the earlier item's value. Shared by the projection's merge and the update
 * coalescer, so one window and two produce the same facts. */
export function withRetainedReplyFacts<T extends object>(earlier: object, later: T): T {
  let merged: Record<PropertyKey, unknown> | undefined;
  for (const key of REPLY_FACTS) {
    if ((later as Record<PropertyKey, unknown>)[key] !== undefined) continue;
    const kept = (earlier as Record<PropertyKey, unknown>)[key];
    if (kept === undefined && !(key in later)) continue;
    const next: Record<PropertyKey, unknown> = merged ??= { ...later } as Record<PropertyKey, unknown>;
    if (kept === undefined) delete next[key]; else next[key] = kept;
  }
  return (merged ?? later) as T;
}

/** The item with exactly the reply facts `source` carries, or none when it has
 * none (or there is no source). The update coalescer uses it to keep reply
 * facts from moving backward across an upsert while every other field of the
 * later item is taken as is. */
export function withReplyFactsOf<T extends object>(source: object | undefined, item: T): T {
  let merged: Record<PropertyKey, unknown> | undefined;
  for (const key of REPLY_FACTS) {
    const wanted = (source as Record<PropertyKey, unknown> | undefined)?.[key];
    const carried = (item as Record<PropertyKey, unknown>)[key];
    if (wanted === carried && (wanted !== undefined || !(key in item))) continue;
    const next: Record<PropertyKey, unknown> = merged ??= { ...item } as Record<PropertyKey, unknown>;
    if (wanted === undefined) delete next[key]; else next[key] = wanted;
  }
  return (merged ?? item) as T;
}

