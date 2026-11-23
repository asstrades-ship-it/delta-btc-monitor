
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      title: "BTC EMA Alert",
      body: event.data ? event.data.text() : "New alert"
    };
  }

  event.waitUntil(
    self.registration.showNotification(
      data.title || "BTC EMA 9/21 Alert",
      {
        body: data.body || "New BTC signal",
        tag: "btc-ema-alert",
        data: {
          url: data.url || "./"
        }
      }
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "./",
    self.registration.scope
  ).href;

  event.waitUntil(
    self.clients.openWindow(targetUrl)
  );
});
