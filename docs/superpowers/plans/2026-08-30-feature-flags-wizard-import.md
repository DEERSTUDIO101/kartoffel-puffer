# Feature-Flags, Setup-Wizard & Browser-Import — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nutzer können beim ersten Start (Wizard) und dauerhaft in den Einstellungen einzelne Browser-Features ein-/ausschalten und Daten aus anderen Browsern importieren.

**Architecture:** Feature-Flags werden als `cfg.features`-Unterkey in localStorage (`kp-settings-v3`) gespeichert und steuern CSS-Klassen auf `<body>` (`feat--<key>`). Toolbar-Buttons werden per CSS versteckt, Kontextmenü-Einträge per JS-Check übersprungen. Der Setup-Wizard ist ein Fullscreen-Overlay in `index.html`, das beim ersten Start (kein `kp-settings-v3` vorhanden) automatisch angezeigt wird. Browser-Import läuft im Electron-Main-Prozess via IPC.

**Tech Stack:** Vanilla JS, localStorage, CSS-Klassen auf `<body>`, Electron IPC, `better-sqlite3` (neu), Node.js `child_process` (DPAPI für Chrome-Passwörter), PowerShell.

## Global Constraints

- Kein Build-Schritt, kein Bundler, kein Test-Runner — alles lädt direkt im Browser via `<script src="...">`.
- Manuelles Testen: immer `npm start` und Verhalten im laufenden Browser prüfen.
- Kein neuer Persistenz-Layer — alles im bestehenden `cfg`/localStorage-System (`js/storage.js`).
- Windows-only für Browser-Import (Pfade sind `%LOCALAPPDATA%`/`%APPDATA%`).
- Alle Labels auf Deutsch (Projektsprache).
- `better-sqlite3` muss als native Electron-Abhängigkeit mit `electron-rebuild` nach Installation gebaut werden.

---

## Dateien-Übersicht

| Datei | Aktion | Verantwortlichkeit |
|-------|--------|-------------------|
| `js/storage.js` | Modify | Feature-Defaults, `applyFeatureFlags()`, `ensureFeatureDefaults()` |
| `index.html` | Modify | Feature-CSS, Settings-Features-Tab, Setup-Wizard (HTML+CSS+JS) |
| `js/tabs.js` | Modify | Kontextmenü-Einträge per Feature-Flag überspringen |
| `js/browser-import.js` | Create | Browser-Erkennung, Parsing aller Formate |
| `main.js` | Modify | IPC-Handler für Import |
| `preload.js` | Modify | `browserImport` API über contextBridge |

---

## Task 1: Feature-Flag-System — Storage & CSS

**Files:**
- Modify: `js/storage.js`
- Modify: `index.html` (CSS-Block)

**Interfaces:**
- Produces: `applyFeatureFlags()` — globale Funktion, setzt/entfernt `feat--<key>`-Klassen auf `document.body`. Wird von Task 2, 3, 5 aufgerufen.
- Produces: `cfg.features` — Objekt mit Boolean-Werten für jeden Feature-Key.

---

- [ ] **Schritt 1: Feature-Defaults in `js/storage.js` hinzufügen**

In `js/storage.js`, das `defaultSettings`-Objekt am Ende um den `features`-Key erweitern (nach `navButtonHidden`):

```js
const defaultSettings = {
  // ... bestehende Keys ...
  navButtonOrder:[], navButtonHidden:[],
  features: {
    devicePreview:    true,
    aiSidebar:        true,
    aiWindow:         true,
    speechToText:     true,
    eyedropper:       true,
    fontInspector:    true,
    vault:            true,
    extensionManager: true,
    uiBuilder:        true,
    browserImport:    true,
  },
};
```

- [ ] **Schritt 2: `ensureFeatureDefaults()` und `applyFeatureFlags()` in `js/storage.js` hinzufügen**

Direkt nach der `saveHistory()`-Funktion in `js/storage.js` einfügen:

```js
// Fehlende Feature-Keys mit true auffüllen (Backwards-Compat für bestehende Installs)
function ensureFeatureDefaults() {
  if (!cfg.features || typeof cfg.features !== 'object') cfg.features = {};
  const def = defaultSettings.features;
  Object.keys(def).forEach(k => {
    if (!(k in cfg.features)) cfg.features[k] = def[k];
  });
}

// CSS-Klassen auf <body> setzen/entfernen je nach Feature-Status
function applyFeatureFlags() {
  ensureFeatureDefaults();
  Object.entries(cfg.features).forEach(([key, enabled]) => {
    document.body.classList.toggle(`feat--${key}`, !!enabled);
  });
}
```

- [ ] **Schritt 3: `ensureFeatureDefaults()` in `loadSettings()` aufrufen**

In `js/storage.js` die bestehende `loadSettings()`-Funktion anpassen:

```js
function loadSettings() {
  try {
    const r = localStorage.getItem(SETTINGS_KEY);
    if (r) cfg = { ...defaultSettings, ...JSON.parse(r) };
  } catch {}
  ensureFeatureDefaults();
}
```

- [ ] **Schritt 4: Feature-CSS in `index.html` einfügen**

Im `<style>`-Block von `index.html`, nach den bestehenden Regeln (z.B. nach `/* ── UI Builder … */`), einfügen:

