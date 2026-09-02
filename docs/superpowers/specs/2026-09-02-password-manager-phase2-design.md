# Password Manager Phase 2 — Generator + Verwaltungsverbesserungen
**Datum:** 2026-09-02  
**Status:** Approved  
**Scope:** Password Manager Phase 2 von 5 (Generator + bessere Verwaltung)

---

## Überblick

Zwei zusammenhängende Verbesserungen die den bestehenden Password-Manager von "funktioniert" zu "komfortabel nutzbar" machen:

1. **Passwort-Generator** — kryptographisch sichere Passwörter direkt im Add-Dialog generieren
2. **Verwaltungsverbesserungen** — Stärke-Balken, Duplikat-Warnung, Edit-Funktion, Passwort-Anzeige

---

## Architektur

Alle Änderungen in `js/vault-ui.js` + kleine HTML-Ergänzungen in `index.html` (Generator-Controls, Edit-Button).  
Vault-API (`vault.js`, IPC-Channels) bleibt **unverändert** — `save()` überschreibt bereits bei gleichem site+username, das ist das gewünschte Verhalten für Edit.

---

## 1. Passwort-Generator

### UI

Im "Eintrag hinzufügen"-Tab, direkt unter dem Passwort-Feld:

```
[ Passwort-Feld                    ] [🎲]
▼ Generator
  Länge: 16  [────────●──────────]  8–64
  ☑ A–Z   ☑ a–z   ☑ 0–9   ☐ Sonderzeichen
  [Neu generieren]
```

- Klick auf 🎲 klappt den Generator-Bereich auf/zu
- "Neu generieren" (oder automatisch beim Aufklappen) füllt das Passwort-Feld aus
- Längen-Slider: min 8, max 64, Standard 16
- Zeichensätze: Großbuchstaben (`A-Z`), Kleinbuchstaben (`a-z`), Ziffern (`0-9`), Sonderzeichen (`!@#$%^&*()-_=+[]{}|;:,.<>?`)
- Standard-Auswahl: A-Z + a-z + 0-9 aktiv, Sonderzeichen aus
- Mindestens eine Kategorie muss aktiv sein (Checkbox-Click deaktiviert nicht wenn letzte)

### Implementierung

```js
function generatePassword(length, opts) {
  const charset = [
    opts.upper   ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '',
    opts.lower   ? 'abcdefghijklmnopqrstuvwxyz' : '',
    opts.digits  ? '0123456789' : '',
    opts.special ? '!@#$%^&*()-_=+[]{}|;:,.<>?' : '',
  ].join('');
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, n => charset[n % charset.length]).join('');
}
```

- `crypto.getRandomValues()` — keine externe Abhängigkeit, kryptographisch sicher
- Kein Bias-Fix nötig für diese Anwendung (Uint32 mod kleiner Charset hat vernachlässigbaren Bias)

---

## 2. Stärke-Balken im Add/Edit-View

Selbe 4-Stufen-Logik wie Phase 1 (wiederverwendet):

| Stufe | Kriterium | Farbe |
|---|---|---|
| Schwach | < 8 Zeichen | rot |
| Mittel | 8–11 Zeichen | orange |
| Stark | 12–15 Zeichen + gemischt | grün |
| Sehr stark | 16+ Zeichen + Sonderzeichen | grün (voll) |

Erscheint direkt unter dem Passwort-Feld im Add/Edit-Formular, aktualisiert sich live beim Tippen.  
Rein visuell — keine Mindestlänge wird erzwungen.

---

## 3. Duplikat-Warnung beim Speichern

Beim Klick auf "Speichern" im Add-View:

1. `vault.get(site)` aufrufen
2. Wenn ein Eintrag mit gleichem site+username existiert → inline Warnung zeigen:  
   `"Eintrag für [site] ([username]) existiert bereits. Überschreiben?"`
3. Zwei Buttons: `[Abbrechen]` `[Überschreiben]`
4. Bei "Überschreiben": `vault.save()` normal aufrufen (überschreibt den bestehenden)

Nur site+username-Kombination wird geprüft — gleiche Site mit anderem Username ist kein Duplikat.

---

## 4. Edit-Funktion

Jeder Listeneintrag bekommt einen "Bearbeiten"-Button (Stift-Icon) neben den bestehenden Buttons.

Klick → öffnet das Add-Formular mit:
- Site und Username vorausgefüllt (aus dem Listeneintrag)
- Passwort vorausgefüllt via `vault.getPassword(site, username)`
- Speichern-Button als "Aktualisieren" beschriftet

Das Formular verhält sich identisch zum normalen Add — `vault.save()` überschreibt den alten Eintrag.  
Duplikat-Warnung greift hier **nicht** (Benutzer bearbeitet ja bewusst einen bestehenden Eintrag).

Ein globales Flag `_editMode = false` im vault-ui.js verhindert die Duplikat-Prüfung beim Aktualisieren.

---

## 5. Passwort sichtbar schalten

In der Passwort-Liste bekommt jeder Eintrag einen 👁-Button (neben "User", "Pass", "Löschen").

- Klick → holt Passwort via `vault.getPassword(site, username)`, zeigt es 3 Sekunden inline an, blendet es dann automatisch aus
- Kein persistenter Zustand — nach 3s wieder verborgen

---

## Was sich NICHT ändert

- `vault.js` — keine Änderungen
- IPC-Channels — keine neuen
- `passwords.enc`-Format — unverändert
- Autofill, Save-Prompt — Phase 3
- Import/Export — Phase 5

---

## Implementierungsreihenfolge

1. `index.html` — Generator-Controls HTML + Edit-Button HTML in Listeneintrag
2. `js/vault-ui.js` — `generatePassword()` + Generator-UI-Logik + Stärke-Balken im Add-View
3. `js/vault-ui.js` — Duplikat-Prüfung + Bestätigungs-UI + Edit-Modus
4. `js/vault-ui.js` — Passwort sichtbar schalten (👁-Button in Liste)
