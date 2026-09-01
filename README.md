# Kartoffel Puffer 🥔

Ein eigener Chromium-Browser auf Electron-Basis mit uBlock Origin, verschlüsseltem Passwort-Tresor, KI-Assistent-Fenster und vielem mehr.

## Features

- Multi-Tab-Browser (`<webview>`-basiert)
- Eingebauter uBlock Origin Ad-/Tracker-Blocker
- Verschlüsselter Passwort-Tresor (AES-256-GCM)
- KI-Assistent-Fenster (Claude, ChatGPT, Gemini, Perplexity, Copilot, Grok, DeepSeek, Mistral)
- Lesezeichen, History, Downloads
- Themen, Fonts, Layout-Einstellungen
- Speech-to-Text (Groq API)
- Browser-Import (Chrome/Firefox/Edge – Lesezeichen, Passwörter, History)

## Voraussetzungen

- **Node.js** v20 oder neuer → [nodejs.org](https://nodejs.org)
- **Git** → [git-scm.com](https://git-scm.com)
- Windows 10/11 x64

## Setup (schnell)

```bat
setup.bat
```

Das Skript installiert alles automatisch (Dependencies + native Module).

## Setup (manuell)

```bash
# 1. Repo klonen
git clone https://github.com/DEERSTUDIO101/kartoffel-puffer.git
cd kartoffel-puffer

# 2. Dependencies installieren
npm install

# 3. Native Module für Electron neu bauen (better-sqlite3 braucht das)
npx electron-rebuild

# 4. App starten
npm start
```

## Befehle

| Befehl | Beschreibung |
|---|---|
| `npm start` | App starten |
| `npm run dev` | App mit DevTools Inspector starten |
| `npm run dist` | Windows-Installer bauen |

## Konfiguration

- **Groq API-Key** (Speech-to-Text): In den Browser-Einstellungen unter „Sprache" eintragen
- **KI-Anbieter**: Im KI-Fenster sind alle Provider voreingestellt, eigene Logins in den jeweiligen Webviews

## Projektstruktur

```
kartoffel-puffer/
├── main.js              # Electron-Main-Prozess (Fenster, IPC, Vault, uBlock)
├── preload.js           # Context-Bridge für Hauptfenster
├── preload-ai.js        # Context-Bridge für KI-Fenster
├── index.html           # Hauptfenster-UI
├── ai-window.html       # KI-Assistent-Fenster
├── js/
│   ├── storage.js       # Settings, Bookmarks, History (localStorage)
│   ├── browser-import.js# Browser-Daten-Import
│   ├── i18n.js          # Übersetzungen (20 Sprachen)
│   ├── ui-builder.js    # Drag-and-Drop Layout-Editor
│   └── extension-loader.js # User-Extension-System
├── extensions/
│   └── ublock/          # Vendored uBlock Origin (Chromium)
└── icons/               # App-Icons
```

## Lizenz

Privates Projekt – DEERSTUDIO101
