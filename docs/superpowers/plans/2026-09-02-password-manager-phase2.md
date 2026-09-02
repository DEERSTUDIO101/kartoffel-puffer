# Password Manager Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add password generator, strength bar, duplicate detection, edit mode, and show-password to the existing password manager UI.

**Architecture:** All changes in `js/vault-ui.js` (logic + event handlers) and `index.html` (HTML structure for new UI elements). The vault API (`vault.js`, IPC) is unchanged. Strength bar reuses existing `.vault-strength-wrap/.vault-strength-bar/.vault-strength-lbl` CSS classes already defined in `index.html`.

**Tech Stack:** Plain JS, HTML, CSS. No bundler, no test runner. `npm start` = `electron .` for manual verification.

## Global Constraints

- No new npm dependencies, no CDN resources
- UI text in German
- `vault.js` and all IPC channels: unchanged
- `passwords.enc` format: unchanged
- No minimum password length enforced (strength bar purely visual)
- `crypto.getRandomValues()` for all random generation (no Math.random)
- Existing CSS classes (`s-btn`, `s-section`, `s-label`, `s-input`, `vault-strength-*`) reused throughout

---

### Task 1: index.html — Generator panel + strength bar + duplicate warning in pwViewAdd

**Files:**
- Modify: `index.html`

**Interfaces:**
- Produces (IDs used by Task 2 and 3):
  - `#pwAddPass` — password input (already exists, stays)
  - `#pwGenToggle` — button to toggle generator panel
  - `#pwGenPanel` — generator panel container (hidden by default)
  - `#pwGenLen` — range input, min=8 max=64 value=16
  - `#pwGenLenLabel` — span showing current length value
  - `#pwGenUpper`, `#pwGenLower`, `#pwGenDigits`, `#pwGenSpecial` — checkboxes
  - `#pwGenBtn` — "Neu generieren" button
  - `#pwAddStrengthBar` — strength bar fill div (width + background updated by JS)
  - `#pwAddStrengthLbl` — strength label text
  - `#pwDupWarning` — duplicate warning container (hidden by default)
  - `#pwDupMsg` — warning message text
  - `#pwDupCancel`, `#pwDupOverwrite` — duplicate warning buttons
  - `#pwSaveBtn` — save button (already exists, label updated by JS in Task 3)

- [ ] **Step 1: Find and replace the pwViewAdd password section in index.html**

Find this exact block in `index.html`:

```html
        <div class="s-section">
          <div class="s-label">Passwort</div>
          <input class="s-input" id="pwAddPass" type="password" placeholder="Passwort" style="width:100%"/>
        </div>
        <button class="s-btn primary" id="pwSaveBtn" style="width:100%;padding:8px">Speichern</button>
```

Replace with:

```html
        <div class="s-section">
          <div class="s-label">Passwort</div>
          <div style="display:flex;gap:6px;align-items:center">
            <input class="s-input" id="pwAddPass" type="password" placeholder="Passwort" style="flex:1"/>
            <button class="s-btn" id="pwGenToggle" title="Passwort generieren">🎲</button>
          </div>
          <div class="vault-strength-wrap" id="pwAddStrengthWrap" style="display:none;margin-top:6px">
            <div class="vault-strength-bar" id="pwAddStrengthBar" style="width:0%"></div>
          </div>
          <div class="vault-strength-lbl" id="pwAddStrengthLbl"></div>
          <div id="pwGenPanel" style="display:none;margin-top:8px;padding:10px;background:var(--panel);border:1px solid var(--panel-border);border-radius:6px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span style="font-size:12px;color:var(--muted);white-space:nowrap">Länge: <span id="pwGenLenLabel">16</span></span>
              <input type="range" id="pwGenLen" min="8" max="64" value="16" style="flex:1"/>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:12px">
              <label><input type="checkbox" id="pwGenUpper" checked> A–Z</label>
              <label><input type="checkbox" id="pwGenLower" checked> a–z</label>
              <label><input type="checkbox" id="pwGenDigits" checked> 0–9</label>
              <label><input type="checkbox" id="pwGenSpecial"> Sonderzeichen</label>
            </div>
            <button class="s-btn" id="pwGenBtn" style="width:100%;margin-top:8px">Neu generieren</button>
          </div>
        </div>
        <div id="pwDupWarning" style="display:none;padding:8px 10px;background:color-mix(in srgb,var(--accent,#5b9bd5) 15%,transparent);border:1px solid var(--accent,#5b9bd5);border-radius:6px;margin-bottom:8px;font-size:13px">
          <div id="pwDupMsg" style="margin-bottom:8px"></div>
          <div style="display:flex;gap:6px">
            <button class="s-btn" id="pwDupCancel" style="flex:1">Abbrechen</button>
            <button class="s-btn danger" id="pwDupOverwrite" style="flex:1">Überschreiben</button>
          </div>
        </div>
        <button class="s-btn primary" id="pwSaveBtn" style="width:100%;padding:8px">Speichern</button>
```

