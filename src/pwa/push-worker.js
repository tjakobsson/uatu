// Push-only worker. Deliberately no fetch interception or offline cache.
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

function destination(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.username || url.password || !/^\/s\/[^/]+\/$/.test(url.pathname)) return null;
    const id = url.searchParams.get("conversation");
    if (!id || id.length > 1024 || !/^[^:]+:.+$/.test(id)) return null;
    return url;
  } catch { return null; }
}

self.addEventListener("push", event => {
  let data;
  try { data = event.data?.json(); } catch {}
  const target = destination(data?.url);
  const valid = data?.version === 1 && typeof data.id === "string" && typeof data.title === "string" && target;
  event.waitUntil(self.registration.showNotification(valid ? data.title : "Uatu", {
    body: valid && data.kind === "turn-completed" ? "Agent turn finished" : "An agent needs your answer",
    ...(valid ? { tag: data.id, data: { url: target.href } } : {}),
    renotify: false,
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = destination(event.notification.data?.url);
  if (!target) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === target.origin && url.pathname.startsWith(target.pathname)
        && url.searchParams.get("conversation") === target.searchParams.get("conversation")) {
        await client.focus();
        client.postMessage({ type: "uatu:open-conversation", conversationId: target.searchParams.get("conversation") });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
