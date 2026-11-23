
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      body: event.data ? event.data.text() : "BTC Alert"
    };
  }

  const title = data.title || "BTC EMA 9/21 Alert";

  const options = {
    body: data.body || "New BTC signal received",
    icon: "../icon-192.png",
    badge: "../icon-192.png",
    tag: data.tag || "btc-ema-alert",
    renotify: true,
    data: {
      url: self.registration.scope
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.openWindow(
      event.notification.data?.url ||
      self.registration.scope
    )
  );
});