- [ ] **Step 2: Verify structure in browser**

Run `npm start`. Open the password manager (click key icon). Click "Eintrag hinzufügen" tab. You should see:
- Password field with 🎲 button to its right
- No generator panel yet (hidden — wired in Task 2)
- No strength bar yet (hidden — wired in Task 2)
- Save button at bottom

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add generator panel, strength bar, duplicate warning HTML to pwViewAdd"
```

---

### Task 2: js/vault-ui.js — Generator logic + strength bar live update

**Files:**
- Modify: `js/vault-ui.js`

**Interfaces:**
- Consumes: all IDs from Task 1
- Produces (used by Task 3):
  - `_pwStrengthLevel(pw)` — returns `{level: 0-4, label: string, color: string}` (shared with edit mode strength bar)

- [ ] **Step 1: Add `generatePassword()` and `_pwStrengthLevel()` helper functions**

Add these two functions near the top of `js/vault-ui.js`, before `openPasswords`:

```js
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
```

- [ ] **Step 2: Add `_updateAddStrength()` helper and wire it to password input**

Add this function after the helpers above:

```js
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
```

Then at the bottom of `js/vault-ui.js`, add:

```js
document.getElementById('pwAddPass')?.addEventListener('input', _updateAddStrength);
```

- [ ] **Step 3: Add generator toggle and controls event handlers**

Add at the bottom of `js/vault-ui.js`:

```js
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
```

- [ ] **Step 4: Verify in browser**

Run `npm start`. Open passwords overlay → "Eintrag hinzufügen":
1. Click 🎲 — generator panel opens, password field auto-fills with a random password
2. Type in password field — strength bar appears and updates live
3. Move slider to 32 — label shows "32"
4. Check "Sonderzeichen", click "Neu generieren" — new password with symbols
5. Uncheck all boxes except one — last box stays checked (can't uncheck)

- [ ] **Step 5: Commit**

```bash
git add js/vault-ui.js
git commit -m "feat: password generator and strength bar in add view"
```

---

### Task 3: js/vault-ui.js — Duplicate check + edit mode

**Files:**
- Modify: `js/vault-ui.js`

**Interfaces:**
- Consumes: `vault.get(site)`, `vault.getPassword(site, username)`, `vault.save(entry)`, `vault.list()`
- Consumes: `_pwStrengthLevel()` from Task 2, `_updateAddStrength()` from Task 2
- Consumes: `switchPwTab('add')`, `renderPwList()`

- [ ] **Step 1: Add `_editMode` flag and replace the `pwSaveBtn` handler**

At the top of `js/vault-ui.js`, after the existing `let masterPwMode` line, add:

```js
let _editMode = false;
```

Find and replace the existing `pwSaveBtn` event listener in `js/vault-ui.js`:

```js
document.getElementById('pwSaveBtn')?.addEventListener('click', async () => {
  const site = document.getElementById('pwAddSite').value.trim();
  const user = document.getElementById('pwAddUser').value.trim();
  const pass = document.getElementById('pwAddPass').value;
  if (!site || !pass) return showToast('Seite und Passwort benötigt!');
  await vault.save({ site, username: user, password: pass });
  document.getElementById('pwAddSite').value=''; document.getElementById('pwAddUser').value=''; document.getElementById('pwAddPass').value='';
  showToast('Gespeichert!'); switchPwTab('list'); await renderPwList();
});
```

Replace with:

```js
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
```

- [ ] **Step 2: Add `editEntry()` function**

Add after `_resetAddForm`:

```js
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
```

- [ ] **Step 3: Add edit button to `renderPwList()`**

In `renderPwList()`, find the `card.innerHTML` template and add an edit button. Replace:

```js
      card.innerHTML=`<div class="pw-info"><div class="pw-site">${escHtml(e.site)}</div><div class="pw-user">${escHtml(e.username)}</div></div>
        <div class="pw-actions">
          <button class="s-btn" data-action="copy-user">User</button>
          <button class="s-btn" data-action="copy-pass">Pass</button>
          <button class="s-btn danger" data-action="delete"><i data-lucide="trash-2" width="14" height="14"></i></button>
        </div>`;
      card.querySelector('[data-action="copy-user"]').addEventListener('click',()=>{navigator.clipboard.writeText(e.username);showToast('Benutzer kopiert');});
      card.querySelector('[data-action="copy-pass"]').addEventListener('click',async()=>{const entry=await vault.get(e.site);if(entry){navigator.clipboard.writeText(entry.password);showToast('Passwort kopiert');}});
      card.querySelector('[data-action="delete"]').addEventListener('click',async()=>{await vault.remove(e.site,e.username);showToast('Eintrag gelöscht');await renderPwList();});
