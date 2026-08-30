// ── IndexedDB — History & Favicon-Cache ──────────────────────────────────────
// Ersetzt localStorage für History: async Writes blockieren den Main-Thread nicht,
// Indexes machen URL-Lookups O(log n) statt O(n), Limit 50.000 statt 5.000.
//
// Alle READS laufen gegen den RAM-Cache (_historyCache in storage.js).
// Dieser wird einmal beim Start aus der IDB geladen; danach sind Reads
// immer synchron und sofort verfügbar.

const _IDB_NAME    = 'kp-browser-db';
const _IDB_VERSION = 1;
const _STORE_HIST  = 'history';
const _HIST_MAX    = 50_000;
const _HIST_TRIM   = 5_000; // so viele auf einmal löschen wenn Limit erreicht

let _db = null;

function _openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_STORE_HIST)) {
        const store = db.createObjectStore(_STORE_HIST, { keyPath: 'id', autoIncrement: true });
        store.createIndex('url', 'url', { unique: false });
        store.createIndex('ts',  'ts',  { unique: false });
      }
    };
    req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
    req.onerror    = ()  => reject(req.error);
    req.onblocked  = ()  => reject(new Error('IDB blocked'));
  });
}

// ── Init: alle Einträge in den RAM laden, localStorage migrieren ──────────────
async function historyIdbInit(legacyEntries = []) {
  const db = await _openDb();
  return new Promise(resolve => {
    const store = db.transaction(_STORE_HIST, 'readonly').objectStore(_STORE_HIST);
    const req   = store.index('ts').openCursor(null, 'prev');
    const out   = [];
    req.onsuccess = e => {
      const cur = e.target.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else {
        if (out.length === 0 && legacyEntries.length > 0) {
          // Migration aus localStorage: einmalig importieren
          _idbBulkInsert(db, legacyEntries).then(() => resolve(legacyEntries));
        } else {
          resolve(out);
        }
      }
    };
    req.onerror = () => resolve(legacyEntries); // Fallback: localStorage-Daten nutzen
  });
}

async function _idbBulkInsert(db, entries) {
  return new Promise(resolve => {
    const tx    = db.transaction(_STORE_HIST, 'readwrite');
    const store = tx.objectStore(_STORE_HIST);
    entries.forEach(e => store.add({ url: e.url, title: e.title || e.url, ts: e.ts || Date.now() }));
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });
}

// ── Entry hinzufügen: Dedup per URL, dann neu anlegen ────────────────────────
function historyIdbAdd(url, title, ts) {
  _openDb().then(db => {
    const tx    = db.transaction(_STORE_HIST, 'readwrite');
    const store = tx.objectStore(_STORE_HIST);
    const req   = store.index('url').getAll(url);
    req.onsuccess = () => {
      req.result.forEach(e => store.delete(e.id));
      store.add({ url, title: title || url, ts });
    };
    tx.oncomplete = () => _trimIdbHistory(db); // Trim in eigener Transaktion
  }).catch(() => {});
}

function _trimIdbHistory(db) {
  const tx    = db.transaction(_STORE_HIST, 'readwrite');
  const store = tx.objectStore(_STORE_HIST);
  const req   = store.count();
  req.onsuccess = () => {
    const excess = req.result - _HIST_MAX;
    if (excess <= 0) return;
    let deleted = 0;
    const cursor = store.index('ts').openCursor(null, 'next');
    cursor.onsuccess = e => {
      const cur = e.target.result;
      if (cur && deleted < excess + _HIST_TRIM) {
        cur.delete(); deleted++;
        cur.continue();
      }
    };
  };
}

// ── Einen Eintrag löschen (ts + url als Schlüssel) ───────────────────────────
function historyIdbDelete(ts, url) {
  _openDb().then(db => {
    const tx    = db.transaction(_STORE_HIST, 'readwrite');
    const store = tx.objectStore(_STORE_HIST);
    const req   = store.index('ts').openCursor(IDBKeyRange.only(ts));
    req.onsuccess = e => {
      const cur = e.target.result;
      if (!cur) return;
      if (cur.value.url === url) { cur.delete(); return; }
      cur.continue();
    };
  }).catch(() => {});
}

// ── Alles löschen ─────────────────────────────────────────────────────────────
function historyIdbClear() {
  _openDb().then(db => {
    db.transaction(_STORE_HIST, 'readwrite').objectStore(_STORE_HIST).clear();
  }).catch(() => {});
}

// ── Favicon-Cache (RAM, per Hostname) ─────────────────────────────────────────
// Verhindert dass Favicons beim Tab-Wechsel neu aus dem Netz geladen werden.
const _faviconMap = new Map();

function faviconCacheSet(url, favicon) {
  if (!favicon || !url) return;
  try { _faviconMap.set(new URL(url).hostname, favicon); } catch {}
}

function faviconCacheGet(url) {
  if (!url) return null;
  try { return _faviconMap.get(new URL(url).hostname) || null; } catch { return null; }
}
