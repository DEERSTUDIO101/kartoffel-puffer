# Vault Security Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Kartoffel Puffer vault: versioned master.key format with atomic migration, master-password lock screen at startup, and optional DPAPI auto-unlock via `electron.safeStorage`.

**Architecture:** All crypto stays in `vault.js` (main process). `main.js` handles startup flow and IPC rate-limiting. `index.html` gets a lock-screen overlay and a settings toggle. No new npm dependencies — `electron.safeStorage` is built-in to Electron 36.

**Tech Stack:** Electron 36, Node.js built-in `crypto`, `electron.safeStorage`, plain JS/CSS, no bundler, no test runner.

## Global Constraints

- **No breaking changes** to `passwords.enc` format or existing IPC channels (`passwords:list`, `passwords:save`, `passwords:get`, `passwords:delete`, `passwords:lock`, `passwords:isSetup`, `passwords:isLocked`)
- **No new npm dependencies** — `electron.safeStorage` is built into Electron
- **UI text in German** — all user-facing strings
- **vault.js stays in main process only** — never required by renderer
- **Master-Passwort wird niemals gespeichert** — only the vault key (as hex) goes into `auto-unlock.dat`, encrypted via safeStorage
- **Tab Groups, Session Restore, Autofill must not be touched** — do not modify `js/tabs.js`, `js/storage.js`, or `tryAutofill()`
- **No test runner** — verify manually with `npm start` after each task
- **Commits via Bash tool** — PowerShell heredoc syntax fails for multi-line commit messages

---

### Task 1: vault.js — New master.key format + atomic migration + onAutoLock

**Files:**
- Modify: `vault.js`

**Interfaces:**
- Produces (unchanged signatures): `vault.isSetup()`, `vault.isLocked()`, `vault.setup(pw)`, `vault.unlock(pw)`, `vault.changePassword(old, new)`, `vault.lock()`
- Produces (new): `vault.onAutoLock(cb)` — registers a callback fired when idle timer auto-locks the vault (used by Task 3)
- Produces (new constants): `MAGIC = Buffer.from('KPVK')`, `VERSION = 0x01`

**New master.key layout (v1):**
```
[MAGIC 4B | VERSION 1B | saltA 32B | saltB 32B | encVaultKey 60B]  = 129 bytes total
```
**Legacy layout (v0.3.5):**
```
[saltA 32B | saltB 32B | selfHash 32B | encVaultKey 60B]            = 156 bytes
```
Detection: `buf.subarray(0, 4).equals(MAGIC)` → v1. Otherwise legacy.

- [ ] **Step 1: Remove `_selfHash()` and add MAGIC/VERSION constants**

In `vault.js`, delete the entire `_selfHash()` function (the block from `function _selfHash()` through its closing `}`). Add at the top of the constants section (after `const SCRYPT_MAXMEM`):

```js
const MAGIC   = Buffer.from('KPVK');   // 4-byte magic header for master.key v1
const VERSION = 0x01;
```

- [ ] **Step 2: Update `setup()` to write v1 format**

In `setup()`, remove the line `const selfHash = _selfHash();` and replace the `fs.writeFileSync(masterPath, ...)` call with:

```js
const header = Buffer.from([...MAGIC, VERSION]);
fs.writeFileSync(masterPath, Buffer.concat([header, saltA, saltB, encVaultKey]));
```

- [ ] **Step 3: Update `unlock()` — detect format, remove selfHash check, add atomic migration**

Replace the entire `try { ... } catch` block inside `unlock()` with:

```js
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

  const vaultKey = _aesDecrypt(wrapKey, encVaultKey); // throws on wrong password/bad tag
  wrapKey.fill(0);

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
  return Promise.reject(new Error('Falsches Master-Passwort'));
}
```

- [ ] **Step 4: Update `changePassword()` to write v1 format**

In `changePassword()`, remove `const selfHash = _selfHash();` and replace the `fs.writeFileSync(masterPath, ...)` call with:

```js
const header = Buffer.from([...MAGIC, VERSION]);
fs.writeFileSync(masterPath, Buffer.concat([header, saltA, saltB, encVaultKey]));
```

