// The hub-brokered live stream's wire protocol — the one contract shared by
// the hub (src/hub/live-*.ts), the client channel (src/shell/live-channel.ts),
// and the e2e harness. A session page holds exactly one `GET /api/hub/live`
// Server-Sent Events connection to the hub origin; everything pushed to it
// (document state, conversation inventory, conversation events, subagent
// transcripts, cross-workspace activity) rides that one connection as typed
// envelopes. See openspec/changes/hub-brokered-live-stream/design.md D2–D5.
//
// Pure module: no DOM, no Bun, no Node imports. Both sides import it.
//
// --- Stream ----------------------------------------------------------------
//
//   GET /api/hub/live?ws=<id>&activity=1&subs=<json>&reconnect=1
//
//   ws         the workspace whose topics this stream carries (one per
//              stream). Required by the hub; a harness serving a single
//              workspace at "/" MAY accept it absent.
//   activity   "1" to receive the cross-workspace `activity` topic.
//   subs       JSON array of LiveSubscription — the initial subscription
//              set, each with the cursor to resume from (reconnect presents
//              every retained cursor here). It rides the query string, so a
//              client whose set would take the URL past what proxies accept
//              (about 8 KB) presents part of it here and adds the rest over
//              the control route after `hello` — the same attach, from the
//              same cursor.
//   reconnect  "1" when this stream replaces one the client lost
//              (diagnostics only — never changes behaviour).
//
// Response frames, in order:
//   `: open`                          written immediately, so headers and
//                                     first bytes leave at once (the #350
//                                     lesson: Bun holds headers until the
//                                     first chunk)
//   `event: hello` data {streamId}    the unguessable id that binds
//                                     subscription control to this stream
//   `event: live`  data LiveEnvelope  every topic event, forever after
//   `: keepalive`                     every 15 s while idle; no envelope, no
//                                     cursor movement
//
// --- Subscription control --------------------------------------------------
//
//   POST /api/hub/live/<streamId>/subscriptions
//   body LiveSubscriptionChange { add?: LiveSubscription[], remove?: LiveSubscriptionKey[] }
//   200 {ok:true} · 400 invalid body or a set past the bound · 403 stream
//   owned by another hub session · 404 unknown/ended stream. None of the
//   three improves by repeating the request: the client reconnects, and the
//   new stream presents the whole set in `subs`. A 5xx or a request that got
//   no answer is retried with backoff a bounded number of times, then also
//   escalates to a reconnect. A client aborts a request still unanswered
//   after 10 s and counts it as one that got no answer, since the stream
//   can outlive the network path the POST was sent over. A client validates
//   what it sends with the parsers below, so a subscription the hub would
//   refuse is never sent.
//
//   `add` of a key already subscribed REPLACES it (re-attach from the new
//   cursor) — the resync path: snapshot, then `add` with the snapshot
//   cursor. Removal is prompt: no envelope for a removed key is written
//   after the POST answers. Within one request removals apply before adds.
//
// --- Topics and cursors ----------------------------------------------------
//
//   document      key = canonical watch-context query (documentContextKey);
//                 data = the child's `state` payload (StatePayload).
//   inventory     no key; data = the child's inventory invalidation
//                 ({type:"conversation.inventory"}) — re-read the inventory.
//   conversation  key = agent-qualified conversation id; data = one ChatEvent
//                 (never type "resync" — that arrives as a `resync` signal).
//   activity      no key; `ws` names the DESCRIBED workspace (any the user
//                 may access, not only the stream's own); data =
//                 WorkspaceActivity. Hub-computed, never child content. On
//                 open the hub sends one `data` envelope per accessible
//                 workspace, then one whenever a workspace's facts change.
//
//   Cursors are opaque, topic-scoped strings. Conversation cursors are the
//   child's own replay ids; document/inventory/activity cursors are
//   hub-assigned. A client advances a topic's cursor ONLY on `data` events;
//   signals carry the topic's current cursor unchanged (possibly "").
//
// --- Signals (LiveEvent kinds other than `data`) ---------------------------
//
//   ready        this subscription is attached to a live upstream and any
//                replay owed to it has been written. The per-topic analogue
//                of EventSource `open`: chat clears its interruption status
//                on it; the document consumer confirms the shell indicator
//                on it when it already holds current state.
//   resync       the presented cursor is not replayable (or the child said
//                so): take a fresh snapshot, then `add` again with its
//                cursor. The subscription is detached until then. `data`
//                may carry the child's resync ChatEvent for conversations.
//                Topic-scoped: never implies anything about other topics.
//   unavailable  the upstream failed or the child exited; the hub retries
//                while subscribers remain and sends `ready` (plus fresh data
//                where the topic needs it) on recovery. Never ends the
//                client stream.

export const LIVE_STREAM_PATH = "/api/hub/live";
export const LIVE_HELLO_EVENT = "hello";
export const LIVE_ENVELOPE_EVENT = "live";
export const LIVE_KEEPALIVE_MS = 15_000;
export const LIVE_OPEN_FRAME = ": open\n\n";
export const LIVE_KEEPALIVE_FRAME = ": keepalive\n\n";