```css
/* ── Feature-Flags: Elemente ausblenden wenn Feature deaktiviert ── */
body:not(.feat--aiSidebar) #btnAI           { display: none !important; }
body:not(.feat--aiSidebar) #aiSidebar       { display: none !important; }
body:not(.feat--aiWindow)  #aiSidebar-detach { display: none !important; }
body:not(.feat--speechToText) #btnMic       { display: none !important; }
body:not(.feat--vault)     #btnPasswords    { display: none !important; }
body:not(.feat--extensionManager) #btnExtensions { display: none !important; }
```

Hinweis: `devicePreview`, `eyedropper`, `fontInspector` und `uiBuilder` haben keine Toolbar-Buttons — sie erscheinen nur im Kontextmenü und werden in Task 2 behandelt.

- [ ] **Schritt 5: `applyFeatureFlags()` nach `applySettings()` aufrufen**

In `index.html`, die bestehende `applySettings()`-Funktion (ca. Zeile 1434) suchen. Am Ende der Funktion, direkt vor der schließenden `}`, einfügen:

```js
applyFeatureFlags();
```

- [ ] **Schritt 6: Testen**

```
npm start
```

Browser öffnet. Öffne DevTools (F12 → Console). Tippe:
```js
cfg.features.vault = false; applyFeatureFlags();
```
Erwartung: `#btnPasswords` (Schlüssel-Icon in der Toolbar) verschwindet sofort.
```js
cfg.features.vault = true; applyFeatureFlags();
```
Erwartung: Button erscheint wieder.

- [ ] **Schritt 7: Commit**

```bash
git add js/storage.js index.html
git commit -m "feat: add feature-flag system with CSS body classes"
```

---

## Task 2: Kontextmenü-Einträge per Feature-Flag steuern

**Files:**
- Modify: `js/tabs.js` (Zeilen ca. 362–414)

**Interfaces:**
- Consumes: `cfg.features` aus `js/storage.js` (global verfügbar)

---

- [ ] **Schritt 1: Design-Tools-Block in `js/tabs.js` anpassen**

In `js/tabs.js`, den Block ab `// ── DESIGN-TOOLS` (ca. Zeile 362) ersetzen:

```js
// ── DESIGN-TOOLS ─────────────────────────────────────────────────────────
const designItems = [];
if (cfg.features?.eyedropper !== false) {
  designItems.push({ label: '🎨 Farbe aufnehmen', click: async () => {
    if (!window.EyeDropper) { showToast('EyeDropper-API nicht unterstützt'); return; }
    try {
      const res = await new EyeDropper().open();
      await navigator.clipboard.writeText(res.sRGBHex);
      showColorToast(res.sRGBHex);
    } catch {}
  }});
}
if (cfg.features?.fontInspector !== false) {
  designItems.push({ label: '🔤 Schrift inspizieren', click: () => {
    const cx = p.x, cy = p.y;
    wv.executeJavaScript(`
      (function(){
        var el = document.elementFromPoint(${cx}, ${cy});
        if (!el) return null;
        var walk = el;
        while (walk && walk !== document.body && walk.children.length && !walk.textContent.trim()) walk = walk.parentElement;
        if (walk && walk !== document.body) el = walk;
        var s = window.getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          fontFamily: s.fontFamily, fontSize: s.fontSize,
          fontWeight: s.fontWeight, fontStyle: s.fontStyle,
          lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
          color: s.color, textAlign: s.textAlign,
        };
      })()
    `).then(info => {
      if (info) showFontInspector(info, wvRect.left + cx, wvRect.top + cy);
    }).catch(() => {});
  }});
}
if (designItems.length > 0) items.push('-', ...designItems);
```

- [ ] **Schritt 2: Gerätevorschau-Block in `js/tabs.js` anpassen**

Den Block ab `// ── GERÄTEVORSCHAU` (ca. Zeile 401) ersetzen:

```js
// ── GERÄTEVORSCHAU ──────────────────────────────────────────────────
if (cfg.features?.devicePreview !== false) {
  items.push(
    '-',
    { label: '📱 Gerätevorschau', submenu: [
      { label: '🖥  Desktop',                 click: () => setDevicePreview(null) },
      '-',
      { label: '▯  Tablet  768×1024',         click: () => setDevicePreview('tab-v', 768, 1024) },
      { label: '▭  Tablet quer  1024×768',    click: () => setDevicePreview('tab-h', 1024, 768) },
      '-',
      { label: '▯  Smartphone  390×844',      click: () => setDevicePreview('mob-v', 390, 844) },
      { label: '▭  Smartphone quer  844×390', click: () => setDevicePreview('mob-h', 844, 390) },
    ]},
  );
}
```

- [ ] **Schritt 3: Testen**

```
npm start
```

Öffne DevTools → Console:
```js
cfg.features.eyedropper = false; cfg.features.devicePreview = false;
```
Rechtsklick auf eine Webseite. Erwartung: "Farbe aufnehmen" und "Gerätevorschau" fehlen im Kontextmenü.

```js
cfg.features.eyedropper = true; cfg.features.devicePreview = true;
```
Rechtsklick → Erwartung: beide Einträge wieder da.

- [ ] **Schritt 4: Commit**

```bash
git add js/tabs.js
git commit -m "feat: hide context menu items based on feature flags"
```

