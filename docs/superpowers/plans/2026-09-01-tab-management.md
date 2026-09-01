# Tab-Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab-Gruppen (Rechtsklick + Drag-and-Drop), automatisches Session-Restore mit Gruppen, und Tab-Suche (Ctrl+Shift+A).

**Architecture:** Alle Tab-Daten (inkl. `groupId`) leben im bestehenden `tabs`-Array in `js/tabs.js`. Gruppen werden in einem neuen `groups`-Array daneben verwaltet. Session-Speicherung in `js/storage.js` wird von einem flachen URL-Array auf ein strukturiertes Objekt erweitert (mit Backward-Compat). Die Tab-Suche ist ein reines Renderer-Overlay ohne IPC.

**Tech Stack:** Vanilla JS, CSS Custom Properties, localStorage, HTML5 Drag-and-Drop API.

## Global Constraints

- Kein Build-Step, kein Bundler — nur plain JS/CSS.
- Alle neuen Funktionen folgen dem bestehenden Stil (kurze Variablen, minifizierte Inline-Styles wo schon vorhanden).
- `SESSION_KEY = 'kp-session-v1'` bleibt — Format-Upgrade mit Backward-Compat.
- `js/storage.js` enthält nur Datenfunktionen (kein DOM).
- `js/tabs.js` enthält Tab-State und Tab-UI.
- CSS für neue Komponenten kommt in den `<style>`-Block in `index.html`.

---

### Task 1: Storage — Gruppen-Funktionen und Session-Format upgraden

**Files:**
- Modify: `js/storage.js`

**Interfaces:**
- Produces:
  - `loadGroups() → Array<{id:string, name:string, color:string}>`
  - `saveGroups(groups: Array) → void`
  - `saveSession(tabs: Array, groups: Array) → void` (ersetzt `saveSessionTabs()` extern — `saveSessionTabs()` in tabs.js ruft das intern auf)
  - `loadSession() → { tabs: Array<{url:string, title:string, groupId:string|null}>, groups: Array, activeIndex: number }`

- [ ] **Schritt 1: Gruppen-Konstante und Lade-/Speicher-Funktionen hinzufügen**

Am Ende von `js/storage.js`, direkt nach der `loadSessionTabs()`-Funktion, einfügen:

```js
const GROUPS_KEY = 'kp-tab-groups-v1';

function loadGroups() {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); } catch { return []; }
}
function saveGroups(groups) {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
}

// Speichert vollständige Session: Tab-Objekte + Gruppen-Array + aktiver Index.
// Ersetzt das alte flache URL-Array; loadSession() versteht beide Formate.
function saveSession(tabsArr, groupsArr, activeIdx) {
  const data = {
    tabs: tabsArr.filter(t => !t.incognito && !t.isNewTab && t.url).map(t => ({
      url: t.url, title: t.title || t.url, groupId: t.groupId || null
    })),
    groups: groupsArr || [],
    activeIndex: activeIdx || 0,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

// Liest Session zurück. Versteht altes Format (flaches Array) und neues (Objekt).
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { tabs: [], groups: [], activeIndex: 0 };
    const parsed = JSON.parse(raw);
    // Altes Format: flaches URL-Array
    if (Array.isArray(parsed)) {
      return { tabs: parsed.map(url => ({ url, title: url, groupId: null })), groups: [], activeIndex: 0 };
    }
    return {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      activeIndex: typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0,
    };
  } catch { return { tabs: [], groups: [], activeIndex: 0 }; }
}
```

- [ ] **Schritt 2: Testen**

Chromium DevTools Console in der App (`npm start` → F12 im Hauptfenster):

