# Vault Security — Phase 1 Design Spec
**Datum:** 2026-09-02  
**Status:** Approved  
**Scope:** Vault Security Phase 1 von 5 (Security-Unterbau für den vollständigen Password Manager)

---

## Überblick

Drei zusammenhängende Verbesserungen die den bestehenden Vault von "funktioniert gut" zu "sicher und updatebar" machen:

1. **Self-Hash entfernen + neues `master.key`-Format** — behebt den Release-Blocker (Vault bricht nach jedem Update)
2. **Master-Passwort-Screen** — Vault startet gesperrt, Lock-Screen-UI mit Setup-Wizard
3. **DPAPI Auto-Unlock** — optionaler Komfort via `electron.safeStorage` (Windows DPAPI), Master-Passwort wird nie gespeichert

---

## 1. `master.key` — Neues Format

### Problem (aktuell)

```
Alt-Format (v0.3.5):
[saltA 32B | saltB 32B | selfHash 32B | encVaultKey ~60B]
```

- `selfHash` enthält SHA-256 von `vault.js` — schlägt nach jedem Code-Update fehl
- Kein Versions-Header → keine saubere Migration möglich
- AES-GCM liefert bereits Tamper-Detection (falscher Key → Entschlüsselung wirft) → selfHash ist redundant

### Neues Format (v1)

```
[MAGIC 4B | VERSION 1B | saltA 32B | saltB 32B | encVaultKey ~60B]
 K P V K    0x01
```

- **Magic**: `0x4B505646` ("KPVK") — eindeutige Erkennung, unwahrscheinlich in altem saltA
- **Version**: `0x01` — Basis für zukünftige Migrationen
- **selfHash**: komplett entfernt
- **encVaultKey**: unverändert (AES-256-GCM: IV 12B + AuthTag 16B + Key 32B = 60B)

### Migrations-Pfad (Atomic)

```
Startup → unlock(masterPassword) aufgerufen
      ↓
buf[0..4] === 'KPVK'?
  ├─ ja  → v1-Format, normal verarbeiten
  └─ nein → Legacy-Format erkannt
              ↓
              saltA = buf[0:32], saltB = buf[32:64]
              encVaultKey = buf[96:]   (selfHash bei [64:96] ignoriert)
              ↓
              Vault-Key ableiten + entschlüsseln (AES-GCM-Auth prüft Korrektheit)
              ↓
              Erfolg → neue master.key in TEMP-Datei schreiben
              ↓
              Temp-Datei validieren (re-lesen + vergleichen)
              ↓
              Erst dann: Temp-Datei → master.key umbenennen (atomic rename)
              ↓
              Alte Datei erst nach erfolgreicher Validierung ersetzt
```

Bei Absturz während Migration: alte `master.key` bleibt erhalten (rename ist atomic auf NTFS).

---

## 2. Master-Passwort-Screen

### Verhalten

- Vault startet beim Browser-Start immer **gesperrt** (außer DPAPI-Auto-Unlock greift)
- Lock-Screen-Overlay wird angezeigt wenn `vault.isSetup() && vault.isLocked()`
- Nach erfolgreichem Unlock: Overlay verschwindet, normaler Browser-Betrieb
- Idle-Auto-Lock (10 min, bereits implementiert) zeigt Overlay erneut

### Setup-Wizard (Ersteinrichtung)

Angezeigt wenn `!vault.isSetup()`:

```
┌─────────────────────────────┐
│   🔐 Vault einrichten       │
│                             │
│  Master-Passwort            │
│  [                    ]     │
│  ████████░░  Stark          │  ← Stärke-Balken (4 Stufen)
│                             │
│  Bestätigen                 │
│  [                    ]     │
│                             │
│  [ Vault erstellen ]        │
└─────────────────────────────┘
```

Passwort-Stärke (rein visuell, keine Mindestlänge erzwungen):
- < 8 Zeichen: Schwach (rot)
- 8–11 Zeichen: Mittel (orange)
- 12–15 Zeichen + gemischt: Stark (grün)
- 16+ Zeichen + Sonderzeichen: Sehr stark (grün, voller Balken)

### Lock-Screen (Vault vorhanden, gesperrt)

```
┌─────────────────────────────┐
│        🥔 Vault gesperrt    │
│                             │
│  Master-Passwort            │
│  [                    ]     │
│                             │
│  [ 🔓 Entsperren ]          │
│                             │
│  ─────────────────────      │
│  💻 Mit Windows entsperren  │  ← nur wenn auto-unlock.dat existiert
└─────────────────────────────┘
```

Fehlermeldung bei falschem Passwort: "Falsches Passwort" (kein Hinweis auf Versuchszähler).  
Nach 5 Fehlversuchen: Button für 30s deaktiviert ("Bitte warte 30 Sekunden").

---

## 3. DPAPI Auto-Unlock

### Designprinzipien

