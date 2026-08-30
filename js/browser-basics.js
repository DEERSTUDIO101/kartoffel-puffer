// ── Standard-Browserfunktionen: Berechtigungen, Suche, Zoom, Daten löschen ───

// ── BERECHTIGUNGS-ABFRAGE ────────────────────────────────────────────────────
// Ohne Handler erteilt Electron alles automatisch — der Main-Prozess fragt
// jetzt hier nach und merkt sich die Antwort pro Herkunft (Origin).
const _permQueue = [];
let _permActive = null;

function showNextPermission() {
  if (_permActive || !_permQueue.length) return;
  _permActive = _permQueue.shift();
  document.getElementById('permOrigin').textContent = _permActive.origin || 'Diese Seite';
  document.getElementById('permLabel').textContent  = _permActive.label;
  document.getElementById('permPrompt').classList.add('open');
}
function answerPermission(allow) {
  if (!_permActive) return;
  window.electronAPI?.permissionRespond(_permActive.id, allow);
  showToast(allow ? 'Berechtigung erteilt' : 'Berechtigung blockiert');
  _permActive = null;
  document.getElementById('permPrompt').classList.remove('open');
  showNextPermission();
}
document.getElementById('permAllow')?.addEventListener('click', () => answerPermission(true));
document.getElementById('permDeny') ?.addEventListener('click', () => answerPermission(false));
window.electronAPI?.onPermissionRequest?.(req => { _permQueue.push(req); showNextPermission(); });

// ── SEITE DURCHSUCHEN (Strg+F) ───────────────────────────────────────────────
let _findTerm = '';
function findWv() { const t = activeTab(); return t && t.webviewEl ? t.webviewEl : null; }

function openFindBar() {
  if (!findWv()) return;                       // auf der Neuer-Tab-Seite sinnlos
  document.getElementById('findBar').classList.add('open');
  const inp = document.getElementById('findInput');
  inp.focus(); inp.select();
}
function closeFindBar() {
  document.getElementById('findBar').classList.remove('open');
  document.getElementById('findCount').textContent = '';
  _findTerm = '';
  findWv()?.stopFindInPage('clearSelection');
}
function doFind(forward = true, fromStart = false) {
  const wv = findWv();
  const term = document.getElementById('findInput').value;
  if (!wv) return;
  if (!term) { wv.stopFindInPage('clearSelection'); document.getElementById('findCount').textContent = ''; _findTerm = ''; return; }
  // findNext=false startet eine neue Suche, true springt zum nächsten Treffer
  const isNew = fromStart || term !== _findTerm;
  _findTerm = term;
  wv.findInPage(term, { forward, findNext: !isNew, matchCase: false });
}

document.getElementById('findInput')?.addEventListener('input', () => doFind(true, true));
document.getElementById('findInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); doFind(!e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
});
document.getElementById('findNext') ?.addEventListener('click', () => doFind(true));
document.getElementById('findPrev') ?.addEventListener('click', () => doFind(false));
document.getElementById('findClose')?.addEventListener('click', closeFindBar);

// Vom Webview gemeldete Trefferzahl anzeigen (wird in attachWebviewEvents verdrahtet)
function handleFoundInPage(result) {
  const el = document.getElementById('findCount');
  if (!el || !result) return;
  el.textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : 'Keine Treffer';
}

// ── ZOOM (Strg + / − / 0) ────────────────────────────────────────────────────
// Zoomstufe wird pro Domain gemerkt, wie in Chrome/Firefox.
const ZOOM_KEY = 'kp-zoom-v1';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let _zoomBadgeTimer = null;

function loadZoomMap() { try { return JSON.parse(localStorage.getItem(ZOOM_KEY) || '{}'); } catch { return {}; } }
function saveZoomMap(m) { localStorage.setItem(ZOOM_KEY, JSON.stringify(m)); }
function hostOf(url) { try { return new URL(url).hostname; } catch { return null; } }

function applyStoredZoom(wv, url) {
  const host = hostOf(url);
  if (!host || !wv) return;
  const factor = loadZoomMap()[host];
  if (factor && factor !== 1) { try { wv.setZoomFactor(factor); } catch {} }
}

function showZoomBadge(factor) {
  const badge = document.getElementById('zoomBadge');
  document.getElementById('zoomLevel').textContent = Math.round(factor * 100) + ' %';
  badge.classList.add('open');
  clearTimeout(_zoomBadgeTimer);
  // Bei 100 % ganz ausblenden — sonst dauerhaft im Weg
  _zoomBadgeTimer = setTimeout(() => badge.classList.remove('open'), factor === 1 ? 1200 : 2600);
}

function changeZoom(dir) {          // dir: +1 rein, -1 raus, 0 zurücksetzen
  const tab = activeTab();
  const wv  = tab && tab.webviewEl;
  if (!wv) return;
  let factor;
  if (dir === 0) factor = 1;
  else {
    const cur = (() => { try { return wv.getZoomFactor(); } catch { return 1; } })();
    // nächstliegende Stufe suchen, dann eine weiter in die gewünschte Richtung
    let idx = ZOOM_STEPS.reduce((best, v, i) => Math.abs(v - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? i : best, 0);
    idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir));
    factor = ZOOM_STEPS[idx];
  }
  try { wv.setZoomFactor(factor); } catch { return; }
  const host = hostOf(tab.url);
  if (host) {
    const map = loadZoomMap();
    if (factor === 1) delete map[host]; else map[host] = factor;
    saveZoomMap(map);
  }
  showZoomBadge(factor);
}
document.getElementById('zoomReset')?.addEventListener('click', () => changeZoom(0));

