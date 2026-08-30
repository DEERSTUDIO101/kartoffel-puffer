const { app, BrowserWindow, ipcMain, shell, session, clipboard, dialog, webContents, net, nativeImage } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { autoUpdater } = require('electron-updater');
const vault  = require('./vault.js');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fetch  = require('cross-fetch');
const browserImport = require('./js/browser-import.js');

// Ghostery hängt sich global in app.on('web-contents-created') ein und versucht
// auch in AI-Window-Webviews zu injizieren. Beim Schließen des AI-Fensters feuert
// sein did-stop-loading-Handler auf einem destroying WebContents → V8 fatal crash.
// Patch: executeJavaScript auf jedem WebContents absichern, bevor ghostery es aufruft.
process.setMaxListeners(50);
app.on('web-contents-created', (_e, wc) => {
  const orig = wc.executeJavaScript.bind(wc);
  wc.executeJavaScript = (script, userGesture) => {
    if (wc.isDestroyed()) return Promise.resolve(null);
    return orig(script, userGesture).catch(() => null);
  };
});

// Unbehandelte Promise-Rejections loggen statt crashen
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});

let mainWin = null;
let aiWin   = null;
let aiInitConfig = { providers: [], active: null };

// Nur eine Instanz zulassen: zwei parallel laufende Instanzen teilen sich das
// gleiche userData-Verzeichnis und blockieren sich gegenseitig beim Disk-Cache
// ("Unable to create cache") — die Folge ist, dass jede Seite ungecacht aus dem
// Netz geladen wird und das Surfen spürbar langsamer wird.
// Disk-Cache auf 512 MB setzen (Chromium-Default ist ~80 MB).
app.commandLine.appendSwitch('disk-cache-size', String(512 * 1024 * 1024));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
}

// ── Nativer Adblocker (EasyList + uBlock Origin Filter) ─────────────────────
// Verwendet @ghostery/adblocker-electron — dieselbe Engine wie uBlock Origin,
// aber direkt im Electron-Main-Prozess verankert ohne Erweiterungs-Overhead.
let _blocker = null;
let adBlockEnabled = true;
// Gecachte Filter-Datei im userData-Ordner (verhindert langsamen Netz-Fetch
// bei jedem Start; wird max. einmal täglich aktualisiert).
let _adBlockCachePath = null;

async function initAdBlocker(kpSession, userDataPath) {
  _adBlockCachePath = path.join(userDataPath, 'adblocker-filters.bin');
  const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 Tag
  let cacheValid = false;
  try {
    const stat = fs.statSync(_adBlockCachePath);
    cacheValid = (Date.now() - stat.mtimeMs) < CACHE_MAX_AGE_MS;
  } catch {}

  try {
    if (cacheValid) {
      console.log('[adblocker] Lade Filter aus Cache …');
      const buf = fs.readFileSync(_adBlockCachePath);
      _blocker = ElectronBlocker.deserialize(new Uint8Array(buf));
    } else {
      console.log('[adblocker] Lade Filter vom Netz (EasyList + uBlock) …');
      _blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
      // Serialisieren für schnellen Start beim nächsten Mal
      try { fs.writeFileSync(_adBlockCachePath, Buffer.from(_blocker.serialize())); } catch {}
      console.log('[adblocker] Filter geladen und gecacht.');
    }
    if (adBlockEnabled) _blocker.enableBlockingInSession(kpSession);
    console.log('[adblocker] Aktiv – blockiert Werbung & Tracker.');
  } catch (err) {
    console.error('[adblocker] Initialisierung fehlgeschlagen:', err?.message || err);
  }
}


// ── Downloads-Manager ────────────────────────────────────────────────────────
let downloadIdCounter = 0;
const downloads = []; // { id, filename, path, url, totalBytes, receivedBytes, state }
let _dlHistoryPath = null;
const MAX_DL_HISTORY = 50;

function saveDownloadsHistory() {
  if (!_dlHistoryPath) return;
  const finished = downloads.filter(d => d.state !== 'progressing').slice(0, MAX_DL_HISTORY);
  try { fs.writeFileSync(_dlHistoryPath, JSON.stringify(finished), 'utf8'); } catch {}
}
function loadDownloadsHistory(userDataPath) {
  _dlHistoryPath = path.join(userDataPath, 'downloads-history.json');
  try {
    const saved = JSON.parse(fs.readFileSync(_dlHistoryPath, 'utf8'));
    if (Array.isArray(saved)) {
      saved.forEach(d => { downloads.push(d); if (d.id >= downloadIdCounter) downloadIdCounter = d.id; });
    }
  } catch {}
}

