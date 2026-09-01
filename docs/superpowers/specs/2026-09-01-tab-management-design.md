# Tab-Management — Design Spec
**Datum:** 2026-09-01  
**Status:** Approved  
**Scope:** Phase 1 von 4 (Tab-Gruppen, Workspaces, Tab-Suche)

---

## Überblick

Drei zusammenhängende Features die das Tab-Erlebnis grundlegend verbessern:
1. **Tab-Gruppen** — farblich kodierte Gruppen, erstellt per Rechtsklick oder Drag-and-Drop
2. **Workspaces / Session-Restore** — automatisches Speichern und Wiederherstellen aller Tabs beim Schließen
3. **Tab-Suche** — Overlay per Ctrl+Shift+A zum schnellen Wechseln zwischen offenen Tabs

---

## 1. Tab-Gruppen

### Datenmodell

Tab-Objekte werden um ein optionales Feld erweitert:

```js
// vorher
{ id, url, title, isNewTab, webviewEl, newtabEl }

// nachher
{ id, url, title, isNewTab, webviewEl, newtabEl, groupId: null | string }
```

Gruppen werden separat verwaltet:

```js
// kp-tab-groups-v1 in localStorage
[
  { id: 'g1', name: 'Arbeit', color: '#4f8ef7' },
  { id: 'g2', name: 'Gaming', color: '#22c55e' }
]
```

Farb-Palette: 8 voreingestellte Farben (Blau, Grün, Rot, Orange, Lila, Pink, Türkis, Gelb) — der User wählt beim Erstellen eine davon.

### Visuelles Erscheinungsbild

Tabs mit `groupId` bekommen einen farbigen Hintergrund via CSS-Variable:

```css
.tab[data-group-color] {
  background-color: color-mix(in srgb, var(--group-color) 25%, var(--tab-bg));
  border-top: 2px solid var(--group-color);
}
```

Tabs derselben Gruppe werden im Tab-Bar nebeneinander gehalten (Sortierung nach `groupId`).

### Erstellen — Rechtsklick

Kontextmenü auf Tab erweitert um:
- **„Zu Gruppe hinzufügen"** → Untermenü: bestehende Gruppen + „Neue Gruppe…"
- **„Aus Gruppe entfernen"** (nur sichtbar wenn Tab in einer Gruppe ist)
- **„Gruppe umbenennen / Farbe ändern"**
- **„Alle Tabs dieser Gruppe schließen"**

### Erstellen — Drag-and-Drop

Beim Ziehen eines Tabs über einen anderen Tab (>300ms hover oder Drop):
- Ziel-Tab ist **in einer Gruppe** → gezogener Tab kommt in dieselbe Gruppe
- Ziel-Tab ist **ohne Gruppe** → beide kommen in eine neue Gruppe (Farbe automatisch, Name editierbar per Doppelklick auf Gruppe)

Drop-Indikator: leichte Hervorhebung des Ziel-Tabs während des Drags.

### Persistenz

Gruppen-Array wird in `js/storage.js` unter `kp-tab-groups-v1` gespeichert und beim Start geladen. Tab-Objekte enthalten `groupId` als Teil der Session-Daten (siehe Workspaces).

---

## 2. Workspaces / Session-Restore

### Verhalten

- **Beim Schließen** (`before-quit` Event in `main.js` → IPC → Renderer): aktuelle Tab-Liste (URLs, aktiver Tab-Index, `groupId` pro Tab) + Gruppen-Array werden in `localStorage` unter `kp-session-v1` gespeichert.
- **Beim Start**: Wenn `kp-session-v1` existiert, werden alle gespeicherten Tabs wiederhergestellt statt einem leeren neuen Tab.
- **Neuer Tab** (Ctrl+T) löscht nicht die Session — Session wird nur beim nächsten Schließen überschrieben.

### Datenstruktur

```js
// kp-session-v1
{
  tabs: [
    { url: 'https://...', title: '...', groupId: 'g1' },
    { url: 'https://...', title: '...', groupId: null }
  ],
  activeIndex: 1,
  groups: [ { id: 'g1', name: 'Arbeit', color: '#4f8ef7' } ]
}
```

### Edge Cases

- Leere Session (alle Tabs waren `isNewTab`) → kein Restore, normaler Start mit einem neuen Tab
- Inkognito-Tabs werden **nicht** in der Session gespeichert
- Crash-Recovery: Session wird auch beim normalen Schließen gespeichert, nicht nur bei sauberem Beenden — damit ist ein Crash automatisch abgedeckt

---

## 3. Tab-Suche (Ctrl+Shift+A)

### UI

Overlay, zentriert, ~600px breit, erscheint über allem:

```
┌─────────────────────────────────────────┐
│ 🔍 Tab suchen...                        │
├─────────────────────────────────────────┤
│ 🌐  GitHub — DEERSTUDIO101              │
│ 📄  MDN — Array.prototype.map           │
│ 🎮  Twitch — xQc                        │
│ ...                                     │
└─────────────────────────────────────────┘
```

- Eingabe filtert sofort (Fuzzy-Match auf Titel + URL)
- Aktive Auswahl per Pfeiltasten navigierbar
- Enter oder Klick → springt zum Tab
- Escape / Klick außerhalb → schließt Overlay
- Tab-Gruppe-Farbe als kleiner Punkt links vom Favicon sichtbar

### Implementierung

Reines Renderer-HTML/CSS/JS — kein IPC, kein Main-Prozess. Shortcut wird per `keydown`-Listener auf `document` abgefangen. Das Overlay-Element ist immer im DOM, wird per CSS `display: none/flex` getoggelt.

Fuzzy-Matching: einfache `includes()`-Suche auf `title.toLowerCase() + url.toLowerCase()` — keine externe Bibliothek nötig.

---

## Implementierungsreihenfolge

1. `js/storage.js` — Tab-Gruppen Lade-/Speicher-Funktionen + Session-Restore Funktionen
2. Renderer (`index.html`) — Tab-Objekt um `groupId` erweitern, Gruppen-Array initialisieren
3. Tab-Bar Rendering — farbiger Hintergrund basierend auf `groupId`
4. Rechtsklick-Kontextmenü — Gruppen-Einträge hinzufügen
5. Drag-and-Drop — Gruppen-Erstellung per Tab-über-Tab-ziehen
6. Session-Restore — Speichern beim Schließen, Laden beim Start
7. Tab-Suche Overlay — HTML + CSS + Fuzzy-Filter + Keyboard-Navigation

---

## Was explizit nicht gebaut wird (YAGNI)

- Synchronisation zwischen Geräten
- Gruppen-Import/-Export
- Verschachtelte Gruppen
- Gruppen-Icons (nur Farbe)
- Workspace-Profile (mehrere benannte Sessions) — kommt ggf. in Phase 4