---

## Task 3: Settings — Features-Tab

**Files:**
- Modify: `index.html` (HTML + JS in der Settings-Sektion)

**Interfaces:**
- Consumes: `cfg.features`, `applyFeatureFlags()`, `saveSettings()` (alle global aus `js/storage.js`)

---

- [ ] **Schritt 1: Nav-Eintrag in den Settings hinzufügen**

In `index.html`, im `<div class="s-nav">` Block (ca. Zeile 651), den letzten bestehenden `snav-item` (Info) suchen und davor einfügen:

```html
<div class="snav-item" data-page="features"><i data-lucide="sliders" width="14" height="14"></i><span>Features</span></div>
```

- [ ] **Schritt 2: Features-Seite HTML hinzufügen**

In `index.html`, nach der letzten `</div><!-- end s-page -->` im Settings-Content-Bereich, direkt vor `</div><!-- end s-content -->`, einfügen:

```html
<!-- Features -->
<div class="s-page" id="s-features">
  <div class="s-section">
    <div class="s-label">Browser-Features</div>
    <div class="s-desc" style="font-size:12px;color:var(--muted);margin-bottom:.8rem">
      Aktiviere oder deaktiviere einzelne Features. Änderungen wirken sofort.
    </div>
    <div id="featureCardList" style="display:flex;flex-direction:column;gap:.5rem"></div>
  </div>
  <div class="s-section" style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--panel-border)">
    <button class="s-btn" id="btnRestartWizard" style="width:100%">
      🧙 Setup-Wizard erneut starten
    </button>
  </div>
</div>
```

- [ ] **Schritt 3: Feature-Karten JS hinzufügen**

In `index.html`, im Script-Block, die Funktion `syncSettingsUI()` suchen (ca. Zeile 1621). Am Ende der Funktion (vor der schließenden `}`) einfügen:

```js
renderFeatureCards();
```

Danach, außerhalb von `syncSettingsUI`, eine neue Funktion einfügen:

```js
const FEATURE_META = [
  { key: 'aiSidebar',        icon: 'bot',          label: 'AI-Sidebar',              desc: 'Eingebettete AI-Sidebar im Browserfenster' },
  { key: 'aiWindow',         icon: 'external-link', label: 'AI-Assistenten-Fenster',  desc: 'Separates always-on-top Fenster mit AI-Anbietern' },
  { key: 'speechToText',     icon: 'mic',          label: 'Sprache-zu-Text',          desc: 'Diktierfunktion in der URL-Leiste' },
  { key: 'vault',            icon: 'key-round',    label: 'Passwort-Tresor',          desc: 'Verschlüsselter Passwort-Manager mit Autofill' },
  { key: 'extensionManager', icon: 'puzzle',       label: 'Erweiterungs-Verwaltung',  desc: 'Benutzerdefinierte Browser-Erweiterungen laden' },
  { key: 'eyedropper',       icon: 'pipette',      label: 'Farbpipette',             desc: 'Farben von Webseiten aufnehmen (Rechtsklick-Menü)' },
  { key: 'fontInspector',    icon: 'type',         label: 'Schrift-Inspektor',        desc: 'Schriftart-Informationen von Elementen (Rechtsklick)' },
  { key: 'devicePreview',    icon: 'monitor-smartphone', label: 'Gerätevorschau',    desc: 'Responsive-Vorschau im Rechtsklick-Menü' },
  { key: 'uiBuilder',        icon: 'layout-dashboard', label: 'UI-Editor',            desc: 'Drag-and-Drop Toolbar-Layout-Editor' },
  { key: 'browserImport',    icon: 'download',     label: 'Browser-Import',           desc: 'Daten aus anderen Browsern importieren' },
];

function renderFeatureCards() {
  const list = document.getElementById('featureCardList');
  if (!list) return;
  list.innerHTML = '';
  ensureFeatureDefaults();
  FEATURE_META.forEach(({ key, icon, label, desc }) => {
    const enabled = cfg.features[key] !== false;
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;align-items:center;gap:.75rem;padding:.6rem .8rem;background:rgba(255,255,255,.04);border-radius:8px;border:1px solid var(--panel-border)';
    card.innerHTML = `
      <i data-lucide="${icon}" width="16" height="16" style="flex-shrink:0;color:var(--accent)"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500">${label}</div>
        <div style="font-size:11px;color:var(--muted)">${desc}</div>
      </div>
      <label style="display:flex;align-items:center;cursor:pointer;flex-shrink:0">
        <input type="checkbox" data-feat="${key}" ${enabled ? 'checked' : ''} style="display:none"/>
        <span class="feat-toggle ${enabled ? 'on' : ''}" style="
          width:36px;height:20px;border-radius:10px;background:${enabled ? 'var(--accent)' : 'rgba(255,255,255,.12)'};
          position:relative;transition:background .15s;display:block">
          <span style="position:absolute;top:3px;left:${enabled ? '19px' : '3px'};width:14px;height:14px;
            border-radius:50%;background:#fff;transition:left .15s"></span>
        </span>
      </label>`;
    const cb = card.querySelector('input[type=checkbox]');
    const toggle = card.querySelector('.feat-toggle');
    const knob = toggle.querySelector('span');
    cb.addEventListener('change', () => {
      cfg.features[key] = cb.checked;
      toggle.style.background = cb.checked ? 'var(--accent)' : 'rgba(255,255,255,.12)';
      knob.style.left = cb.checked ? '19px' : '3px';
      saveSettings();
      applyFeatureFlags();
    });
    list.appendChild(card);
  });
  if (window.lucide) lucide.createIcons({ nodes: [list] });
}
```

