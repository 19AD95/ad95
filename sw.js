const CACHE_NAME = 'habit-tracker-v22';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon.svg'];

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
    await checkDueAlarms();
    startKeepAlive();
    await tryRegisterPeriodicSync();
  })());
});

// ── FETCH (cache-first) ───────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;
  rearmOnWakeup();
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// ── PERIODIC BACKGROUND SYNC ─────────────────────────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-alarms') {
    e.waitUntil((async () => {
      await checkDueAlarms();
      startKeepAlive();
    })());
  }
});

async function tryRegisterPeriodicSync() {
  try {
    if (!self.registration.periodicSync) return;
    await self.registration.periodicSync.register('check-alarms', { minInterval: 60 * 1000 });
  } catch {}
}

// ── PUSH ─────────────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    await checkDueAlarms();
    startKeepAlive();
  })());
});

// ── INDEXEDDB HELPERS ────────────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sw-alarms-v2', 2);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('alarms')) db.createObjectStore('alarms', { keyPath: 'tag' });
      if (!db.objectStoreNames.contains('meta'))   db.createObjectStore('meta');
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror   = () => rej(r.error);
  });
}

async function dbPut(store, value, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    key !== undefined ? tx.objectStore(store).put(value, key) : tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r  = tx.objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r  = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

async function dbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

// ── CHECK DUE ALARMS ─────────────────────────────────────────────────────────
const LATE_GRACE_MS = 10 * 60 * 1000;

async function checkDueAlarms() {
  const now = Date.now();
  let alarms;
  try { alarms = await dbGetAll('alarms'); } catch { return; }

  for (const alarm of alarms) {
    const age = now - alarm.fireAt;
    if (age >= 0 && age <= LATE_GRACE_MS) {
      try {
        await self.registration.showNotification(alarm.title, {
          body:               alarm.body,
          tag:                alarm.tag,
          icon:               './icon.svg',
          badge:              './icon.svg',
          vibrate:            [200, 100, 200, 100, 200],
          requireInteraction: true,
          silent:             false,
          renotify:           false,
          data:               alarm.data || {},
          actions:            alarm.actions || [{ action: 'dismiss', title: 'Dismiss' }]
        });
      } catch (err) {
        console.warn('[SW] showNotification failed:', err);
      }
      try { await dbDelete('alarms', alarm.tag); } catch {}
    } else if (age > LATE_GRACE_MS) {
      try { await dbDelete('alarms', alarm.tag); } catch {}
    }
  }

  await _updateNextWakeMeta();
}

// ── NEXT-WAKE TIMER ───────────────────────────────────────────────────────────
let _nextWakeTimer = null;

async function _updateNextWakeMeta() {
  const alarms = await dbGetAll('alarms').catch(() => []);
  const now = Date.now();
  const next = alarms
    .filter(a => a.fireAt > now)
    .sort((a, b) => a.fireAt - b.fireAt)[0];

  if (next) {
    await dbPut('meta', next.fireAt, 'nextWake').catch(() => {});
    _armNextWakeTimer(next.fireAt - now);
  } else {
    await dbDelete('meta', 'nextWake').catch(() => {});
  }
}

function _armNextWakeTimer(delay) {
  if (_nextWakeTimer) clearTimeout(_nextWakeTimer);
  _nextWakeTimer = setTimeout(async () => {
    _nextWakeTimer = null;
    await checkDueAlarms();
    startKeepAlive();
  }, Math.max(0, delay));
}

async function rearmOnWakeup() {
  if (_nextWakeTimer) return;
  try {
    const nextWake = await dbGet('meta', 'nextWake');
    if (nextWake) {
      const delay = nextWake - Date.now();
      if (delay <= 0) await checkDueAlarms();
      else _armNextWakeTimer(delay);
    }
  } catch {}
}

// ── KEEP-ALIVE LOOP ───────────────────────────────────────────────────────────
const TICK_MS = 20000;
let keepAliveTimer = null;
let keepAliveRunning = false;

function startKeepAlive() {
  if (keepAliveRunning) return;
  keepAliveRunning = true;
  _scheduleTick();
}

function stopKeepAlive() {
  keepAliveRunning = false;
  if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
}

function _scheduleTick() {
  if (keepAliveTimer) clearTimeout(keepAliveTimer);
  keepAliveTimer = setTimeout(async () => {
    keepAliveTimer = null;
    if (!keepAliveRunning) return;

    await checkDueAlarms();

    const remaining = await dbGetAll('alarms').catch(() => []);
    if (!remaining.length) {
      stopKeepAlive();
      return;
    }

    try { await fetch('./manifest.json', { cache: 'no-store' }); } catch {}
    if (keepAliveRunning) _scheduleTick();
  }, TICK_MS);
}

// ── SNOOZE TIMERS ─────────────────────────────────────────────────────────────
const snoozeTimers = {};

function setSnoozeTimer(tag, delay, title, body, actions) {
  if (snoozeTimers[tag]) { clearTimeout(snoozeTimers[tag]); delete snoozeTimers[tag]; }
  snoozeTimers[tag] = setTimeout(async () => {
    delete snoozeTimers[tag];
    try { await dbDelete('alarms', tag); } catch {}
    await self.registration.showNotification(title, {
      body, tag,
      icon: './icon.svg', badge: './icon.svg',
      vibrate: [200, 100, 200, 100, 200], requireInteraction: true,
      silent: false,
      data: { tag },
      actions: actions || [
        { action: 'done',     title: '✓ Done'  },
        { action: 'snooze5',  title: '⏰ +5m'  },
        { action: 'snooze10', title: '⏰ +10m' }
      ]
    });
  }, delay);
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (e.data.type === 'SYNC_ALARMS') {
    e.waitUntil((async () => {
      await dbClear('alarms');
      const now = Date.now();
      for (const alarm of (e.data.alarms || [])) {
        if (alarm.fireAt > now) await dbPut('alarms', alarm);
      }
      startKeepAlive();
      await _updateNextWakeMeta();
      await tryRegisterPeriodicSync();
    })());
    return;
  }

  if (e.data.type === 'SHOW_ALARM') {
    const { title, body, tag, actions, data } = e.data;
    e.waitUntil(
      self.registration.showNotification(title, {
        body, tag,
        icon: './icon.svg', badge: './icon.svg',
        vibrate: [200, 100, 200, 100, 200], requireInteraction: true,
        silent: false,
        data: data || {},
        actions: actions || [{ action: 'dismiss', title: 'Dismiss' }]
      })
    );
    return;
  }

  if (e.data.type === 'SCHEDULE_ALARM') {
    const { title, body, tag, delay, actions, data } = e.data;
    const fireAt = Date.now() + (delay || 0);
    setSnoozeTimer(tag, delay || 0, title, body, actions);
    e.waitUntil((async () => {
      await dbPut('alarms', { tag, title, body, fireAt, actions, data: data || {} });
      startKeepAlive();
      await _updateNextWakeMeta();
    })());
    return;
  }

  if (e.data.type === 'CANCEL_ALARM') {
    const { tag } = e.data;
    if (snoozeTimers[tag]) { clearTimeout(snoozeTimers[tag]); delete snoozeTimers[tag]; }
    e.waitUntil(dbDelete('alarms', tag));
    return;
  }

  if (e.data.type === 'START_KEEPALIVE') {
    startKeepAlive();
    e.waitUntil((async () => {
      await rearmOnWakeup();
      await tryRegisterPeriodicSync();
    })());
    return;
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const tag    = e.notification.tag || '';

  e.waitUntil((async () => {
    if (action.startsWith('snooze:')) {
      const parts = action.split(':');
      const mins  = parseInt(parts[2]) || 5;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'SNOOZED', tag, mins }); }
      else await self.clients.openWindow('./index.html');
      return;
    }

    if (action === 'snooze5' || action === 'snooze10') {
      const mins = action === 'snooze5' ? 5 : 10;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'SNOOZED', tag, mins }); }
      else await self.clients.openWindow('./index.html');
      return;
    }

    if (action.startsWith('habit:')) {
      const parts    = action.split(':');
      const habitKey = parts[1];
      const habitVal = parseInt(parts[2]);
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'HABIT_ACTION', habitKey, habitVal }); }
      else await self.clients.openWindow('./index.html?ha=' + encodeURIComponent(JSON.stringify({ habitKey, habitVal })));
      return;
    }

    if (action === 'done') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'NOTIFICATION_CLICK', tag }); }
      else await self.clients.openWindow('./index.html');
      return;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length) clients[0].focus();
    else await self.clients.openWindow('./index.html');
  })());
});