```js
saveGroups([{id:'g1', name:'Test', color:'#4f8ef7'}]);
console.log(loadGroups()); // → [{id:'g1', name:'Test', color:'#4f8ef7'}]
saveSession([{url:'https://google.com', title:'Google', groupId:'g1', incognito:false, isNewTab:false}], [{id:'g1', name:'Test', color:'#4f8ef7'}], 0);
console.log(loadSession()); // → {tabs:[{url:...,groupId:'g1'}], groups:[...], activeIndex:0}
```

- [ ] **Schritt 3: Commit**

```bash
git add js/storage.js
git commit -m "feat: add group storage and structured session format to storage.js"
```

---

### Task 2: Tab-State um Gruppen erweitern und Session-Restore aktualisieren

**Files:**
- Modify: `js/tabs.js` (Zeilen 2, 433–438, 464–469, 2164–2166 in `index.html`)
- Modify: `index.html` (Init-Block am Ende)

**Interfaces:**
- Consumes: `loadSession()`, `saveSession()`, `loadGroups()`, `saveGroups()` aus Task 1
- Produces:
  - `groups` Array (global in tabs.js, sichtbar für alle tab-Funktionen)
  - Tab-Objekte haben jetzt `groupId: null | string`
  - `saveSessionTabs()` ruft intern `saveSession()` auf

- [ ] **Schritt 1: `groups`-Array initialisieren und `saveSessionTabs()` upgraden**

In `js/tabs.js`, Zeile 2 (nach `let tabs = [], activeTabId = null, tabIdCounter = 0;`):

```js
let tabs = [], activeTabId = null, tabIdCounter = 0;
let groups = [];
```

Dann `saveSessionTabs()` (Zeilen 432–439) ersetzen:

```js
let _saveSessionTimer = null;
function saveSessionTabs() {
  clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    const activeIdx = tabs.findIndex(t => t.id === activeTabId);
    saveSession(tabs, groups, Math.max(0, activeIdx));
  }, 400);
}
```

- [ ] **Schritt 2: `createTab()` um `groupId: null` erweitern**

In `createTab()` (Zeile 465), das Tab-Objekt erweitern:

```js
const tab = { id, url: isNewTab ? 'newtab' : url, title: isNewTab ? 'Neuer Tab' : (url||'Neuer Tab'), favicon: cachedFav, isNewTab, webviewEl, newtabEl, incognito: !!incognito, groupId: null };
```

- [ ] **Schritt 3: Init-Block in `index.html` auf neues Session-Format umstellen**

In `index.html`, die letzten drei Zeilen (aktuell ca. Zeilen 2164–2166):

```js
// ALT:
const _restoredUrls = cfg.restoreSession ? loadSessionTabs() : [];
if (_restoredUrls.length) { _restoredUrls.forEach(u => createTab(u)); }
else { createTab('newtab'); }
```

Ersetzen durch:

```js
if (cfg.restoreSession) {
  const session = loadSession();
  groups = session.groups || [];
  saveGroups(groups);
  if (session.tabs.length) {
    session.tabs.forEach(t => {
      const tab = createTab(t.url);
      tab.groupId = t.groupId || null;
      if (t.title && t.title !== t.url) tab.title = t.title;
    });
    const restoreIdx = Math.min(session.activeIndex, tabs.length - 1);
    if (restoreIdx >= 0) activateTab(tabs[restoreIdx].id);
  } else {
    createTab('newtab');
  }
} else {
  createTab('newtab');
}
```

- [ ] **Schritt 4: Testen**

`npm start` → Tab öffnen → Browser schließen → neu starten → Tab sollte wiederhergestellt sein. DevTools Console:

```js
console.log(tabs.map(t => ({url: t.url, groupId: t.groupId}))); // groupId sollte null sein
console.log(groups); // leeres Array []
```

- [ ] **Schritt 5: Commit**

```bash
git add js/tabs.js index.html
git commit -m "feat: add groupId to tab objects, upgrade session restore to structured format"
```

---

### Task 3: Tab-Bar Rendering mit Gruppenfarben