- [ ] **Schritt 4: "Setup-Wizard erneut starten"-Button verdrahten**

Im Script-Block von `index.html`, nach der Funktion `renderFeatureCards()`, einfügen:

```js
document.getElementById('btnRestartWizard')?.addEventListener('click', () => {
  closeSettings();
  showWizard();
});
```

Hinweis: `showWizard()` wird in Task 5 definiert.

- [ ] **Schritt 5: Testen**

```
npm start
```

Öffne Einstellungen (Zahnrad-Icon). Erwartung: neuer Nav-Eintrag "Features" erscheint. Klicke ihn an — Feature-Karten mit Toggles sind sichtbar. Toggle "Passwort-Tresor" aus → `#btnPasswords` verschwindet aus der Toolbar. Toggle wieder ein → Button kommt zurück.

- [ ] **Schritt 6: Commit**

```bash
git add index.html
git commit -m "feat: add Features tab to settings with live feature toggles"
```

---

## Task 4: Browser-Import Backend

**Files:**
- Create: `js/browser-import.js`
- Modify: `main.js`
- Modify: `preload.js`

**Interfaces:**
- Produces IPC-Kanäle:
  - `import:detectBrowsers` → `Promise<Array<{ id, name, hasBookmarks, hasPasswords, hasHistory }>>` 
  - `import:run` → `Promise<{ bookmarks: number, passwords: number, history: number, errors: string[] }>`
    - Argumente: `{ browser: string, types: string[], filePaths?: object }`
  - `import:fromFile` → `Promise<{ count: number, errors: string[] }>`
    - Argumente: `{ type: 'bookmarks'|'passwords', filePath: string }`
- Produces `window.electronAPI.browserImport` (via preload.js)

---

- [ ] **Schritt 1: `better-sqlite3` installieren und rebuilden**

```bash
npm install better-sqlite3
npm install --save-dev electron-rebuild
npx electron-rebuild -f -w better-sqlite3
```

Erwartung: `better-sqlite3` wird für die installierte Electron-Version nativ gebaut. Keine Fehler.

- [ ] **Schritt 2: `js/browser-import.js` erstellen**

Neue Datei `js/browser-import.js` anlegen:

```js
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// better-sqlite3 wird nur bei Bedarf geladen (Lazy) damit der Main-Prozess
// nicht crasht wenn die Datei gesperrt oder nicht lesbar ist.
function openDb(filePath) {
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

// ── Lesezeichen: Chrome/Edge/Brave/Opera JSON ──────────────────────────────────
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

// ── Lesezeichen: Firefox places.sqlite ────────────────────────────────────────
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
    return rows.map(r => ({ url: r.url, title: r.title || r.url, ts: Math.floor(r.dateAdded / 1000) }));
  } finally {
    db?.close();
  }
}

// ── Lesezeichen: HTML (Netscape Bookmark Format) ───────────────────────────────
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
  // Chrome v80+: prefix "v10" + 12-byte nonce + ciphertext + 16-byte tag
  if (!encryptedBuf || encryptedBuf.length < 31) return '';
  const prefix = encryptedBuf.slice(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') return '(älteres DPAPI-Format — nicht unterstützt)';
  try {
    const { createDecipheriv } = require('crypto');
    const nonce      = encryptedBuf.slice(3, 15);
    const ciphertext = encryptedBuf.slice(15, encryptedBuf.length - 16);
    const tag        = encryptedBuf.slice(encryptedBuf.length - 16);
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
  // Base64 → Buffer, dann DPAPI-Prefix "DPAPI" entfernen
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64').slice(5);
  // DPAPI-Entschlüsselung via PowerShell
  const hexKey = encryptedKey.toString('hex');
  const ps = `
    $bytes = [System.Convert]::FromHexString('${hexKey}')
    $dec   = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
    [System.Convert]::ToBase64String($dec)
  `;
  const result = execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g,' ')}"`, { encoding: 'utf8' }).trim();
  return Buffer.from(result, 'base64');
}

