// sudo service worker.
//
// Two responsibilities:
//   1. Cache only the static shell (HTML/CSS/manifest/icons + the JS module
//      graph the page bootstraps). Relay / message / sync payloads are NEVER
//      cached — they're identity-bearing and per-account, and disappearing
//      messages must not survive past their lifetime.
//   2. Receive Web Push events and show notifications. Push delivery is
//      added in Part B; the handler stub is here so a single SW version
//      covers both phases.
//
// Cache name is versioned by the bundle string below; bump it on every
// deploy that changes the shell. Old caches are evicted on activate.

const CACHE_VERSION = "sudo-shell-v1";

// The list below is the "minimum to render the offline shell" — index +
// stylesheet + manifest + icons. The JS module graph lives under /client
// and /protocol with `Cache-Control: no-store` and is intentionally NOT
// precached; we let the network fetch govern those so a deploy is picked
// up immediately. We use a "stale-while-revalidate" pattern for the shell
// HTML so a returning user gets an instant paint and the new HTML loads
// in the background.
const SHELL_ASSETS = [
  "/",
  "/styles.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("sudo-shell-") && k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// The set of URL pathnames the SW is allowed to serve from cache. Anything
// under /api, /client (JS), /protocol (JS), or /dev MUST go to the network.
function isShellPath(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p === "/" || p === "/index.html") return true;
  if (p === "/styles.css") return true;
  if (p === "/manifest.webmanifest") return true;
  if (p.startsWith("/icons/")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isShellPath(url)) return; // network-only — never cache API/JS

  // Stale-while-revalidate for the shell. Returns cache immediately if
  // present; kicks off a background fetch that replaces the cached copy.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      const fetchPromise = fetch(request)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            cache.put(request, res.clone()).catch(() => {/* ignore */});
          }
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(fetchPromise);
        return cached;
      }
      const fresh = await fetchPromise;
      if (fresh) return fresh;
      return new Response("offline", { status: 503, statusText: "offline" });
    })()
  );
});

// ============================================================
// Push events (Part B wires the backend; here we host the handler).
// Server-side payloads are *always* the generic shape:
//   { conversation_hint, sender_handle, unread_count }
// No message body text leaves the server (see Part C decision). The
// page (when foregrounded for the conversation) sends a postMessage
// telling the SW to suppress the notification.
// ============================================================

const suppressedConversations = new Map(); // hint -> expiresAt (ms)
const SUPPRESS_TTL_MS = 30_000;

function pruneSuppressions(now) {
  for (const [k, exp] of suppressedConversations) {
    if (exp <= now) suppressedConversations.delete(k);
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "sudo/suppress-conversation" && typeof data.hint === "string") {
    suppressedConversations.set(data.hint, Date.now() + SUPPRESS_TTL_MS);
  } else if (data.type === "sudo/unsuppress-conversation" && typeof data.hint === "string") {
    suppressedConversations.delete(data.hint);
  } else if (data.type === "sudo/clear-notifications") {
    event.waitUntil(
      (async () => {
        const notifications = await self.registration.getNotifications();
        for (const n of notifications) n.close();
      })()
    );
  }
});

self.addEventListener("push", (event) => {
  pruneSuppressions(Date.now());
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const hint = typeof payload.conversation_hint === "string" ? payload.conversation_hint : "";
  if (hint && suppressedConversations.has(hint)) return; // foreground dedup

  const sender = typeof payload.sender_handle === "string" && payload.sender_handle
    ? payload.sender_handle
    : "someone";
  const unread = typeof payload.unread_count === "number" ? payload.unread_count : 1;

  // Privacy floor: never include message body. "new message" is the only
  // body text. The page can show preview text in the UI, the notification
  // itself never does.
  const title = sender;
  const options = {
    body: unread > 1 ? `${unread} new messages` : "new message",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: hint || "sudo-default",
    renotify: true,
    data: { conversation_hint: hint }
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if ("setAppBadge" in self.navigator) {
        try { await self.navigator.setAppBadge(unread); } catch { /* ignore */ }
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hint = (event.notification.data && event.notification.data.conversation_hint) || "";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = all.find((c) => c.url.startsWith(self.location.origin));
      if (target) {
        await target.focus();
        target.postMessage({ type: "sudo/open-conversation", hint });
        return;
      }
      const win = await self.clients.openWindow(`/?open=${encodeURIComponent(hint)}`);
      if (win) win.focus();
    })()
  );
});
