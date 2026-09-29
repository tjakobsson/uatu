import { mergeAssistantMessage } from "./usage";
import type { ChatEvent, ConversationConfiguration, ConversationItem, ConversationSnapshot, ConversationStatus, ConversationSummary, MessageAttachment, QueuedMessage, ReversibleHistoryState } from "./types";

export type AcceptedDraft = { requestId: string; messageId: string; text: string; attachments?: MessageAttachment[] };
export type ChatProjection = {
  conversationId: string;
  generation: string;
  sequence: number;
  cursor: string;
  conversation?: ConversationSummary;
  configuration?: ConversationConfiguration;
  reversibleHistory?: ReversibleHistoryState;
  items: ConversationItem[];
  status: ConversationStatus;
  olderCursor?: string;
  acceptedDrafts: AcceptedDraft[];
  // Items the stream removed, most recent last and bounded: an acceptance
  // answering after the stream already retired its row (a `/reload`, a 2.x
  // placeholder the server's own row replaced) must not bring it back.
  // A later upsert of the same id takes it off the list.
  removedIds?: string[];
  // Server-held messages awaiting delivery, in submission order. Sourced from
  // the snapshot and restated whole by every queue event, so this is state,
  // not an accumulation.
  queued: QueuedMessage[];
  // Counts applied queue events. A held acceptance's local echo is valid only
  // while no queue event has spoken since the submission: once one has, the
  // stream is the authority and an echo could resurrect an entry the stream
  // already delivered or removed.
  queueRevision: number;
  // Counts applied configuration events, for the same reason: an acceptance's
  // committed configuration is stale the moment a configuration event has
  // spoken since the submission left — the stream publishes commits in
  // server order, so whatever it said is at least as new as the response.
  configurationRevision: number;
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
    reversibleHistory: snapshot.reversibleHistory,
    items: deduplicate(snapshot.items),
    status: snapshot.conversation.status,
    olderCursor: snapshot.olderCursor,
    acceptedDrafts: reconcileDrafts(acceptedDrafts, snapshot.items, queued),
    queued,
    queueRevision: 0,
    configurationRevision: 0,
  };
}

export function prependSnapshot(current: ChatProjection, page: ConversationSnapshot): ChatProjection {
  // Merged by time, not merely prepended: the first page can carry rows
  // from before its own span (a subagent launcher backfilled for the cost
  // fold), and an older page's rows must land around such a row, not
  // wholesale ahead of it. Where both hold a row, the page's copy is kept
  // in the page's order: parts of one message share its timestamp, and only
  // the page that holds the whole message knows their order. The sort is
  // stable, so ties keep that order and the older page still precedes what
  // was already held.
  const fromPage = new Set(page.items.map(item => item.id));
  const items = [...page.items, ...current.items.filter(item => !fromPage.has(item.id))].sort((left, right) => left.createdAt - right.createdAt);
  return { ...current, items, olderCursor: page.olderCursor };
}

/**
 * A fresh first page of a conversation the reader already holds, folded in
 * place — the silent-run re-read (design D14): the drill-down of a run that
 * streams nothing re-reads its snapshot while it works, and the reader must
 * see new records arrive the way live ones would, not a reload.
 *
 * Null when the page cannot be folded — another conversation or generation,
 * or a page older than what the live stream already applied (the stream is
 * ahead, and owns the view until the next read). Otherwise the page's items
 * win where both hold one, items only the reader holds (an older page it
 * paged in) stay, and the page's cursor, status, and summary are adopted, so
 * the stream resumes from the page. `changed` says whether any of that
 * differs from what the reader holds, so an identical read repaints nothing.
 */