- [ ] **Step 5: Add `onAutoLock()` and update `_touch()` to call it**

Add after the `let idleTimer = null;` line:
```js
let _onLockCallback = null;
```

Add new exported function:
```js
function onAutoLock(cb) {
  _onLockCallback = cb;
}
```

Update `_touch()` to call the callback when the idle timer fires:
```js
function _touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (unlockedKey) { unlockedKey.fill(0); }
    unlockedKey = null;
    if (_onLockCallback) _onLockCallback();
  }, IDLE_MS);
}
```

Update `module.exports` to include `onAutoLock`:
```js
module.exports = {
  init, isSetup, isLocked, setup, unlock, lock, changePassword,
  list, save, get, getPassword, remove,
  onAutoLock,
};
```

- [ ] **Step 6: Verify manually**

Run `npm start`. Open DevTools (Ctrl+Shift+I on main window).
- Console: `await window.electronAPI.passwords.isSetup()` → should resolve (no crash)
- If a v0.3.5 vault exists: enter master password → should unlock → check `userData/vault/master.key` file size is now 129 bytes (was 156)
- If no vault: verify no crash at startup

- [ ] **Step 7: Commit**

Use Bash tool:
```bash
git add vault.js
git commit -m "feat: new versioned master.key format (v1), remove self-hash, atomic migration from legacy"
```

---

### Task 2: vault.js — DPAPI Auto-Unlock functions

**Files:**
- Modify: `vault.js`

**Interfaces:**
- Consumes: `unlockedKey`, `vaultPath`, `dataDir` from Task 1
- Produces:
  - `vault.tryAutoUnlock()` → `Promise<{ ok: boolean }>` — decrypts `auto-unlock.dat` via safeStorage, verifies via AES-GCM, sets `unlockedKey`
  - `vault.setupAutoUnlock()` → `Promise<{ ok: true }>` | `Promise.reject(Error)` — encrypts current `unlockedKey` hex via safeStorage, writes `auto-unlock.dat`
  - `vault.disableAutoUnlock()` → `Promise<{ ok: true }>` — deletes `auto-unlock.dat`
  - `vault.isAutoUnlockEnabled()` → `boolean` — true if `auto-unlock.dat` exists

- [ ] **Step 1: Add helper for auto-unlock path and safeStorage access**

After the `let _onLockCallback = null;` line added in Task 1, add:
```js
function _autoUnlockPath() {
  return path.join(dataDir, 'auto-unlock.dat');
}

function _getSafeStorage() {
  return require('electron').safeStorage;
}
```

- [ ] **Step 2: Implement `isAutoUnlockEnabled()`**

```js
function isAutoUnlockEnabled() {
  _ensureInit();
  return fs.existsSync(_autoUnlockPath());
}
```

- [ ] **Step 3: Implement `tryAutoUnlock()`**

```js
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
```

- [ ] **Step 4: Implement `setupAutoUnlock()`**

```js
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
```

- [ ] **Step 5: Implement `disableAutoUnlock()`**

```js
function disableAutoUnlock() {
  _ensureInit();
  try { fs.unlinkSync(_autoUnlockPath()); } catch {}
  return Promise.resolve({ ok: true });
}
```

- [ ] **Step 6: Update `module.exports`**

```js
module.exports = {
  init, isSetup, isLocked, setup, unlock, lock, changePassword,
  list, save, get, getPassword, remove,
  onAutoLock,
  tryAutoUnlock, setupAutoUnlock, disableAutoUnlock, isAutoUnlockEnabled,
};
```

- [ ] **Step 7: Commit**

```bash
git add vault.js
git commit -m "feat: DPAPI auto-unlock via electron.safeStorage (tryAutoUnlock, setupAutoUnlock, disableAutoUnlock)"
```

---

### Task 3: main.js + preload.js — Startup flow, manuallyLocked, rate-limiting

**Files:**
- Modify: `main.js`
- Modify: `preload.js`

