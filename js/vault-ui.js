// ── PASSWORDS UI ─────────────────────────────────────────────────────────────
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
          <button class="s-btn danger" data-action="delete"><i data-lucide="trash-2" width="14" height="14"></i></button>
        </div>`;
      card.querySelector('[data-action="copy-user"]').addEventListener('click',()=>{navigator.clipboard.writeText(e.username);showToast('Benutzer kopiert');});
      card.querySelector('[data-action="copy-pass"]').addEventListener('click',async()=>{const entry=await vault.get(e.site);if(entry){navigator.clipboard.writeText(entry.password);showToast('Passwort kopiert');}});
      card.querySelector('[data-action="delete"]').addEventListener('click',async()=>{await vault.remove(e.site,e.username);showToast('Eintrag gelöscht');await renderPwList();});
      list.appendChild(card);
    });
    renderLucide();
  } catch { list.innerHTML='<div style="color:var(--danger);padding:10px">Fehler beim Laden.</div>'; }
}

document.getElementById('pwSaveBtn')?.addEventListener('click', async () => {
  const site = document.getElementById('pwAddSite').value.trim();
  const user = document.getElementById('pwAddUser').value.trim();
  const pass = document.getElementById('pwAddPass').value;
  if (!site || !pass) return showToast('Seite und Passwort benötigt!');
  await vault.save({ site, username: user, password: pass });
  document.getElementById('pwAddSite').value=''; document.getElementById('pwAddUser').value=''; document.getElementById('pwAddPass').value='';
  showToast('Gespeichert!'); switchPwTab('list'); await renderPwList();
});
document.getElementById('pwSearch')?.addEventListener('input', renderPwList);
document.getElementById('closePwOverlay')?.addEventListener('click', closePasswords);
document.getElementById('pwTabList')?.addEventListener('click', () => switchPwTab('list'));
document.getElementById('pwTabAdd')?.addEventListener('click',  () => switchPwTab('add'));
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
