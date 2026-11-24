import type { NormalizedProviderUpdate } from "../../src/chat/provider";
import { CHAT_STATUS_REPEAT, CHAT_TEXT_SEAL, CHAT_TURN, CHAT_TURN_CONTINUES, type ChatStatusLiveness, type ChatTextSeal, type ChatTurnIdentity, type ChatTurnToken } from "../../src/chat/turn-liveness";
import type { ConversationItem } from "../../src/chat/types";

type Output = Iterable<NormalizedProviderUpdate | ConversationItem>;
type Facts = { seal?: unknown; completedAt?: unknown; turn?: ChatTurnToken };
type TokenState = { completed: boolean; authority: string; rows: Set<string> };

/** Checks a normalizer's output against the D1 liveness contract. Observe each
 * frame's output as soon as it is normalized: after every frame the current
 * state of every token seen so far is compared with its recorded state. A
 * conforming normalizer has no mixed replies, no status with both flags, no
 * repeat on a status other than completed, no continuation on a status other
 * than failed, no reply fact changed on a text update to an existing row, and
 * no token changed in place except a provisional one closing at a genuine
 * turn boundary: a terminal status that neither continues nor repeats (under
 * D1's precedence), or a native turn end that emits no updates, which the
 * caller declares with `turnEnd`. */
export function livenessChecker() {
  const kinds = new Map<string, Set<string>>();
  // A reply's facts as its creating item and upserts left them.
  const rows = new Map<string, Facts>();
  const tokens = new Map<ChatTurnToken, TokenState>();
  const textFactChanges = new Set<string>();
  const tokenChanges = new Set<string>();
  const statuses: Array<{ completed: boolean; failed: boolean; repeat: boolean; continues: boolean }> = [];
  const record = (token: ChatTurnToken, id: string): TokenState => {
    let state = tokens.get(token);
    if (!state) { state = { completed: token.completed, authority: token.authority, rows: new Set() }; tokens.set(token, state); }
    state.rows.add(id);
    return state;
  };
  const observe = <T extends Output>(output: T, frame: { turnEnd?: boolean } = {}): T => {
    let boundary = frame.turnEnd === true;
    for (const entry of output) {
      if ("kind" in entry && entry.kind === "status") {
        const flags = entry as typeof entry & ChatStatusLiveness;
        const repeat = flags[CHAT_STATUS_REPEAT] === true, continues = flags[CHAT_TURN_CONTINUES] === true;
        statuses.push({ completed: entry.status === "completed", failed: entry.status === "failed", repeat, continues });
        // D1 precedence: on completed only the repeat flag counts, on failed
        // only the continues flag, and on interrupted neither.
        if (entry.status === "completed" && !repeat || entry.status === "failed" && !continues || entry.status === "interrupted") boundary = true;
        continue;
      }
      // The projection deletes a removed row, and the next update recreates it
      // with fresh facts. Its token-kind history is kept: one kind for life.
      if ("kind" in entry && entry.kind === "remove") { rows.delete(entry.itemId); continue; }
      const item = "kind" in entry ? (entry.kind === "upsert" || entry.kind === "text" ? entry.item : undefined) : entry;
      if (item?.type !== "assistant_message") continue;
      const carried = replyFacts(item);
      if (carried.turn) record(carried.turn, item.id);
      const known = rows.get(item.id);
      // A text update for an existing row may repeat its facts, never change them.
      if (known && "kind" in entry && entry.kind === "text") {
        if (changes(known, carried)) textFactChanges.add(item.id);
      } else rows.set(item.id, { ...known, ...carried });
      if (carried.turn) {
        const seen = kinds.get(item.id) ?? new Set<string>();
        seen.add(carried.turn.authority);
        kinds.set(item.id, seen);
      }
    }
    // Every token seen so far, whether or not this frame carried its row.
    for (const [token, state] of tokens) {
      if (token.completed === state.completed && token.authority === state.authority) continue;
      const legal = state.authority === "provisional" && token.authority === "provisional" && !state.completed && token.completed && boundary;
      if (!legal) for (const id of state.rows) tokenChanges.add(id);
      state.completed = token.completed;
      state.authority = token.authority;
    }
    return output;
  };
  const result = () => ({
    /** Every token kind seen, across all replies. */
    authorities: new Set([...kinds.values()].flatMap(seen => [...seen])),
    /** Replies that carried both kinds. */
    mixed: [...kinds].filter(([, seen]) => seen.size > 1).map(([id]) => id),
    tokens: kinds.size,
    repeats: statuses.filter(status => status.repeat).length,
    continuations: statuses.filter(status => status.continues).length,
    /** Statuses that were both a repeat and a continuation. */
    both: statuses.filter(status => status.repeat && status.continues).length,
    /** Replies whose facts a text update to the existing row changed. */
    textFactChanges: [...textFactChanges],
    /** Replies whose token changed in place other than by closing at a genuine turn boundary. */
    tokenChanges: [...tokenChanges],
    /** Statuses other than completed carrying the repeat flag: it is completed-only. */
    repeatOffCompleted: statuses.filter(status => !status.completed && status.repeat).length,
    /** Statuses other than failed carrying the turn-continues flag: it is failed-only. */
    continuesOffFailed: statuses.filter(status => !status.failed && status.continues).length,
  });
  return { observe, result };
}

/** The same check over output already collected, observed as one frame. */
export function livenessConformance(output: Output) {
  const checker = livenessChecker();
  checker.observe(output);
  return checker.result();
}

/** The reply facts an item carries; an omitted fact is not a change. */
function replyFacts(item: ConversationItem & { type: "assistant_message" }): Facts {
  const facts: Facts = {};
  const seal = (item as typeof item & ChatTextSeal)[CHAT_TEXT_SEAL];
  const turn = (item as typeof item & ChatTurnIdentity)[CHAT_TURN];
  if (seal !== undefined) facts.seal = seal;
  if (item.completedAt !== undefined) facts.completedAt = item.completedAt;
  if (turn !== undefined) facts.turn = turn;
  return facts;
}

/** Whether carried facts differ from known ones. A text update may carry only
 * the row's own token object; its state changes are checked frame by frame. */
function changes(known: Facts, carried: Facts): boolean {
  if (carried.seal !== undefined && carried.seal !== known.seal) return true;
  if (carried.completedAt !== undefined && carried.completedAt !== known.completedAt) return true;
  return carried.turn !== undefined && carried.turn !== known.turn;
}