**Interfaces:**
- Consumes: `vault.onAutoLock()`, `vault.tryAutoUnlock()`, `vault.setupAutoUnlock()`, `vault.disableAutoUnlock()`, `vault.isAutoUnlockEnabled()` from Tasks 1–2
- Produces (new IPC channels, all callable from renderer):
  - `passwords:tryAutoUnlock` → `{ ok: boolean }`
  - `passwords:setupAutoUnlock` → `{ ok: true }` | Error
  - `passwords:disableAutoUnlock` → `{ ok: true }`
  - `passwords:autoUnlockAvailable` → `boolean`
  - `passwords:isAutoUnlockEnabled` → `boolean`
- Produces (IPC events pushed to renderer):
  - `vault:status` — sent on `did-finish-load`: `{ isSetup, isLocked, autoUnlockAvailable, isAutoUnlockEnabled }`
  - `vault:locked` — sent when idle auto-lock fires

- [ ] **Step 1: Add `manuallyLocked` flag and rate-limiting vars to main.js**

Near the top of `main.js` after `const vault = require('./vault.js');`, add:
```js
let manuallyLocked  = false;
let _unlockAttempts = 0;
let _unlockCooldown = 0;  // timestamp ms until cooldown expires
```

- [ ] **Step 2: Register `vault.onAutoLock` after `vault.init()`**

Find `vault.init(userData)` and add immediately after:
```js
vault.onAutoLock(() => {
  mainWin?.webContents.send('vault:locked');
});
```

- [ ] **Step 3: Send `vault:status` after main window loads**

Find `mainWin.loadFile('index.html')` and add a `did-finish-load` listener after it:
```js
mainWin.webContents.on('did-finish-load', async () => {
  // Startup auto-unlock: only if not manually locked this session
  if (!manuallyLocked && vault.isSetup() && vault.isAutoUnlockEnabled()) {
    await vault.tryAutoUnlock();
  }
  mainWin.webContents.send('vault:status', {
    isSetup:             vault.isSetup(),
    isLocked:            vault.isLocked(),
    autoUnlockAvailable: require('electron').safeStorage.isEncryptionAvailable(),
    isAutoUnlockEnabled: vault.isAutoUnlockEnabled(),
  });
});
```

- [ ] **Step 4: Wrap `passwords:unlock` with rate-limiting**

Replace the existing `ipcMain.handle('passwords:unlock', ...)` handler:
```js
ipcMain.handle('passwords:unlock', async (_e, pw) => {
  if (Date.now() < _unlockCooldown) {
    const sec = Math.ceil((_unlockCooldown - Date.now()) / 1000);
    throw new Error(`Zu viele Versuche. Bitte warte ${sec} Sekunden.`);
  }
  try {
    const result  = await vault.unlock(pw);
    _unlockAttempts = 0;
    manuallyLocked  = false;
    return result;
  } catch (err) {
    if (++_unlockAttempts >= 5) {
      _unlockCooldown  = Date.now() + 30_000;
      _unlockAttempts  = 0;
    }
    throw err;
  }
});
```

- [ ] **Step 5: Update `passwords:lock` to set `manuallyLocked`**

Find `ipcMain.handle('passwords:lock', ...)` and update:
```js
ipcMain.handle('passwords:lock', () => {
  manuallyLocked = true;
  return vault.lock();
});
```

- [ ] **Step 6: Add new IPC handlers to main.js**

After the existing `passwords:*` handlers, add:
```js
ipcMain.handle('passwords:tryAutoUnlock',     () => vault.tryAutoUnlock());
ipcMain.handle('passwords:setupAutoUnlock',   () => vault.setupAutoUnlock());
ipcMain.handle('passwords:disableAutoUnlock', () => vault.disableAutoUnlock());
ipcMain.handle('passwords:autoUnlockAvailable', () =>
  require('electron').safeStorage.isEncryptionAvailable());
ipcMain.handle('passwords:isAutoUnlockEnabled', () => vault.isAutoUnlockEnabled());
```

- [ ] **Step 7: Update preload.js**

