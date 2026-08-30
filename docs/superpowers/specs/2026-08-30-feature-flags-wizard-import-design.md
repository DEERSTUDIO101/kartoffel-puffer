# Design: Feature-Flags, Setup-Wizard & Browser-Import

**Datum:** 2026-08-30  
**Status:** Genehmigt  
**Projekt:** Kartoffel Puffer Browser

---

## Überblick

Drei zusammenhängende Features:

1. **Feature-Flags** — jedes Feature des Browsers kann einzeln ein-/ausgeschaltet werden
2. **Setup-Wizard** — erscheint beim ersten Start, führt den Nutzer durch Import und Feature-Auswahl
3. **Browser-Import** — Lesezeichen, Passwörter und Verlauf aus anderen Browsern importieren

---

## 1. Feature-Flags

### Datenpersistenz

Flags werden als `features`-Unterkey im bestehenden `cfg`-Objekt gespeichert (localStorage `kp-settings-v3`):

```js
cfg.features = {
  devicePreview: true,
  aiSidebar: true,
  aiWindow: true,
  speechToText: true,
  eyedropper: true,
  fontInspector: true,
  vault: true,
  extensionManager: true,
  uiBuilder: true,
  browserImport: true,
}
```

Fehlende Keys werden beim Start mit `true` (Standard) aufgefüllt — vorhandene Installs ohne `features`-Key verlieren keine Funktionalität.

### Anwendung zur Laufzeit

Beim App-Start (und bei jeder Änderung) werden aktive Features als CSS-Klassen auf `<body>` gesetzt:

```js
// Feature aktiv → Klasse setzen, inaktiv → entfernen
Object.entries(cfg.features).forEach(([key, enabled]) => {
  document.body.classList.toggle(`feat--${key}`, enabled);
});
```

UI-Elemente die zu einem Feature gehören, erhalten passendes CSS:

```css
body:not(.feat--devicePreview) .device-preview-btn { display: none; }
body:not(.feat--speechToText) .stt-btn { display: none; }
/* etc. */
```

Features mit IPC-Anteil (z.B. Speech-to-Text) prüfen den Flag in `main.js` bevor der IPC-Handler registriert wird. Da IPC-Handler nicht dynamisch abgemeldet werden können, wird der Handler registriert, gibt aber bei deaktiviertem Feature sofort zurück.

### Feature-Liste (vollständig)

| Key | Label (DE) | Beschreibung |
|-----|------------|--------------|
| `devicePreview` | Gerätevorschau | Responsive-Vorschau für verschiedene Bildschirmgrößen |
| `aiSidebar` | AI-Sidebar | Eingebettete AI-Sidebar im Browserfenster |
| `aiWindow` | AI-Assistenten-Fenster | Separates always-on-top Fenster mit AI-Anbietern |
| `speechToText` | Sprache-zu-Text | Diktierfunktion in der URL-Leiste |
| `eyedropper` | Farbpipette | Farben von Webseiten aufnehmen (Kontext-Menü) |
| `fontInspector` | Schrift-Inspektor | Schriftart-Informationen von Elementen (Kontext-Menü) |
| `vault` | Passwort-Tresor | Verschlüsselter Passwort-Manager mit Autofill |
| `extensionManager` | Erweiterungs-Verwaltung | Benutzerdefinierte Browser-Erweiterungen laden |
| `uiBuilder` | UI-Editor | Drag-and-Drop Toolbar-Layout-Editor |
| `browserImport` | Browser-Import | Daten aus anderen Browsern importieren |

---

## 2. Setup-Wizard

### Auslöser

Der Wizard erscheint beim ersten Start: erkennbar daran, dass `kp-settings-v3` in localStorage **nicht** vorhanden ist. Danach nie wieder automatisch — nur über "Setup-Wizard erneut starten" in den Einstellungen.

### Struktur (4 Schritte)

**Schritt 1 — Willkommen**
- Kartoffel Puffer Logo + Name
- Kurzer Satz: "Lass uns den Browser auf deinen Workflow einrichten."
- Button: "Los geht's"

**Schritt 2 — Daten importieren** *(optional, überspringbar)*
- Überschrift: "Daten aus einem anderen Browser importieren"
- Erkannte Browser werden als Karten angezeigt (Icon + Name)
- Falls kein Browser erkannt: nur "Datei auswählen" Buttons
- Checkboxen: was soll importiert werden (Lesezeichen / Passwörter / Verlauf)
- Buttons: "Importieren" und "Überspringen"

**Schritt 3 — Features wählen**
- Überschrift: "Welche Features möchtest du nutzen?"
- Alle Features als Karten mit Icon, Name, kurzer Beschreibung und Toggle
- Standardmäßig alle aktiviert
- Kein "Weiter" nötig bis der Nutzer bereit ist