**Files:**
- Modify: `js/tabs.js` (`renderTabBar()`)
- Modify: `index.html` (CSS `<style>`-Block)

**Interfaces:**
- Consumes: `groups` Array aus Task 2, `tab.groupId` aus Task 2
- Produces: Tabs mit Gruppenfarbe im Tab-Bar sichtbar

**8 Gruppen-Farben (Palette):**
```js
const GROUP_COLORS = ['#4f8ef7','#22c55e','#ef4444','#f97316','#a855f7','#ec4899','#06b6d4','#eab308'];
```

- [ ] **Schritt 1: Gruppen-Farb-CSS in `index.html` einfügen**

Im `<style>`-Block in `index.html`, direkt nach der Zeile `.close-tab:hover{background:rgba(255,255,255,0.12)}` (nach dem bestehenden Tab-Styling):

```css
/* Tab-Gruppen: farbiger Hintergrund + oberer Balken */
.tab[data-group-color] {
  background-color: color-mix(in srgb, var(--group-color) 20%, rgba(255,255,255,0.04));
  border-top: 2px solid var(--group-color);
}
.tab[data-group-color].active {
  background-color: color-mix(in srgb, var(--group-color) 30%, rgba(255,255,255,0.11));
}
.tab-group-dot {
  width: 7px; height: 7px; border-radius: 50%;
  flex-shrink: 0; margin-right: 1px;
}
```

- [ ] **Schritt 2: `GROUP_COLORS` Konstante in `js/tabs.js` hinzufügen**

Direkt nach `let groups = [];` (Zeile 3):

```js
const GROUP_COLORS = ['#4f8ef7','#22c55e','#ef4444','#f97316','#a855f7','#ec4899','#06b6d4','#eab308'];
```

- [ ] **Schritt 3: `renderTabBar()` um Gruppenfarbe erweitern**

In `renderTabBar()`, das `el.className`- und `el.innerHTML`-Assignment anpassen. Die aktuelle Zeile (ca. Zeile 528–533):

```js
tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '') + (t.incognito ? ' incognito' : '');
    el.title = t.title || t.url;
    el.dataset.title = t.title || t.url;
    const safeTabIcon = t.favicon ? safeFaviconUrl(t.favicon) : null;
    const iconHtml = t.incognito ? `<i data-lucide="glasses" width="14" height="14"></i>` : (safeTabIcon ? `<img src="${escHtml(safeTabIcon)}" class="tab-favicon">` : `<i data-lucide="${t.isNewTab?'file-plus':'globe'}" width="14" height="14"></i>`);
    el.innerHTML = `<span class="tab-icon-wrap">${iconHtml}</span><span class="tab-title">${escHtml(t.title)}</span><span class="close-tab"><i data-lucide="x" width="12" height="12"></i></span>`;
```

Ersetzen durch:

```js
tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '') + (t.incognito ? ' incognito' : '');
    el.title = t.title || t.url;
    el.dataset.title = t.title || t.url;
    const group = t.groupId ? groups.find(g => g.id === t.groupId) : null;
    if (group) {
      el.dataset.groupColor = group.color;
      el.style.setProperty('--group-color', group.color);
    }
    const safeTabIcon = t.favicon ? safeFaviconUrl(t.favicon) : null;
    const iconHtml = t.incognito ? `<i data-lucide="glasses" width="14" height="14"></i>` : (safeTabIcon ? `<img src="${escHtml(safeTabIcon)}" class="tab-favicon">` : `<i data-lucide="${t.isNewTab?'file-plus':'globe'}" width="14" height="14"></i>`);
    const dotHtml = group ? `<span class="tab-group-dot" style="background:${escHtml(group.color)}"></span>` : '';
    el.innerHTML = `<span class="tab-icon-wrap">${iconHtml}</span>${dotHtml}<span class="tab-title">${escHtml(t.title)}</span><span class="close-tab"><i data-lucide="x" width="12" height="12"></i></span>`;
```

