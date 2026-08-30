// Bump this whenever you deploy changes to index.html so devices pick up the new version.
const CACHE_NAME = "qic-app-shell-v21";

// Firebase Messaging needs its own SDK loaded inside the service worker context,
// since this file runs separately from index.html and can't reuse its Firebase instance.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDNo-dN4e7uw3C3rdlWZ68PXWxUha7ankI",
  authDomain: "qic-service-management-system.firebaseapp.com",
  projectId: "qic-service-management-system",
  storageBucket: "qic-service-management-system.firebasestorage.app",
  messagingSenderId: "559612881987",
  appId: "1:559612881987:web:d91ce4fdb9dfa2f391f8f6"
});

const messaging = firebase.messaging();

// Fires when a push arrives while the app is closed or in the background.
messaging.onBackgroundMessage((payload) => {
  const title = (payload.data && payload.data.title) || "QIC Service";
  const body = (payload.data && payload.data.body) || "";
  // Returning this promise matters: without it, the browser assumes we didn't
  // show anything and displays its own generic placeholder notification instead.
  return self.registration.showNotification(title, {
    body,
    icon: "icon-192.png",
    badge: "icon-192.png"
  });
});

// Tapping the notification focuses an already-open tab instead of opening a duplicate one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
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
  // Only http(s) requests are cacheable — browser extensions (chrome-extension://,
  // moz-extension://) inject requests the Cache API can't store, which was throwing
  // a console error on every load.
  if (!request.url.startsWith("http")) return;

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