export function refreshFromSnapshot(current: ChatProjection, page: ConversationSnapshot): { projection: ChatProjection; changed: boolean } | null {
  if (page.conversation.id !== current.conversationId || page.generation !== current.generation) return null;
  const sequence = decodeCursorSequence(page.cursor) ?? 0;
  if (sequence < current.sequence) return null;
  const fresh = deduplicate(page.items);
  const fromPage = new Set(fresh.map(item => item.id));
  const kept = current.items.filter(item => !fromPage.has(item.id));
  const items = [...kept, ...fresh].sort((left, right) => left.createdAt - right.createdAt);
  const held = new Map(current.items.map(item => [item.id, item]));
  const changed = page.conversation.status !== current.status
    || fresh.some(item => { const before = held.get(item.id); return !before || JSON.stringify(before) !== JSON.stringify(item); });
  return {
    projection: {
      ...current,
      sequence,
      cursor: page.cursor,
      conversation: page.conversation,
      status: page.conversation.status,
      items,
      // Paging continues from what the reader already reached when it has
      // gone past the page's own start.
      olderCursor: kept.length > 0 ? current.olderCursor : page.olderCursor,
    },
    changed,
  };
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

// The server refused a removal because it no longer holds the message: the
// local entry is a stale echo (delivered or removed elsewhere), and keeping
// it would strand a dead Remove button until the next reload.
export function dropQueuedMessage(current: ChatProjection, messageId: string): ChatProjection {
  if (!current.queued.some(entry => entry.id === messageId)) return current;
  return { ...current, queued: current.queued.filter(entry => entry.id !== messageId) };
}

const REMOVED_ID_LIMIT = 64;

export function confirmAcceptedDraft(current: ChatProjection, draft: AcceptedDraft, options: { insert?: boolean } = {}): ChatProjection {
  const id = `message:${draft.messageId}`;
  // The stream retired this row before the acceptance answered, or the
  // caller knows the row is the stream's alone to show (`insert: false`, a
  // `/reload`, which the stream shows and retires): the draft is settled,
  // and nothing is created.
  const absent = current.items.findIndex(candidate => candidate.id === id) < 0;
  if (current.removedIds?.includes(id) || (options.insert === false && absent)) {
    return { ...current, acceptedDrafts: current.acceptedDrafts.filter(candidate => candidate.requestId !== draft.requestId) };
  }
  const existing = current.items.findIndex(candidate => candidate.id === id);
  // A row the stream already delivered is the server's statement of the
  // turn, and it can differ from what was typed (a 2.x skill runs as
  // `@<skill> <args>`): it keeps its text, gaining only what the local draft
  // knows and it lacks. A sparse streamed row (no text yet) takes the draft.
  const streamed = existing < 0 ? undefined : current.items[existing];
  const item: ConversationItem = streamed?.type === "user_message" && streamed.text
    ? { ...streamed, requestId: streamed.requestId ?? draft.requestId, ...(!streamed.attachments?.length && draft.attachments?.length ? { attachments: draft.attachments } : {}) }
    : { id, type: "user_message", createdAt: Date.now(), text: draft.text, requestId: draft.requestId, ...(draft.attachments?.length ? { attachments: draft.attachments } : {}) };
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
  let configurationRevision = current.configurationRevision;
  let removedIds = current.removedIds;
  if (event.type === "item.upsert") {
    if (removedIds?.includes(event.item.id)) removedIds = removedIds.filter(id => id !== event.item.id);
    const index = items.findIndex(item => item.id === event.item.id);
    const existing = index < 0 ? undefined : items[index];
    const incoming = mergeUpsert(existing, event.item);
    items = index < 0 ? insertInConversationOrder(items, incoming) : items.map((item, at) => at === index ? incoming : item);
  } else if (event.type === "item.remove") {
    items = items.filter(item => item.id !== event.itemId);
    removedIds = [...(removedIds ?? []).filter(id => id !== event.itemId), event.itemId].slice(-REMOVED_ID_LIMIT);
  } else if (event.type === "item.text_delta") {
    items = items.map(item => item.id === event.itemId ? appendDelta(item, event.delta) : item);
  } else if (event.type === "conversation.status") {
    status = event.status;
    if (conversation) conversation = { ...conversation, status: event.status };
  } else if (event.type === "conversation.configuration") {
    configuration = event.configuration;
    configurationRevision += 1;
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
      configurationRevision,
      ...(removedIds ? { removedIds } : {}),
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
    // An update that omits attachments is sparse, not a strip instruction —
    // mirrors the workspace-side mergeInteraction rule.
    const attachments = incoming.attachments ?? existing.attachments;
    const preserved = attachments?.length ? { attachments } : {};
    return existing.requestId && !incoming.requestId
      ? { ...incoming, text: existing.text, requestId: existing.requestId, ...preserved }
      : { ...incoming, ...preserved };
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
