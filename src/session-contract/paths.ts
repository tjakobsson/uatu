// Session contract: how a workspace session is addressed. The Hub serves
// every workspace session under `/s/<id>/`, and the session is started with
// that same base path, so a path means the same thing on both sides of the
// hop. This file is the one declaration of the base path, of the internal
// session paths the Hub calls or refuses, and of the classification that
// tells the Hub what to do with a browser request for a session path.
//
// Paths here are session-relative with a leading slash (`/api/events`), the
// form `server/routes.ts` registers and the Hub sees after the `/s/<id>`
// prefix. Browser code cannot import this module; it keeps its own
// `appUrl("…")` literals for the paths it also reaches.

const SESSION_PREFIX = /^\/s\/([^/]+)(\/|$)/;

export function sessionBasePath(workspaceId: string): string {
  return `/s/${workspaceId}/`;
}

// Splits a Hub request path into the still-encoded workspace id and the
// session-relative suffix (`""` for `/s/<id>`, `/` for `/s/<id>/`). Null when
// the path is not under a workspace prefix.
export function parseSessionPath(pathname: string): { workspaceId: string; suffix: string } | null {
  const match = SESSION_PREFIX.exec(pathname);
  if (!match) return null;
  return {
    workspaceId: match[1]!,
    suffix: pathname.slice(match[0].endsWith("/") ? match[0].length - 1 : match[0].length),
  };
}

// The one join of a session-relative path (which may carry a query) onto a
// base path.
export function sessionPath(basePath: string, relative: string): string {
  return basePath.replace(/\/$/, "") + (relative.startsWith("/") ? relative : `/${relative}`);
}

// The session-relative suffix of `pathname` under `basePath`, or null when
// the path is not under it.
export function sessionSuffix(pathname: string, basePath: string): string | null {
  return pathname.startsWith(basePath) ? `/${pathname.slice(basePath.length)}` : null;
}

// ---------------------------------------------------------------------------
// Internal session paths: only the Hub calls these. The first five are the
// per-stream sources the Hub's live broker subscribes to; a browser asking
// for one through the Hub is refused and pointed at the brokered stream.
// The account-change notice and the policy proof are refused through the
// Hub too: the Hub reaches them on the session's own listener, and no page
// has a use for either.

export const SESSION_DOCUMENT_EVENTS_PATH = "/api/events";
export const SESSION_INVENTORY_EVENTS_PATH = "/api/chat/conversations/events";
export const SESSION_CONVERSATION_EVENTS_ROUTE = "/api/chat/conversations/:conversationId/events";
export function sessionConversationEventsPath(conversationId: string): string {
  return `/api/chat/conversations/${encodeURIComponent(conversationId)}/events`;
}
// Workspace activity summary stream: opening comment, then
// `event: activity` with internal data {working, awaiting, unresolved} on
// every change (the first one immediately), 15 s keepalives.
export const SESSION_ACTIVITY_PATH = "/api/activity";
export const SESSION_NOTIFICATIONS_PATH = "/api/chat/notifications/events";

// The terminal-session inventory the dashboard summarises. Browsers reach it
// too, through the Hub's proxy.
export const SESSION_TERMINAL_SESSIONS_PATH = "/api/terminal/sessions";
export const SESSION_WORKER_EVIDENCE_ROUTE = "/api/chat/conversations/:conversationId/worker-evidence";
export function sessionWorkerEvidencePath(conversationId: string): string {
  return `/api/chat/conversations/${encodeURIComponent(conversationId)}/worker-evidence`;
}
export const SESSION_ACCOUNTS_CHANGED_PATH = "/api/chat/accounts-changed";
export const SESSION_POLICY_PROOF_PATH = "/api/internal/hub-policy-proof";

// Every internal path above, as a concrete sample the contract test can
// request from a real workspace session.
export const INTERNAL_SESSION_PATHS: readonly { path: string; method: "GET" | "POST" }[] = [
  { path: SESSION_DOCUMENT_EVENTS_PATH, method: "GET" },
  { path: SESSION_INVENTORY_EVENTS_PATH, method: "GET" },
  { path: sessionConversationEventsPath("sample"), method: "GET" },
  { path: SESSION_ACTIVITY_PATH, method: "GET" },
  { path: SESSION_NOTIFICATIONS_PATH, method: "GET" },
  { path: SESSION_TERMINAL_SESSIONS_PATH, method: "GET" },
  { path: sessionWorkerEvidencePath("sample"), method: "GET" },
  { path: SESSION_ACCOUNTS_CHANGED_PATH, method: "POST" },
  { path: SESSION_POLICY_PROOF_PATH, method: "POST" },
];