function sendDownloadsUpdate() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('downloads-update', downloads);
}
function setupDownloads(ses) {
  ses.on('will-download', (event, item) => {
    const id = ++downloadIdCounter;
    const entry = {
      id, filename: item.getFilename(), path: item.getSavePath() || '',
      url: item.getURL(), totalBytes: item.getTotalBytes(), receivedBytes: 0, state: 'progressing',
    };
    downloads.unshift(entry);
    sendDownloadsUpdate();
    item.on('updated', (_e, state) => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      entry.path = item.getSavePath();
      entry.state = state;
      sendDownloadsUpdate();
    });
    item.once('done', (_e, state) => {
      entry.state = state;
      entry.path = item.getSavePath();
      sendDownloadsUpdate();
      saveDownloadsHistory();
    });
  });
}

// ── Erweiterungen (Chrome-Extensions über Electrons native Extension-Engine) ──
// Kein eigener chrome.*-Polyfill nötig: session.loadExtension() nutzt dieselbe
// Extension-Implementierung wie Chrome (MV2 vollständig, MV3 weitgehend).
// Registry-Key ist der absolute Ordnerpfad — Electron leitet die Extension-ID
// bei unpacked Extensions ohne "key" daraus ab, der Pfad ist also stabil.
const extRegistry = new Map(); // key -> { key, dir, manifest, builtin, id, error }
let extDisabled   = new Set();
let _extStatePath = null;
let _extUserDir   = null;      // Zielordner für Installationen (in userData)

function extInit(userDataPath) {
  _extStatePath = path.join(userDataPath, 'extensions-state.json');
  _extUserDir   = path.join(userDataPath, 'extensions');
  try { fs.mkdirSync(_extUserDir, { recursive: true }); } catch {}
  try {
    const s = JSON.parse(fs.readFileSync(_extStatePath, 'utf8'));
    if (Array.isArray(s.disabled)) extDisabled = new Set(s.disabled);
  } catch {}
}
function extStateSave() {
  if (!_extStatePath) return;
  try { fs.writeFileSync(_extStatePath, JSON.stringify({ disabled: [...extDisabled] }), 'utf8'); } catch {}
}

// Lokalisierte Manifest-Felder ("__MSG_extName__") aus _locales auflösen
function extResolveMsg(dir, manifest, value) {
  if (typeof value !== 'string' || !value.startsWith('__MSG_')) return value || '';
  const msgKey = value.slice(6, -2);
  for (const loc of [manifest.default_locale || 'en', 'en', 'de']) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
      const hit = msgs[msgKey] || msgs[Object.keys(msgs).find(k => k.toLowerCase() === msgKey.toLowerCase())];
      if (hit && hit.message) return hit.message;
    } catch {}
  }
  return msgKey;
}

// Toolbar-Icon als data:-URL (chrome-extension:// ist aus dem Host-Renderer
// heraus nicht ladbar — der läuft über file:// in einer anderen Session).
function extPickIcon(dir, manifest) {
  const act = manifest.action || manifest.browser_action || {};
  let best = null, bestSize = -1;
  for (const set of [act.default_icon, manifest.icons].filter(Boolean)) {
    if (typeof set === 'string') { if (bestSize < 0) { best = set; bestSize = 0; } continue; }
    for (const [size, rel] of Object.entries(set)) {
      const n = parseInt(size, 10) || 0;
      if (n > bestSize && n <= 128) { best = rel; bestSize = n; }
    }
  }
  if (!best) return null;
  try {
    const p    = path.join(dir, best);
    const ext  = path.extname(p).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch { return null; }
}

function extScanDirs() {
  const roots = [
    { dir: path.join(__dirname, 'extensions', 'user'), builtin: false },
    { dir: _extUserDir,                                builtin: false },
  ];
  const found = [], seen = new Set();
  for (const root of roots) {
    if (!root.dir) continue;
    let candidates;
    if (root.direct) candidates = [root.dir];
    else {
      try { candidates = fs.readdirSync(root.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root.dir, d.name)); }
      catch { candidates = []; }
    }
    for (const dir of candidates) {
      const key = path.resolve(dir);
      if (seen.has(key)) continue;
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
      seen.add(key);
      found.push({ key, dir, manifest, builtin: root.builtin });
    }
  }
  return found;
}

