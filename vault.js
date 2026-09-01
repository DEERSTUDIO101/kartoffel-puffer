/**
 * vault.js – lokaler Passwort-Speicher für Kartoffel Puffer
 *
 * Sicherheitsmodell:
 *  1. AES-256-GCM: Alle Einträge + Chaff werden verschlüsselt.
 *  2. Zweistufige Schlüsselableitung: PBKDF2-SHA512 (600 000 Iterationen)
 *     gefolgt von scrypt (speicherhart, ~128 MB RAM/Versuch). scrypt lässt
 *     sich – anders als PBKDF2 – kaum auf GPUs/ASICs parallelisieren,
 *     das macht Offline-Brute-Force deutlich teurer.
 *  3. Maschinen-Bindung: Der Wrap-Key wird mit einem maschinenspezifischen
 *     HMAC kombiniert. master.key funktioniert NUR auf diesem PC-Konto.
 *  4. Versioniertes master.key-Format (v1): KPVK-Magic + Versions-Byte ermöglichen
 *     saubere Migration. AES-GCM liefert bereits Tamper-Detection (AuthTag).
 *  5. Memory Zeroing: Der Vault-Key wird nach lock() aus dem RAM gelöscht.
 *  6. Chaff: 50–150 Fake-Einträge + random Padding schützen selbst bei
 *     einem theoretischen AES-Bruch.
 */

'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');

// Auto-lock nach 10 Minuten Inaktivität
const IDLE_MS = 10 * 60 * 1000;
// PBKDF2 Iterationen (OWASP 2024 Empfehlung für SHA-512)
const PBKDF2_ITER = 600_000;
const PBKDF2_HASH = 'sha512';
// scrypt-Parameter: N=2^17 (~128 MB RAM), r=8, p=1 (empfohlene starke Werte)
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const MAGIC   = Buffer.from('KPVK');   // 4-byte magic header for master.key v1
const VERSION = 0x01;

let dataDir    = null;
let vaultPath  = null;
let masterPath = null;

// Der im RAM gehaltene, entschlüsselte Vault-Schlüssel
let unlockedKey = null;
let idleTimer   = null;
let _onLockCallback = null;

function _autoUnlockPath() {
  return path.join(dataDir, 'auto-unlock.dat');
}

function _getSafeStorage() {
  return require('electron').safeStorage;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function _ensureInit() {
  if (!dataDir) throw new Error('vault.init() wurde noch nicht aufgerufen');
}

function _touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (unlockedKey) { unlockedKey.fill(0); }
    unlockedKey = null;
    if (_onLockCallback) _onLockCallback();
  }, IDLE_MS);
}

/**
 * Berechnet einen maschinenspezifischen 32-Byte-Fingerabdruck.
 * Basiert auf Hostname + Benutzername + Platform.
 * Die master.key-Datei funktioniert damit NUR auf diesem PC-Konto.
 */
function _machineFingerprint() {
  const os = require('os');
  const data = `${os.hostname()}\x00${os.userInfo().username}\x00${os.platform()}\x00${os.arch()}`;
  return crypto.createHash('sha256').update(data, 'utf8').digest();
}

/**
 * Kombiniert PBKDF2-Key mit Maschinen-Fingerabdruck via HMAC.
 * Ergebnis: Ein Key der BEIDE Faktoren benötigt.
 */
function _bindToMachine(pbkdfKey) {
  const fp = _machineFingerprint();
  return crypto.createHmac('sha256', fp).update(pbkdfKey).digest();
}

/**
 * Leitet einen 32-Byte-Schlüssel aus Passwort + zwei Salts ab.
 * Zweistufig: PBKDF2-SHA512 (600k Iterationen) → scrypt (speicherhart).
 * Beide Stufen müssen gebrochen werden, jede mit anderem Angriffsprofil.
 */