function parseChromiumPasswords(loginDataPath, localStatePath) {
  const aesKey = getChromiumAesKey(localStatePath);
  let db;
  try {
    db = openDb(loginDataPath);
    const rows = db.prepare('SELECT origin_url, username_value, password_value FROM logins').all();
    return rows.map(r => ({
      site:     r.origin_url,
      username: r.username_value,
      password: aesKey ? decryptChromiumPassword(r.password_value, aesKey) : '(nicht entschlüsselt)',
    }));
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
      ts:    Math.floor(r.last_visit / 1000),
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

  const def = BROWSERS[browser];
  const ffDir = browser === 'firefox' ? firefoxProfileDir() : null;

  if (types.includes('bookmarks')) {
    try {
      let bookmarks = [];
      if (def) {
        bookmarks = parseChromiumBookmarks(path.join(def.base, def.bookmarks));
      } else if (ffDir) {
        bookmarks = parseFirefoxBookmarks(ffDir);
      }
      result.bookmarks = bookmarks.length;
      result._bookmarks = bookmarks; // wird im IPC-Handler in localStorage geschrieben
    } catch (e) {
      result.errors.push(`Lesezeichen: ${e.message}`);
    }
  }

  if (types.includes('passwords') && def) {
    try {
      const pwPath  = path.join(def.base, def.loginData);
      const lsPath  = def.localState;
      const entries = parseChromiumPasswords(pwPath, lsPath);
      result.passwords = entries.length;
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
      result.history = history.length;
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
      const bookmarks = parseBookmarkHtml(filePath);
      result.count = bookmarks.length;
      result._bookmarks = bookmarks;
    } else if (type === 'passwords') {
      const entries = parsePasswordCsv(filePath);
      result.count = entries.length;
      result._passwords = entries;
    }
  } catch (e) {
    result.errors.push(e.message);
  }
  return result;
}

module.exports = { detectBrowsers, runImport, importFromFile };
```

- [ ] **Schritt 3: IPC-Handler in `main.js` hinzufügen**

In `main.js`, nach dem `require`-Block am Anfang der Datei, `browser-import` einbinden:

```js
const browserImport = require('./js/browser-import.js');
```

Dann, am Ende der `app.whenReady()`-Funktion (vor der schließenden `}`), die IPC-Handler registrieren:

```js
// ── Browser-Import ───────────────────────────────────────────────────────────
ipcMain.handle('import:detectBrowsers', () => {
  return browserImport.detectBrowsers();
});

ipcMain.handle('import:run', async (_e, args) => {
  const result = browserImport.runImport(args);
  // Daten werden als Serialisierungs-sichere Arrays zurückgegeben
  // (ohne _bookmarks/_passwords/_history — die landen über einen zweiten
  // IPC-Aufruf im Renderer, der sie direkt in localStorage schreibt)
  const payload = {
    bookmarks: result.bookmarks,
    passwords: result.passwords,
    history:   result.history,
    errors:    result.errors,
    data: {
      bookmarks: result._bookmarks || [],
      passwords: result._passwords || [],
      history:   result._history   || [],
    },
  };
  return payload;
});

ipcMain.handle('import:fromFile', async (_e, args) => {
  const result = browserImport.importFromFile(args);
  return {
    count:  result.count,
    errors: result.errors,
    data: {
      bookmarks: result._bookmarks || [],
      passwords: result._passwords || [],
    },
  };
});
```

- [ ] **Schritt 4: `preload.js` erweitern**

In `preload.js`, am Ende des `contextBridge.exposeInMainWorld('electronAPI', { ... })`-Objekts (vor der schließenden `}`), einfügen:

```js
  // Browser-Import
  browserImport: {
    detect:   ()     => ipcRenderer.invoke('import:detectBrowsers'),
    run:      (args) => ipcRenderer.invoke('import:run', args),
    fromFile: (args) => ipcRenderer.invoke('import:fromFile', args),
  },
