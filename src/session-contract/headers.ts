// Session contract: the headers that cross the hop between the Hub and a
// workspace session.

// Hop-by-hop headers never forwarded in either direction (RFC 9110 §7.6.1).
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// Headers under this prefix are set by the Hub only. A caller's copy never
// crosses the hop, so a session can trust the ones it receives.
export const HUB_HEADER_PREFIX = "x-uatu-hub-";
export function isHubHeader(name: string): boolean {
  return name.toLowerCase().startsWith(HUB_HEADER_PREFIX);
}

// An opaque idempotency key, never principal or automatic-policy authority.
// Callers possessing workspace access can choose request identifiers already;
// this separate namespace lets the Hub keep account isolation without sending
// unsigned identity when private policy trust is unavailable.
export const CHAT_OPERATION_RECEIPT_HEADER = "x-uatu-hub-operation-receipt";
export function validChatOperationReceipt(value: string): boolean {
  return /^opr_[A-Za-z0-9_-]{43}$/.test(value);
}

// Session-response metadata, never a public event/body field. The native
// event at this cursor is followed by a separate, same-cursor visual resync.
export const SESSION_REPLAY_RESYNC_HEADER = "x-uatu-chat-replay-resync-cursor";

// Same-origin GETs never carry an Origin header (browsers only attach it to
// WebSocket upgrades, POSTs, and cross-origin requests), so the terminal
// client ships the page's origin in this custom header when probing — the
// only way the probe can see the address the browser is REALLY on when an
// intermediary rewrites Host. Client-asserted, but the probe is diagnostic
// only: lying buys a wrong diagnosis of your own connection, nothing more.
// The browser cannot import the contract, so `terminal/client.ts` repeats
// this name as a literal; `headers.test.ts` holds the two equal.
export const PAGE_ORIGIN_HEADER = "X-Uatu-Page-Origin";
