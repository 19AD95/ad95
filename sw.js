const CACHE_NAME = 'habit-tracker-v20';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon.svg'];

const STATUS_TAG = 'alarm-watcher'; // persistent status notification tag

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
    await updateStatusNotification();
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
      await updateStatusNotification();
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
    await updateStatusNotification();
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

// ── STATUS NOTIFICATION ───────────────────────────────────────────────────────
// A persistent notification that lives in the tray showing alarm status.
// It is silent (no sound/vibration), non-interactive except for a "View" action.
// Updated every time alarms change. Removed when no alarms remain.
async function updateStatusNotification() {
  // Check user preference — if disabled, clear and return
  const pref = await dbGet('meta', 'statusNotifEnabled').catch(() => true);
  if (pref === false) {
    await clearStatusNotification();
    return;
  }

  const alarms = await dbGetAll('alarms').catch(() => []);
  const now = Date.now();
  const upcoming = alarms
    .filter(a => a.fireAt > now)
    .sort((a, b) => a.fireAt - b.fireAt);

  if (!upcoming.length) {
    await clearStatusNotification();
    return;
  }

  const next = upcoming[0];
  const nextTime = new Date(next.fireAt);
  const timeStr = nextTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const count = upcoming.length;

  // Extract just the activity name from title like "⏰ 9:00 AM — Morning Run"
  const actMatch = next.title.match(/— (.+)$/);
  const actName = actMatch ? actMatch[1] : next.title;

  const bodyLines = count === 1
    ? `${actName} at ${timeStr}`
    : `Next: ${actName} at ${timeStr} · ${count} alarm${count > 1 ? 's' : ''} today`;

  try {
    await self.registration.showNotification('⏰ Vault Dex · Alarms Active', {
      body:               bodyLines,
      tag:                STATUS_TAG,
      icon:               './icon.svg',
      badge:              './icon.svg',
      silent:             true,  // no sound — purely informational
      renotify:           true,  // replace existing silently
      requireInteraction: true,  // prevents swipe-to-dismiss on Chrome/Android
      data:               { type: 'status' },
      actions:            [{ action: 'open', title: 'Open App' }],
    });
  } catch (err) {
    console.warn('[SW] status notification failed:', err);
  }
}

async function clearStatusNotification() {
  try {
    const notifications = await self.registration.getNotifications({ tag: STATUS_TAG });
    notifications.forEach(n => n.close());
  } catch {}
}

// ── CHECK DUE ALARMS ─────────────────────────────────────────────────────────
const LATE_GRACE_MS = 10 * 60 * 1000;

async function checkDueAlarms() {
  const now = Date.now();
  let alarms;
  try { alarms = await dbGetAll('alarms'); } catch { return; }

  for (const alarm of alarms) {
    if (alarm.tag === STATUS_TAG) continue; // never treat status as a real alarm
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
    .filter(a => a.fireAt > now && a.tag !== STATUS_TAG)
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
    await updateStatusNotification();
    startKeepAlive();
  }, Math.max(0, delay));
}