- [ ] **Schritt 4: Testen**

Manuell in DevTools Console:

```js
groups.push({id:'gtest', name:'Test', color:'#22c55e'});
tabs[0].groupId = 'gtest';
renderTabBar();
// → Erster Tab sollte grünen Hintergrund + grünen Punkt haben
```

Danach zurücksetzen:

```js
tabs[0].groupId = null; groups = []; renderTabBar();
```

- [ ] **Schritt 5: Commit**

```bash
git add js/tabs.js index.html
git commit -m "feat: render tab group colors in tab bar"
```

---

### Task 4: Gruppen-Verwaltung per Rechtsklick

**Files:**
- Modify: `js/tabs.js` (`renderTabBar()` → contextmenu handler)

**Interfaces:**
- Consumes: `groups`, `GROUP_COLORS`, `saveGroups()`, `saveSessionTabs()`
- Produces: Rechtsklick-Menü auf Tabs mit Gruppen-Einträgen

- [ ] **Schritt 1: Hilfsfunktionen für Gruppenoperationen hinzufügen**

In `js/tabs.js`, direkt vor `renderTabBar()`:

```js
function generateGroupId() { return 'g' + Date.now().toString(36); }

function createGroup(name, color) {
  const g = { id: generateGroupId(), name, color };
  groups.push(g);
  saveGroups(groups);
  return g;
}

function addTabToGroup(tab, groupId) {
  tab.groupId = groupId;
  saveSessionTabs();
  renderTabBar();
}

function removeTabFromGroup(tab) {
  tab.groupId = null;
  saveSessionTabs();
  renderTabBar();
}

function renameGroup(groupId, newName) {
  const g = groups.find(g => g.id === groupId);
  if (g) { g.name = newName; saveGroups(groups); renderTabBar(); }
}

function closeGroupTabs(groupId) {
  const toClose = tabs.filter(t => t.groupId === groupId).map(t => t.id);
  toClose.forEach(id => closeTab(id));
}
```

- [ ] **Schritt 2: Tab-Kontextmenü in `renderTabBar()` um Gruppen-Einträge erweitern**

Das bestehende `el.addEventListener('contextmenu', ...)` in `renderTabBar()` (ca. Zeilen 535–543) ersetzen:

```js
el.addEventListener('contextmenu', e => {
  e.preventDefault();
  const group = t.groupId ? groups.find(g => g.id === t.groupId) : null;

  // Gruppen-Untermenü: bestehende Gruppen + "Neue Gruppe…"
  const groupSubmenu = [
    ...groups.map(g => ({
      label: `⬤ ${g.name}`,
      click: () => addTabToGroup(t, g.id),
    })),
    ...(groups.length ? ['-'] : []),
    { label: '＋ Neue Gruppe…', click: () => {
      const name = prompt('Gruppenname:', 'Neue Gruppe');
      if (!name) return;
      const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
      const g = createGroup(name, color);
      addTabToGroup(t, g.id);
    }},
  ];

  const items = [
    { label: 'Tab neu laden',   click: () => { if (t.webviewEl) t.webviewEl.reload(); } },
    { label: 'Tab duplizieren', click: () => createTab(t.url) },
    '-',
    { label: 'Zu Gruppe hinzufügen', submenu: groupSubmenu },
    ...(group ? [
      { label: `Aus Gruppe "${group.name}" entfernen`, click: () => removeTabFromGroup(t) },
      { label: `Gruppe umbenennen…`, click: () => {
        const name = prompt('Neuer Name:', group.name);
        if (name) renameGroup(group.id, name);
      }},
      { label: `Gruppe Farbe ändern`, submenu: GROUP_COLORS.map(c => ({
        label: `⬤ ${c}`,
        click: () => { group.color = c; saveGroups(groups); renderTabBar(); }
      }))},
      '-',
      { label: `Alle Tabs dieser Gruppe schließen`, danger: true, click: () => closeGroupTabs(group.id) },
    ] : []),
    '-',
    { label: 'Tab schließen', click: () => closeTab(t.id), danger: true },
  ];
  showCtxMenu(items, e.clientX, e.clientY);
});
```