```

- [ ] **Schritt 5: Testen**

```
npm start
```

Öffne DevTools → Console:
```js
window.electronAPI.browserImport.detect().then(r => console.log('Erkannte Browser:', r));
```
Erwartung: Array mit erkannten Browsern (z.B. Chrome, Edge) — oder leeres Array wenn keiner installiert.

- [ ] **Schritt 6: Commit**

```bash
git add js/browser-import.js main.js preload.js package.json package-lock.json
git commit -m "feat: add browser import backend with IPC (bookmarks, passwords, history)"
```

---

## Task 5: Setup-Wizard UI & First-Run-Logik

**Files:**
- Modify: `index.html` (HTML, CSS, JS)

**Interfaces:**
- Consumes: `window.electronAPI.browserImport` (Task 4), `cfg`, `loadSettings()`, `saveSettings()`, `applyFeatureFlags()`, `applySettings()`, `FEATURE_META`, `renderFeatureCards()` (alle lokal)
- Produces: `showWizard()` — globale Funktion (wird von Task 3 aufgerufen)

---

- [ ] **Schritt 1: Wizard-Overlay HTML in `index.html` einfügen**

Direkt nach dem `<!-- Toast -->` Kommentar (ca. Zeile 600), das Wizard-Overlay einfügen:

```html
<!-- ── Setup-Wizard ── -->
<div id="wizardOverlay" style="display:none;position:fixed;inset:0;z-index:9999;background:var(--bg);overflow-y:auto">
  <div style="min-height:100%;display:flex;align-items:center;justify-content:center;padding:2rem">
    <div id="wizardBox" style="width:min(620px,96vw);display:flex;flex-direction:column;gap:1.5rem">

      <!-- Step indicators -->
      <div id="wizardSteps" style="display:flex;gap:.5rem;justify-content:center">
        <div class="wstep active" data-s="0"></div>
        <div class="wstep" data-s="1"></div>
        <div class="wstep" data-s="2"></div>
        <div class="wstep" data-s="3"></div>
      </div>

      <!-- Schritt 0: Willkommen -->
      <div id="wiz-0" class="wiz-page">
        <div style="text-align:center;padding:2rem 0">
          <div style="font-size:64px;margin-bottom:1rem">🥔</div>
          <h1 style="font-size:1.8rem;font-weight:700;margin-bottom:.5rem">Kartoffel Puffer</h1>
          <p style="color:var(--muted);margin-bottom:2rem">Lass uns den Browser auf deinen Workflow einrichten.</p>
          <button class="s-btn primary" id="wizBtnStart" style="padding:.75rem 2.5rem;font-size:1rem">Los geht's →</button>
        </div>
      </div>

      <!-- Schritt 1: Import -->
      <div id="wiz-1" class="wiz-page" style="display:none">
        <h2 style="font-size:1.2rem;font-weight:600;margin-bottom:.3rem">Daten importieren</h2>
        <p style="color:var(--muted);font-size:13px;margin-bottom:1.2rem">Lesezeichen, Passwörter und Verlauf aus einem anderen Browser übernehmen.</p>
        <div id="wizBrowserList" style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:1rem">
          <div style="color:var(--muted);font-size:13px">Suche nach installierten Browsern…</div>
        </div>
        <!-- Manueller Import -->
        <div style="border-top:1px solid var(--panel-border);padding-top:1rem;margin-top:.5rem">
          <div style="font-size:12px;color:var(--muted);margin-bottom:.5rem">Oder Datei auswählen:</div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="s-btn" id="wizImportBmHtml">📄 Lesezeichen-HTML</button>
            <button class="s-btn" id="wizImportPwCsv">🔑 Passwörter-CSV</button>
          </div>
        </div>
        <div id="wizImportStatus" style="font-size:12px;color:var(--accent);margin-top:.5rem;min-height:1.2em"></div>
        <div style="display:flex;justify-content:space-between;margin-top:1.5rem">
          <button class="s-btn" id="wizSkipImport">Überspringen</button>
          <button class="s-btn primary" id="wizNextToFeatures">Weiter →</button>
        </div>
      </div>

      <!-- Schritt 2: Features -->
      <div id="wiz-2" class="wiz-page" style="display:none">
        <h2 style="font-size:1.2rem;font-weight:600;margin-bottom:.3rem">Welche Features möchtest du nutzen?</h2>
        <p style="color:var(--muted);font-size:13px;margin-bottom:1rem">Du kannst das jederzeit in den Einstellungen ändern.</p>
        <div id="wizFeatureList" style="display:flex;flex-direction:column;gap:.4rem;max-height:50vh;overflow-y:auto"></div>
        <div style="display:flex;justify-content:space-between;margin-top:1.5rem">
          <button class="s-btn" id="wizBackToImport">← Zurück</button>
          <button class="s-btn primary" id="wizNextToDone">Weiter →</button>
        </div>
      </div>

      <!-- Schritt 3: Fertig -->
      <div id="wiz-3" class="wiz-page" style="display:none">
        <div style="text-align:center;padding:2rem 0">
          <div style="font-size:64px;margin-bottom:1rem">✅</div>
          <h2 style="font-size:1.4rem;font-weight:700;margin-bottom:.5rem">Alles bereit!</h2>
          <div id="wizSummary" style="color:var(--muted);font-size:13px;margin-bottom:2rem;line-height:1.7"></div>
          <button class="s-btn primary" id="wizFinish" style="padding:.75rem 2.5rem;font-size:1rem">Browser starten 🚀</button>
        </div>
      </div>

    </div>
  </div>
</div>
```

- [ ] **Schritt 2: Wizard-CSS in `index.html` einfügen**

Im `<style>`-Block von `index.html`, nach den Feature-Flag-Regeln aus Task 1, einfügen:

```css
/* ── Setup-Wizard ── */
.wstep {
  width: 28px; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,.15); transition: background .2s;
}
.wstep.active { background: var(--accent); }
.wiz-page { animation: wizFadeIn .2s ease; }
@keyframes wizFadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
```

- [ ] **Schritt 3: Wizard-JS in `index.html` einfügen**

Im Script-Block von `index.html`, am Ende (vor dem letzten schließenden `</script>`), einfügen:

```js
// ── SETUP-WIZARD ──────────────────────────────────────────────────────────────
let _wizStep = 0;
let _wizSummary = { bookmarks: 0, passwords: 0, history: 0 };

function showWizard() {
  _wizStep = 0;
  _wizSummary = { bookmarks: 0, passwords: 0, history: 0 };
  document.getElementById('wizardOverlay').style.display = '';
  wizGotoStep(0);
  // Browser-Erkennung starten sobald der Wizard sichtbar ist
  loadWizardBrowserList();
}

function wizGotoStep(n) {
  _wizStep = n;
  document.querySelectorAll('.wiz-page').forEach((el, i) => {
    el.style.display = i === n ? '' : 'none';
  });
  document.querySelectorAll('.wstep').forEach((el, i) => {
    el.classList.toggle('active', i === n);
  });
}

function closeWizard() {
  document.getElementById('wizardOverlay').style.display = 'none';
  document.getElementById('wizardOverlay').remove();
}

