// ── UI BUILDER ────────────────────────────────────────────────────────────────
// Direkt-Editor: Toolbar-Buttons ziehen/ausblenden, Tab-Leiste verschieben.
// Aktivierung: Strg+Shift+E oder der Edit-Button in den Einstellungen.

const NAV_BUTTONS = [
  { id: 'btnBack',       label: 'Zurück',                icon: '←',  locked: false },
  { id: 'btnFwd',        label: 'Vorwärts',              icon: '→',  locked: false },
  { id: 'btnReload',     label: 'Neu laden',             icon: '↻',  locked: false },
  { id: 'btnHome',       label: 'Startseite',            icon: '⌂',  locked: false },
  { id: 'secBadge',      label: 'Sicherheits-Indikator', icon: '🔒', locked: false },
  { id: 'urlbarWrap',    label: 'URL-Leiste',            icon: '⌨',  locked: true  },
  { id: 'btnBookmark',   label: 'Lesezeichen',           icon: '🔖', locked: false },
  { id: 'btnHistory',    label: 'Verlauf',               icon: '🕐', locked: false },
  { id: 'btnDownloads',  label: 'Downloads',             icon: '⬇',  locked: false },
  { id: 'btnPasswords',  label: 'Passwörter',            icon: '🔑', locked: false },
  { id: 'btnAI',         label: 'AI Assistent',          icon: '🤖', locked: false },
  { id: 'extBar',        label: 'Erweiterungen',         icon: '🧩', locked: false },
  { id: 'btnAdBlock',    label: 'Werbeblocker',          icon: '🛡',  locked: false },
  { id: 'btnExtensions', label: 'Erweiterungen-Manager', icon: '🧩', locked: false },
  { id: 'btnSettings',   label: 'Einstellungen',         icon: '⚙',  locked: false },
];

const _DEFAULT_NAV_ORDER = NAV_BUTTONS.map(b => b.id);

// ── Tab-Bar-Position anwenden ─────────────────────────────────────────────────
function applyTabBarPos(pos) {
  const p = pos || 'top';
  document.body.classList.remove('tabs-top','tabs-bottom','tabs-left','tabs-right');
  document.body.classList.add('tabs-' + p);
  const winInTab = document.getElementById('winControls');
  const winInNav = document.getElementById('winControlsNav');
  if (winInTab && winInNav) {
    const toNav = (p === 'bottom');
    winInTab.style.display = toNav ? 'none' : '';
    winInNav.style.display = toNav ? '' : 'none';
  }
}

// ── Nav-Button-Reihenfolge + Sichtbarkeit anwenden ───────────────────────────
function applyNavOrder() {
  const navBar = document.getElementById('navBar');
  if (!navBar) return;
  const order  = cfg.navButtonOrder?.length ? cfg.navButtonOrder : _DEFAULT_NAV_ORDER;
  const hidden = new Set(cfg.navButtonHidden || []);
  order.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'urlbarWrap') { navBar.appendChild(el); return; }
    el.style.display = hidden.has(id) ? 'none' : '';
    navBar.appendChild(el);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── LIVE EDIT MODE ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let _editActive   = false;
let _editSnapshot = null;   // für Abbrechen
let _dragSrc      = null;
let _navClickBlock = null;  // temporärer Capturing-Listener

function enterEditMode() {
  if (_editActive) return;
  _editActive = true;

  // Snapshot für Abbrechen
  _editSnapshot = {
    tabBarPos:      cfg.tabBarPos,
    navButtonOrder: [...(cfg.navButtonOrder?.length ? cfg.navButtonOrder : _DEFAULT_NAV_ORDER)],
    navButtonHidden:[...(cfg.navButtonHidden || [])],
  };

  document.body.classList.add('ui-edit-mode');
  _showEditBar(true);
  _buildTabZones();
  _setupNavDrag();
  _addEditHints();
}

function exitEditMode(save) {
  if (!_editActive) return;
  _editActive = false;

  _teardownNavDrag();
  _removeEditHints();
  _removeTabZones();
  _showEditBar(false);
  document.body.classList.remove('ui-edit-mode');

  if (!save && _editSnapshot) {
    cfg.tabBarPos       = _editSnapshot.tabBarPos;
    cfg.navButtonOrder  = _editSnapshot.navButtonOrder;
    cfg.navButtonHidden = _editSnapshot.navButtonHidden;
    saveSettings();
    applyTabBarPos(cfg.tabBarPos);
    applyNavOrder();
  } else {
    saveSettings();
  }
  _editSnapshot = null;
}

