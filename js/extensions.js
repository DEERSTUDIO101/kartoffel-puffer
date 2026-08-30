// ── Erweiterungen (UI) ───────────────────────────────────────────────────────
// Die eigentliche Lade-/Verwaltungslogik liegt im Main-Prozess (main.js),
// da nur der Zugriff auf session.loadExtension() und das Dateisystem hat.
let _extCache = [];

function extApi() { return window.electronAPI?.extensions; }

// Optionsseite einer Erweiterung als normalen Tab öffnen. Extension-Seiten
// laufen in <webview partition="persist:kp">, weil die Erweiterung in genau
// dieser Session geladen ist.
function openExtPage(e) {
  if (!e?.id || !e.optionsPage) return;
  createTab(`chrome-extension://${e.id}/${e.optionsPage}`);
  closeExtensions();
}

// Toolbar-Icons der aktiven Erweiterungen mit Popup (browser_action/action)
function renderExtBar() {
  const bar = document.getElementById('extBar');
  if (!bar) return;
  bar.innerHTML = '';
  _extCache.filter(e => e.enabled && e.popup).forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'ext-icon' + (e.icon ? '' : ' no-icon');
    btn.title = e.title || e.name;
    btn.innerHTML = e.icon
      ? `<img src="${escHtml(e.icon)}" alt="">`
      : escHtml((e.name || '?').slice(0, 2).toUpperCase());
    btn.addEventListener('click', () => {
      // Popup unter dem Icon verankern (Fenster-relative Koordinaten,
      // der Main-Prozess rechnet sie über getContentBounds auf den Screen um).
      const r = btn.getBoundingClientRect();
      extApi()?.popup(e.key, { x: Math.round(r.right), y: Math.round(r.bottom + 4) });
    });
    // Rechtsklick: Optionen/Dashboard. Wichtig, weil manche Popups unter
    // Electron nicht laufen (kein aktiver Tab in chrome.tabs, chrome.storage
    // liefert undefined statt null) — die Optionsseite funktioniert dagegen.
    btn.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const items = [];
      if (e.optionsPage) items.push({ label: '⚙ Optionen öffnen', click: () => openExtPage(e) });
      items.push({ label: '🧩 Erweiterungen verwalten', click: openExtensions });
      showCtxMenu(items, ev.clientX, ev.clientY);
    });
    bar.appendChild(btn);
  });
}

function renderExtList() {
  const list = document.getElementById('extList');
  if (!list) return;
  list.innerHTML = '';
  if (!_extCache.length) {
    list.innerHTML = '<div style="color:var(--muted);padding:16px;font-size:13px">Keine Erweiterungen installiert.</div>';
    return;
  }
  _extCache.forEach(e => {
    const row = document.createElement('div');
    row.className = 'ext-item';
    const badges =
      (e.builtin ? '<span class="ext-badge builtin">mitgeliefert</span>' : '') +
      (e.error   ? '<span class="ext-badge err">Fehler</span>' : '');
    row.innerHTML = `
      <div class="ext-item-icon">${e.icon ? `<img src="${escHtml(e.icon)}" alt="">` : '🧩'}</div>
      <div class="ext-item-info">
        <div class="ext-item-name">${escHtml(e.name)} <span class="ext-badge">v${escHtml(e.version)}</span> ${badges}</div>
        <div class="ext-item-desc">${escHtml(e.error || e.description || '')}</div>
      </div>
      <div class="ext-actions">
        <button class="ext-switch${e.enabled ? ' on' : ''}" data-act="toggle" title="${e.enabled ? 'Deaktivieren' : 'Aktivieren'}"></button>
        ${e.optionsPage && e.enabled ? '<button class="s-btn" data-act="options" title="Optionen öffnen">⚙</button>' : ''}
        <button class="s-btn" data-act="folder" title="Ordner öffnen">📁</button>
        ${e.builtin ? '' : '<button class="s-btn danger" data-act="remove" title="Entfernen">🗑</button>'}
      </div>`;
    row.querySelector('[data-act="options"]')?.addEventListener('click', () => openExtPage(e));
    row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      _extCache = await extApi().toggle(e.key, !e.enabled);
      renderExtList(); renderExtBar();
      showToast(e.enabled ? 'Erweiterung deaktiviert' : 'Erweiterung aktiviert');
    });
    row.querySelector('[data-act="folder"]').addEventListener('click', () => extApi()?.openFolder(e.key));
    row.querySelector('[data-act="remove"]')?.addEventListener('click', async () => {
      const res = await extApi().remove(e.key);
      if (res?.ok) showToast('Erweiterung entfernt');
      else showToast(res?.error || 'Entfernen fehlgeschlagen');
    });
    list.appendChild(row);
  });
}

async function refreshExtensions() {
  try { _extCache = await extApi()?.list() || []; } catch { _extCache = []; }
  renderExtBar();
  if (document.getElementById('extOverlay')?.classList.contains('open')) renderExtList();
}

function openExtensions() {
  document.getElementById('extOverlay')?.classList.add('open');
  renderExtList(); renderLucide();
}
function closeExtensions() { document.getElementById('extOverlay')?.classList.remove('open'); }

document.getElementById('btnExtensions')?.addEventListener('click', openExtensions);
document.getElementById('closeExtOverlay')?.addEventListener('click', closeExtensions);
document.getElementById('extOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('extOverlay')) closeExtensions();
});
document.getElementById('extInstallBtn')?.addEventListener('click', async () => {
  const res = await extApi()?.install();
  if (!res || res.cancelled) return;
  showToast(res.ok ? `„${res.name}" installiert` : (res.error || 'Installation fehlgeschlagen'));
});

// Der Main-Prozess meldet Änderungen (Start-Ladevorgang, Install, Toggle, Remove)
window.electronAPI?.onExtensionsUpdate?.(list => {
  _extCache = list || [];
  renderExtBar();
  if (document.getElementById('extOverlay')?.classList.contains('open')) renderExtList();
});

// Erst nach dem Parsen starten: escHtml/showToast/renderLucide werden im
// Inline-Script von index.html definiert, das nach dieser Datei ausgeführt wird.
document.addEventListener('DOMContentLoaded', refreshExtensions);
