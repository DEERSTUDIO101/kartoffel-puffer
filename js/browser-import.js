'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── SQLite-Backend ─────────────────────────────────────────────────────────────
// Priorität 1: node:sqlite (in Node 22.5+/Electron 36+, kein nativer Build nötig)
// Priorität 2: better-sqlite3 (nativer Build via electron-rebuild)
// Beide APIs sind kompatibel: .prepare(sql).all() / .close()
function openDb(filePath) {
  // Versuch 1: Built-in node:sqlite
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath, { readOnly: true });
  } catch (_e1) {
    // Nicht verfügbar — weiter zu better-sqlite3
  }
  // Versuch 2: better-sqlite3 (muss nativ gebaut sein)
  const Database = require('better-sqlite3');
  return new Database(filePath, { readonly: true, fileMustExist: true });
}

// ── Pfad-Definitionen ─────────────────────────────────────────────────────────
const BROWSERS = {
  chrome: {
    name: 'Google Chrome',
    base: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'),
    bookmarks: 'Bookmarks',
    loginData: 'Login Data',
    history:   'History',
    localState: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State'),
  },
  edge: {
    name: 'Microsoft Edge',
    base: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default'),
    bookmarks: 'Bookmarks',
    loginData: 'Login Data',
    history:   'History',
    localState: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Local State'),
  },
  brave: {
    name: 'Brave Browser',
    base: path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'),
    bookmarks: 'Bookmarks',
    loginData: 'Login Data',
    history:   'History',
    localState: path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Local State'),
  },
  opera: {
    name: 'Opera',
    base: path.join(os.homedir(), 'AppData', 'Roaming', 'Opera Software', 'Opera Stable'),
    bookmarks: 'Bookmarks',
    loginData: 'Login Data',
    history:   'History',
    localState: path.join(os.homedir(), 'AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Local State'),
  },
};

function firefoxProfileDir() {
  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
  if (!fs.existsSync(base)) return null;
  const entries = fs.readdirSync(base, { withFileTypes: true });
  const profile = entries.find(e => e.isDirectory() && e.name.includes('.default'));
  return profile ? path.join(base, profile.name) : null;
}

// ── Browser erkennen ──────────────────────────────────────────────────────────
function detectBrowsers() {
  const results = [];
  for (const [id, def] of Object.entries(BROWSERS)) {
    const bPath  = path.join(def.base, def.bookmarks);
    const hPath  = path.join(def.base, def.history);
    const pwPath = path.join(def.base, def.loginData);
    if (!fs.existsSync(bPath) && !fs.existsSync(hPath)) continue;
    results.push({
      id,
      name: def.name,
      hasBookmarks: fs.existsSync(bPath),
      hasPasswords: fs.existsSync(pwPath),
      hasHistory:   fs.existsSync(hPath),
    });
  }
  // Firefox
  const ffDir = firefoxProfileDir();
  if (ffDir) {
    results.push({
      id: 'firefox',
      name: 'Mozilla Firefox',
      hasBookmarks: fs.existsSync(path.join(ffDir, 'places.sqlite')),
      hasPasswords: false, // nur via CSV
      hasHistory:   fs.existsSync(path.join(ffDir, 'places.sqlite')),
    });
  }
  return results;
}

// ── Lesezeichen: Chrome/Edge/Brave/Opera JSON ─────────────────────────────────
function parseChromiumBookmarks(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const bookmarks = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'url') {
      bookmarks.push({ url: node.url, title: node.name || node.url, ts: Date.now() });
    } else if (node.children) {
      node.children.forEach(walk);
    }
  }
  const roots = data.roots || {};
  ['bookmark_bar', 'other', 'synced'].forEach(k => walk(roots[k]));
  return bookmarks;
}

// ── Lesezeichen: Firefox places.sqlite ───────────────────────────────────────
function parseFirefoxBookmarks(profileDir) {
  const dbPath = path.join(profileDir, 'places.sqlite');
  let db;
  try {
    db = openDb(dbPath);
    const rows = db.prepare(`
      SELECT p.url, b.title, b.dateAdded
      FROM moz_bookmarks b
      JOIN moz_places p ON b.fk = p.id
      WHERE b.type = 1 AND p.url NOT LIKE 'place:%'
      ORDER BY b.dateAdded DESC
    `).all();
    return rows.map(r => ({ url: r.url, title: r.title || r.url, ts: Math.floor(Number(r.dateAdded) / 1000) }));
  } finally {
    db?.close();
  }
}

// ── Lesezeichen: HTML (Netscape Bookmark Format) ──────────────────────────────
function parseBookmarkHtml(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const bookmarks = [];
  const re = /<A\s+HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    bookmarks.push({ url: m[1], title: m[2] || m[1], ts: Date.now() });
  }
  return bookmarks;
}

// ── Passwörter: Chrome Login Data (SQLite + DPAPI) ────────────────────────────
function decryptChromiumPassword(encryptedBuf, aesKey) {
  // Chrome v80+: Präfix "v10" + 12-Byte-Nonce + Ciphertext + 16-Byte-Tag
  if (!encryptedBuf || encryptedBuf.length < 31) return '';
  const buf    = Buffer.isBuffer(encryptedBuf) ? encryptedBuf : Buffer.from(encryptedBuf);
  const prefix = buf.slice(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') return '(älteres DPAPI-Format — nicht unterstützt)';
  try {
    const { createDecipheriv } = require('crypto');
    const nonce      = buf.slice(3, 15);
    const ciphertext = buf.slice(15, buf.length - 16);
    const tag        = buf.slice(buf.length - 16);
    const decipher   = createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
  } catch {
    return '(Entschlüsselung fehlgeschlagen)';
  }
}

function getChromiumAesKey(localStatePath) {
  const { execSync } = require('child_process');
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) return null;
  // Base64 → Buffer, dann DPAPI-Präfix "DPAPI" (5 Bytes) entfernen
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64').slice(5);
  // DPAPI-Entschlüsselung via PowerShell
  const hexKey = encryptedKey.toString('hex');
  const ps = `$bytes=[System.Convert]::FromHexString('${hexKey}');$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser');[System.Convert]::ToBase64String($dec)`;
  const result = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { encoding: 'utf8', timeout: 15000 }).trim();
  return Buffer.from(result, 'base64');
}