async function extLoadOne(ses, key) {
  const rec = extRegistry.get(key);
  if (!rec || rec.id) return !!rec?.id;
  try {
    const ext = await ses.loadExtension(rec.dir, { allowFileAccess: true });
    rec.id = ext.id; rec.error = null;
    console.log('[ext] geladen:', ext.name, ext.version, ext.id);
    return true;
  } catch (err) {
    rec.error = String(err?.message || err);
    console.error('[ext] Laden fehlgeschlagen:', rec.dir, rec.error);
    return false;
  }
}
async function extLoadAll(ses) {
  for (const e of extScanDirs()) {
    if (!extRegistry.has(e.key)) extRegistry.set(e.key, { ...e, id: null, error: null });
    if (!extDisabled.has(e.key)) await extLoadOne(ses, e.key);
  }
}
function extList() {
  return [...extRegistry.values()].map(r => {
    const act = r.manifest.action || r.manifest.browser_action || {};
    return {
      key: r.key,
      id: r.id,
      name:        extResolveMsg(r.dir, r.manifest, r.manifest.name) || path.basename(r.dir),
      description: extResolveMsg(r.dir, r.manifest, r.manifest.description),
      title:       extResolveMsg(r.dir, r.manifest, act.default_title || r.manifest.name),
      version: r.manifest.version || '',
      icon:    extPickIcon(r.dir, r.manifest),
      popup:   act.default_popup || null,
      optionsPage: (r.manifest.options_ui && r.manifest.options_ui.page) || r.manifest.options_page || null,
      enabled: !extDisabled.has(r.key) && !!r.id,
      builtin: r.builtin,
      error:   r.error,
    };
  });
}
function sendExtensionsUpdate() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const wc = mainWin.webContents;
  // Der Start-Ladevorgang der Erweiterungen ist oft schneller fertig als der
  // Renderer — ohne diese Prüfung feuert send() in ein noch nicht existierendes
  // Render-Frame ("Render frame was disposed before WebFrameMain could be accessed").
  if (wc.isLoadingMainFrame()) {
    wc.once('did-finish-load', () => { try { wc.send('extensions-update', extList()); } catch {} });
    return;
  }
  try { wc.send('extensions-update', extList()); } catch {}
}