- [ ] **Schritt 3: Testen**

`npm start` → Rechtsklick auf Tab → „Zu Gruppe hinzufügen" → „Neue Gruppe…" → Namen eingeben → Tab sollte farbigen Hintergrund kriegen. Rechtsklick wieder → „Aus Gruppe entfernen" → Farbe weg.

- [ ] **Schritt 4: Commit**

```bash
git add js/tabs.js
git commit -m "feat: add tab group management via right-click context menu"
```

---

### Task 5: Drag-and-Drop Gruppen-Erstellung

**Files:**
- Modify: `js/tabs.js` (`renderTabBar()`)

**Interfaces:**
- Consumes: `createGroup()`, `addTabToGroup()`, `groups`, `GROUP_COLORS`
- Produces: Tab auf Tab ziehen → Gruppe entsteht

- [ ] **Schritt 1: Drag-Handler in `renderTabBar()` hinzufügen**

Direkt nach dem `contextmenu`-Listener in `renderTabBar()` (nach dem `el.addEventListener('contextmenu', ...)` Block), vor `bar.appendChild(el)`:

```js
el.draggable = true;
el.addEventListener('dragstart', e => {
  e.dataTransfer.setData('text/tab-id', String(t.id));
  e.dataTransfer.effectAllowed = 'move';
  el.style.opacity = '0.5';
});
el.addEventListener('dragend', () => { el.style.opacity = ''; });
el.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  el.style.outline = '2px solid var(--accent)';
});
el.addEventListener('dragleave', () => { el.style.outline = ''; });
el.addEventListener('drop', e => {
  e.preventDefault();
  el.style.outline = '';
  const draggedId = +e.dataTransfer.getData('text/tab-id');
  if (!draggedId || draggedId === t.id) return;
  const dragged = tabs.find(tab => tab.id === draggedId);
  if (!dragged) return;

  if (t.groupId) {
    // Ziel ist in einer Gruppe → gezogener Tab kommt rein
    addTabToGroup(dragged, t.groupId);
  } else {
    // Beide ohne Gruppe → neue Gruppe erstellen
    const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
    const g = createGroup('Gruppe', color);
    addTabToGroup(t, g.id);
    addTabToGroup(dragged, g.id);
  }
});
```

- [ ] **Schritt 2: Testen**

`npm start` → Tab auf anderen Tab ziehen → beide sollten farbigen Hintergrund bekommen. Tab auf Tab in einer Gruppe ziehen → Tab kommt in die Gruppe.

- [ ] **Schritt 3: Commit**

```bash
git add js/tabs.js
git commit -m "feat: add drag-and-drop group creation in tab bar"
```

---

### Task 6: Session-Restore fertigstellen (Gruppen persistent)

**Files:**
- Modify: `js/tabs.js` (`saveSessionTabs()` ist bereits aus Task 2 erledigt)
- Verify: Init-Block in `index.html` aus Task 2

Dieser Task prüft, dass Gruppen nach einem Neustart korrekt wiederhergestellt werden.

- [ ] **Schritt 1: End-to-End testen**

```
1. npm start
2. Rechtsklick auf Tab → "Zu Gruppe hinzufügen" → "Neue Gruppe…" → "Arbeit"
3. Zweiten Tab öffnen (Ctrl+T), zu einer anderen Seite navigieren
4. Browser schließen
5. npm start
6. Prüfen: beide Tabs wiederhergestellt, erster Tab noch in der Gruppe "Arbeit" mit Farbe
```

DevTools Console zur Verifikation:

```js
console.log(loadSession());
// Sollte tabs mit groupId und groups-Array enthalten
```