In `preload.js`, inside the `passwords: { ... }` block, add:
```js
tryAutoUnlock:       ()  => ipcRenderer.invoke('passwords:tryAutoUnlock'),
setupAutoUnlock:     ()  => ipcRenderer.invoke('passwords:setupAutoUnlock'),
disableAutoUnlock:   ()  => ipcRenderer.invoke('passwords:disableAutoUnlock'),
autoUnlockAvailable: ()  => ipcRenderer.invoke('passwords:autoUnlockAvailable'),
isAutoUnlockEnabled: ()  => ipcRenderer.invoke('passwords:isAutoUnlockEnabled'),
```

Also add IPC event listeners in the `electronAPI` object (alongside existing `on*` helpers):
```js
onVaultStatus: (cb) => ipcRenderer.on('vault:status', (_e, data) => cb(data)),
onVaultLocked: (cb) => ipcRenderer.on('vault:locked', cb),
```

- [ ] **Step 8: Verify**

Run `npm start`. In DevTools console:
```js
await window.electronAPI.passwords.isSetup()            // → true or false
await window.electronAPI.passwords.isLocked()           // → true (nothing unlocked yet)
await window.electronAPI.passwords.autoUnlockAvailable()// → true on Windows
```
All should resolve without error. No crashes on startup.

- [ ] **Step 9: Commit**

```bash
git add main.js preload.js
git commit -m "feat: vault startup flow, manuallyLocked, IPC rate-limiting, vault:status and vault:locked events"
```

---

### Task 4: index.html — Lock screen overlay + setup wizard

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `window.electronAPI.passwords.setup`, `window.electronAPI.passwords.unlock`, `window.electronAPI.passwords.tryAutoUnlock`, `window.electronAPI.passwords.isSetup`, `window.electronAPI.passwords.isLocked`, `window.electronAPI.passwords.autoUnlockAvailable`, `window.electronAPI.passwords.isAutoUnlockEnabled`, `window.electronAPI.onVaultStatus`, `window.electronAPI.onVaultLocked` from Task 3
- Produces: `showVaultOverlay(status)`, `hideVaultOverlay()` — globally callable from Task 5

- [ ] **Step 1: Add CSS for vault overlay**

In the `<style>` block of `index.html`, add:
```css
/* ── Vault Lock Screen ───────────────────────────────── */
#vaultOverlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,.85); backdrop-filter: blur(12px);
  display: flex; align-items: center; justify-content: center;
}
#vaultOverlay.hidden { display: none; }
.vault-box {
  background: var(--panel-bg, #1a1f2e);
  border: 1px solid var(--border, rgba(255,255,255,.1));
  border-radius: 16px; padding: 2rem; width: 340px;
  box-shadow: 0 20px 60px rgba(0,0,0,.6);
  display: flex; flex-direction: column; gap: 1rem;
}
.vault-box h2 { margin: 0; font-size: 1.2rem; text-align: center; }
.vault-pw-input {
  width: 100%; padding: .7rem .9rem; border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,.15));
  background: var(--input-bg, rgba(255,255,255,.05));
  color: inherit; font-size: .95rem; outline: none; box-sizing: border-box;
}
.vault-pw-input:focus { border-color: var(--accent, #ff9f1c); }
.vault-btn-primary {
  width: 100%; padding: .75rem; border-radius: 8px; border: none;
  background: var(--accent, #ff9f1c); color: #1a0f00;
  font-weight: 700; font-size: .95rem; cursor: pointer;
}
.vault-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.vault-btn-secondary {
  width: 100%; padding: .6rem; border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,.15));
  background: transparent; color: inherit; font-size: .85rem; cursor: pointer;
}
.vault-error { color: #ef4444; font-size: .82rem; text-align: center; min-height: 1.2em; }
.vault-divider { border: none; border-top: 1px solid var(--border, rgba(255,255,255,.1)); margin: .1rem 0; }
.vault-strength-wrap { height: 4px; border-radius: 2px; background: rgba(255,255,255,.1); overflow: hidden; margin-top: .35rem; }
.vault-strength-bar  { height: 100%; border-radius: 2px; transition: width .2s, background .2s; }
.vault-strength-lbl  { font-size: .75rem; color: var(--text-muted, #7c8a9c); text-align: right; min-height: 1.1em; }
```

- [ ] **Step 2: Add HTML for vault overlay**