```

With:

```js
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
```

- [ ] **Step 4: Reset `_editMode` when switching to Add tab manually**

Find the existing `pwTabAdd` event listener:

```js
document.getElementById('pwTabAdd')?.addEventListener('click',  () => switchPwTab('add'));
```

Replace with:

```js
document.getElementById('pwTabAdd')?.addEventListener('click', () => {
  if (_editMode) { _editMode = false; _resetAddForm(); }
  switchPwTab('add');
});
```

- [ ] **Step 5: Verify in browser**

Run `npm start`. Add an entry (e.g. site=`github.com`, user=`test@test.de`, pass=`abc123`). Then:

1. **Duplicate check:** Click "Eintrag hinzufügen", enter same site+username, different password → warning appears. Click "Abbrechen" → warning disappears. Click again → "Überschreiben" → entry updated.
2. **Edit mode:** In list, click ✏ on entry → Add tab opens pre-filled, save button shows "Aktualisieren". Change password, click "Aktualisieren" → list shows updated entry, no duplicate warning fired.
3. **Tab switch cancels edit:** Click ✏ to enter edit mode, then click "Eintrag hinzufügen" tab manually → form resets, button shows "Speichern".

- [ ] **Step 6: Commit**

```bash
git add js/vault-ui.js
git commit -m "feat: duplicate warning and edit mode for password entries"
```

---

### Task 4: js/vault-ui.js — Show-password button in list

**Files:**
- Modify: `js/vault-ui.js`

**Interfaces:**
- Consumes: `vault.getPassword(site, username)` from vault API

- [ ] **Step 1: Add 👁 button and reveal logic to `renderPwList()`**

In `renderPwList()`, update the `card.innerHTML` template to add the show-password button and a reveal span. Replace the template from Task 3 Step 3:

```js
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
```

With:

```js
      card.innerHTML=`
        <div class="pw-info">
          <div class="pw-site">${escHtml(e.site)}</div>
          <div class="pw-user">${escHtml(e.username)}</div>
          <div class="pw-revealed" style="display:none;font-size:11px;color:var(--accent,#5b9bd5);word-break:break-all;margin-top:2px;font-family:monospace"></div>
        </div>
        <div class="pw-actions">
          <button class="s-btn" data-action="copy-user">User</button>
          <button class="s-btn" data-action="copy-pass">Pass</button>
          <button class="s-btn" data-action="show-pass" title="Passwort anzeigen">👁</button>
          <button class="s-btn" data-action="edit"><i data-lucide="pencil" width="14" height="14"></i></button>
          <button class="s-btn danger" data-action="delete"><i data-lucide="trash-2" width="14" height="14"></i></button>
        </div>`;
      card.querySelector('[data-action="copy-user"]').addEventListener('click',()=>{navigator.clipboard.writeText(e.username);showToast('Benutzer kopiert');});
      card.querySelector('[data-action="copy-pass"]').addEventListener('click',async()=>{const pw=await vault.getPassword(e.site,e.username);if(pw){navigator.clipboard.writeText(pw);showToast('Passwort kopiert');}});
      card.querySelector('[data-action="show-pass"]').addEventListener('click', async function() {
        const revEl = card.querySelector('.pw-revealed');
        if (revEl.style.display !== 'none') { revEl.style.display='none'; revEl.textContent=''; return; }
        const pw = await vault.getPassword(e.site, e.username);
        if (!pw) return;
        revEl.textContent = pw;
        revEl.style.display = 'block';
        setTimeout(() => { revEl.style.display='none'; revEl.textContent=''; }, 3000);
      });
      card.querySelector('[data-action="edit"]').addEventListener('click',()=>editEntry(e.site,e.username));
      card.querySelector('[data-action="delete"]').addEventListener('click',async()=>{await vault.remove(e.site,e.username);showToast('Eintrag gelöscht');await renderPwList();});
```

- [ ] **Step 2: Verify in browser**

Run `npm start`. Open password list:
1. Click 👁 on any entry → password appears in monospace below username for 3 seconds, then disappears automatically
2. Click 👁 again while visible → hides immediately (toggle)
3. "Pass" copy button still works correctly (now uses `getPassword` directly for correctness)

- [ ] **Step 3: Commit**

```bash
git add js/vault-ui.js
git commit -m "feat: show-password toggle (3s reveal) in password list"
```

---

## Self-Review Checklist

- All `document.getElementById` calls use `?.` for safety ✓
- `crypto.getRandomValues` used (not `Math.random`) ✓
- No minimum password length enforced ✓
- German UI text throughout ✓
- `vault.js` and IPC unchanged ✓
- `_editMode` reset in all paths (save, cancel, tab switch) ✓
- Duplicate check correctly skipped in edit mode ✓
- Show-password clears `textContent` before hiding (no memory leak) ✓
