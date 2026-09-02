// ── PASSWORDS UI ─────────────────────────────────────────────────────────────

function generatePassword(length, opts) {
  const charset = [
    opts.upper   ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '',
    opts.lower   ? 'abcdefghijklmnopqrstuvwxyz' : '',
    opts.digits  ? '0123456789' : '',
    opts.special ? '!@#$%^&*()-_=+[]{}|;:,.<>?' : '',
  ].join('');
  if (!charset) return '';
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, n => charset[n % charset.length]).join('');
}

function _pwStrengthLevel(pw) {
  const len = pw.length;
  const mixed = /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);
  const special = /[^A-Za-z0-9]/.test(pw);
  if (!pw) return { level: 0, label: '', color: '' };
  if (len < 8)  return { level: 1, label: 'Schwach',    color: '#e05c5c' };
  if (len < 12) return { level: 2, label: 'Mittel',     color: '#e08c5c' };
  if (len < 16 && mixed) return { level: 3, label: 'Stark',     color: '#5cb85c' };
  if (len >= 16 && special) return { level: 4, label: 'Sehr stark', color: '#5cb85c' };
  return { level: 3, label: 'Stark', color: '#5cb85c' };
}

function _updateAddStrength() {
  const pw  = document.getElementById('pwAddPass')?.value || '';
  const bar = document.getElementById('pwAddStrengthBar');
  const lbl = document.getElementById('pwAddStrengthLbl');
  const wrap = document.getElementById('pwAddStrengthWrap');
  if (!bar || !lbl) return;
  if (!pw) {
    wrap.style.display = 'none';
    lbl.textContent = '';
    return;
  }
  const s = _pwStrengthLevel(pw);
  wrap.style.display = 'block';
  bar.style.width = (s.level * 25) + '%';
  bar.style.background = s.color;
  lbl.textContent = s.label;
  lbl.style.color = s.color;
}

async function openPasswords() {
  const isSetup = await vault.isSetup();
  if (!isSetup) { showMasterPwOverlay('setup'); return; }
  const locked = await vault.isLocked();
  if (locked) { showMasterPwOverlay('unlock'); return; }
  document.getElementById('pwOverlay').classList.add('open');
  switchPwTab('list'); await renderPwList(); renderLucide();
}
function closePasswords() { document.getElementById('pwOverlay').classList.remove('open'); }

// ── MASTER PASSWORD ───────────────────────────────────────────────────────────
let masterPwMode = 'unlock';
let _editMode = false;
function showMasterPwOverlay(mode) {
  masterPwMode = mode;
  const title = document.getElementById('masterPwTitle');
  const desc  = document.getElementById('masterPwDesc');
  const inp1  = document.getElementById('masterPwInput');
  const inp2  = document.getElementById('masterPwInput2');
  const err   = document.getElementById('masterPwError');
  inp1.value = ''; inp2.value = ''; err.textContent = '';
  const t = typeof getT === 'function' ? getT : (k => ({
    masterPwSetup:'Tresor einrichten', masterPwDesc:'Lege ein Master-Passwort fest. Damit werden alle gespeicherten Logins verschlüsselt.',
    masterPwUnlock:'Tresor entsperren', masterPwUnlockDesc:'Master-Passwort eingeben.'
  }[k] || k));
  if (mode === 'setup') {
    title.textContent = t('masterPwSetup');
    desc.textContent  = t('masterPwDesc');
    inp2.style.display = 'block';
  } else {
    title.textContent = t('masterPwUnlock');
    desc.textContent  = t('masterPwUnlockDesc');
    inp2.style.display = 'none';
  }
  document.getElementById('masterPwOverlay').classList.add('open');
  inp1.focus();
}
function hideMasterPwOverlay() { document.getElementById('masterPwOverlay').classList.remove('open'); }

function switchPwTab(tabId) {
  document.querySelectorAll('.pw-tab').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('#pwBox-body > div').forEach(el=>el.style.display='none');
  document.getElementById('pwTab'+(tabId==='list'?'List':'Add')).classList.add('active');
  document.getElementById('pwView'+(tabId==='list'?'List':'Add')).style.display='block';
}