Find `<!-- Seite durchsuchen -->` (or the first `<!-- ... overlay -->` comment) in `index.html`. Add before it:
```html
<!-- ── Vault Lock Screen ──────────────────────────────────────────── -->
<div id="vaultOverlay" class="hidden">
  <!-- Setup wizard (no vault yet) -->
  <div class="vault-box" id="vaultSetupBox" style="display:none">
    <h2>🔐 Vault einrichten</h2>
    <div>
      <input class="vault-pw-input" type="password" id="vaultSetupPw"
             placeholder="Master-Passwort" autocomplete="new-password"/>
      <div class="vault-strength-wrap">
        <div class="vault-strength-bar" id="vaultStrBar" style="width:0%"></div>
      </div>
      <div class="vault-strength-lbl" id="vaultStrLbl"></div>
    </div>
    <input class="vault-pw-input" type="password" id="vaultSetupPw2"
           placeholder="Bestätigen" autocomplete="new-password"/>
    <div class="vault-error" id="vaultSetupErr"></div>
    <button class="vault-btn-primary" id="vaultSetupBtn">Vault erstellen</button>
  </div>

  <!-- Lock screen (vault exists, locked) -->
  <div class="vault-box" id="vaultLockBox" style="display:none">
    <h2>🥔 Vault gesperrt</h2>
    <input class="vault-pw-input" type="password" id="vaultUnlockPw"
           placeholder="Master-Passwort" autocomplete="current-password"/>
    <div class="vault-error" id="vaultUnlockErr"></div>
    <button class="vault-btn-primary" id="vaultUnlockBtn">🔓 Entsperren</button>
    <hr class="vault-divider" id="vaultDpaDivider" style="display:none"/>
    <button class="vault-btn-secondary" id="vaultDpapiBtn" style="display:none">
      💻 Mit Windows-Konto entsperren
    </button>
  </div>
</div>
```

- [ ] **Step 3: Add JS for vault overlay**

Before `// ── INIT ──` in the `<script>` block, add:

