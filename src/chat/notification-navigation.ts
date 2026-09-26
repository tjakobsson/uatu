// The chat destinations a URL can name for the page that opens it:
//   ?conversation=<agent>:<id>  a push notification's conversation
//   ?awaiting=1                 "whichever conversation waits on me here" —
//                               the in-app notice for another workspace
//                               (src/shell/attention-notice.ts), resolved by
//                               the destination workspace itself
export function notificationConversation(search: string): string | null {
  const id = new URLSearchParams(search).get("conversation");
  return id && id.length <= 1024 && /^[a-z0-9-]+:[^\u0000-\u001f]+$/.test(id) ? id : null;
}

export function notificationAwaiting(search: string): boolean {
  return new URLSearchParams(search).get("awaiting") === "1";
}

/** Keeps the page's chat destination on a document or commit navigation, and nothing else of the current query. */
export function carryNotificationTarget(path: string, search: string): string {
  const conversation = notificationConversation(search);
  const awaiting = !conversation && notificationAwaiting(search);
  if (!conversation && !awaiting) return path;
  const url = new URL(path, "http://uatu.invalid");
  if (conversation) url.searchParams.set("conversation", conversation);
  else url.searchParams.set("awaiting", "1");
  return url.pathname + url.search + url.hash;
}
