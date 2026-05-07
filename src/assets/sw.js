// Minimal pass-through service worker. Its only job is to satisfy the
// install criteria for Edge/Chrome/Brave so the install pill appears — uatu
// has nothing useful to do offline (the server has to be running) so we
// deliberately do NOT cache. A real cache here would create version-skew
// bugs across uatu upgrades and could serve stale UI bundles or, worse,
// stale terminal traffic. Keep it dumb on purpose.
//
// `clientsClaim` + `skipWaiting` mean a new uatu version's worker takes over
// existing tabs immediately, instead of waiting for every uatu tab to close.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  // No transformation, no cache. The handler exists only because Chromium's
  // install heuristic looks for one.
  event.respondWith(fetch(event.request));
});
