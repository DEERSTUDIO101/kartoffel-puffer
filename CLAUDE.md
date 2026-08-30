# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"Kartoffel Puffer" (`package.json` name: `kartoffel-puffer`) is a custom Chromium-based web browser built on Electron. It's a single-window multi-tab browser shell (`<webview>`-based) with a bundled uBlock Origin extension, a built-in encrypted password vault, per-site autofill, and a separate always-on-top "AI Assistant" window that embeds several AI chat providers (Claude, ChatGPT, Gemini, Perplexity, Copilot, Grok, DeepSeek, Mistral) as webviews and can exchange page context/URLs with the main browser window via IPC.

UI text and in-app strings are primarily German (variable/comment names mix German and English).

## Commands

- Install deps: `npm install`
- Run the app: `npm start` (runs `electron .`)
- Run with inspector: `npm run dev` (runs `electron . --inspect`)

There is no build step, bundler, linter, or test runner configured — `test.js` at the repo root is **not** a test suite, see Known state below.

## Architecture

Electron main/renderer split, with two independent top-level windows:

- **`main.js`** — Electron main process. Owns:
  - Window lifecycle for the main browser window (`mainWin`, frameless, loads `index.html` via `preload.js`) and the AI assistant window (`aiWin`, frameless/always-on-top, loads `ai-window.html` via `preload-ai.js`).
  - Loads the bundled uBlock Origin extension from `extensions/ublock/uBlock0.chromium` into `session.defaultSession` on startup.
  - The password vault, implemented **in-process** directly in `main.js` (AES-256-GCM, key derived via PBKDF2 from `app.getPath('userData')`, auto-unlocked at startup — no user master password in this version). All vault IPC handlers (`passwords:*`) live here.
  - IPC bridges: window controls (`win-*`), AI window controls/context relay (`ai-*`), clipboard, `shell:openExternal`.
- **`preload.js`** — exposes `window.electronAPI` (window controls, AI window open/close, context push, clipboard, passwords) to the main window renderer via `contextBridge`. `contextIsolation: true`, `nodeIntegration: false`.
- **`preload-ai.js`** — exposes `window.aiAPI` to the AI window renderer (its own window controls/drag, `getContext`/`onBrowserContext` for receiving page context from the main window, `openUrl` to ask the browser to navigate, clipboard).
- **`ai-window.html`** — self-contained AI assistant window: provider tabs, each provider loaded as its own `<webview>` with a distinct persisted partition (`persist:kp-ai-<providerId>`) so sessions/logins don't collide between providers.
- **Renderer (main window) logic** — tabs are managed by a plain array of tab objects (`{id, url, title, isNewTab, webviewEl, newtabEl}`); each real tab is a `<webview partition="persist:kp">`. Settings/bookmarks/history persist to `localStorage` (`kp-settings-v3`, `kp-bookmarks-v1`, `kp-history-v1`) — there is no on-disk settings file. Extensive theming (colors, backgrounds, fonts, layout) is applied live via CSS custom properties from a single `cfg` settings object.
- **`js/i18n.js`** — language/translation tables for the settings UI (20 languages defined) — not yet wired into a live renderer.
- **`js/ui-builder.js`** — an in-app drag-and-drop toolbar/layout editor ("UI Builder mode") operating on element IDs (`navBar`, `tabBar`, `bookmarksBar`, etc.) that only exist once the renderer is wired to a real `index.html`.
- **`js/extension-loader.js`** — a from-scratch Chrome extension (Manifest V2/V3) content-script loader + `chrome`/`browser` API polyfill (storage, runtime, i18n, tabs, notifications, action) for injecting **user-installed** extensions (`extensions/user/<id>/`) into webviews on `loadcommit`; separate from the bundled uBlock extension, which is loaded natively via `session.loadExtension`.
- **`vault.js`** — a more elaborate *standalone* vault module (PBKDF2-SHA512 600k iterations, machine-binding via HMAC of hostname/user/platform, self-integrity hash check of its own file, chaff/decoy entries, idle auto-lock) written for an NW.js-style `require()` renderer. This is a different, richer implementation than the simple vault embedded in `main.js` — check which one is actually wired up before assuming vault behavior.
- **`extensions/ublock/`** — vendored uBlock Origin (Chromium build), loaded unmodified as an unpacked extension.

## Known state / traps for future work

- **`index.html` is currently empty.** The actual renderer markup+script that `main.js` loads does not exist yet — the real UI logic appears to live in `test.js` (despite its name, it's not a test file; it's renderer code written for an NW.js `require('./vault.js')` style app, referencing `os`, `path`, and DOM element IDs used by `js/ui-builder.js`/`js/i18n.js`). Treat `test.js` as a source-of-truth draft to migrate into `index.html`, not as a test suite.
- **Two competing vault implementations** exist: the simple one inlined in `main.js` (currently live, IPC-based, auto-unlocked with a machine key) and the standalone `vault.js` (richer: master password, chaff, self-hash check, meant to be `require()`d directly by a renderer, e.g. as `test.js` does). They are not integrated with each other.
- **`main.electron.bak`, `preload.electron.bak`, `vault-process.electron.bak`** are earlier abandoned Electron architectures (separate forked `vault-process.js` using `safeStorage`, `@cliqz/adblocker-electron` for ad-blocking) superseded by the current simpler design (in-process vault, bundled uBlock extension). Useful for historical context, not active code.
- `start.log` shows an even earlier `nw .` (NW.js) invocation from when the project was `KP-browser@0.1.0` — the project has migrated NW.js → Electron at least once.