- Master-Passwort wird **niemals** gespeichert
- `auto-unlock.dat` enthält nur den Vault-Key (via safeStorage verschlüsselt)
- AES-GCM-Authentifizierung läuft immer durch — kein blindes Vertrauen in die Datei
- Manueller Lock → `manuallyLocked = true` → Auto-Unlock greift **nicht** bis nächsten Neustart
- `safeStorage.isEncryptionAvailable() === false` → Fallback auf Master-Passwort-Dialog, kein unsicherer Pfad
- "Auto-Unlock deaktivieren" → `auto-unlock.dat` löschen, done

### Aktivierungsfluss

```
User entsperrt Vault mit Master-Passwort
        ↓
Settings: "Mit Windows-Konto entsperren" aktivieren
        ↓
vault.setupAutoUnlock()
        ↓
safeStorage.encryptString(vaultKey.toString('hex'))
        ↓
→ auto-unlock.dat (im vault/-Verzeichnis)
```

### Startup-Fluss (Auto-Unlock)

```
vault.init(userData)
        ↓
vault.isSetup() && autoUnlockEnabled?
        ↓ ja
vault.tryAutoUnlock()
        ↓
safeStorage.decryptString(auto-unlock.dat)
        ↓
vaultKey hex → Buffer
        ↓
_aesDecrypt(vaultKey, buf aus passwords.enc) — AES-GCM verifiziert
        ↓
Erfolg → unlockedKey setzen → Vault offen 🔓
Fehler (beschädigt/manipuliert) → auto-unlock.dat löschen → Master-Passwort-Dialog
```

### Dateistruktur

```
userData/
  vault/
    master.key        ← verschlüsselter Vault-Key (KPVK-Format v1)
    passwords.enc     ← verschlüsselte Passwörter (unverändert)
    auto-unlock.dat   ← (optional) DPAPI-geschützter Vault-Key hex
```

### IPC-Channels (neu)

```js
passwords:tryAutoUnlock    // → { ok: true } | { ok: false }
passwords:setupAutoUnlock  // → { ok: true } | Error
passwords:disableAutoUnlock // → { ok: true }
passwords:autoUnlockAvailable // → boolean (safeStorage.isEncryptionAvailable())
```

### Settings-UI

```
Sicherheit
──────────────────────────────────────────
🔐 Vault Auto-Unlock

☐ Mit Windows-Konto entsperren
  Kartoffel Puffer entsperrt beim Start automatisch
  mit deinem Windows-Konto. Dein Master-Passwort
  wird niemals gespeichert.

[ Auto-Unlock deaktivieren ]   ← nur wenn aktiv
```

---

## 4. IPC-Härtung (Rate-Limiting)

Im Main-Prozess, nicht in vault.js:

```js
let _unlockAttempts = 0;
let _unlockCooldownUntil = 0;

ipcMain.handle('passwords:unlock', async (_e, pw) => {
  if (Date.now() < _unlockCooldownUntil) {
    const remainingSec = Math.ceil((_unlockCooldownUntil - Date.now()) / 1000);
    throw new Error(`Zu viele Versuche. Bitte warte ${remainingSec} Sekunden.`);
  }
  try {
    const result = await vault.unlock(pw);
    _unlockAttempts = 0;
    return result;
  } catch (err) {
    if (++_unlockAttempts >= 5) {
      _unlockCooldownUntil = Date.now() + 30_000;
      _unlockAttempts = 0;
    }
    throw err;
  }
});
```

---

## 5. Was sich NICHT ändert

- AES-256-GCM + PBKDF2→scrypt Schlüsselableitung: **unverändert**
- `passwords.enc` Dateiformat: **unverändert** (kein Datenverlust)
- Chaff-Einträge + Padding: **unverändert**
- Idle-Auto-Lock (10 min): **unverändert**
- Bestehende IPC-Channels (`passwords:list`, `passwords:save`, `passwords:get`, `passwords:delete`): **unverändert**
- Autofill (`tryAutofill()`): **unverändert**
- Tab Groups, Session Restore: **nicht berührt**

---

## 6. Implementierungsreihenfolge

1. `vault.js` — neues master.key-Format + Migrations-Logik (Self-Hash raus)
2. `vault.js` — DPAPI-Funktionen (`tryAutoUnlock`, `setupAutoUnlock`, `disableAutoUnlock`)
3. `main.js` — Startup-Auto-Unlock-Flow + manuallyLocked-Flag + IPC Rate-Limiting
4. `index.html` — Lock-Screen-Overlay + Setup-Wizard (HTML/CSS/JS)
5. `index.html` — DPAPI-Toggle in Settings + neue IPC-Handler verdrahten

---

## Was explizit nicht gebaut wird (YAGNI)

- Biometrie (Windows Hello) — Phase 2+
- Export/Backup des Vaults — Phase 5
- Reset-Mechanismus bei vergessenem Master-Passwort — bewusst nicht (kein Recovery ohne Master-Passwort)
- Passwort-Generator, Stärke-Check, Save-Prompt — Spec 2