async function rearmOnWakeup() {
  if (_nextWakeTimer) return;
  try {
    const nextWake = await dbGet('meta', 'nextWake');
    if (nextWake) {
      const delay = nextWake - Date.now();
      if (delay <= 0) {
        await checkDueAlarms();
        await updateStatusNotification();
      } else {
        _armNextWakeTimer(delay);
      }
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
    const hasReal = remaining.some(a => a.tag !== STATUS_TAG);
    if (!hasReal) {
      stopKeepAlive();
      await clearStatusNotification();
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
      vibrate: [200, 100, 200], requireInteraction: true,
      data: { tag },
      actions: actions || [
        { action: 'done',     title: '✓ Done'  },
        { action: 'snooze5',  title: '⏰ +5m'  },
        { action: 'snooze10', title: '⏰ +10m' }
      ]
    });
    await updateStatusNotification();
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
        if (alarm.fireAt > now) {
          await dbPut('alarms', alarm);
        }
      }
      startKeepAlive();
      await _updateNextWakeMeta();
      await tryRegisterPeriodicSync();
      await updateStatusNotification();
    })());
    return;
  }

  if (e.data.type === 'SHOW_ALARM') {
    const { title, body, tag, actions, data } = e.data;
    e.waitUntil((async () => {
      await self.registration.showNotification(title, {
        body, tag,
        icon: './icon.svg', badge: './icon.svg',
        vibrate: [200, 100, 200], requireInteraction: true,
        data: data || {},
        actions: actions || [{ action: 'dismiss', title: 'Dismiss' }]
      });
      await updateStatusNotification();
    })());
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
      await updateStatusNotification();
    })());
    return;
  }

  if (e.data.type === 'CANCEL_ALARM') {
    const { tag } = e.data;
    if (snoozeTimers[tag]) { clearTimeout(snoozeTimers[tag]); delete snoozeTimers[tag]; }
    e.waitUntil((async () => {
      await dbDelete('alarms', tag);
      await updateStatusNotification();
    })());
    return;
  }

  if (e.data.type === 'START_KEEPALIVE') {
    startKeepAlive();
    e.waitUntil((async () => {
      await rearmOnWakeup();
      await tryRegisterPeriodicSync();
      await updateStatusNotification();
    })());
    return;
  }

  // Toggle the persistent status notification on/off
  if (e.data.type === 'SET_STATUS_NOTIF') {
    const enabled = e.data.enabled !== false;
    e.waitUntil((async () => {
      await dbPut('meta', enabled, 'statusNotifEnabled');
      if (enabled) await updateStatusNotification();
      else await clearStatusNotification();
    })());
    return;
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const tag    = e.notification.tag || '';
  const data   = e.notification.data || {};

  e.waitUntil((async () => {
    // Status notification tapped / "Open App" action
    if (tag === STATUS_TAG || data.type === 'status' || action === 'open') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) clients[0].focus();
      else await self.clients.openWindow('./index.html');
      return;
    }

    // Snooze: "snooze:idx:mins"
    if (action.startsWith('snooze:')) {
      const parts = action.split(':');
      const mins  = parseInt(parts[2]) || 5;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const msg = { type: 'SNOOZED', tag, mins };
      if (clients.length) { clients[0].focus(); clients[0].postMessage(msg); }
      else await self.clients.openWindow('./index.html');
      return;
    }

    // Legacy snooze
    if (action === 'snooze5' || action === 'snooze10') {
      const mins = action === 'snooze5' ? 5 : 10;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'SNOOZED', tag, mins }); }
      else await self.clients.openWindow('./index.html');
      return;
    }

    // Habit action: "habit:key:value"
    if (action.startsWith('habit:')) {
      const parts    = action.split(':');
      const habitKey = parts[1];
      const habitVal = parseInt(parts[2]);
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const msg = { type: 'HABIT_ACTION', habitKey, habitVal };
      if (clients.length) { clients[0].focus(); clients[0].postMessage(msg); }
      else await self.clients.openWindow('./index.html?ha=' + encodeURIComponent(JSON.stringify({ habitKey, habitVal })));
      return;
    }

    // Done
    if (action === 'done') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) { clients[0].focus(); clients[0].postMessage({ type: 'NOTIFICATION_CLICK', tag }); }
      else await self.clients.openWindow('./index.html');
      return;
    }

    // Default tap
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length) clients[0].focus();
    else await self.clients.openWindow('./index.html');
  })());
});

// ── NOTIFICATION CLOSE ────────────────────────────────────────────────────────
self.addEventListener('notificationclose', e => {
  if (e.notification.tag !== STATUS_TAG) return;

  // Repost the status notification as soon as it is dismissed — infinitely,
  // until the user explicitly disables it in Settings (statusNotifEnabled===false).
  e.waitUntil((async () => {
    // Retry loop: attempt up to 10 times with growing delays.
    // Each attempt checks the user pref first so we stop immediately if they
    // disable the tray notification in Settings while retrying.
    const delays = [300, 600, 1200, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
    for (const delay of delays) {
      await new Promise(r => setTimeout(r, delay));
      const pref = await dbGet('meta', 'statusNotifEnabled').catch(() => undefined);
      if (pref === false) return; // user turned it off — stop
      // Check if it has already been reposted by another path (keep-alive tick, etc.)
      const existing = await self.registration.getNotifications({ tag: STATUS_TAG }).catch(() => []);
      if (existing.length) return; // already showing — done
      await updateStatusNotification();
      // Confirm it actually showed
      const check = await self.registration.getNotifications({ tag: STATUS_TAG }).catch(() => []);
      if (check.length) return; // success
      // If still not showing, continue loop and try again
    }
  })());
});
