// Bump this whenever you deploy changes to index.html so devices pick up the new version.
const CACHE_NAME = "qic-app-shell-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Firebase/Firestore endpoints stream live data and shouldn't be intercepted or cached —
// Firestore's own offline persistence (enabled in index.html) already handles that.
const PASSTHROUGH_HOSTS = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firebasestorage.googleapis.com",
  "www.googleapis.com"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (PASSTHROUGH_HOSTS.some((h) => url.hostname.includes(h))) return;

  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // Network-first for our own files, so a phone with signal always gets the latest
    // version, but it falls back to the cached copy the moment signal drops.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
    );
  } else {
    // Cache-first for the CDN libraries (React, Tailwind, Firebase SDKs, etc.) — these
    // are pinned versions that rarely change, and caching them is what lets the app
    // actually boot with no signal at all.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
  }
});