// Popup einer Erweiterung (browser_action/action default_popup) in einem
// eigenen, rahmenlosen Fenster öffnen — Electron rendert das nicht selbst.
let extPopupWin = null;
function extOpenPopup(key, anchor) {
  const rec = extRegistry.get(key);
  if (!rec || !rec.id) return;
  const act = rec.manifest.action || rec.manifest.browser_action || {};
  if (!act.default_popup) return;
  if (extPopupWin && !extPopupWin.isDestroyed()) { extPopupWin.close(); extPopupWin = null; }

  const bounds = (mainWin && !mainWin.isDestroyed()) ? mainWin.getContentBounds() : { x: 0, y: 0 };
  extPopupWin = new BrowserWindow({
    width: 400, height: 500,
    x: Math.round(bounds.x + (anchor?.x ?? 0) - 380),
    y: Math.round(bounds.y + (anchor?.y ?? 0)),
    frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#ffffff',
    webPreferences: { session: session.fromPartition('persist:kp'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  extPopupWin.loadURL(`chrome-extension://${rec.id}/${act.default_popup}`);
  extPopupWin.on('blur',   () => { if (extPopupWin && !extPopupWin.isDestroyed()) extPopupWin.close(); });
  extPopupWin.on('closed', () => { extPopupWin = null; });
  // Popups definieren ihre Größe per CSS und erwarten, dass der Browser sich
  // an den Inhalt anpasst → nach dem Laden ausmessen und nachziehen.
  extPopupWin.webContents.on('did-finish-load', async () => {
    try {
      const size = await extPopupWin.webContents.executeJavaScript(
        '({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})'
      );
      const w = Math.max(180, Math.min(800, Math.ceil(size.w)));
      const h = Math.max(100, Math.min(700, Math.ceil(size.h)));
      if (extPopupWin && !extPopupWin.isDestroyed()) {
        extPopupWin.setContentSize(w, h);
        extPopupWin.setPosition(Math.round(bounds.x + (anchor?.x ?? 0) - w + 20), Math.round(bounds.y + (anchor?.y ?? 0)));
      }
    } catch {}
  });
}

// ── Berechtigungen ────────────────────────────────────────────────────────────
// Ohne Handler erteilt Electron JEDE Berechtigung automatisch (verifiziert:
// Notification.requestPermission() -> "granted" ohne Nachfrage). Deshalb hier
// explizit: harmlose Dinge automatisch, alles Sensible nur nach Rückfrage.
const PERM_AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'background-sync']);
const PERM_LABELS = {
  media:              'Kamera und/oder Mikrofon',
  geolocation:        'deinen Standort',
  notifications:      'Benachrichtigungen zu senden',
  'clipboard-read':   'deine Zwischenablage zu lesen',
  'display-capture':  'deinen Bildschirm aufzunehmen',
  midi:               'MIDI-Geräte',
  midiSysex:          'MIDI-Geräte (SysEx)',
  hid:                'HID-Geräte',
  serial:             'serielle Geräte',
  usb:                'USB-Geräte',
  'idle-detection':   'zu erkennen, ob du inaktiv bist',
  'window-management':'deine Fenster zu verwalten',
};
let permDecisions = {};        // "origin|permission" -> true/false  (Ausnahmen pro Website)
let permDefaults  = {};        // permission -> 'ask' | 'allow' | 'block'  (Standardregel)
let _permPath = null, _permSeq = 0;
const _permPending = new Map();

function permInit(userDataPath) {
  _permPath = path.join(userDataPath, 'permissions.json');
  try {
    const raw = JSON.parse(fs.readFileSync(_permPath, 'utf8')) || {};
    if (raw.version >= 2) {
      permDecisions = raw.sites    || {};
      permDefaults  = raw.defaults || {};
    } else {
      // Altes Format war eine flache Map "origin|permission" -> bool
      permDecisions = raw; permDefaults = {};
    }
  } catch { permDecisions = {}; permDefaults = {}; }
}
function permSave() {
  try { fs.writeFileSync(_permPath, JSON.stringify({ version: 2, defaults: permDefaults, sites: permDecisions }), 'utf8'); } catch {}
}
function originOf(url) { try { return new URL(url).origin; } catch { return url || ''; } }

function setupPermissions(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (PERM_AUTO_ALLOW.has(permission)) return callback(true);
    const origin = originOf(details?.requestingUrl || wc?.getURL?.() || '');
    const key = origin + '|' + permission;
    // Reihenfolge wie in Chrome: Ausnahme der Website schlägt die Standardregel
    if (key in permDecisions) return callback(permDecisions[key]);
    const def = permDefaults[permission];
    if (def === 'block') return callback(false);
    if (def === 'allow') return callback(true);
    if (!mainWin || mainWin.isDestroyed()) return callback(false);
    const id = ++_permSeq;
    _permPending.set(id, { callback, key });
    mainWin.webContents.send('permission-request', {
      id, origin, permission, label: PERM_LABELS[permission] || permission,
    });
  });
  // Synchroner Pfad (navigator.permissions.query u.ä.): niemals raten —
  // nur was ausdrücklich erlaubt wurde, gilt als erlaubt.
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (PERM_AUTO_ALLOW.has(permission)) return true;
    const key = originOf(requestingOrigin) + '|' + permission;
    if (key in permDecisions) return permDecisions[key];
    return permDefaults[permission] === 'allow';
  });
}

ipcMain.on('permission-response', (_e, id, allow) => {
  const p = _permPending.get(id);
  if (!p) return;
  _permPending.delete(id);
  permDecisions[p.key] = !!allow;
  permSave();
  try { p.callback(!!allow); } catch {}
});
ipcMain.handle('permissions:list',  () => ({ sites: permDecisions, defaults: permDefaults, labels: PERM_LABELS }));
ipcMain.handle('permissions:reset', () => { permDecisions = {}; permDefaults = {}; permSave(); return true; });
// Einzelne Website-Ausnahme setzen (true/false) oder mit null wieder entfernen
ipcMain.handle('permissions:set', (_e, key, value) => {
  if (value === null) delete permDecisions[key]; else permDecisions[key] = !!value;
  permSave();
  return { sites: permDecisions, defaults: permDefaults, labels: PERM_LABELS };
});
ipcMain.handle('permissions:setDefault', (_e, permission, mode) => {
  if (mode === 'ask') delete permDefaults[permission]; else permDefaults[permission] = mode;
  permSave();
  return { sites: permDecisions, defaults: permDefaults, labels: PERM_LABELS };
});

