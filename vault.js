/**
 * vault.js – lokaler Passwort-Speicher für Kartoffel Puffer (NW.js)
 *
 * Sicherheitsmodell:
 *  1. AES-256-GCM: Alle Einträge + Chaff werden verschlüsselt.
 *  2. Zweistufige Schlüsselableitung: PBKDF2-SHA512 (600 000 Iterationen)
 *     gefolgt von scrypt (speicherhart, ~128 MB RAM/Versuch). scrypt lässt
 *     sich – anders als PBKDF2 – kaum auf GPUs/ASICs parallelisieren,
 *     das macht Offline-Brute-Force deutlich teurer.
 *  3. Maschinen-Bindung: Der Wrap-Key wird mit einem maschinenspezifischen
 *     HMAC kombiniert. master.key funktioniert NUR auf diesem PC-Konto.
 *  4. Selbst-Integritätsprüfung: SHA-256-Hash von vault.js wird in master.key
 *     gespeichert. Wenn jemand vault.js manipuliert, schlägt unlock() fehl.
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

let dataDir    = null;
let vaultPath  = null;
let masterPath = null;

// Der im RAM gehaltene, entschlüsselte Vault-Schlüssel
let unlockedKey = null;
let idleTimer   = null;

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function _ensureInit() {
  if (!dataDir) throw new Error('vault.init() wurde noch nicht aufgerufen');
}

function _touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Memory Zeroing: Key aus dem RAM löschen bevor genullt wird
    if (unlockedKey) { unlockedKey.fill(0); }
    unlockedKey = null;
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
 * Berechnet den SHA-256-Hash dieser vault.js-Datei selbst.
 * Wird in master.key gespeichert um Manipulation zu erkennen.
 */
function _selfHash() {
  const code = require('fs').readFileSync(__filename);
  return crypto.createHash('sha256').update(code).digest();
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

  // 5. Selbst-Hash von vault.js berechnen
  const selfHash = _selfHash();

  // 6. [SaltA (32B) | SaltB (32B) | SelfHash (32B) | verschlüsselter Vault-Key] speichern
  fs.writeFileSync(masterPath, Buffer.concat([saltA, saltB, selfHash, encVaultKey]));

  // 7. Vault entsperren
  unlockedKey = vaultKey;
  _touch();

  // 8. Leere verschlüsselte Vault-Datei anlegen
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

  try {
    const buf = fs.readFileSync(masterPath);
    const saltA       = buf.subarray(0, 32);
    const saltB       = buf.subarray(32, 64);
    const storedHash  = buf.subarray(64, 96);
    const encVaultKey = buf.subarray(96);

    // Selbst-Integritätsprüfung: vault.js wurde nicht manipuliert?
    const currentHash = _selfHash();
    if (!crypto.timingSafeEqual(storedHash, currentHash)) {
      return Promise.reject(new Error(
        'Sicherheitswarnung: vault.js wurde seit dem letzten Setup verändert! ' +
        'Vault wurde gesperrt. Wenn du vault.js aktualisiert hast, musst du das ' +
        'Passwort einmal neu setzen (Vault löschen und neu erstellen).'
      ));
    }

    // Wrap-Key: PBKDF2→scrypt + Maschinen-Bindung
    const stretchedKey = _deriveKey(masterPassword, saltA, saltB);
    const wrapKey        = _bindToMachine(stretchedKey);
    stretchedKey.fill(0); // Temporären Key aus RAM löschen

    const vaultKey = _aesDecrypt(wrapKey, encVaultKey); // wirft bei falschem Passwort
    wrapKey.fill(0); // Wrap-Key aus RAM löschen

    unlockedKey = vaultKey;
    _touch();
    return Promise.resolve({ ok: true });
  } catch (err) {
    if (err.message && err.message.startsWith('Sicherheitswarnung')) throw err;
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
    const selfHash = _selfHash();
    fs.writeFileSync(masterPath, Buffer.concat([saltA, saltB, selfHash, encVaultKey]));
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

module.exports = { init, isSetup, isLocked, setup, unlock, lock, changePassword, list, save, get, getPassword, remove };