async function loadWizardBrowserList() {
  const list = document.getElementById('wizBrowserList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--muted);font-size:13px">Suche…</div>';
  const browsers = await window.electronAPI.browserImport.detect().catch(() => []);
  if (browsers.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px">Keine installierten Browser gefunden.</div>';
    return;
  }
  list.innerHTML = '';
  browsers.forEach(b => {
    const types = [
      b.hasBookmarks && 'bookmarks',
      b.hasPasswords && 'passwords',
      b.hasHistory   && 'history',
    ].filter(Boolean);

    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(255,255,255,.04);border:1px solid var(--panel-border);border-radius:8px;padding:.7rem 1rem';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <span style="font-weight:500">${b.name}</span>
        <button class="s-btn primary wiz-import-btn" data-browser="${b.id}" style="font-size:12px;padding:.25rem .75rem">
          Importieren
        </button>
      </div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        ${types.map(t => `<label style="display:flex;align-items:center;gap:.3rem;font-size:12px;cursor:pointer">
          <input type="checkbox" class="wiz-type-cb" data-browser="${b.id}" data-type="${t}" checked/>
          ${t === 'bookmarks' ? 'Lesezeichen' : t === 'passwords' ? 'Passwörter' : 'Verlauf'}
        </label>`).join('')}
      </div>`;
    const btn = card.querySelector('.wiz-import-btn');
    btn.addEventListener('click', async () => {
      const selectedTypes = [...card.querySelectorAll('.wiz-type-cb:checked')].map(c => c.dataset.type);
      if (selectedTypes.length === 0) return;
      btn.disabled = true;
      btn.textContent = '…';
      const status = document.getElementById('wizImportStatus');
      status.textContent = `Importiere von ${b.name}…`;
      try {
        const res = await window.electronAPI.browserImport.run({ browser: b.id, types: selectedTypes });
        applyImportResult(res);
        status.textContent = `✓ ${b.name}: ${res.bookmarks} Lesezeichen, ${res.passwords} Passwörter, ${res.history} Verlauf-Einträge`;
        btn.textContent = '✓ Fertig';
      } catch (e) {
        status.textContent = `Fehler: ${e.message}`;
        btn.disabled = false;
        btn.textContent = 'Wiederholen';
      }
    });
    list.appendChild(card);
  });
}

function applyImportResult(res) {
  // Lesezeichen in localStorage schreiben
  if (res.data?.bookmarks?.length > 0) {
    const existing = loadBookmarks();
    const existingUrls = new Set(existing.map(b => b.url));
    const newBm = res.data.bookmarks.filter(b => !existingUrls.has(b.url));
    saveBookmarks([...newBm, ...existing]);
    _wizSummary.bookmarks += newBm.length;
    renderBookmarksBar?.();
  }
  // Verlauf in IndexedDB schreiben
  if (res.data?.history?.length > 0) {
    res.data.history.forEach(h => historyIdbAdd(h.url, h.title, h.ts));
    if (_historyCache) {
      _historyCache.push(...res.data.history);
      _historyCache.sort((a,b) => b.ts - a.ts);
      if (_historyCache.length > 10000) _historyCache.length = 10000;
    }
    _wizSummary.history += res.data.history.length;
  }
  // Passwörter in Vault importieren
  if (res.data?.passwords?.length > 0) {
    res.data.passwords.forEach(pw => {
      window.electronAPI.passwords.save({ site: pw.site, username: pw.username, password: pw.password }).catch(() => {});
    });
    _wizSummary.passwords += res.data.passwords.length;
  }
  if (res.errors?.length > 0) console.warn('[Import]', res.errors);
}

function renderWizardFeatureList() {
  const list = document.getElementById('wizFeatureList');
  if (!list) return;
  list.innerHTML = '';
  ensureFeatureDefaults();
  FEATURE_META.forEach(({ key, icon, label, desc }) => {
    const enabled = cfg.features[key] !== false;
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:.75rem;padding:.5rem .7rem;background:rgba(255,255,255,.03);border-radius:6px;cursor:pointer';
    row.innerHTML = `
      <i data-lucide="${icon}" width="15" height="15" style="flex-shrink:0;color:var(--accent)"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px">${label}</div>
        <div style="font-size:11px;color:var(--muted)">${desc}</div>
      </div>
      <input type="checkbox" data-feat="${key}" ${enabled ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)"/>`;
    row.querySelector('input').addEventListener('change', e => {
      cfg.features[key] = e.target.checked;
    });
    list.appendChild(row);
  });
  if (window.lucide) lucide.createIcons({ nodes: [list] });
}

// Wizard-Schaltflächen verdrahten
document.getElementById('wizBtnStart').addEventListener('click', () => wizGotoStep(1));

document.getElementById('wizSkipImport').addEventListener('click', () => {
  wizGotoStep(2);
  renderWizardFeatureList();
});
document.getElementById('wizNextToFeatures').addEventListener('click', () => {
  wizGotoStep(2);
  renderWizardFeatureList();
});
document.getElementById('wizBackToImport').addEventListener('click', () => wizGotoStep(1));

document.getElementById('wizNextToDone').addEventListener('click', () => {
  saveSettings();
  applyFeatureFlags();
  wizGotoStep(3);
  const s = _wizSummary;
  const lines = [];
  if (s.bookmarks > 0) lines.push(`${s.bookmarks} Lesezeichen importiert`);
  if (s.passwords > 0) lines.push(`${s.passwords} Passwörter importiert`);
  if (s.history   > 0) lines.push(`${s.history} Verlauf-Einträge importiert`);
  const active = FEATURE_META.filter(f => cfg.features[f.key] !== false).length;
  lines.push(`${active} von ${FEATURE_META.length} Features aktiv`);
  document.getElementById('wizSummary').innerHTML = lines.join('<br>');
});

document.getElementById('wizFinish').addEventListener('click', () => {
  saveSettings();
  applyFeatureFlags();
  closeWizard();
});

document.getElementById('wizImportBmHtml').addEventListener('click', async () => {
  const { dialog } = window.electronAPI || {};
  // Datei-Dialog via IPC — benötigt einen eigenen Handler (siehe unten)
  const filePath = await window.electronAPI.openFilePicker({ filters: [{ name: 'HTML', extensions: ['html','htm'] }] });
  if (!filePath) return;
  const status = document.getElementById('wizImportStatus');
  status.textContent = 'Importiere…';
  const res = await window.electronAPI.browserImport.fromFile({ type: 'bookmarks', filePath });
  applyImportResult({ data: { bookmarks: res.data.bookmarks, passwords: [], history: [] }, errors: res.errors });
  status.textContent = `✓ ${res.count} Lesezeichen importiert`;
});

document.getElementById('wizImportPwCsv').addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFilePicker({ filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (!filePath) return;
  const status = document.getElementById('wizImportStatus');
  status.textContent = 'Importiere…';
  const res = await window.electronAPI.browserImport.fromFile({ type: 'passwords', filePath });
  applyImportResult({ data: { bookmarks: [], passwords: res.data.passwords, history: [] }, errors: res.errors });
  status.textContent = `✓ ${res.count} Passwörter importiert`;
});

// ── First-Run-Erkennung ───────────────────────────────────────────────────────
// Muss am Ende des DOMContentLoaded-Handlers aufgerufen werden, NACHDEM
// loadSettings() und applySettings() durchgelaufen sind.
function checkFirstRun() {
  const isFirstRun = !localStorage.getItem('kp-settings-v3');
  if (isFirstRun) {
    // Kurze Verzögerung damit der Browser vollständig initialisiert ist
    setTimeout(showWizard, 300);
  }
}
```

- [ ] **Schritt 4: `openFilePicker` IPC hinzufügen**

Das Wizard braucht einen Datei-Dialog. In `main.js`, in den Import-IPC-Handlern aus Task 4, ergänzen:

```js
ipcMain.handle('dialog:openFile', async (_e, opts = {}) => {
  const result = await dialog.showOpenDialog(mainWin, {
    properties: ['openFile'],
    filters: opts.filters || [],
  });
  return result.canceled ? null : result.filePaths[0];
});
```

In `preload.js`, im `electronAPI`-Objekt, ergänzen:

```js
  openFilePicker: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
```

- [ ] **Schritt 5: `checkFirstRun()` am Ende des Init-Flows aufrufen**

In `index.html` den DOMContentLoaded-Handler suchen (oder den Block wo `loadSettings()` und `applySettings()` aufgerufen werden). `checkFirstRun()` ans Ende anhängen:

```js
// Am Ende des Startup-Codes (nach loadSettings(), historyInit(), applySettings() etc.)
checkFirstRun();
```

- [ ] **Schritt 6: Testen — Wizard beim ersten Start**

```
npm start
```

Öffne DevTools → Console. Wizard-Test simulieren:
```js
localStorage.removeItem('kp-settings-v3'); location.reload();
```
Erwartung: Nach Reload erscheint der Wizard-Overlay mit Willkommens-Screen.

Teste alle 4 Schritte durch:
1. "Los geht's" → Schritt 2 (Import) erscheint, Browser-Erkennungsstatus wird geladen
2. "Überspringen" → Schritt 3 (Features) erscheint mit Toggles
3. Einen Toggle aus- und wieder einschalten
4. "Weiter" → Schritt 4 (Fertig) mit Zusammenfassung
5. "Browser starten" → Wizard schließt sich

Normaler Start (Settings vorhanden): kein Wizard.

- [ ] **Schritt 7: Testen — "Wizard erneut starten" aus den Einstellungen**

```
npm start
```

Einstellungen öffnen → "Features"-Tab → Button "Setup-Wizard erneut starten" klicken.
Erwartung: Einstellungen schließen sich, Wizard öffnet sich.

- [ ] **Schritt 8: Commit**

```bash
git add index.html main.js preload.js
git commit -m "feat: add setup wizard with first-run detection and browser import UI"
```

---

## Abschluss-Check

Nach Abschluss aller Tasks:

- [ ] `npm start` — Browser startet ohne Fehler in der Konsole
- [ ] `localStorage.removeItem('kp-settings-v3'); location.reload()` — Wizard erscheint
- [ ] Wizard durchlaufen, Features togglen, Wizard abschließen — Settings bleiben gespeichert
- [ ] Settings → Features-Tab: Toggles spiegeln den gesetzten Zustand, Live-Updates funktionieren
- [ ] Kontextmenü auf einer Webseite: Eyedropper/Font/Device-Preview verschwinden wenn deaktiviert
- [ ] Toolbar: Passwort-Button, AI-Button, Mikrofon-Button verschwinden wenn deaktiviert
- [ ] `window.electronAPI.browserImport.detect()` gibt installierte Browser zurück
