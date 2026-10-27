/*
 * Notflix service worker: shows Web Push notifications and opens the right page when one is
 * clicked. It deliberately has no "fetch" handler: it never caches or intercepts pages, API calls
 * or video, so it cannot affect browsing or playback.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Only same-origin paths are opened ("/browse?…"); anything else falls back to the home page. */
function safePath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : "/browse";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : "Notflix";
  const options = {
    body: typeof data.body === "string" ? data.body.slice(0, 300) : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: typeof data.icon === "string" && data.icon.startsWith("https://image.tmdb.org/") ? data.icon : "/icon.svg",
    badge: "/icon.svg",
    data: { url: safePath(data.url) },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Open Notflix pages refresh their bell instead of polling.
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: "notflix:notifications-changed" }))),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus().then((c) => (c && "navigate" in c ? c.navigate(target) : self.clients.openWindow(target)));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