**Schritt 4 — Fertig**
- "Alles bereit!" + kurze Zusammenfassung was importiert/aktiviert wurde
- Button: "Browser starten"
- Wizard schließt sich, Einstellungen werden gespeichert

### Implementierung

- Wizard ist ein Fullscreen-Overlay (`position: fixed; inset: 0; z-index: 9999`) in `index.html`
- Schritt-Navigation per JS, kein Reload
- Wird nach Abschluss aus dem DOM entfernt (nicht nur versteckt)

---

## 3. Browser-Import

### Erkannte Browser (automatischer Schnellimport)

Bekannte Datei-Pfade werden beim Wizard-Start geprüft (via IPC `import:detectBrowsers`):

| Browser | Lesezeichen | Passwörter | Verlauf |
|---------|-------------|------------|---------|
| Chrome | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Bookmarks` | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Login Data` | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\History` |
| Edge | `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Bookmarks` | `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Login Data` | `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\History` |
| Brave | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Bookmarks` | `...Login Data` | `...History` |
| Opera | `%APPDATA%\Opera Software\Opera Stable\Bookmarks` | `...Login Data` | `...History` |
| Firefox | `%APPDATA%\Mozilla\Firefox\Profiles\*.default*\places.sqlite` | nur via CSV-Export | (via places.sqlite) |

### Manueller Import (Fallback)

- Lesezeichen: HTML-Datei (Netscape Bookmark Format — alle Browser unterstützen Export)
- Passwörter: CSV-Datei (Chrome/Firefox/Bitwarden Export-Format)
- Verlauf: (kein universelles Format — nur via direktem Browser-Datei-Zugriff)

### Datei-Formate & Parsing

**Lesezeichen — Chrome/Edge/Brave JSON:**
```
{ "roots": { "bookmark_bar": { "children": [...] } } }
```
→ Rekursiv in Kartoffel Puffer `kp-bookmarks-v1` Format konvertieren.

**Lesezeichen — Firefox places.sqlite:**
SQLite-Datei, Tabelle `moz_bookmarks` + `moz_places` joinen.
Bibliothek: `better-sqlite3` (muss als Dependency hinzugefügt werden: `npm install better-sqlite3`).

**Lesezeichen — HTML (Netscape):**
DOM-Parser: `<DT><A HREF="..." ADD_DATE="...">Title</A>`

**Passwörter — Chrome Login Data (SQLite):**
Tabelle `logins`: `origin_url`, `username_value`, `password_value`.
`password_value` ist mit Windows DPAPI + AES-256-GCM verschlüsselt.
Entschlüsselung: `encryption_key` aus `Local State` JSON → DPAPI → AES-GCM.
In Electron mit Node.js `crypto` + `child_process` (PowerShell DPAPI) machbar.

**Passwörter — CSV:**
Spalten: `name,url,username,password` (Chrome-Format)
→ Direkt in Vault importieren.

**Verlauf — SQLite (Chrome/Firefox):**
Chrome: Tabelle `urls` (`url`, `title`, `last_visit_time`)
Firefox: Tabelle `moz_places` + `moz_historyvisits`
→ In `kp-history-v1` (localStorage, max. 50k Einträge) importieren, neueste zuerst.

### IPC-Architektur

Alles läuft im Main-Prozess (`main.js`):
- `import:detectBrowsers` → gibt Liste erkannter Browser zurück
- `import:run` → `{ browser, types: ['bookmarks','passwords','history'] }` → führt Import durch, gibt Ergebnis zurück
- `import:fromFile` → `{ type, filePath }` → manueller Import aus Datei

---

## 4. Settings-Integration

Neuer Tab **"Features"** in den Einstellungen:
- Gleiche Karten-Checkliste wie Wizard Schritt 3
- Änderungen greifen sofort (CSS-Klassen live updaten, `cfg` speichern)
- Ganz unten: Button **"Setup-Wizard erneut starten"** — öffnet Wizard-Overlay neu, setzt `cfg.features` zurück auf alle `true`

---

## Technische Abhängigkeiten

- `better-sqlite3` — für SQLite-Parsing (Chrome History/Bookmarks, Firefox places.sqlite). **Noch nicht in package.json** — muss hinzugefügt werden.
- Windows DPAPI für Chrome-Passwort-Entschlüsselung — via PowerShell `[System.Security.Cryptography.ProtectedData]::Unprotect(...)` aus Node.js heraus aufrufen.
- Kein neuer Persistenz-Layer — alles in bestehendem `cfg`/localStorage-System.

---

## Was explizit nicht gebaut wird

- Keine Browser-Erkennung auf macOS/Linux (Windows-only für jetzt)
- Kein Sync zwischen Geräten
- Keine automatischen Passwort-Updates zurück in den Quell-Browser