function parseChromiumPasswords(loginDataPath, localStatePath) {
  let aesKey = null;
  try { aesKey = getChromiumAesKey(localStatePath); } catch {}
  let db;
  try {
    db = openDb(loginDataPath);
    const rows = db.prepare('SELECT origin_url, username_value, password_value FROM logins').all();
    return rows.map(r => {
      const encBuf = r.password_value instanceof Uint8Array
        ? Buffer.from(r.password_value)
        : (Buffer.isBuffer(r.password_value) ? r.password_value : Buffer.from(r.password_value || []));
      return {
        site:     r.origin_url,
        username: r.username_value,
        password: aesKey ? decryptChromiumPassword(encBuf, aesKey) : '(nicht entschlüsselt)',
      };
    });
  } finally {
    db?.close();
  }
}

// ── Passwörter: CSV ───────────────────────────────────────────────────────────
function parsePasswordCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const entries = [];
  // Erste Zeile ist Header (name,url,username,password oder ähnlich)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Einfaches CSV-Parsing (keine Anführungszeichen-Escapierung)
    const parts = line.split(',');
    if (parts.length >= 4) {
      entries.push({ site: parts[1] || parts[0], username: parts[2], password: parts[3] });
    }
  }
  return entries;
}

// ── Verlauf: Chrome/Edge/Brave/Opera SQLite ───────────────────────────────────
function parseChromiumHistory(historyPath) {
  let db;
  try {
    db = openDb(historyPath);
    // last_visit_time ist Chrome-Epoch (Mikrosekunden seit 1601-01-01)
    const CHROME_EPOCH_OFFSET = 11644473600000000n;
    const rows = db.prepare('SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 50000').all();
    return rows.map(r => ({
      url:   r.url,
      title: r.title || r.url,
      ts:    Number((BigInt(r.last_visit_time) - CHROME_EPOCH_OFFSET) / 1000n),
    }));
  } finally {
    db?.close();
  }
}

// ── Verlauf: Firefox places.sqlite ────────────────────────────────────────────
function parseFirefoxHistory(profileDir) {
  const dbPath = path.join(profileDir, 'places.sqlite');
  let db;
  try {
    db = openDb(dbPath);
    const rows = db.prepare(`
      SELECT p.url, p.title, MAX(h.visit_date) as last_visit
      FROM moz_historyvisits h
      JOIN moz_places p ON h.place_id = p.id
      GROUP BY p.id
      ORDER BY last_visit DESC
      LIMIT 50000
    `).all();
    return rows.map(r => ({
      url:   r.url,
      title: r.title || r.url,
      ts:    Math.floor(Number(r.last_visit) / 1000),
    }));
  } finally {
    db?.close();
  }
}

// ── Haupt-Import-Funktion ─────────────────────────────────────────────────────
function runImport({ browser, types, filePaths = {} }) {
  const result = { bookmarks: 0, passwords: 0, history: 0, errors: [] };

  if (browser === 'file') {
    // Manueller Datei-Import — wird über import:fromFile abgewickelt
    return result;
  }

  const def   = BROWSERS[browser];
  const ffDir = browser === 'firefox' ? firefoxProfileDir() : null;

  if (types.includes('bookmarks')) {
    try {
      let bookmarks = [];
      if (def) {
        bookmarks = parseChromiumBookmarks(path.join(def.base, def.bookmarks));
      } else if (ffDir) {
        bookmarks = parseFirefoxBookmarks(ffDir);
      }
      result.bookmarks  = bookmarks.length;
      result._bookmarks = bookmarks; // wird im IPC-Handler zurückgegeben
    } catch (e) {
      result.errors.push(`Lesezeichen: ${e.message}`);
    }
  }

  if (types.includes('passwords') && def) {
    try {
      const pwPath  = path.join(def.base, def.loginData);
      const lsPath  = def.localState;
      const entries = parseChromiumPasswords(pwPath, lsPath);
      result.passwords  = entries.length;
      result._passwords = entries;
    } catch (e) {
      result.errors.push(`Passwörter: ${e.message}`);
    }
  }

  if (types.includes('history')) {
    try {
      let history = [];
      if (def) {
        history = parseChromiumHistory(path.join(def.base, def.history));
      } else if (ffDir) {
        history = parseFirefoxHistory(ffDir);
      }
      result.history  = history.length;
      result._history = history;
    } catch (e) {
      result.errors.push(`Verlauf: ${e.message}`);
    }
  }

  return result;
}

function importFromFile({ type, filePath }) {
  const result = { count: 0, errors: [] };
  try {
    if (type === 'bookmarks') {
      const bookmarks   = parseBookmarkHtml(filePath);
      result.count      = bookmarks.length;
      result._bookmarks = bookmarks;
    } else if (type === 'passwords') {
      const entries     = parsePasswordCsv(filePath);
      result.count      = entries.length;
      result._passwords = entries;
    }
  } catch (e) {
    result.errors.push(e.message);
  }
  return result;
}

module.exports = { detectBrowsers, runImport, importFromFile };
