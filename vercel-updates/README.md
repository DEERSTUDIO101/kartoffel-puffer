# Kartoffel Puffer – Update-Hosting

Dieser Ordner ist ein eigenständiges, minimales Vercel-Projekt. Er hostet **nur**
die Auto-Update-Dateien (nicht den Browser-Quellcode).

## Einmalig einrichten

```powershell
cd R:\Entwicklung\Browser\vercel-updates
vercel login          # falls noch nicht eingeloggt
vercel link            # Projekt erstellen/verknüpfen (Fragen einfach mit Enter/Standard beantworten)
vercel --prod           # deployed diesen Ordner live
```

Nach dem ersten `vercel --prod` bekommst du eine URL wie
`https://kartoffel-puffer-updates.vercel.app`.

**Trage diese URL in `../package.json` unter `build.publish.url` ein**, und zwar
mit `/updates` am Ende:

```json
"publish": { "provider": "generic", "url": "https://DEINE-URL.vercel.app/updates" }
```

## Bei jedem neuen Release

1. Version in `../package.json` hochzählen (z.B. `0.2.0` → `0.2.1`).
2. Installer bauen:
   ```powershell
   cd R:\Entwicklung\Browser
   npm run dist
   ```
3. Aus `dist/` (vom Build erzeugt) diese Dateien in `vercel-updates/updates/` kopieren:
   - `latest.yml`
   - `Kartoffel Puffer Setup <version>.exe`
   - `Kartoffel Puffer Setup <version>.exe.blockmap`
4. Erneut deployen:
   ```powershell
   cd R:\Entwicklung\Browser\vercel-updates
   vercel --prod
   ```

Danach bekommen alle installierten Kopien beim nächsten Start automatisch das
Update angeboten (electron-updater prüft beim App-Start gegen `latest.yml`).