- [ ] **Schritt 2: Edge Case — alle Tabs waren Inkognito/Newtab**

```
1. Alle normalen Tabs schließen, nur Neuer Tab offen
2. Browser schließen und neu starten
3. Ergebnis: normaler Neuer Tab (kein Restore-Versuch mit leerer Liste)
```

- [ ] **Schritt 3: Commit (nur wenn Fixes nötig waren)**

```bash
git add js/tabs.js index.html
git commit -m "fix: verify session restore correctly preserves groups across restarts"
```

---

### Task 7: Tab-Suche Overlay (Ctrl+Shift+A)

**Files:**
- Modify: `index.html` (HTML-Overlay + CSS + JS)
- Modify: `js/tabs.js` (`handleShortcut()`)

**Interfaces:**
- Consumes: `tabs` Array, `activateTab()`, `groups` (für Gruppen-Dot)
- Produces: Ctrl+Shift+A öffnet Overlay, fuzzy-filtert Tabs, Enter/Klick springt zum Tab

- [ ] **Schritt 1: Tab-Suche HTML in `index.html` einfügen**

Direkt vor `<!-- Seite durchsuchen -->` (vor dem `<div id="findBar">`), einfügen:

```html
<!-- ── Tab-Suche Overlay ── -->
<div id="tabSearch" style="display:none;position:fixed;inset:0;z-index:99998;align-items:flex-start;justify-content:center;padding-top:80px;background:rgba(0,0,0,.45);backdrop-filter:blur(4px)">
  <div style="width:min(600px,92vw);background:var(--panel);border:1px solid var(--panel-border);border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6)">
    <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--panel-border)">
      <i data-lucide="search" width="15" height="15" style="color:var(--muted);flex-shrink:0"></i>
      <input id="tabSearchInput" placeholder="Tab suchen …" autocomplete="off" spellcheck="false"
        style="flex:1;background:none;border:none;outline:none;color:var(--text);font-size:14px;font-family:inherit"/>
      <span style="font-size:11px;color:var(--muted)">Esc zum Schließen</span>
    </div>
    <div id="tabSearchList" style="max-height:380px;overflow-y:auto"></div>
  </div>
</div>
```

- [ ] **Schritt 2: Tab-Suche CSS im `<style>`-Block einfügen**

Nach dem Gruppen-CSS aus Task 3:

```css
.ts-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; cursor: pointer; transition: background .1s;
}
.ts-item:hover, .ts-item.selected { background: rgba(255,255,255,.07); }
.ts-item.selected { background: rgba(255,255,255,.1); }
.ts-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-url   { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Schritt 3: Tab-Suche JS in `index.html` einfügen**

Im `<script>`-Block von `index.html`, vor `// ── INIT ──`:

```js
// ── TAB-SUCHE ─────────────────────────────────────────────────────────────────
let _tsSelected = 0;
let _tsFiltered = [];

function openTabSearch() {
  const overlay = document.getElementById('tabSearch');
  overlay.style.display = 'flex';
  const input = document.getElementById('tabSearchInput');
  input.value = '';
  _tsSelected = 0;
  renderTabSearchList('');
  setTimeout(() => input.focus(), 30);
}

function closeTabSearch() {
  document.getElementById('tabSearch').style.display = 'none';
}

function renderTabSearchList(query) {
  const list = document.getElementById('tabSearchList');
  const q = query.toLowerCase();
  _tsFiltered = q
    ? tabs.filter(t => !t.isNewTab && ((t.title||'').toLowerCase().includes(q) || (t.url||'').toLowerCase().includes(q)))
    : tabs.filter(t => !t.isNewTab);
  if (!_tsFiltered.length && !q) _tsFiltered = tabs; // alle anzeigen wenn keine Query

  if (!_tsFiltered.length) {
    list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--muted);font-size:13px">Keine Tabs gefunden.</div>';
    return;
  }
  list.innerHTML = '';
  _tsFiltered.forEach((t, i) => {
    const group = t.groupId ? groups.find(g => g.id === t.groupId) : null;
    const dotHtml = group ? `<span style="width:7px;height:7px;border-radius:50%;background:${escHtml(group.color)};flex-shrink:0"></span>` : '';
    const safeIcon = t.favicon ? safeFaviconUrl(t.favicon) : null;
    const iconHtml = safeIcon ? `<img src="${escHtml(safeIcon)}" style="width:14px;height:14px;object-fit:contain;flex-shrink:0">` : `<i data-lucide="globe" width="14" height="14" style="flex-shrink:0;color:var(--muted)"></i>`;
    const item = document.createElement('div');
    item.className = 'ts-item' + (i === _tsSelected ? ' selected' : '');
    item.innerHTML = `${iconHtml}${dotHtml}<div style="flex:1;min-width:0"><div class="ts-title">${escHtml(t.title||t.url)}</div><div class="ts-url">${escHtml(t.url)}</div></div>`;
    item.addEventListener('click', () => { activateTab(t.id); closeTabSearch(); });
    list.appendChild(item);
  });
  renderLucide();
}

function tabSearchScrollSelected() {
  const items = document.querySelectorAll('.ts-item');
  if (items[_tsSelected]) items[_tsSelected].scrollIntoView({ block: 'nearest' });
}

document.getElementById('tabSearchInput')?.addEventListener('input', e => {
  _tsSelected = 0;
  renderTabSearchList(e.target.value);
});
document.getElementById('tabSearchInput')?.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _tsSelected = Math.min(_tsSelected + 1, _tsFiltered.length - 1);
    document.querySelectorAll('.ts-item').forEach((el, i) => el.classList.toggle('selected', i === _tsSelected));
    tabSearchScrollSelected();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _tsSelected = Math.max(_tsSelected - 1, 0);
    document.querySelectorAll('.ts-item').forEach((el, i) => el.classList.toggle('selected', i === _tsSelected));
    tabSearchScrollSelected();
  } else if (e.key === 'Enter') {
    const t = _tsFiltered[_tsSelected];
    if (t) { activateTab(t.id); closeTabSearch(); }
  } else if (e.key === 'Escape') {
    closeTabSearch();
  }
});
document.getElementById('tabSearch')?.addEventListener('mousedown', e => {
  if (e.target === document.getElementById('tabSearch')) closeTabSearch();
});
```

- [ ] **Schritt 4: Ctrl+Shift+A Shortcut in `handleShortcut()` in `js/tabs.js` einfügen**

In `handleShortcut()`, direkt nach `if (ctrl && key === 'f') { openFindBar(); return true; }`:

```js
if (ctrl && shift && key === 'a') { openTabSearch(); return true; }
```

- [ ] **Schritt 5: Testen**

```
1. npm start → mehrere Tabs öffnen
2. Ctrl+Shift+A → Overlay erscheint
3. "git" tippen → filtert auf Tabs mit "git" in Titel/URL
4. Pfeil-unten → zweiter Eintrag markiert
5. Enter → springt zum Tab, Overlay schließt
6. Ctrl+Shift+A → Escape → Overlay schließt
```

- [ ] **Schritt 6: Commit**

```bash
git add index.html js/tabs.js
git commit -m "feat: add tab search overlay (Ctrl+Shift+A)"
```

---

### Task 8: Push und Release

- [ ] **Schritt 1: Alle Commits pushen**

```bash
git push origin master
```

- [ ] **Schritt 2: Version auf 0.3.4 bumpen und Release taggen**

In `package.json`:
```json
"version": "0.3.4",
```

```bash
git add package.json
git commit -m "build: bump to v0.3.4 (tab groups, session restore, tab search)"
git tag v0.3.4
git push origin master
git push origin v0.3.4
```

→ GitHub Actions baut automatisch den Installer.
