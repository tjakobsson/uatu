export function notificationConversation(search: string): string | null {
  const id = new URLSearchParams(search).get("conversation");
  return id && id.length <= 1024 && /^[a-z0-9-]+:[^\u0000-\u001f]+$/.test(id) ? id : null;
}

export function carryNotificationConversation(path: string, search: string): string {
  const conversation = notificationConversation(search);
  if (!conversation) return path;
  const url = new URL(path, "http://uatu.invalid");
  url.searchParams.set("conversation", conversation);
  return url.pathname + url.search + url.hash;
}