async function renderPwList() {
  const list = document.getElementById('pwList');
  const q    = document.getElementById('pwSearch')?.value.toLowerCase()||'';
  list.innerHTML = '';
  try {
    let entries = await vault.list();
    if (q) entries = entries.filter(e=>(e.site||'').toLowerCase().includes(q)||(e.username||'').toLowerCase().includes(q));
    if (!entries.length) { list.innerHTML='<div style="color:var(--muted);padding:10px">Keine Einträge gefunden.</div>'; return; }
    entries.forEach(e => {
      const card = document.createElement('div'); card.className = 'pw-item';
      card.innerHTML=`<div class="pw-info"><div class="pw-site">${escHtml(e.site)}</div><div class="pw-user">${escHtml(e.username)}</div></div>
        <div class="pw-actions">
          <button class="s-btn" data-action="copy-user">User</button>
          <button class="s-btn" data-action="copy-pass">Pass</button>
          <button class="s-btn" data-action="edit"><i data-lucide="pencil" width="14" height="14"></i></button>
          <button class="s-btn danger" data-action="delete"><i data-lucide="trash-2" width="14" height="14"></i></button>
        </div>`;
      card.querySelector('[data-action="copy-user"]').addEventListener('click',()=>{navigator.clipboard.writeText(e.username);showToast('Benutzer kopiert');});
      card.querySelector('[data-action="copy-pass"]').addEventListener('click',async()=>{const entry=await vault.get(e.site);if(entry){navigator.clipboard.writeText(entry.password);showToast('Passwort kopiert');}});
      card.querySelector('[data-action="edit"]').addEventListener('click',()=>editEntry(e.site,e.username));
      card.querySelector('[data-action="delete"]').addEventListener('click',async()=>{await vault.remove(e.site,e.username);showToast('Eintrag gelöscht');await renderPwList();});
      list.appendChild(card);
    });
    renderLucide();
  } catch { list.innerHTML='<div style="color:var(--danger);padding:10px">Fehler beim Laden.</div>'; }
}

async function _doSave() {
  const site = document.getElementById('pwAddSite').value.trim();
  const user = document.getElementById('pwAddUser').value.trim();
  const pass = document.getElementById('pwAddPass').value;
  if (!site || !pass) return showToast('Seite und Passwort benötigt!');

  // Duplicate check — skip in edit mode
  if (!_editMode) {
    const existing = await vault.get(site);
    if (existing && existing.username === (user || '')) {
      const msg = document.getElementById('pwDupMsg');
      if (msg) msg.textContent = `Eintrag für „${site}" (${user || '–'}) existiert bereits. Überschreiben?`;
      document.getElementById('pwDupWarning').style.display = 'block';
      return;
    }
  }

  await vault.save({ site, username: user, password: pass });
  _resetAddForm();
  showToast(_editMode ? 'Aktualisiert!' : 'Gespeichert!');
  _editMode = false;
  switchPwTab('list');
  await renderPwList();
}

