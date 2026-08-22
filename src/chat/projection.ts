import { mergeAssistantMessage } from "./usage";
import type { ChatEvent, ConversationConfiguration, ConversationItem, ConversationSnapshot, ConversationStatus, ConversationSummary, QueuedMessage } from "./types";

export type AcceptedDraft = { requestId: string; messageId: string; text: string };
export type ChatProjection = {
  conversationId: string;
  generation: string;
  sequence: number;
  cursor: string;
  conversation?: ConversationSummary;
  configuration?: ConversationConfiguration;
  items: ConversationItem[];
  status: ConversationStatus;
  olderCursor?: string;
  acceptedDrafts: AcceptedDraft[];
  // Server-held messages awaiting delivery, in submission order. Sourced from
  // the snapshot and restated whole by every queue event, so this is state,
  // not an accumulation.
  queued: QueuedMessage[];
  // Counts applied queue events. A held acceptance's local echo is valid only
  // while no queue event has spoken since the submission: once one has, the
  // stream is the authority and an echo could resurrect an entry the stream
  // already delivered or removed.
  queueRevision: number;
};

export type ProjectionResult = { projection: ChatProjection; outcome: "applied" | "duplicate" | "gap" | "resync" };

export function projectionFromSnapshot(snapshot: ConversationSnapshot, acceptedDrafts: AcceptedDraft[] = []): ChatProjection {
  const sequence = decodeCursorSequence(snapshot.cursor) ?? 0;
  const queued = snapshot.queued ?? [];
  return {
    conversationId: snapshot.conversation.id,
    generation: snapshot.generation,
    sequence,
    cursor: snapshot.cursor,
    conversation: snapshot.conversation,
    configuration: snapshot.configuration,
    items: deduplicate(snapshot.items),
    status: snapshot.conversation.status,
    olderCursor: snapshot.olderCursor,
    acceptedDrafts: reconcileDrafts(acceptedDrafts, snapshot.items, queued),
    queued,
    queueRevision: 0,
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
      current.queued,
    ),
  };
}

/**
 * Locally mirrors a held acceptance so the pinned entry appears the moment
 * the response lands rather than one stream event later. The next queue
 * event restates the authoritative list and converges with this.
 *
 * The echo is refused when it can only be stale: once the message has
 * already been delivered into the timeline (a retried acceptance answered
 * after delivery), or once any queue event has been applied since the
 * submission (`sinceRevision`) — the stream restates the whole queue, so an
 * entry it no longer contains was delivered or removed, and re-adding it
 * would show a phantom no later event is guaranteed to clear.
 */
export function noteQueuedMessage(current: ChatProjection, held: QueuedMessage, sinceRevision = current.queueRevision): ChatProjection {
  const delivered = held.requestId !== undefined
    && current.items.some(item => item.type === "user_message" && item.requestId === held.requestId);
  const trustEcho = !delivered && current.queueRevision === sinceRevision;
  const queued = !trustEcho || current.queued.some(entry => entry.id === held.id)
    ? current.queued
    : [...current.queued, held];
  return {
    ...current,
    queued,
    acceptedDrafts: reconcileDrafts(
      // The draft retires either way: the submission was accepted, and its
      // message is represented by the queued entry, the delivered item, or
      // the authoritative stream state — never by the draft.
      current.acceptedDrafts.filter(draft => held.requestId === undefined || draft.requestId !== held.requestId),
      current.items,
      queued,
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
  let conversation = current.conversation;
  let configuration = current.configuration;
  let queued = current.queued;
  let queueRevision = current.queueRevision;
  if (event.type === "item.upsert") {
    const index = items.findIndex(item => item.id === event.item.id);
    const existing = index < 0 ? undefined : items[index];
    const incoming = mergeUpsert(existing, event.item);
    items = index < 0 ? insertInConversationOrder(items, incoming) : items.map((item, at) => at === index ? incoming : item);
  } else if (event.type === "item.remove") {
    items = items.filter(item => item.id !== event.itemId);
  } else if (event.type === "item.text_delta") {
    items = items.map(item => item.id === event.itemId ? appendDelta(item, event.delta) : item);
  } else if (event.type === "conversation.status") {
    status = event.status;
    if (conversation) conversation = { ...conversation, status: event.status };
  } else if (event.type === "conversation.configuration") {
    configuration = event.configuration;
  } else if (event.type === "conversation.updated") {
    conversation = event.conversation;
    status = event.conversation.status;
  } else if (event.type === "conversation.queue") {
    queued = event.queued;
    queueRevision += 1;
  }
  return {
    projection: {
      ...current,
      sequence: event.sequence,
      cursor,
      items,
      status,
      conversation,
      configuration,
      queued,
      queueRevision,
      acceptedDrafts: reconcileDrafts(current.acceptedDrafts, items, queued),
    },
    outcome: "applied",
  };
}

/**
 * Places a new item where a fresh snapshot would put it: snapshots sort
 * stably by `createdAt`, so a live update belonging to an earlier moment —
 * a recovered request, a replayed frame from before items that arrived out
 * of band — must not render at the end of the timeline just because it
 * arrived last. Equal timestamps keep arrival order. Within one message —
 * whose parts all share the message's timestamp — arrival order is the
 * order the provider delivered the parts; live part events carry no
 * position index, so parts delivered out of provider order stay in
 * delivery order until the next snapshot load. Cross-message order is
 * exact, which is what the requirement guarantees.
 */
function insertInConversationOrder(items: ConversationItem[], incoming: ConversationItem): ConversationItem[] {
  let at = items.length;
  while (at > 0 && items[at - 1]!.createdAt > incoming.createdAt) at -= 1;
  if (at === items.length) return [...items, incoming];
  return [...items.slice(0, at), incoming, ...items.slice(at)];
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

function reconcileDrafts(drafts: AcceptedDraft[], items: ConversationItem[], queued: QueuedMessage[] = []): AcceptedDraft[] {
  const accepted = new Set(items.filter(item => item.type === "user_message").flatMap(item => [
    item.id,
    item.id.replace(/^message:/, ""),
    item.requestId ?? "",
  ]));
  // A draft the server now holds in the queue is represented by its pinned
  // queued entry; keeping the draft too would show the message twice.
  for (const held of queued) {
    accepted.add(held.id);
    if (held.requestId) accepted.add(held.requestId);
  }
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