// The child-side internal routes the hub subscribes to (hub-to-child
// protocol; never proxied to browsers). Paths are relative to the child's
// base path.
export const CHILD_DOCUMENT_EVENTS_PATH = "/api/events";
export const CHILD_INVENTORY_EVENTS_PATH = "/api/chat/conversations/events";
export function childConversationEventsPath(conversationId: string): string {
  return `/api/chat/conversations/${encodeURIComponent(conversationId)}/events`;
}
// Workspace activity summary stream (task 1.1): opening comment, then
// `event: activity` with data {working, awaiting} on every change (the first
// one immediately), 15 s keepalives.
export const CHILD_ACTIVITY_PATH = "/api/activity";
export const CHILD_ACTIVITY_EVENT = "activity";
// The child's conversation stream opens with this event, whose data names
// the cursor its live events follow: `{ "cursor": "<replay cursor>" }`. A
// subscriber that asked for no cursor — the hub's broker opening a shared
// stream — learns where the stream begins from it.
export const CHILD_CONVERSATION_OPEN_EVENT = "open";

export function liveSubscriptionsPath(streamId: string): string {
  return `${LIVE_STREAM_PATH}/${encodeURIComponent(streamId)}/subscriptions`;
}

export const LIVE_TOPICS = ["document", "inventory", "conversation", "activity"] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];
// Topics a client subscribes to per workspace; `activity` is stream-wide and
// opted into with `activity=1`.
export type LiveSubscribableTopic = Exclude<LiveTopic, "activity">;

// Bounds — every value is attacker-reachable through the query or the POST.
export const LIVE_MAX_SUBSCRIPTIONS = 16;
// Document keys carry an absolute path, URL-encoded ("/" becomes "%2F"), plus
// a git ref; a file pinned a few dozen directories deep passes 512 bytes.
export const LIVE_MAX_KEY_BYTES = 4096;
export const LIVE_MAX_CURSOR_BYTES = 1024;
export const LIVE_MAX_WORKSPACE_ID_BYTES = 256;

export type LiveSubscriptionKey = { topic: LiveSubscribableTopic; key?: string };
export type LiveSubscription = LiveSubscriptionKey & { cursor?: string };
export type LiveSubscriptionChange = { add?: LiveSubscription[]; remove?: LiveSubscriptionKey[] };

export type WorkspaceActivity = { running: boolean; working: boolean; awaiting: boolean };

export type LiveEvent =
  | { kind: "data"; data: unknown }
  | { kind: "ready" }
  | { kind: "resync"; data?: unknown }
  | { kind: "unavailable" };

export type LiveEnvelope = {
  ws: string;
  topic: LiveTopic;
  key?: string;
  cursor: string;
  event: LiveEvent;
};

export type LiveHello = { streamId: string };

export type LiveStreamQuery = {
  ws: string | null;
  activity: boolean;
  subs: LiveSubscription[];
  reconnect: boolean;
};

// Canonical identity of a subscription within one stream.
export function liveSubscriptionId(subscription: LiveSubscriptionKey): string {
  return `${subscription.topic}\u0000${subscription.key ?? ""}`;
}

// The document topic's key: the watch context (compare target + scope) as a
// canonical query string, exactly the parameters the child's /api/events
// reads. The hub appends it verbatim to the child route; two tabs with the
// same context share one upstream.
export function documentContextKey(params: URLSearchParams): string {
  const canonical = new URLSearchParams();
  for (const name of ["compareTarget", "scope", "documentId"]) {
    const value = params.get(name);
    if (value !== null) canonical.set(name, value);
  }
  return canonical.toString();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSubscribableTopic(value: unknown): value is LiveSubscribableTopic {
  return value === "document" || value === "inventory" || value === "conversation";
}

function parseSubscriptionKey(value: unknown): LiveSubscriptionKey | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "subscription must be an object";
  const record = value as Record<string, unknown>;
  if (!isSubscribableTopic(record.topic)) return "subscription topic must be document, inventory, or conversation";
  const topic = record.topic;
  if (topic === "conversation" && (typeof record.key !== "string" || record.key === "")) {
    return "conversation subscription needs a key";
  }
  if (topic === "inventory" && record.key !== undefined) return "inventory subscription takes no key";
  if (record.key !== undefined) {
    if (typeof record.key !== "string") return "subscription key must be a string";
    if (byteLength(record.key) > LIVE_MAX_KEY_BYTES) return "subscription key is too large";
  }
  return record.key === undefined ? { topic } : { topic, key: record.key as string };
}