function _resetAddForm() {
  document.getElementById('pwAddSite').value = '';
  document.getElementById('pwAddUser').value = '';
  document.getElementById('pwAddPass').value = '';
  document.getElementById('pwGenPanel').style.display = 'none';
  document.getElementById('pwDupWarning').style.display = 'none';
  document.getElementById('pwAddStrengthWrap').style.display = 'none';
  document.getElementById('pwAddStrengthLbl').textContent = '';
  const saveBtn = document.getElementById('pwSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Speichern';
}

async function editEntry(site, username) {
  _editMode = true;
  switchPwTab('add');
  document.getElementById('pwAddSite').value = site;
  document.getElementById('pwAddUser').value = username;
  const pw = await vault.getPassword(site, username);
  const inp = document.getElementById('pwAddPass');
  if (inp) inp.value = pw || '';
  _updateAddStrength();
  const saveBtn = document.getElementById('pwSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Aktualisieren';
  inp?.focus();
}

document.getElementById('pwSaveBtn')?.addEventListener('click', _doSave);

// Duplicate warning buttons
document.getElementById('pwDupCancel')?.addEventListener('click', () => {
  document.getElementById('pwDupWarning').style.display = 'none';
});

document.getElementById('pwDupOverwrite')?.addEventListener('click', async () => {
  document.getElementById('pwDupWarning').style.display = 'none';
  const site = document.getElementById('pwAddSite').value.trim();
  const user = document.getElementById('pwAddUser').value.trim();
  const pass = document.getElementById('pwAddPass').value;
  await vault.save({ site, username: user, password: pass });
  _resetAddForm();
  showToast('Überschrieben!');
  switchPwTab('list');
  await renderPwList();
});

document.getElementById('pwSearch')?.addEventListener('input', renderPwList);
document.getElementById('closePwOverlay')?.addEventListener('click', closePasswords);
document.getElementById('pwTabList')?.addEventListener('click', () => switchPwTab('list'));
document.getElementById('pwTabAdd')?.addEventListener('click', () => {
  if (_editMode) { _editMode = false; _resetAddForm(); }
  switchPwTab('add');
});
document.getElementById('pwOverlay')?.addEventListener('click', e=>{if(e.target===document.getElementById('pwOverlay'))closePasswords();});

document.getElementById('masterPwCancel')?.addEventListener('click', hideMasterPwOverlay);
document.getElementById('masterPwConfirm')?.addEventListener('click', async () => {
  const pw   = document.getElementById('masterPwInput').value;
  const pw2  = document.getElementById('masterPwInput2').value;
  const err  = document.getElementById('masterPwError');
  err.textContent = '';
  if (!pw) { err.textContent = 'Passwort darf nicht leer sein.'; return; }
  try {
    if (masterPwMode === 'setup') {
      if (pw !== pw2) { err.textContent = 'Passwörter stimmen nicht überein.'; return; }
      await vault.setup(pw);
    } else {
      await vault.unlock(pw);
    }
    hideMasterPwOverlay();
    document.getElementById('pwOverlay').classList.add('open');
    switchPwTab('list'); await renderPwList(); renderLucide();
  } catch (e) {
    err.textContent = e?.message || 'Falsches Passwort.';
  }
});
document.getElementById('masterPwInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('masterPwConfirm').click(); });
document.getElementById('masterPwInput2')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('masterPwConfirm').click(); });

// Password strength input listener
document.getElementById('pwAddPass')?.addEventListener('input', _updateAddStrength);

// Generator toggle
document.getElementById('pwGenToggle')?.addEventListener('click', () => {
  const panel = document.getElementById('pwGenPanel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) _doGenerate();  // auto-generate on open
});

function _getGenOpts() {
  return {
    upper:   document.getElementById('pwGenUpper')?.checked ?? true,
    lower:   document.getElementById('pwGenLower')?.checked ?? true,
    digits:  document.getElementById('pwGenDigits')?.checked ?? true,
    special: document.getElementById('pwGenSpecial')?.checked ?? false,
  };
}

function _doGenerate() {
  const len  = parseInt(document.getElementById('pwGenLen')?.value || '16', 10);
  const opts = _getGenOpts();
  const pw   = generatePassword(len, opts);
  const inp  = document.getElementById('pwAddPass');
  if (inp) { inp.value = pw; inp.type = 'text'; setTimeout(() => { inp.type = 'password'; }, 1500); }
  _updateAddStrength();
}

// Length slider
document.getElementById('pwGenLen')?.addEventListener('input', function () {
  const lbl = document.getElementById('pwGenLenLabel');
  if (lbl) lbl.textContent = this.value;
});

// Checkboxes — at least one must stay checked
['pwGenUpper','pwGenLower','pwGenDigits','pwGenSpecial'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', function () {
    const boxes = ['pwGenUpper','pwGenLower','pwGenDigits','pwGenSpecial']
      .map(i => document.getElementById(i)).filter(Boolean);
    const anyChecked = boxes.some(b => b.checked);
    if (!anyChecked) this.checked = true;  // revert: last box can't uncheck
  });
});

// Generate button
document.getElementById('pwGenBtn')?.addEventListener('click', _doGenerate);
