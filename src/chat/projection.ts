import { mergeAssistantMessage } from "./usage";
import type { ChatEvent, ConversationItem, ConversationSnapshot, ConversationStatus } from "./types";

export type AcceptedDraft = { requestId: string; messageId: string; text: string };
export type ChatProjection = {
  conversationId: string;
  generation: string;
  sequence: number;
  cursor: string;
  items: ConversationItem[];
  status: ConversationStatus;
  olderCursor?: string;
  acceptedDrafts: AcceptedDraft[];
};

export type ProjectionResult = { projection: ChatProjection; outcome: "applied" | "duplicate" | "gap" | "resync" };

export function projectionFromSnapshot(snapshot: ConversationSnapshot, acceptedDrafts: AcceptedDraft[] = []): ChatProjection {
  const sequence = decodeCursorSequence(snapshot.cursor) ?? 0;
  return {
    conversationId: snapshot.conversation.id,
    generation: snapshot.generation,
    sequence,
    cursor: snapshot.cursor,
    items: deduplicate(snapshot.items),
    status: snapshot.conversation.status,
    olderCursor: snapshot.olderCursor,
    acceptedDrafts: reconcileDrafts(acceptedDrafts, snapshot.items),
  };
}

export function prependSnapshot(current: ChatProjection, page: ConversationSnapshot): ChatProjection {
  const existing = new Set(current.items.map(item => item.id));
  return { ...current, items: [...page.items.filter(item => !existing.has(item.id)), ...current.items], olderCursor: page.olderCursor };
}

export function addAcceptedDraft(current: ChatProjection, draft: AcceptedDraft): ChatProjection {
  return {
    ...current,
    acceptedDrafts: reconcileDrafts(
      [...current.acceptedDrafts.filter(item => item.requestId !== draft.requestId), draft],
      current.items,
    ),
  };
}

export function removeAcceptedDraft(current: ChatProjection, requestId: string): ChatProjection {
  return { ...current, acceptedDrafts: current.acceptedDrafts.filter(item => item.requestId !== requestId) };
}

export function confirmAcceptedDraft(current: ChatProjection, draft: AcceptedDraft): ChatProjection {
  const id = `message:${draft.messageId}`;
  const item: ConversationItem = { id, type: "user_message", createdAt: Date.now(), text: draft.text, requestId: draft.requestId };
  const existing = current.items.findIndex(candidate => candidate.id === id);
  return {
    ...current,
    items: existing < 0 ? [...current.items, item] : current.items.map((candidate, index) => index === existing ? item : candidate),
    acceptedDrafts: current.acceptedDrafts.filter(candidate => candidate.requestId !== draft.requestId),
  };
}

export function applyChatEvent(current: ChatProjection, event: ChatEvent, cursor = current.cursor): ProjectionResult {
  if (event.conversationId !== current.conversationId || event.generation !== current.generation || event.type === "resync") {
    return { projection: current, outcome: "resync" };
  }
  if (event.sequence <= current.sequence) return { projection: current, outcome: "duplicate" };
  if (event.sequence !== current.sequence + 1) return { projection: current, outcome: "gap" };

  let items = current.items;
  let status = current.status;
  if (event.type === "item.upsert") {
    const index = items.findIndex(item => item.id === event.item.id);
    const existing = index < 0 ? undefined : items[index];
    const incoming = mergeUpsert(existing, event.item);
    items = index < 0 ? [...items, incoming] : items.map((item, at) => at === index ? incoming : item);
  } else if (event.type === "item.remove") {
    items = items.filter(item => item.id !== event.itemId);
  } else if (event.type === "item.text_delta") {
    items = items.map(item => item.id === event.itemId ? appendDelta(item, event.delta) : item);
  } else if (event.type === "conversation.status") {
    status = event.status;
  }
  return {
    projection: {
      ...current,
      sequence: event.sequence,
      cursor,
      items,
      status,
      acceptedDrafts: reconcileDrafts(current.acceptedDrafts, items),
    },
    outcome: "applied",
  };
}

/**
 * What an upsert keeps from the item it replaces. Two cases, both about an
 * upsert that carries less than what is already on screen:
 *
 * - A `message.updated` for a user message normalizes with empty parts, and an
 *   optimistically-sent message holds a requestId the server echo lacks.
 * - A token-usage upsert restates a dedicated empty-markdown carrier and must
 *   preserve previously reported accounting fields it omits.
 */
function mergeUpsert(existing: ConversationItem | undefined, incoming: ConversationItem): ConversationItem {
  if (!existing || existing.type !== incoming.type) return incoming;
  if (existing.type === "user_message" && incoming.type === "user_message") {
    return existing.requestId && !incoming.requestId
      ? { ...incoming, text: existing.text, requestId: existing.requestId }
      : incoming;
  }
  if (existing.type === "assistant_message" && incoming.type === "assistant_message") {
    return mergeAssistantMessage(existing, incoming);
  }
  return incoming;
}

function appendDelta(item: ConversationItem, delta: string): ConversationItem {
  if (item.type === "assistant_message") return { ...item, markdown: item.markdown + delta };
  if (item.type === "reasoning") return { ...item, text: item.text + delta };
  return item;
}

function deduplicate(items: ConversationItem[]): ConversationItem[] {
  const byId = new Map<string, ConversationItem>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

function reconcileDrafts(drafts: AcceptedDraft[], items: ConversationItem[]): AcceptedDraft[] {
  const accepted = new Set(items.filter(item => item.type === "user_message").flatMap(item => [
    item.id,
    item.id.replace(/^message:/, ""),
    item.requestId ?? "",
  ]));
  return drafts.filter(draft => !accepted.has(draft.messageId) && !accepted.has(draft.requestId));
}

function decodeCursorSequence(cursor: string): number | null {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(base64)) as { v?: unknown; s?: unknown };
    return decoded.v === 1 && Number.isSafeInteger(decoded.s) && (decoded.s as number) >= 0 ? decoded.s as number : null;
  } catch {
    return null;
  }
}
