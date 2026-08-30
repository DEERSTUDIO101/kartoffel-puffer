// ── STORAGE ───────────────────────────────────────────────────────────────────
// Reine Daten-Schicht: kein DOM, keine Tab-Referenzen.
// Alle Funktionen hier arbeiten nur mit localStorage und dem cfg-Objekt.

const SETTINGS_KEY  = 'kp-settings-v3';
const BOOKMARKS_KEY = 'kp-bookmarks-v1';
const HISTORY_KEY   = 'kp-history-v1';
const SESSION_KEY   = 'kp-session-v1';

const defaultSettings = {
  theme:'dark', accentColor:'#ff9f1c', accent2Color:'#4cc9f0', dangerColor:'#ff5c7a',
  panelColor:'#0d1520', textColor:'#ecf2f8', borderRadius:12, panelOpacity:92, toolbarOpacity:92,
  bgType:'color', bgColor:'#070b10', bgGrad1:'#132033', bgGrad2:'#070b10',
  bgGradDir:'to bottom', bgImageUrl:'', bgSize:'cover', bgPos:'center', bgSolid:'#000000',
  toolbarPos:'top', tabPos:'top', tabStyle:'modern',
  showBackFwd:true, showReload:true, showHome:true, showBadge:true,
  showHistoryBtn:true, showPwBtn:true, showAiBtn:true,
  browserName:'Kartoffel Puffer', browserSubtitle:'Dein Browser. Deine Regeln.',
  homeUrl:'newtab', searchEngine:'https://www.google.com/search?q=', customSearchUrl:'', restoreSession:true,
  uiLang:'de',
  quickLinks:[
    { label:'Google',    url:'https://www.google.com' },
    { label:'YouTube',   url:'https://www.youtube.com' },
    { label:'Wikipedia', url:'https://www.wikipedia.org' },
  ],
  adblock:true, trackerblock:true, autofill:true, askSave:true, saveHistory:true, clearCookies:false,
  fontFamily:'Inter, system-ui, sans-serif', customFont:'', fontSize:'15px',
  allowPopups:true, enableJS:true, loadImages:true,
  aiSidebarPos:'right', aiSidebarWidth:360,
  aiEnabledProviders:['claude','chatgpt','gemini','perplexity','copilot','grok','deepseek','mistral'],
  aiAutoCtx:false, aiActiveProvider:'claude',
  speechApiKey:'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',
  tabBarPos:'top', navButtonOrder:[], navButtonHidden:[],
};
let cfg = { ...defaultSettings };
function loadSettings()  { try { const r = localStorage.getItem(SETTINGS_KEY); if(r) cfg = {...defaultSettings,...JSON.parse(r)}; } catch{} }
function saveSettings()  { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); }

// ── BOOKMARKS (Daten) ─────────────────────────────────────────────────────────
// In-Memory-Cache: _bookmarkSet für O(1)-isBookmarked, _bookmarkCache für Render.
// Vorher: loadBookmarks() parste JSON bei JEDEM Aufruf (inkl. jedem Tab-Wechsel).
let _bookmarkCache = null;
let _bookmarkSet   = null;

function loadBookmarks() {
  if (_bookmarkCache) return _bookmarkCache;
  try { _bookmarkCache = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]'); }
  catch { _bookmarkCache = []; }
  _bookmarkSet = new Set(_bookmarkCache.map(b => b.url));
  return _bookmarkCache;
}
function saveBookmarks(b) {
  _bookmarkCache = b;
  _bookmarkSet   = new Set(b.map(x => x.url));
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(b));
}
function isBookmarked(url) {
  if (!_bookmarkSet) loadBookmarks();
  return _bookmarkSet.has(url); // O(1) statt O(n) JSON-Parse
}

// ── HISTORY (Daten) ───────────────────────────────────────────────────────────
// RAM-Cache + IndexedDB-Backend (js/idb.js).
// Reads: immer synchron aus _historyCache (sofort nach Init verfügbar).
// Writes: sofort im RAM, async ins IDB — kein Main-Thread-Blocking.
let _historyCache = null;

function loadHistory() { return _historyCache || []; }

// Wird einmal beim Start aufgerufen (async), danach sind alle Reads sync.
async function historyInit() {
  const legacy = (() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  })();
  _historyCache = await historyIdbInit(legacy);
  // Legacy-Daten nach erfolgter Migration aus localStorage entfernen
  if (legacy.length > 0 && _historyCache.length > 0) {
    try { localStorage.removeItem(HISTORY_KEY); } catch {}
  }
}

function addToHistory(url, title) {
  if (!cfg.saveHistory || !url || url === 'newtab') return;
  const ts    = Date.now();
  const entry = { url, title: title || url, ts };
  if (!_historyCache) _historyCache = [];
  // Dedup im RAM: bestehenden Eintrag gleicher URL entfernen, neuen vorne einfügen
  const idx = _historyCache.findIndex(e => e.url === url);
  if (idx !== -1) _historyCache.splice(idx, 1);
  _historyCache.unshift(entry);
  if (_historyCache.length > 10000) _historyCache.length = 10000;
  historyIdbAdd(url, title, ts); // async, fire-and-forget
}

function deleteHistoryEntry(ts, url) {
  if (_historyCache) {
    const i = _historyCache.findIndex(e => e.ts === ts && e.url === url);
    if (i !== -1) _historyCache.splice(i, 1);
  }
  historyIdbDelete(ts, url);
}

function clearHistory() {
  _historyCache = [];
  historyIdbClear();
}

// Compat-Shim: alter Code der saveHistory([]) aufruft wird weitergeleitet
function saveHistory(h) {
  if (Array.isArray(h) && h.length === 0) { clearHistory(); return; }
  // Vollständiges Array-Replace (nur noch für Edge-Cases nötig)
  _historyCache = h.slice(0, 10000);
  historyIdbClear();
  h.forEach(e => historyIdbAdd(e.url, e.title, e.ts));
}

// ── SESSION ───────────────────────────────────────────────────────────────────
function loadSessionTabs() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '[]'); } catch { return []; }
}