// ── Floating Edit-Bar ─────────────────────────────────────────────────────────
function _showEditBar(show) {
  let bar = document.getElementById('uiEditBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'uiEditBar';
    bar.innerHTML = `
      <span id="uiEditBarLabel">✏ UI bearbeiten &nbsp;<small style="color:var(--muted)">Buttons ziehen · anklicken zum Ein-/Ausblenden · Tab-Leiste: Rand anklicken</small></span>
      <button id="uiEditDone"   class="ued-btn primary">✓ Fertig</button>
      <button id="uiEditCancel" class="ued-btn">✕ Abbrechen</button>
    `;
    document.body.appendChild(bar);
    document.getElementById('uiEditDone')  ?.addEventListener('click', () => exitEditMode(true));
    document.getElementById('uiEditCancel')?.addEventListener('click', () => exitEditMode(false));
  }
  bar.classList.toggle('open', show);
}

// ── Tab-Zonen (Rand-Klick für Tab-Leiste Position) ────────────────────────────
function _buildTabZones() {
  const zones = [
    { id:'uiZoneTop',    pos:'top',    style:'top:0;left:0;right:0;height:32px;flex-direction:row;',  label:'↑ Oben' },
    { id:'uiZoneBottom', pos:'bottom', style:'bottom:0;left:0;right:0;height:32px;flex-direction:row;',label:'↓ Unten' },
    { id:'uiZoneLeft',   pos:'left',   style:'left:0;top:38px;bottom:38px;width:36px;flex-direction:column;',label:'← Links' },
    { id:'uiZoneRight',  pos:'right',  style:'right:0;top:38px;bottom:38px;width:36px;flex-direction:column;',label:'Rechts →' },
  ];
  zones.forEach(z => {
    const div = document.createElement('div');
    div.id = z.id;
    div.className = 'ui-tab-zone' + (cfg.tabBarPos === z.pos ? ' active-zone' : '');
    div.style.cssText = z.style;
    div.innerHTML = `<span class="ui-zone-lbl">${z.label}</span>`;
    div.addEventListener('click', () => {
      cfg.tabBarPos = z.pos;
      applyTabBarPos(z.pos);
      document.querySelectorAll('.ui-tab-zone').forEach(el => el.classList.toggle('active-zone', el.dataset.pos === z.pos));
    });
    div.dataset.pos = z.pos;
    document.body.appendChild(div);
  });
}

function _removeTabZones() {
  ['uiZoneTop','uiZoneBottom','uiZoneLeft','uiZoneRight'].forEach(id => document.getElementById(id)?.remove());
}

// ── Edit-Hints (Beschriftungen über den Buttons) ──────────────────────────────
function _addEditHints() {
  const hidden = new Set(cfg.navButtonHidden || []);
  const navBar = document.getElementById('navBar');
  if (!navBar) return;
  navBar.querySelectorAll(':scope > *').forEach(el => {
    if (el.id === 'urlbarWrap') return;
    const def = NAV_BUTTONS.find(b => b.id === el.id);
    if (!def) return;
    el.dataset.editLabel = def.label;
  });
}

function _removeEditHints() {
  document.getElementById('navBar')?.querySelectorAll('[data-edit-label]').forEach(el => {
    delete el.dataset.editLabel;
  });
}

// ── Nav-Drag in-place ─────────────────────────────────────────────────────────
function _setupNavDrag() {
  const navBar = document.getElementById('navBar');
  if (!navBar) return;

  const order  = cfg.navButtonOrder?.length ? cfg.navButtonOrder : _DEFAULT_NAV_ORDER;
  const hidden = new Set(cfg.navButtonHidden || []);

  order.forEach(id => {
    const el = document.getElementById(id);
    if (!el || id === 'urlbarWrap') return;
    el.setAttribute('draggable', 'true');
    el._uiDragStart  = _onNavDragStart.bind(null, el);
    el._uiDragOver   = _onNavDragOver.bind(null, el);
    el._uiDragLeave  = _onNavDragLeave.bind(null, el);
    el._uiDrop       = _onNavDrop.bind(null, el);
    el._uiDragEnd    = _onNavDragEnd.bind(null, el);
    el._uiClick      = _onNavEditClick.bind(null, el, id);
    el.addEventListener('dragstart', el._uiDragStart);
    el.addEventListener('dragover',  el._uiDragOver);
    el.addEventListener('dragleave', el._uiDragLeave);
    el.addEventListener('drop',      el._uiDrop);
    el.addEventListener('dragend',   el._uiDragEnd);
    el.addEventListener('click',     el._uiClick, true); // Capturing → vor normalen Handlern
  });
}