// SSE event names on the internal streams.
export const SESSION_ACTIVITY_EVENT = "activity";
// A conversation stream opens with this event, whose data names the cursor
// its live events follow: `{ "cursor": "<replay cursor>" }`. A subscriber
// that asked for no cursor (the Hub's broker opening a shared stream) learns
// where the stream begins from it.
export const SESSION_CONVERSATION_OPEN_EVENT = "open";

// ---------------------------------------------------------------------------
// Browser-reachable session paths the Hub treats specially while proxying.
// `server/routes.ts` and the browser keep their own literals for these; the
// shapes below are what the Hub matches.

export const SESSION_MEDIA_PATH = "/api/media";
const CONVERSATION_SNAPSHOT = /^\/api\/chat\/conversations\/([^/]+)$/;
const LOCAL_DISCARD = /^\/api\/chat\/conversations\/[^/]+\/queue\/[^/]+\/discard-unconfirmed$/;
const POLICY_POST = /^\/api\/chat\/conversations\/[^/]+\/(prompts|queue\/[^/]+\/send-now)$/;
const POLICY_PATCH = /^\/api\/chat\/conversations\/[^/]+\/queue\/[^/]+$/;

function routePattern(route: string): string {
  return route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z0-9_]+/g, "[^/]+");
}
// Derived from the constants the session registers, so the refused set
// cannot drift from the route table.
const REFUSED_STREAMS = new RegExp(`^(?:${[
  SESSION_DOCUMENT_EVENTS_PATH,
  SESSION_ACTIVITY_PATH,
  SESSION_NOTIFICATIONS_PATH,
  SESSION_INVENTORY_EVENTS_PATH,
  SESSION_CONVERSATION_EVENTS_ROUTE,
].map(routePattern).join("|")})$`);

// Internal routes with no browser-facing replacement.
const REFUSED_INTERNAL: ReadonlySet<string> = new Set([SESSION_ACCOUNTS_CHANGED_PATH, SESSION_POLICY_PROOF_PATH]);

export type SessionPathClass =
  // Internal per-stream source: answered 410, naming the brokered stream.
  | "refused-stream"
  // Internal route with no replacement: answered 404, on any method.
  | "refused-internal"
  // Discard of an unconfirmed queued message: forwarded with a Hub-scoped
  // operation id and no policy.
  | "local-discard"
  // A chat action the Hub signs with the caller's personal chat policy.
  | "policy-action"
  // A conversation snapshot read, eligible for the bounded observation tap.
  | "conversation-snapshot"
  // Media bytes: forwarded without compression or rewriting.
  | "media"
  | "forward";

// What the Hub does with a request for a session path. Depends only on the
// method and the session-relative suffix, never on a particular session.
export function classifySessionPath(method: string, suffix: string): SessionPathClass {
  if (REFUSED_STREAMS.test(suffix)) return "refused-stream";
  if (REFUSED_INTERNAL.has(suffix)) return "refused-internal";
  if (method === "POST" && LOCAL_DISCARD.test(suffix)) return "local-discard";
  if ((method === "POST" && POLICY_POST.test(suffix)) || (method === "PATCH" && POLICY_PATCH.test(suffix))) return "policy-action";
  if (method === "GET" && CONVERSATION_SNAPSHOT.test(suffix)) return "conversation-snapshot";
  if (suffix === SESSION_MEDIA_PATH) return "media";
  return "forward";
}

// The classification of a full request path under one session's base path.
// A path outside the base path is forwarded untouched.
export function classifySessionRequest(method: string, pathname: string, basePath: string): SessionPathClass {
  const suffix = sessionSuffix(pathname, basePath);
  return suffix === null ? "forward" : classifySessionPath(method, suffix);
}

// The still-encoded conversation segment of a conversation-snapshot suffix.
export function snapshotConversationSegment(suffix: string): string | null {
  return CONVERSATION_SNAPSHOT.exec(suffix)?.[1] ?? null;
}