function parseSubscription(value: unknown): LiveSubscription | string {
  const key = parseSubscriptionKey(value);
  if (typeof key === "string") return key;
  const cursor = (value as Record<string, unknown>).cursor;
  if (cursor === undefined || cursor === null || cursor === "") return key;
  if (typeof cursor !== "string") return "subscription cursor must be a string";
  if (byteLength(cursor) > LIVE_MAX_CURSOR_BYTES) return "subscription cursor is too large";
  return { ...key, cursor };
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | string): T[] | string {
  if (!Array.isArray(value)) return "expected an array of subscriptions";
  if (value.length > LIVE_MAX_SUBSCRIPTIONS) return "too many subscriptions";
  const parsed: T[] = [];
  for (const entry of value) {
    const result = parse(entry);
    if (typeof result === "string") return result;
    parsed.push(result);
  }
  return parsed;
}

// Last entry for a key wins — the same replace semantics `add` has.
function dedupeSubscriptions<T extends LiveSubscriptionKey>(list: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of list) byId.set(liveSubscriptionId(entry), entry);
  return [...byId.values()];
}

// Returns the parsed query or an error message suitable for a 400 body.
export function parseLiveStreamQuery(params: URLSearchParams): LiveStreamQuery | { error: string } {
  const ws = params.get("ws");
  if (ws !== null && (ws === "" || byteLength(ws) > LIVE_MAX_WORKSPACE_ID_BYTES)) return { error: "invalid workspace id" };
  let subs: LiveSubscription[] = [];
  const rawSubs = params.get("subs");
  if (rawSubs !== null && rawSubs !== "") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawSubs);
    } catch {
      return { error: "subs must be a JSON array" };
    }
    const parsed = parseList(decoded, parseSubscription);
    if (typeof parsed === "string") return { error: parsed };
    subs = dedupeSubscriptions(parsed);
  }
  return { ws, activity: params.get("activity") === "1", subs, reconnect: params.get("reconnect") === "1" };
}

export function buildLiveStreamQuery(query: LiveStreamQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.ws !== null) params.set("ws", query.ws);
  if (query.activity) params.set("activity", "1");
  if (query.subs.length > 0) params.set("subs", JSON.stringify(query.subs));
  if (query.reconnect) params.set("reconnect", "1");
  return params;
}

export function parseLiveSubscriptionChange(value: unknown): LiveSubscriptionChange | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "body must be an object" };
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (field !== "add" && field !== "remove") return { error: `unknown field: ${field}` };
  }
  const change: LiveSubscriptionChange = {};
  if (record.add !== undefined) {
    const add = parseList(record.add, parseSubscription);
    if (typeof add === "string") return { error: add };
    change.add = dedupeSubscriptions(add);
  }
  if (record.remove !== undefined) {
    const remove = parseList(record.remove, parseSubscriptionKey);
    if (typeof remove === "string") return { error: remove };
    change.remove = dedupeSubscriptions(remove);
  }
  return change;
}

// Fixed shape, validated before fan-out: any other field is dropped so the
// activity topic can never become a side channel for content. Not running
// implies neither working nor awaiting.
export function sanitizeWorkspaceActivity(value: unknown): WorkspaceActivity {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const running = record.running === true;
  return {
    running,
    working: running && record.working === true,
    awaiting: running && record.awaiting === true,
  };
}

export function formatLiveHello(hello: LiveHello): string {
  return `event: ${LIVE_HELLO_EVENT}\ndata: ${JSON.stringify({ streamId: hello.streamId })}\n\n`;
}

export function formatLiveEnvelope(envelope: LiveEnvelope): string {
  return `event: ${LIVE_ENVELOPE_EVENT}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function isLiveTopic(value: unknown): value is LiveTopic {
  return typeof value === "string" && (LIVE_TOPICS as readonly string[]).includes(value);
}

// Client-side validation of one `live` frame. Returns null for anything that
// is not a well-formed envelope; the channel drops those.
export function parseLiveEnvelope(raw: string): LiveEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ws !== "string" || !isLiveTopic(record.topic) || typeof record.cursor !== "string") return null;
  if (record.key !== undefined && typeof record.key !== "string") return null;
  const event = record.event as Record<string, unknown> | null;
  if (typeof event !== "object" || event === null) return null;
  let parsed: LiveEvent;
  switch (event.kind) {
    case "data":
      parsed = { kind: "data", data: event.data };
      break;
    case "ready":
      parsed = { kind: "ready" };
      break;
    case "resync":
      parsed = event.data === undefined ? { kind: "resync" } : { kind: "resync", data: event.data };
      break;
    case "unavailable":
      parsed = { kind: "unavailable" };
      break;
    default:
      return null;
  }
  return {
    ws: record.ws,
    topic: record.topic,
    ...(typeof record.key === "string" ? { key: record.key } : {}),
    cursor: record.cursor,
    event: parsed,
  };
}

export function parseLiveHello(raw: string): LiveHello | null {
  try {
    const value = JSON.parse(raw) as { streamId?: unknown };
    return typeof value.streamId === "string" && value.streamId !== "" ? { streamId: value.streamId } : null;
  } catch {
    return null;
  }
}