function _teardownNavDrag() {
  const navBar = document.getElementById('navBar');
  if (!navBar) return;
  navBar.querySelectorAll('[draggable]').forEach(el => {
    el.removeAttribute('draggable');
    if (el._uiDragStart)  el.removeEventListener('dragstart', el._uiDragStart);
    if (el._uiDragOver)   el.removeEventListener('dragover',  el._uiDragOver);
    if (el._uiDragLeave)  el.removeEventListener('dragleave', el._uiDragLeave);
    if (el._uiDrop)       el.removeEventListener('drop',      el._uiDrop);
    if (el._uiDragEnd)    el.removeEventListener('dragend',   el._uiDragEnd);
    if (el._uiClick)      el.removeEventListener('click',     el._uiClick, true);
    delete el._uiDragStart; delete el._uiDragOver; delete el._uiDragLeave;
    delete el._uiDrop; delete el._uiDragEnd; delete el._uiClick;
    el.classList.remove('ui-drag-over', 'ui-dragging');
  });
  _dragSrc = null;
}

function _onNavDragStart(el, e) {
  _dragSrc = el;
  el.classList.add('ui-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', el.id);
}
function _onNavDragOver(el, e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  if (_dragSrc && _dragSrc !== el) el.classList.add('ui-drag-over');
}
function _onNavDragLeave(el) { el.classList.remove('ui-drag-over'); }
function _onNavDragEnd(el) {
  el.classList.remove('ui-dragging');
  document.querySelectorAll('.ui-drag-over').forEach(e => e.classList.remove('ui-drag-over'));
  _dragSrc = null;
}
function _onNavDrop(el, e) {
  e.preventDefault();
  el.classList.remove('ui-drag-over');
  if (!_dragSrc || _dragSrc === el) return;
  const navBar = document.getElementById('navBar');
  const children = [...navBar.children];
  const si = children.indexOf(_dragSrc), ti = children.indexOf(el);
  if (si < ti) el.after(_dragSrc); else el.before(_dragSrc);
  _saveCurrentNavOrder();
}
function _onNavEditClick(el, id, e) {
  // Im Edit-Mode: Klick togglet Sichtbarkeit statt normale Aktion
  if (!_editActive) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const hidden = new Set(cfg.navButtonHidden || []);
  if (hidden.has(id)) { hidden.delete(id); el.style.display = ''; }
  else                { hidden.add(id);    el.style.display = 'none'; }
  cfg.navButtonHidden = [...hidden];
  el.classList.toggle('ui-btn-hidden', hidden.has(id));
}

function _saveCurrentNavOrder() {
  const navBar = document.getElementById('navBar');
  if (!navBar) return;
  cfg.navButtonOrder = [...navBar.children]
    .map(el => el.id)
    .filter(id => id && NAV_BUTTONS.some(b => b.id === id));
}

// ── Tastenkürzel: Strg+Shift+E ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    _editActive ? exitEditMode(true) : enterEditMode();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── SETTINGS-LAYOUT-PAGE (Fallback wenn Edit Mode nicht reicht) ───────────────
// ═══════════════════════════════════════════════════════════════════════════════

