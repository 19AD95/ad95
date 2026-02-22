const CACHE_NAME = 'habit-tracker-v15';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon.svg'];

// ── INSTALL / ACTIVATE / FETCH (unchanged) ──────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
  // Start keep-alive as soon as SW activates
  startKeepAlive();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;
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

// ── INDEXEDDB HELPERS ────────────────────────────────────────────────────────
// Stores the alarm schedule so it survives SW restarts
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sw-alarms-v1', 1);
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

// ── KEEP-ALIVE LOOP ──────────────────────────────────────────────────────────
// Browser kills SWs ~30s after last event. We keep it alive by fetching our
// own cached manifest every 20s — a real fetch event that resets the idle timer.
// This is the only approach that works cross-browser without hacks.

const TICK_MS = 20000;
let keepAliveTimer = null;
let keepAliveRunning = false;

function startKeepAlive() {
  if (keepAliveRunning) return;
  keepAliveRunning = true;
  scheduleNextTick();
}

function scheduleNextTick() {
  if (keepAliveTimer) clearTimeout(keepAliveTimer);
  keepAliveTimer = setTimeout(async () => {
    keepAliveTimer = null;
    await checkDueAlarms();
    // Self-fetch to reset SW idle timer — fetches from cache, no network needed
    try { await fetch('./manifest.json', { cache: 'no-store' }); } catch {}
    scheduleNextTick(); // re-arm
  }, TICK_MS);
}

// ── CHECK DUE ALARMS ────────────────────────────────────────────────────────
async function checkDueAlarms() {
  const now = Date.now();
  let alarms;
  try { alarms = await dbGetAll('alarms'); } catch { return; }

  for (const alarm of alarms) {
    if (alarm.fireAt <= now) {
      // Fire it
      try {
        await self.registration.showNotification(alarm.title, {
          body:               alarm.body,
          tag:                alarm.tag,
          icon:               './icon.svg',
          badge:              './icon.svg',
          vibrate:            [200, 100, 200, 100, 200],
          requireInteraction: true,
          data:               alarm.data || {},
          actions:            alarm.actions || [{ action: 'dismiss', title: 'Dismiss' }]
        });
      } catch (err) {
        console.warn('[SW] showNotification failed:', err);
      }
      // Remove fired alarm
      try { await dbDelete('alarms', alarm.tag); } catch {}
    }
  }
}

// ── LEGACY SNOOZE TIMERS (fallback — kept alongside IndexedDB system) ────────
// If the SW is alive these fire reliably. If SW is killed, IndexedDB picks it
// back up when the SW wakes again. Belt-and-suspenders.
const snoozeTimers = {};

function setSnoozeTimer(tag, delay, title, body, actions) {
  if (snoozeTimers[tag]) { clearTimeout(snoozeTimers[tag]); delete snoozeTimers[tag]; }
  snoozeTimers[tag] = setTimeout(async () => {
    delete snoozeTimers[tag];
    // Remove from IndexedDB so we don't double-fire
    try { await dbDelete('alarms', tag); } catch {}
    await self.registration.showNotification(title, {
      body, tag, icon: './icon-192.png', badge: './icon-192.png',
      vibrate: [200, 100, 200], requireInteraction: true,
      data: { tag },
      actions: actions || [
        { action: 'done',     title: '✓ Done'  },
        { action: 'snooze5',  title: '⏰ +5m'  },
        { action: 'snooze10', title: '⏰ +10m' }
      ]
    });
  }, delay);
}


self.addEventListener('message', e => {
  if (!e.data) return;

  // Force immediate SW activation — called when user saves schedule changes
  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // App is open and sends the full alarm schedule for today
  // Format: { type: 'SYNC_ALARMS', alarms: [ { tag, title, body, fireAt, actions, data }, ... ] }
  if (e.data.type === 'SYNC_ALARMS') {
    e.waitUntil((async () => {
      await dbClear('alarms');
      const now = Date.now();
      for (const alarm of (e.data.alarms || [])) {
        if (alarm.fireAt > now) {
          await dbPut('alarms', alarm);
        }
      }
      // Kick off keep-alive loop if not already running
      startKeepAlive();
    })());
    return;
  }

  // Immediate alarm (app is open, alarm fires right now)
  if (e.data.type === 'SHOW_ALARM') {
    const { title, body, tag, actions, data } = e.data;
    e.waitUntil(
      self.registration.showNotification(title, {
        body, tag, icon: './icon-192.png', badge: './icon-192.png',
        vibrate: [200, 100, 200], requireInteraction: true,
        data: data || {},
        actions: actions || [{ action: 'dismiss', title: 'Dismiss' }]
      })
    );
    return;
  }

  // Schedule a single alarm (e.g. snooze expiry) — stored in IndexedDB AND legacy timer
  if (e.data.type === 'SCHEDULE_ALARM') {
    const { title, body, tag, delay, actions, data } = e.data;
    const fireAt = Date.now() + (delay || 0);
    // Legacy timer (works while SW is alive)
    setSnoozeTimer(tag, delay || 0, title, body, actions);
    // IndexedDB (works if SW is killed and restarted)
    e.waitUntil((async () => {
      await dbPut('alarms', { tag, title, body, fireAt, actions, data: data || {} });
      startKeepAlive();
    })());
    return;
  }

  // Cancel a scheduled alarm — both systems
  if (e.data.type === 'CANCEL_ALARM') {
    const { tag } = e.data;
    if (snoozeTimers[tag]) { clearTimeout(snoozeTimers[tag]); delete snoozeTimers[tag]; }
    e.waitUntil(dbDelete('alarms', tag));
    return;
  }

  // Start keep-alive loop explicitly (called on app open)
  if (e.data.type === 'START_KEEPALIVE') {
    startKeepAlive();
    return;
  }
});

// ── NOTIFICATION CLICK ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const tag    = e.notification.tag || '';

  // Snooze: "snooze:idx:mins"
  if (action.startsWith('snooze:')) {
    const parts = action.split(':');
    const mins  = parseInt(parts[2]) || 5;
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const msg = { type: 'SNOOZED', tag, mins };
        if (clients.length) { clients[0].focus(); clients[0].postMessage(msg); }
        else self.clients.openWindow('./index.html');
      })
    );
    return;
  }

  // Legacy snooze buttons
  if (action === 'snooze5' || action === 'snooze10') {
    const mins = action === 'snooze5' ? 5 : 10;
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'SNOOZED', tag, mins }); }
        else self.clients.openWindow('./index.html');
      })
    );
    return;
  }

  // Habit action from notification button: "habit:key:value"
  if (action.startsWith('habit:')) {
    const parts    = action.split(':');
    const habitKey = parts[1];
    const habitVal = parseInt(parts[2]);
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const msg = { type: 'HABIT_ACTION', habitKey, habitVal };
        if (clients.length) { clients[0].focus(); clients[0].postMessage(msg); }
        else self.clients.openWindow('./index.html?ha=' + encodeURIComponent(JSON.stringify({ habitKey, habitVal })));
      })
    );
    return;
  }

  // "done" action
  if (action === 'done') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'NOTIFICATION_CLICK', tag }); }
        else self.clients.openWindow('./index.html');
      })
    );
    return;
  }

  // Default tap / dismiss
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length) clients[0].focus();
      else self.clients.openWindow('./index.html');
    })
  );
});