// ── IPC: Browserdaten löschen ─────────────────────────────────────────────────
// Wichtig: das bisherige "Verlauf löschen" leerte nur die localStorage-Liste
// der App — Cookies, Cache und Website-Daten der besuchten Seiten blieben.
ipcMain.handle('data:clear', async (_e, opts = {}) => {
  const ses = session.fromPartition('persist:kp');
  const cleared = [];
  try {
    if (opts.cache)   { await ses.clearCache(); cleared.push('Cache'); }
    if (opts.cookies) { await ses.clearStorageData({ storages: ['cookies'] }); cleared.push('Cookies'); }
    if (opts.storage) {
      await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'] });
      cleared.push('Website-Daten');
    }
    if (opts.cookies || opts.storage) { try { await ses.clearAuthCache(); } catch {} }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  return { ok: true, cleared };
});

// ── Window factory ────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 640,
    backgroundColor: '#0b0f14',
    title: 'Kartoffel Puffer',
    icon: path.join(__dirname, 'icons', 'Logo_kartoffelPuffer_lightmode.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWin.on('closed', () => {
    mainWin = null;
    if (aiWin && !aiWin.isDestroyed()) { aiWin.close(); aiWin = null; }
  });
}

function createAiWindow(opts = {}) {
  aiInitConfig = { providers: opts.providers || [], active: opts.active || null };
  if (aiWin && !aiWin.isDestroyed()) { aiWin.focus(); return; }

  // Figure out position: right of main window if possible
  let x = opts.x, y = opts.y;
  if (x == null && mainWin && !mainWin.isDestroyed()) {
    const [wx, wy] = mainWin.getPosition();
    const [ww]     = mainWin.getSize();
    x = wx + ww + 8;
    y = wy;
  }

  aiWin = new BrowserWindow({
    width:  opts.width  || 450,
    height: opts.height || 640,
    x, y,
    minWidth:  320,
    minHeight: 400,
    alwaysOnTop: true,
    resizable:   true,
    skipTaskbar: false,
    title: 'KP – AI Assistent',
    icon: path.join(__dirname, 'icons', 'Logo_kartoffelPuffer_lightmode.png'),
    frame: false,
    transparent: false,
    backgroundColor: '#13181f',
    webPreferences: {
      preload: path.join(__dirname, 'preload-ai.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  aiWin.loadFile(path.join(__dirname, 'ai-window.html'));
  aiWin.on('closed', () => {
    aiWin = null;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('ai-window-closed');
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // Zweitinstanz beendet sich selbst

  const kpSession = session.fromPartition('persist:kp');
  const userData = app.getPath('userData');

  loadDownloadsHistory(userData);
  setupDownloads(kpSession);
  vault.init(userData);
  extInit(userData);
  permInit(userData);
  setupPermissions(kpSession);
  createMainWindow();
  extLoadAll(kpSession).then(sendExtensionsUpdate);

  // Adblocker asynchron initialisieren (Netz-Fetch passiert im Hintergrund,
  // der Browser ist dadurch sofort nutzbar und blockiert dann ab dem Moment,
  // wo die Filter geladen sind – meist innerhalb von Sekunden).
  initAdBlocker(kpSession, userData);

  // Auto-Update-Check nur im fertigen Build, nicht beim lokalen npm start
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    const sendStatus = (status, data) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-status', { status, ...data });
    };
    autoUpdater.on('checking-for-update', () => sendStatus('checking'));
    autoUpdater.on('update-available',    (info) => sendStatus('available', { version: info.version }));
    autoUpdater.on('update-not-available',() => sendStatus('not-available'));
    autoUpdater.on('download-progress',   (p) => sendStatus('downloading', { percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded',   () => {
      sendStatus('downloaded');
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-ready');
    });
    autoUpdater.on('error', (err) => sendStatus('error', { message: String(err?.message || err) }));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
});

ipcMain.on('update-install', () => autoUpdater.quitAndInstall());
ipcMain.on('update-check',   () => autoUpdater.checkForUpdates().catch(() => {}));

// Adblocker ein-/ausschalten
ipcMain.on('set-ad-block', (_e, enabled) => {
  adBlockEnabled = !!enabled;
  const kpSession = session.fromPartition('persist:kp');
  if (_blocker) {
    if (adBlockEnabled) _blocker.enableBlockingInSession(kpSession);
    else _blocker.disableBlockingInSession(kpSession);
  }
});
ipcMain.handle('get-ad-block', () => adBlockEnabled);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

// ── IPC: main window controls ─────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWin?.minimize());
ipcMain.on('win-maximize', () => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
ipcMain.on('win-close',    () => mainWin?.close());
ipcMain.on('win-fullscreen', () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.setFullScreen(!mainWin.isFullScreen());
});

// ── IPC: AI window ────────────────────────────────────────────────────────────
ipcMain.on('ai-window-open',     (_e, opts)  => createAiWindow(opts || {}));
ipcMain.on('ai-window-close',    ()           => { if (aiWin && !aiWin.isDestroyed()) aiWin.close(); });
ipcMain.on('ai-window-minimize', ()           => aiWin?.minimize());
ipcMain.on('ai-win-drag',        (_e, {dx,dy}) => {
  if (!aiWin || aiWin.isDestroyed()) return;
  const [x,y] = aiWin.getPosition();
  aiWin.setPosition(x + dx, y + dy);
});

// Push current-tab context to AI window whenever it changes
ipcMain.on('ai-context-update', (_e, ctx) => {
  if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('browser-context', ctx);
});

// AI window requests its init config (enabled providers + active tab)
ipcMain.handle('ai-get-init-config', () => aiInitConfig);

// AI window requests latest context
ipcMain.handle('ai-get-context', async () => {
  if (!mainWin || mainWin.isDestroyed()) return null;
  try {
    const raw = await mainWin.webContents.executeJavaScript(
      'window.__kpCurrentContext ? JSON.stringify(window.__kpCurrentContext) : null'
    );
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
});

// AI window wants to open a URL in the browser
ipcMain.on('ai-open-url', (_e, url) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('open-url-from-ai', url);
    mainWin.focus();
  }
});

// ── IPC: clipboard ────────────────────────────────────────────────────────────
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('clipboard:read',  ()          => clipboard.readText());

// ── IPC: passwords (verschlüsselter Tresor via vault.js) ───────────────────────
ipcMain.handle('passwords:isSetup',  () => vault.isSetup());
ipcMain.handle('passwords:isLocked', () => vault.isLocked());
ipcMain.handle('passwords:setup',    (_e, pw) => vault.setup(pw));
ipcMain.handle('passwords:unlock',   (_e, pw) => vault.unlock(pw));
ipcMain.handle('passwords:lock',     () => vault.lock());
ipcMain.handle('passwords:list',     () => vault.list());
ipcMain.handle('passwords:save',     (_e, entry) => vault.save(entry));
ipcMain.handle('passwords:get',      (_e, site) => vault.get(site));
ipcMain.handle('passwords:delete',   (_e, site, username) => vault.remove(site, username));

// ── IPC: shell ────────────────────────────────────────────────────────────────
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));

// ── IPC: Downloads ────────────────────────────────────────────────────────────
ipcMain.handle('downloads:list', () => downloads);
ipcMain.handle('downloads:openFile', (_e, id) => {
  const d = downloads.find(x => x.id === id);
  if (d && d.path) shell.openPath(d.path);
});
ipcMain.handle('downloads:showInFolder', (_e, id) => {
  const d = downloads.find(x => x.id === id);
  if (d && d.path) shell.showItemInFolder(d.path);
});
ipcMain.handle('downloads:clear', () => {
  downloads.length = 0;
  saveDownloadsHistory();
  sendDownloadsUpdate();
});
ipcMain.handle('downloads:url', (_e, url) => {
  try { session.fromPartition('persist:kp').downloadURL(url); } catch {}
});

// ── IPC: Bild kopieren ─────────────────────────────────────────────────────────
// Läuft im Main-Prozess statt per fetch() im Renderer, weil ein Renderer-fetch()
// über file:// als Origin bei den meisten Seiten an CORS scheitert (Bilder ohne
// Access-Control-Allow-Origin-Header). net.request unterliegt keiner CORS-Prüfung.
ipcMain.handle('image:copy', async (_e, url) => {
  try {
    const buffer = await new Promise((resolve, reject) => {
      const req = net.request({ url, session: session.fromPartition('persist:kp') });
      const chunks = [];
      req.on('response', res => {
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
  } catch {
    return false;
  }
});

// ── IPC: Erweiterungen ─────────────────────────────────────────────────────────
ipcMain.handle('ext:list', () => extList());

ipcMain.handle('ext:popup', (_e, key, anchor) => { extOpenPopup(key, anchor); });

ipcMain.handle('ext:toggle', async (_e, key, enabled) => {
  const rec = extRegistry.get(key);
  if (!rec) return extList();
  const ses = session.fromPartition('persist:kp');
  if (enabled) {
    extDisabled.delete(key);
    await extLoadOne(ses, key);
  } else {
    extDisabled.add(key);
    if (rec.id) { try { ses.removeExtension(rec.id); } catch {} rec.id = null; }
  }
  extStateSave();
  sendExtensionsUpdate();
  return extList();
});

// Entpackte Erweiterung aus einem Ordner installieren (wie Chromes
// "Entpackte Erweiterung laden"). Der Ordner wird nach userData kopiert,
// damit die Erweiterung ein App-Update übersteht.
ipcMain.handle('ext:install', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    title: 'Entpackte Erweiterung auswählen (Ordner mit manifest.json)',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths?.[0]) return { ok: false, cancelled: true };
  const src = filePaths[0];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')); }
  catch { return { ok: false, error: 'Kein gültiges manifest.json in diesem Ordner gefunden.' }; }

  const safeName = (manifest.name || path.basename(src)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  let dest = path.join(_extUserDir, safeName);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(_extUserDir, `${safeName}-${n++}`);
  try { fs.cpSync(src, dest, { recursive: true }); }
  catch (err) { return { ok: false, error: 'Kopieren fehlgeschlagen: ' + String(err?.message || err) }; }

  const key = path.resolve(dest);
  extRegistry.set(key, { key, dir: dest, manifest, builtin: false, id: null, error: null });
  const ok = await extLoadOne(session.fromPartition('persist:kp'), key);
  sendExtensionsUpdate();
  return { ok, name: extResolveMsg(dest, manifest, manifest.name), error: extRegistry.get(key)?.error || null };
});

ipcMain.handle('ext:remove', (_e, key) => {
  const rec = extRegistry.get(key);
  if (!rec || rec.builtin) return { ok: false, error: 'Diese Erweiterung ist mitgeliefert und kann nicht entfernt werden.' };
  if (rec.id) { try { session.fromPartition('persist:kp').removeExtension(rec.id); } catch {} }
  // Nur löschen, was auch wirklich im Nutzer-Verzeichnis liegt
  if (_extUserDir && path.resolve(rec.dir).startsWith(path.resolve(_extUserDir))) {
    try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch {}
  }
  extRegistry.delete(key);
  extDisabled.delete(key);
  extStateSave();
  sendExtensionsUpdate();
  return { ok: true };
});

ipcMain.handle('ext:openFolder', (_e, key) => {
  const rec = extRegistry.get(key);
  if (rec) shell.openPath(rec.dir);
});

// ── IPC: Bildschirmfoto der Seite ──────────────────────────────────────────────
ipcMain.handle('page:screenshot', async (_e, wcId) => {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return { ok: false };
  let img;
  try { img = await wc.capturePage(); } catch { return { ok: false, error: 'Aufnahme fehlgeschlagen.' }; }
  const title = (wc.getTitle() || 'bildschirmfoto').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 60);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    defaultPath: title + '.png',
    filters: [{ name: 'PNG-Bild', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  try { fs.writeFileSync(filePath, img.toPNG()); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ── IPC: Seite speichern ───────────────────────────────────────────────────────
ipcMain.handle('page:save', async (_e, wcId) => {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;
  const title = (wc.getTitle() || 'seite').replace(/[/\\?%*:|"<>]/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    defaultPath: title + '.html',
    filters: [
      { name: 'Webseite (vollständig)', extensions: ['html'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });
  if (!canceled && filePath) wc.savePage(filePath, 'HTMLComplete').catch(() => {});
});

// ── IPC: Browser-Import ───────────────────────────────────────────────────────
ipcMain.handle('import:detectBrowsers', () => {
  return browserImport.detectBrowsers();
});

ipcMain.handle('import:run', async (_e, args) => {
  const result = browserImport.runImport(args);
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

ipcMain.handle('dialog:openFile', async (_e, opts = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    properties: ['openFile'],
    ...opts,
  });
  return canceled || !filePaths?.[0] ? null : filePaths[0];
});