function buildLayoutSettingsUI() {
  const container = document.getElementById('s-layout');
  if (!container) return;

  const hidden = new Set(cfg.navButtonHidden || []);
  const order  = (cfg.navButtonOrder?.length ? cfg.navButtonOrder : _DEFAULT_NAV_ORDER)
    .filter(id => NAV_BUTTONS.some(b => b.id === id));

  container.innerHTML = `
    <div class="s-section" style="text-align:center;padding:1rem 0 .5rem">
      <button id="enterEditModeBtn" style="
        padding:10px 28px;border:1px solid var(--accent);border-radius:8px;
        background:rgba(255,159,28,.1);color:var(--accent);font-size:14px;
        cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:background .15s">
        ✏ UI direkt bearbeiten
      </button>
      <div style="font-size:11px;color:var(--muted);margin-top:.5rem">Oder: Strg+Shift+E</div>
    </div>

    <div class="s-section">
      <div class="s-label">Tab-Leiste Position</div>
      <div class="tabpos-grid">
        ${[
          { val:'top',    svg:'<rect x="2" y="2" width="20" height="5" rx="1" fill="currentColor"/><rect x="2" y="9" width="20" height="13" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
          { val:'bottom', svg:'<rect x="2" y="17" width="20" height="5" rx="1" fill="currentColor"/><rect x="2" y="2" width="20" height="13" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
          { val:'left',   svg:'<rect x="2" y="2" width="6" height="20" rx="1" fill="currentColor"/><rect x="10" y="2" width="12" height="20" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
          { val:'right',  svg:'<rect x="16" y="2" width="6" height="20" rx="1" fill="currentColor"/><rect x="2" y="2" width="12" height="20" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
        ].map(o => {
          const labels = { top:'Oben', bottom:'Unten', left:'Links', right:'Rechts' };
          return `<div class="tabpos-card${cfg.tabBarPos===o.val?' active':''}" data-pos="${o.val}">
            <svg width="36" height="28" viewBox="0 0 24 24">${o.svg}</svg>
            <span>${labels[o.val]}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="s-section">
      <div class="s-label">Navigations-Buttons</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:.7rem">⠿ ziehen · Auge ein-/ausblenden</div>
      <div id="navOrderList" class="nav-order-list"></div>
      <button class="s-btn" id="navOrderReset" style="margin-top:.6rem;font-size:12px">↺ Standard wiederherstellen</button>
    </div>
  `;

  document.getElementById('enterEditModeBtn')?.addEventListener('click', () => {
    closeSettings?.();
    setTimeout(enterEditMode, 200);
  });
  container.querySelectorAll('.tabpos-card').forEach(card => {
    card.addEventListener('click', () => {
      cfg.tabBarPos = card.dataset.pos; saveSettings(); applyTabBarPos(cfg.tabBarPos);
      container.querySelectorAll('.tabpos-card').forEach(c => c.classList.toggle('active', c.dataset.pos === cfg.tabBarPos));
    });
  });
  document.getElementById('navOrderReset')?.addEventListener('click', () => {
    cfg.navButtonOrder = [..._DEFAULT_NAV_ORDER]; cfg.navButtonHidden = [];
    saveSettings(); applyNavOrder(); buildLayoutSettingsUI();
  });
  _renderNavOrderList(document.getElementById('navOrderList'), order, hidden);
}

function _renderNavOrderList(listEl, order, hidden) {
  if (!listEl) return;
  listEl.innerHTML = '';
  let dragSrc = null;
  order.forEach(id => {
    const def = NAV_BUTTONS.find(b => b.id === id);
    if (!def) return;
    const isHid = hidden.has(id);
    const row = document.createElement('div');
    row.className = 'nav-order-row' + (isHid ? ' nav-order-hidden' : '');
    row.dataset.id = id; row.draggable = !def.locked;
    row.innerHTML = `
      <span class="nav-order-handle">${def.locked ? '🔒' : '⠿⠿'}</span>
      <span class="nav-order-icon">${def.icon}</span>
      <span class="nav-order-label">${def.label}</span>
      <button class="nav-order-eye"${def.locked?' disabled':''}>${isHid
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'}</button>`;
    if (!def.locked) {
      row.addEventListener('dragstart', e => { dragSrc=row; row.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
      row.addEventListener('dragend',   () => { row.classList.remove('dragging'); listEl.querySelectorAll('.drag-over').forEach(r=>r.classList.remove('drag-over')); dragSrc=null; });
      row.addEventListener('dragover',  e => { e.preventDefault(); if(dragSrc&&dragSrc!==row) row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop',      e => { e.preventDefault(); row.classList.remove('drag-over'); if(!dragSrc||dragSrc===row)return; const rows=[...listEl.querySelectorAll('.nav-order-row')]; if(rows.indexOf(dragSrc)<rows.indexOf(row))row.after(dragSrc);else row.before(dragSrc); cfg.navButtonOrder=[...listEl.querySelectorAll('.nav-order-row')].map(r=>r.dataset.id); saveSettings(); applyNavOrder(); });
    }
    row.querySelector('.nav-order-eye')?.addEventListener('click', () => {
      if(def.locked)return;
      if(hidden.has(id))hidden.delete(id);else hidden.add(id);
      cfg.navButtonHidden=[...hidden]; saveSettings(); applyNavOrder();
      row.classList.toggle('nav-order-hidden',hidden.has(id));
    });
    listEl.appendChild(row);
  });
}