```js
// ── VAULT LOCK SCREEN ────────────────────────────────────────────────────────
function _vaultStrength(pw) {
  if (!pw) return { w: 0, label: '', color: '#ef4444' };
  const hasU = /[A-Z]/.test(pw), hasN = /\d/.test(pw), hasS = /[^a-zA-Z0-9]/.test(pw);
  const mix  = (hasU ? 1 : 0) + (hasN ? 1 : 0) + (hasS ? 1 : 0);
  if (pw.length >= 16 && mix >= 2) return { w: 100, label: 'Sehr stark', color: '#22c55e' };
  if (pw.length >= 12 && mix >= 1) return { w: 75,  label: 'Stark',      color: '#22c55e' };
  if (pw.length >= 8)              return { w: 45,  label: 'Mittel',     color: '#f97316' };
  return                                  { w: 20,  label: 'Schwach',    color: '#ef4444' };
}

function showVaultOverlay(status) {
  const overlay  = document.getElementById('vaultOverlay');
  const setupBox = document.getElementById('vaultSetupBox');
  const lockBox  = document.getElementById('vaultLockBox');
  overlay.classList.remove('hidden');
  if (!status.isSetup) {
    setupBox.style.display = ''; lockBox.style.display = 'none';
    document.getElementById('vaultSetupPw').focus();
  } else {
    setupBox.style.display = 'none'; lockBox.style.display = '';
    const showDpapi = status.autoUnlockAvailable && status.isAutoUnlockEnabled;
    document.getElementById('vaultDpaDivider').style.display = showDpapi ? '' : 'none';
    document.getElementById('vaultDpapiBtn').style.display   = showDpapi ? '' : 'none';
    document.getElementById('vaultUnlockPw').value = '';
    document.getElementById('vaultUnlockErr').textContent = '';
    document.getElementById('vaultUnlockPw').focus();
  }
}

function hideVaultOverlay() {
  document.getElementById('vaultOverlay').classList.add('hidden');
}

// Strength bar on setup
document.getElementById('vaultSetupPw')?.addEventListener('input', e => {
  const s = _vaultStrength(e.target.value);
  const bar = document.getElementById('vaultStrBar');
  bar.style.width      = s.w + '%';
  bar.style.background = s.color;
  document.getElementById('vaultStrLbl').textContent = s.label;
});

// Setup form
document.getElementById('vaultSetupBtn')?.addEventListener('click', async () => {
  const pw  = document.getElementById('vaultSetupPw').value;
  const pw2 = document.getElementById('vaultSetupPw2').value;
  const err = document.getElementById('vaultSetupErr');
  err.textContent = '';
  if (!pw) return (err.textContent = 'Master-Passwort eingeben.');
  if (pw !== pw2) return (err.textContent = 'Passwörter stimmen nicht überein.');
  document.getElementById('vaultSetupBtn').disabled = true;
  try {
    await window.electronAPI.passwords.setup(pw);
    hideVaultOverlay();
  } catch (e) {
    err.textContent = e.message || 'Fehler beim Einrichten.';
  } finally {
    document.getElementById('vaultSetupBtn').disabled = false;
  }
});
document.getElementById('vaultSetupPw2')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('vaultSetupBtn').click();
});

// Unlock form
let _vaultCdTimer = null;
document.getElementById('vaultUnlockBtn')?.addEventListener('click', async () => {
  const pw  = document.getElementById('vaultUnlockPw').value;
  const err = document.getElementById('vaultUnlockErr');
  const btn = document.getElementById('vaultUnlockBtn');
  err.textContent = ''; btn.disabled = true;
  try {
    await window.electronAPI.passwords.unlock(pw);
    hideVaultOverlay();
  } catch (e) {
    err.textContent = e.message || 'Falsches Passwort.';
    if (e.message?.includes('warte')) {
      clearTimeout(_vaultCdTimer);
      _vaultCdTimer = setTimeout(() => { btn.disabled = false; }, 30_500);
    } else {
      btn.disabled = false;
    }
  }
});
document.getElementById('vaultUnlockPw')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('vaultUnlockBtn').click();
});

// DPAPI button (user-initiated, always allowed)
document.getElementById('vaultDpapiBtn')?.addEventListener('click', async () => {
  const err = document.getElementById('vaultUnlockErr');
  err.textContent = '';
  try {
    const result = await window.electronAPI.passwords.tryAutoUnlock();
    if (result.ok) hideVaultOverlay();
    else err.textContent = 'Windows-Entsperrung fehlgeschlagen. Bitte Master-Passwort eingeben.';
  } catch {
    err.textContent = 'Windows-Entsperrung fehlgeschlagen.';
  }
});

// Receive vault status from main process (startup)
window.electronAPI.onVaultStatus(status => {
  if (!status.isSetup || status.isLocked) showVaultOverlay(status);
});

// Receive vault:locked (idle auto-lock fired)
window.electronAPI.onVaultLocked(async () => {
  const [isSetup, isLocked, autoUnlockAvailable, isAutoUnlockEnabled] = await Promise.all([
    window.electronAPI.passwords.isSetup(),
    window.electronAPI.passwords.isLocked(),
    window.electronAPI.passwords.autoUnlockAvailable(),
    window.electronAPI.passwords.isAutoUnlockEnabled(),
  ]);
  showVaultOverlay({ isSetup, isLocked, autoUnlockAvailable, isAutoUnlockEnabled });
});
```

- [ ] **Step 4: Verify**