// ── BROWSERDATEN LÖSCHEN ─────────────────────────────────────────────────────
function openClearData()  { document.getElementById('clearDataOverlay')?.classList.add('open'); renderLucide(); }
function closeClearData() { document.getElementById('clearDataOverlay')?.classList.remove('open'); }

document.getElementById('openClearDataBtn')?.addEventListener('click', openClearData);

// ── BERECHTIGUNGS-VERWALTUNG (nach Chromes Modell) ───────────────────────────
// Pro Berechtigung eine Standardregel (fragen/erlauben/blockieren) plus
// Ausnahmen je Website — Ausnahme schlägt Standard.
let _permData = { sites: {}, defaults: {}, labels: {} };

async function openPermissions() {
  _permData = await window.electronAPI?.permissionsList?.() || _permData;
  document.getElementById('permOverlay')?.classList.add('open');
  renderPermList(); renderLucide();
}
function closePermissions() { document.getElementById('permOverlay')?.classList.remove('open'); }

function renderPermList() {
  const box = document.getElementById('permList');
  if (!box) return;
  const filter = (document.getElementById('permFilter')?.value || '').toLowerCase();
  box.innerHTML = '';

  // Alle bekannten Berechtigungen zeigen, auch die ohne Einträge — sonst kann
  // man keine Standardregel setzen, bevor eine Website überhaupt gefragt hat.
  const perms = new Set([...Object.keys(_permData.labels || {})]);
  Object.keys(_permData.sites || {}).forEach(k => perms.add(k.split('|')[1]));

  let shown = 0;
  [...perms].sort().forEach(perm => {
    const entries = Object.entries(_permData.sites || {})
      .filter(([k]) => k.endsWith('|' + perm))
      .map(([k, v]) => ({ key: k, origin: k.slice(0, k.lastIndexOf('|')), allow: v }))
      .filter(e => !filter || e.origin.toLowerCase().includes(filter));
    if (filter && !entries.length) return;         // beim Filtern leere Gruppen ausblenden
    shown++;

    const group = document.createElement('div');
    group.className = 'perm-group';
    const mode = _permData.defaults?.[perm] || 'ask';
    group.innerHTML = `
      <div class="perm-group-head">
        <span class="perm-group-title">${escHtml(_permData.labels?.[perm] || perm)}</span>
        <select class="perm-default" data-perm="${escHtml(perm)}">
          <option value="ask"${mode==='ask'?' selected':''}>Immer fragen</option>
          <option value="allow"${mode==='allow'?' selected':''}>Immer erlauben</option>
          <option value="block"${mode==='block'?' selected':''}>Immer blockieren</option>
        </select>
      </div>`;
    entries.forEach(e => {
      const row = document.createElement('div');
      row.className = 'perm-site';
      row.innerHTML = `
        <span class="perm-state ${e.allow ? 'allow' : 'block'}">${e.allow ? 'erlaubt' : 'blockiert'}</span>
        <span class="perm-site-origin" title="${escHtml(e.origin)}">${escHtml(e.origin)}</span>
        <button class="s-btn" data-act="flip">${e.allow ? 'Blockieren' : 'Erlauben'}</button>
        <button class="s-btn danger" data-act="del" title="Ausnahme entfernen">🗑</button>`;
      row.querySelector('[data-act="flip"]').addEventListener('click', async () => {
        _permData = await window.electronAPI.permissionsSet(e.key, !e.allow);
        renderPermList();
      });
      row.querySelector('[data-act="del"]').addEventListener('click', async () => {
        _permData = await window.electronAPI.permissionsSet(e.key, null);
        showToast('Ausnahme entfernt'); renderPermList();
      });
      group.appendChild(row);
    });
    group.querySelector('.perm-default').addEventListener('change', async ev => {
      _permData = await window.electronAPI.permissionsSetDefault(perm, ev.target.value);
      showToast('Standard gespeichert');
    });
    box.appendChild(group);
  });

  if (!shown) box.innerHTML = '<div style="color:var(--muted);padding:16px;font-size:13px">Keine passenden Einträge.</div>';
}

document.getElementById('permFilter')?.addEventListener('input', renderPermList);
document.getElementById('closePermOverlay')?.addEventListener('click', closePermissions);
document.getElementById('permOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('permOverlay')) closePermissions();
});
document.getElementById('resetPermsBtn')?.addEventListener('click', openPermissions);
document.getElementById('closeClearData')?.addEventListener('click', closeClearData);
document.getElementById('cdCancel')     ?.addEventListener('click', closeClearData);
document.getElementById('clearDataOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('clearDataOverlay')) closeClearData();
});
document.getElementById('cdConfirm')?.addEventListener('click', async () => {
  const opts = {
    cookies: document.getElementById('cdCookies').checked,
    cache:   document.getElementById('cdCache').checked,
    storage: document.getElementById('cdStorage').checked,
  };
  const alsoHistory = document.getElementById('cdHistory').checked;
  const alsoPerms   = document.getElementById('cdPerms').checked;
  if (!opts.cookies && !opts.cache && !opts.storage && !alsoHistory && !alsoPerms) {
    showToast('Nichts ausgewählt'); return;
  }
  const parts = [];
  if (alsoHistory) { saveHistory([]); parts.push('Verlauf'); }
  if (alsoPerms)   { await window.electronAPI?.permissionsReset?.(); parts.push('Berechtigungen'); }
  const res = await window.electronAPI?.clearData?.(opts);
  if (res?.ok) {
    parts.push(...(res.cleared || []));
    showToast('Gelöscht: ' + (parts.join(', ') || 'nichts'));
  } else {
    showToast(res?.error || 'Löschen fehlgeschlagen');
  }
  closeClearData();
});