function _deriveKey(password, saltA, saltB) {
  const stage1 = crypto.pbkdf2Sync(
    Buffer.from(String(password), 'utf8'),
    saltA,
    PBKDF2_ITER,
    64,
    PBKDF2_HASH
  );
  const stage2 = crypto.scryptSync(stage1, saltB, 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM
  });
  stage1.fill(0);
  return stage2;
}

/**
 * Verschlüsselt `plainBuf` mit AES-256-GCM und `key`.
 * Gibt [IV (12 B) | AuthTag (16 B) | Ciphertext] zurück.
 */
function _aesEncrypt(key, plainBuf) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/**
 * Entschlüsselt einen [IV | Tag | CT]-Buffer mit `key`.
 * Wirft bei falschen Daten / falschem Schlüssel.
 */
function _aesDecrypt(key, buf) {
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

// ── Chaff-Verschlüsselung ─────────────────────────────────────────────────────

/**
 * Berechnet einen geheimen HMAC-Tag für einen echten Eintrag.
 * Nur wer den Vault-Schlüssel kennt, kann diesen Tag verifizieren.
 * Chaff-Einträge haben zufällige Tags, die niemals stimmen.
 */
function _realTag(key, site, username) {
  return crypto.createHmac('sha256', key)
    .update(Buffer.from(site + '\x00' + username, 'utf8'))
    .digest('base64')
    .slice(0, 22); // 22 base64-Zeichen = 132 Bit
}

/** Generiert einen zufälligen String mit `len` Bytes (als hex). */
function _randStr(len = 8) {
  return crypto.randomBytes(len).toString('hex');
}

/**
 * Liest den Vault und gibt NUR die echten Einträge zurück.
 * Chaff-Einträge werden durch HMAC-Verifikation herausgefiltert.
 */
function _read() {
  if (!fs.existsSync(vaultPath)) return [];
  const buf = fs.readFileSync(vaultPath);
  // Entschlüsseln und Padding entfernen
  let json = _aesDecrypt(unlockedKey, buf).toString('utf8');
  // Padding-Marker entfernen: alles nach dem letzten ']' wird ignoriert
  const end = json.lastIndexOf(']');
  if (end !== -1) json = json.slice(0, end + 1);
  const all = JSON.parse(json);
  // Nur echte Einträge zurückgeben (HMAC stimmt überein)
  return all
    .filter(e => e._t === _realTag(unlockedKey, e.site, e.username))
    .map(({ site, username, password }) => ({ site, username, password }));
}

/**
 * Schreibt Einträge in den Vault.
 * Mischt Chaff (Fake-Einträge) darunter und fügt zufälliges Padding hinzu.
 */
function _write(realEntries) {
  // Echte Einträge mit HMAC-Tag versehen
  const tagged = realEntries.map(e => ({
    site: e.site, username: e.username, password: e.password,
    _t: _realTag(unlockedKey, e.site, e.username)
  }));

  // Chaff-Einträge generieren: 50–150 Fake-Einträge
  const chaffCount = 50 + Math.floor(Math.random() * 100);
  const chaff = [];
  for (let i = 0; i < chaffCount; i++) {
    // Zufälliger gefälschter HMAC-Tag (stimmt nie überein)
    const fakeTag = crypto.randomBytes(17).toString('base64').slice(0, 22);
    chaff.push({
      site:     _randStr(4 + Math.floor(Math.random() * 8)),
      username: _randStr(3 + Math.floor(Math.random() * 6)),
      password: _randStr(8 + Math.floor(Math.random() * 16)),
      _t: fakeTag
    });
  }

  // Alles mischen – Reihenfolge ist zufällig
  const all = [...tagged, ...chaff].sort(() => Math.random() - 0.5);

  // In JSON serialisieren und mit zufälligem Padding (512–4096 Byte) auffüllen
  let json = JSON.stringify(all);
  const padLen = 512 + Math.floor(Math.random() * 3584);
  json += crypto.randomBytes(padLen).toString('base64').slice(0, padLen);

  fs.writeFileSync(vaultPath, _aesEncrypt(unlockedKey, Buffer.from(json, 'utf8')));
}

// ── Öffentliche API ───────────────────────────────────────────────────────────

/**
 * Initialisiert den Vault. Muss beim Programmstart aufgerufen werden.
 * Der Vault bleibt danach GESPERRT bis unlock() aufgerufen wird.
 */
function init(userDataPath) {
  dataDir    = path.join(userDataPath, 'vault');
  vaultPath  = path.join(dataDir, 'passwords.enc');
  masterPath = path.join(dataDir, 'master.key');
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Gibt an, ob bereits ein Master-Passwort eingerichtet wurde.
 */
function isSetup() {
  _ensureInit();
  return fs.existsSync(masterPath);
}

/**
 * Gibt an, ob der Vault aktuell gesperrt ist.
 */
function isLocked() {
  return unlockedKey === null;
}

/**
 * Erstellt erstmalig das Master-Passwort und den Vault-Schlüssel.
 * Schlägt fehl, wenn bereits ein Master-Passwort existiert.
 */
function setup(masterPassword) {
  _ensureInit();
  if (isSetup()) return Promise.reject(new Error('Vault ist bereits eingerichtet'));
  if (!masterPassword || masterPassword.length < 1) {
    return Promise.reject(new Error('Master-Passwort darf nicht leer sein'));
  }

  // 1. Zufälligen Vault-Schlüssel generieren
  const vaultKey = crypto.randomBytes(32);

  // 2. Zwei unabhängige Salts für die zweistufige Ableitung (PBKDF2 + scrypt)
  const saltA = crypto.randomBytes(32);
  const saltB = crypto.randomBytes(32);

  // 3. Wrap-Key: PBKDF2→scrypt(masterPassword, saltA, saltB) + Maschinen-Bindung
  const stretchedKey = _deriveKey(masterPassword, saltA, saltB);
  const wrapKey       = _bindToMachine(stretchedKey);
  stretchedKey.fill(0); // Temporären Key aus RAM löschen

  // 4. Vault-Schlüssel mit Wrap-Key verschlüsseln
  const encVaultKey = _aesEncrypt(wrapKey, vaultKey);
  wrapKey.fill(0); // Wrap-Key aus RAM löschen

  // 5. [MAGIC 4B | VERSION 1B | saltA 32B | saltB 32B | encVaultKey 60B] speichern
  const header = Buffer.from([...MAGIC, VERSION]);
  fs.writeFileSync(masterPath, Buffer.concat([header, saltA, saltB, encVaultKey]));

  // 6. Vault entsperren
  unlockedKey = vaultKey;
  _touch();

  // 7. Leere verschlüsselte Vault-Datei anlegen
  _write([]);

  return Promise.resolve({ ok: true });
}

/**
 * Entsperrt den Vault mit dem Master-Passwort.
 * Gibt { ok: true } zurück oder wirft bei falschem Passwort.
 */
function unlock(masterPassword) {
  _ensureInit();
  if (!isSetup()) return Promise.reject(new Error('Vault ist noch nicht eingerichtet'));

  let authOk = false;
  try {
    const raw = fs.readFileSync(masterPath);
    let saltA, saltB, encVaultKey, isLegacy = false;

    if (raw.subarray(0, 4).equals(MAGIC)) {
      // v1: [MAGIC 4B | VERSION 1B | saltA 32B | saltB 32B | encVaultKey 60B]
      saltA       = raw.subarray(5,  37);
      saltB       = raw.subarray(37, 69);
      encVaultKey = raw.subarray(69);
    } else {
      // Legacy: [saltA 32B | saltB 32B | selfHash 32B | encVaultKey 60B]
      saltA       = raw.subarray(0,  32);
      saltB       = raw.subarray(32, 64);
      encVaultKey = raw.subarray(96);   // skip selfHash at [64:96]
      isLegacy    = true;
    }

    const stretchedKey = _deriveKey(masterPassword, saltA, saltB);
    const wrapKey      = _bindToMachine(stretchedKey);
    stretchedKey.fill(0);

    let vaultKey;
    try {
      vaultKey = _aesDecrypt(wrapKey, encVaultKey); // throws on wrong password/bad tag
    } finally {
      wrapKey.fill(0);
    }
    authOk = true; // password was correct; any error below is an I/O error

    // Atomic migration: legacy → v1
    if (isLegacy) {
      const header  = Buffer.from([...MAGIC, VERSION]);
      const newBuf  = Buffer.concat([header, saltA, saltB, encVaultKey]);
      const tmpPath = masterPath + '.tmp';
      fs.writeFileSync(tmpPath, newBuf);
      // Validate temp file before replacing original
      const verify = fs.readFileSync(tmpPath);
      if (!verify.subarray(0, 4).equals(MAGIC)) {
        fs.unlinkSync(tmpPath);
        throw new Error('Migration validation failed');
      }
      fs.renameSync(tmpPath, masterPath); // atomic on NTFS
    }

    unlockedKey = vaultKey;
    _touch();
    return Promise.resolve({ ok: true });
  } catch (err) {
    if (authOk) throw err; // password was correct — re-throw I/O / migration errors
    return Promise.reject(new Error('Falsches Master-Passwort'));
  }
}

/**
 * Ändert das Master-Passwort. Benötigt das alte Passwort zur Verifikation.
 */
function changePassword(oldPassword, newPassword) {
  _ensureInit();
  if (!newPassword || newPassword.length < 1) {
    return Promise.reject(new Error('Neues Passwort darf nicht leer sein'));
  }

  return unlock(oldPassword).then(() => {
    const saltA = crypto.randomBytes(32);
    const saltB = crypto.randomBytes(32);
    const stretchedKey = _deriveKey(newPassword, saltA, saltB);
    const wrapKey        = _bindToMachine(stretchedKey);
    stretchedKey.fill(0);
    const encVaultKey = _aesEncrypt(wrapKey, unlockedKey);
    wrapKey.fill(0);
    const header = Buffer.from([...MAGIC, VERSION]);
    fs.writeFileSync(masterPath, Buffer.concat([header, saltA, saltB, encVaultKey]));
    _touch();
    return { ok: true };
  });
}

/**
 * Sperrt den Vault und überschreibt den Schlüssel im RAM mit Nullen.
 * Dadurch kann ein RAM-Dump den Key nicht mehr auslesen.
 */
function lock() {
  if (unlockedKey) {
    unlockedKey.fill(0); // Zero-out: Schlüssel aus RAM überschreiben
    unlockedKey = null;
  }
  if (idleTimer) clearTimeout(idleTimer);
  return Promise.resolve({ ok: true });
}

/**
 * Gibt alle Einträge zurück (ohne Passwörter).
 */
function list() {
  _ensureInit();
  if (isLocked()) return Promise.reject(new Error('Vault ist gesperrt'));
  _touch();
  return Promise.resolve(_read().map(({ site, username }) => ({ site, username })));
}

/**
 * Speichert einen neuen Eintrag (oder überschreibt einen bestehenden).
 */
function save({ site, username, password }) {
  _ensureInit();
  if (isLocked()) return Promise.reject(new Error('Vault ist gesperrt'));
  _touch();
  const s = String(site || '').trim();
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!s || !u || !p) return Promise.reject(new Error('site, username und password sind erforderlich'));
  const entries = _read().filter(e => !(e.site === s && e.username === u));
  entries.push({ site: s, username: u, password: p });
  _write(entries);
  return Promise.resolve({ ok: true });
}

/**
 * Gibt einen Eintrag (mit Passwort) für eine bestimmte Site zurück.
 */
function get(site) {
  _ensureInit();
  if (isLocked()) return Promise.reject(new Error('Vault ist gesperrt'));
  _touch();
  const target = String(site || '').trim();
  return Promise.resolve(_read().find(e => e.site === target) || null);
}

/**
 * Gibt das Passwort für eine bestimmte Site + Username zurück.
 */
function getPassword(site, username) {
  _ensureInit();
  if (isLocked()) return Promise.reject(new Error('Vault ist gesperrt'));
  _touch();
  const s = String(site || '').trim();
  const u = String(username || '').trim();
  const entry = _read().find(e => e.site === s && e.username === u);
  return Promise.resolve(entry ? entry.password : null);
}

/**
 * Löscht einen Eintrag.
 */
function remove(site, username) {
  _ensureInit();
  if (isLocked()) return Promise.reject(new Error('Vault ist gesperrt'));
  _touch();
  const s = String(site || '').trim();
  const u = String(username || '').trim();
  _write(_read().filter(e => !(e.site === s && e.username === u)));
  return Promise.resolve({ ok: true });
}

/**
 * Registriert einen Callback, der beim automatischen Sperren (Idle-Timer) aufgerufen wird.
 */
function onAutoLock(cb) {
  _onLockCallback = cb;
}

/**
 * Gibt an, ob Auto-Unlock aktiviert ist (auto-unlock.dat existiert).
 */
function isAutoUnlockEnabled() {
  _ensureInit();
  return fs.existsSync(_autoUnlockPath());
}

/**
 * Versucht, den Vault automatisch mittels DPAPI (electron.safeStorage) zu entsperren.
 * Entschlüsselt auto-unlock.dat, verifiziert via AES-GCM, setzt unlockedKey.
 * Bei Fehler: auto-unlock.dat wird gelöscht, gibt { ok: false } zurück.
 */
function tryAutoUnlock() {
  _ensureInit();
  const autoPath = _autoUnlockPath();
  if (!fs.existsSync(autoPath)) return Promise.resolve({ ok: false });

  try {
    const ss = _getSafeStorage();
    if (!ss.isEncryptionAvailable()) return Promise.resolve({ ok: false });

    const encrypted = fs.readFileSync(autoPath, 'utf8');
    const hex       = ss.decryptString(encrypted);
    const key       = Buffer.from(hex, 'hex');
    if (key.length !== 32) throw new Error('Invalid key length');

    // AES-GCM verification — only set unlocked AFTER this passes
    if (fs.existsSync(vaultPath)) {
      const buf = fs.readFileSync(vaultPath);
      _aesDecrypt(key, buf); // throws if key is wrong
    }

    unlockedKey = key;
    _touch();
    return Promise.resolve({ ok: true });
  } catch {
    // Corrupted or wrong — delete auto-unlock.dat, fall back to master password
    try { fs.unlinkSync(_autoUnlockPath()); } catch {}
    return Promise.resolve({ ok: false });
  }
}

/**
 * Richtet Auto-Unlock ein: Verschlüsselt den aktuellen unlockedKey via DPAPI
 * und speichert ihn in auto-unlock.dat.
 */
function setupAutoUnlock() {
  _ensureInit();
  if (isLocked()) return Promise.reject(new Error('Vault ist gesperrt'));

  const ss = _getSafeStorage();
  if (!ss.isEncryptionAvailable()) {
    return Promise.reject(new Error('safeStorage nicht verfügbar'));
  }

  const hex       = unlockedKey.toString('hex');
  const encrypted = ss.encryptString(hex);
  fs.writeFileSync(_autoUnlockPath(), encrypted, 'utf8');
  return Promise.resolve({ ok: true });
}

/**
 * Deaktiviert Auto-Unlock: Löscht auto-unlock.dat.
 */
function disableAutoUnlock() {
  _ensureInit();
  try { fs.unlinkSync(_autoUnlockPath()); } catch {}
  return Promise.resolve({ ok: true });
}

module.exports = {
  init, isSetup, isLocked, setup, unlock, lock, changePassword,
  list, save, get, getPassword, remove,
  onAutoLock,
  tryAutoUnlock, setupAutoUnlock, disableAutoUnlock, isAutoUnlockEnabled,
};