Run `npm start`. Test these scenarios:
1. No vault → setup wizard appears → create vault → wizard closes
2. Close browser, reopen → lock screen appears → enter password → browser unlocks
3. Wait 10 min (or temporarily set `IDLE_MS = 10_000` in vault.js) → lock screen reappears
4. Wrong password → "Falsches Passwort." shown
5. 5 wrong passwords → button disabled for 30s

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: vault lock screen overlay and first-time setup wizard"
```

---

### Task 5: index.html — DPAPI toggle in Settings + manual lock button

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `window.electronAPI.passwords.setupAutoUnlock`, `window.electronAPI.passwords.disableAutoUnlock`, `window.electronAPI.passwords.autoUnlockAvailable`, `window.electronAPI.passwords.isAutoUnlockEnabled`, `window.electronAPI.passwords.lock`, `showVaultOverlay()` from Task 4
- Produces: Settings section "🔐 Vault-Sicherheit" with DPAPI toggle + manual lock button

- [ ] **Step 1: Add vault settings section HTML**

In the settings panel, find an existing `settings-section` div (look for `class="settings-section"` or similar). Add a new section after the last one:
```html
<div class="settings-section" id="vaultSettingsSection">
  <div class="settings-title">🔐 Vault-Sicherheit</div>

  <div class="toggle-row" id="autoUnlockRow" style="display:none">
    <div>
      <div class="toggle-label">Mit Windows-Konto entsperren</div>
      <div style="font-size:.78rem;color:var(--text-muted,#7c8a9c);margin-top:.15rem">
        Geschützt durch Electron safeStorage. Master-Passwort wird nie gespeichert.
      </div>
    </div>
    <label class="s-toggle">
      <input type="checkbox" id="autoUnlockToggle"/>
      <span class="s-toggle-track"></span>
    </label>
  </div>

  <div style="margin-top:.6rem">
    <button id="vaultManualLockBtn"
            style="padding:.5rem 1rem;border-radius:8px;border:1px solid rgba(239,68,68,.5);
                   background:transparent;color:#ef4444;cursor:pointer;font-size:.85rem">
      🔒 Vault jetzt sperren
    </button>
  </div>
</div>
```

- [ ] **Step 2: Add JS for vault settings**

Before `// ── INIT ──`, add:
```js
// ── VAULT SETTINGS ───────────────────────────────────────────────────────────
async function initVaultSettings() {
  const available = await window.electronAPI.passwords.autoUnlockAvailable();
  const row = document.getElementById('autoUnlockRow');
  if (!available || !row) return;
  row.style.display = '';
  const enabled = await window.electronAPI.passwords.isAutoUnlockEnabled();
  const toggle  = document.getElementById('autoUnlockToggle');
  if (toggle) toggle.checked = enabled;
}

document.getElementById('autoUnlockToggle')?.addEventListener('change', async e => {
  try {
    if (e.target.checked) {
      await window.electronAPI.passwords.setupAutoUnlock();
      showToast('Auto-Unlock aktiviert');
    } else {
      await window.electronAPI.passwords.disableAutoUnlock();
      showToast('Auto-Unlock deaktiviert');
    }
  } catch (err) {
    showToast('Fehler: ' + (err.message || 'Unbekannt'));
    e.target.checked = !e.target.checked; // revert toggle on error
  }
});

document.getElementById('vaultManualLockBtn')?.addEventListener('click', async () => {
  await window.electronAPI.passwords.lock();
  closeSettings?.();
  const [isSetup, autoUnlockAvailable, isAutoUnlockEnabled] = await Promise.all([
    window.electronAPI.passwords.isSetup(),
    window.electronAPI.passwords.autoUnlockAvailable(),
    window.electronAPI.passwords.isAutoUnlockEnabled(),
  ]);
  showVaultOverlay({ isSetup, isLocked: true, autoUnlockAvailable, isAutoUnlockEnabled });
});
```

- [ ] **Step 3: Call `initVaultSettings()` when settings panel opens**

Find `function openSettings()` in `index.html`. Add `initVaultSettings();` at the end of the function body.

- [ ] **Step 4: Verify full end-to-end flow**

Run `npm start`. Test all scenarios:
1. Create vault → unlock → open Settings → "🔐 Vault-Sicherheit" section visible
2. On Windows: "Mit Windows-Konto entsperren" toggle visible → activate → `auto-unlock.dat` created in userData/vault/
3. Close browser, reopen → vault auto-unlocks (no password prompt)
4. Open Settings → click "Vault jetzt sperren" → lock screen appears
5. Lock screen shows "💻 Mit Windows-Konto entsperren" button → click → unlocks without master password
6. Open Settings → disable auto-unlock → `auto-unlock.dat` deleted
7. Reopen browser → lock screen requires master password
8. Verify existing `passwords.enc` entries survive throughout (autofill still works)

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: vault settings — DPAPI auto-unlock toggle and manual lock button"
```
