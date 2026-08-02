// Minimal service worker. Its only job is to make the app installable on
// Android (Chrome wants a registered SW with a fetch handler). It intentionally
// does NOT cache anything, so every visit loads the latest deploy — no stale
// versions to debug.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // No respondWith() -> the browser handles the request normally (network).
});
