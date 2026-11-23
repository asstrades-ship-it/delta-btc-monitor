
self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      body: event.data ? event.data.text() : ''
    };
  }

  const title = data.title || 'BTC EMA 9/21 Alert';

  const options = {
    body: data.body || 'New BTC signal received',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || 'btc-ema-alert',
    renotify: true,
    data: {
      url: './'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(async windows => {
      for (const windowClient of windows) {
        if (windowClient.url.startsWith(self.registration.scope)) {
          return windowClient.focus();
        }
      }

      return clients.openWindow(self.registration.scope);
    })
  );
});
