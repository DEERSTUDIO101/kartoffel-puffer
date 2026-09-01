@echo off
setlocal enabledelayedexpansion
title Kartoffel Puffer - Setup
color 0A

echo.
echo  ==================================================
echo    Kartoffel Puffer - Setup
echo  ==================================================
echo.

:: Node.js pruefen
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [FEHLER] Node.js wurde nicht gefunden!
    echo.
    echo  Bitte installiere Node.js v20 oder neuer:
    echo  https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=1" %%v in ('node -v 2^>nul') do set NODE_VERSION=%%v
echo  Node.js gefunden: %NODE_VERSION%

:: npm pruefen
where npm >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [FEHLER] npm nicht gefunden - Node.js neu installieren!
    pause
    exit /b 1
)

for /f "tokens=1" %%v in ('npm -v 2^>nul') do set NPM_VERSION=%%v
echo  npm gefunden: v%NPM_VERSION%
echo.

:: Dependencies installieren
echo  [1/2] Installiere npm-Dependencies...
echo  ----------------------------------------
npm install
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo  [FEHLER] npm install fehlgeschlagen!
    echo  Pruefen: Ist Node.js korrekt installiert?
    pause
    exit /b 1
)

echo.
echo  [2/2] Baue native Module fuer Electron (better-sqlite3)...
echo  ----------------------------------------
npx electron-rebuild
if %errorlevel% neq 0 (
    color 0E
    echo.
    echo  [WARNUNG] electron-rebuild hat einen Fehler gemeldet.
    echo  Versuche trotzdem zu starten - eventuell funktioniert es.
)

echo.
echo  ==================================================
echo    Setup abgeschlossen!
echo  ==================================================
echo.
echo  App starten:   npm start
echo  Dev-Modus:     npm run dev
echo.

set /p AUTOSTART="App jetzt starten? (j/n): "
if /i "%AUTOSTART%"=="j" (
    echo.
    echo  Starte Kartoffel Puffer...
    npm start
)

endlocal
