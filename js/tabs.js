// ── TABS ──────────────────────────────────────────────────────────────────────
let tabs = [], activeTabId = null, tabIdCounter = 0;
let groups = [];
const GROUP_COLORS = ['#4f8ef7','#22c55e','#ef4444','#f97316','#a855f7','#ec4899','#06b6d4','#eab308'];

// Eigener kosmetischer Ad-Ausblender: uBlocks eigenes Content-Script läuft in einer
// isolierten Welt, auf die wir vom Host aus keinen Zugriff haben (Electron unterstützt
// dafür keine öffentliche API). Als Ergänzung blenden wir bekannte native Ad-Container
// selbst per CSS aus — bei jeder Navigation (auch SPA-Wechsel) neu angewendet.
const AD_HIDE_CSS_BY_HOST = {
  'youtube.com': `
    ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer,
    ytd-statement-banner-renderer, tp-yt-paper-dialog:has(ytd-mealbar-promo-renderer),
    #masthead-ad, .ytd-display-ad-renderer,
    .ytp-ad-module, .ytp-ad-overlay-container, .ytp-ad-text-overlay, .ytp-ad-player-overlay,
    ytd-in-player-ad-message-renderer { display: none !important; }
  `,
  'facebook.com': `div[aria-label="Sponsored"], div[data-pagelet*="FeedUnit"]:has(a[aria-label="Sponsored"]) { display: none !important; }`,
  'instagram.com': `article:has(a[href*="/ads/"]) { display: none !important; }`,
};
// Reine CSS-Ausblendung stoppt Video-Werbung im YouTube-Player nicht (Ton/Zeit
// laufen weiter) und die vorherige Liste kannte nur Feed-/Banner-Ads, keine
// In-Player-Ads. Zusätzlich ein aktiver Skip-Watcher: erkennt die von YouTube
// gesetzte 'ad-showing'/'ad-interrupting'-Klasse am Player, klickt den
// Skip-Button falls vorhanden, sonst wird die Ad stummgeschaltet und ans Ende
// gespult. Läuft als Intervall dauerhaft im Tab (auch für später auftretende
// Mid-Roll-Ads, nicht nur beim initialen Laden).
const YT_AD_SKIP_SCRIPT = `(function(){
  if (window.__kpYtAdSkip) return;
  window.__kpYtAdSkip = true;
  setInterval(function(){
    var player = document.querySelector('.html5-video-player');
    if (!player) return;
    var adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    if (!adShowing) return;
    var skipBtn = document.querySelector('.ytp-ad-skip-button-modern, .ytp-ad-skip-button, .ytp-skip-ad-button');
    if (skipBtn) { skipBtn.click(); return; }
    var video = document.querySelector('video');
    if (video && isFinite(video.duration) && video.duration > 0) {
      video.muted = true;
      video.currentTime = video.duration;
    }
  }, 300);
})()`;
// ── Bild-im-Bild-Knopf auf Videos (wie in Firefox) ───────────────────────────
// Wird IN der Seite ausgeführt, damit der Klick eine echte Nutzergeste ist —
// requestPictureInPicture() verlangt das zwingend.
const PIP_BUTTON_SCRIPT = `(function(){
  if (window.__kpPip) return;
  window.__kpPip = true;
  if (!document.pictureInPictureEnabled) return;

  var btn = document.createElement('button');
  btn.id = '_kpPipBtn';
  btn.title = 'Bild-im-Bild';
  btn.setAttribute('aria-label','Bild-im-Bild');
  btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="#fff"/></svg>';
  btn.style.cssText = 'position:absolute;z-index:2147483600;display:none;align-items:center;justify-content:center;'
    + 'width:34px;height:34px;border:none;border-radius:8px;cursor:pointer;padding:0;'
    + 'background:rgba(15,20,32,.82);box-shadow:0 2px 10px rgba(0,0,0,.5);backdrop-filter:blur(4px)';
  document.documentElement.appendChild(btn);

  var current = null, hideTimer = null;

  function place(v){
    var r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 150) return false;   // Mini-Videos ignorieren
    btn.style.left = (r.right + window.scrollX - 44) + 'px';
    btn.style.top  = (r.top   + window.scrollY + 10) + 'px';
    btn.style.display = 'flex';
    return true;
  }
  function show(v){ current = v; clearTimeout(hideTimer); if(!place(v)) hide(); }
  function hide(){ hideTimer = setTimeout(function(){ btn.style.display='none'; current=null; }, 350); }

  document.addEventListener('mouseover', function(e){
    var v = e.target && e.target.tagName === 'VIDEO' ? e.target : null;
    if (v) show(v);
  }, true);
  document.addEventListener('mouseout', function(e){
    if (e.target && e.target.tagName === 'VIDEO') hide();
  }, true);
  btn.addEventListener('mouseenter', function(){ clearTimeout(hideTimer); });
  btn.addEventListener('mouseleave', hide);
  window.addEventListener('scroll', function(){ if(current) place(current); }, true);

  btn.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    var v = current || document.querySelector('video');
    if (!v) return;
    if (document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
    v.requestPictureInPicture().catch(function(){});
  });
})()`;

function injectAdHideCss(tab) {
  if (!cfg.adblock) return;
  if (!tab || !tab.webviewEl || !tab.url || tab.url === 'newtab') return;
  let host;
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return; }
  const rules = Object.entries(AD_HIDE_CSS_BY_HOST).find(([h]) => host === h || host.endsWith('.' + h));
  if (rules) {
    const css = rules[1];
    tab.webviewEl.executeJavaScript(`
      (function(){
        let el = document.getElementById('_kpAdHide');
        if (!el) { el = document.createElement('style'); el.id = '_kpAdHide'; document.documentElement.appendChild(el); }
        el.textContent = ${JSON.stringify(css)};
      })()
    `).catch(() => {});
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    tab.webviewEl.executeJavaScript(YT_AD_SKIP_SCRIPT).catch(() => {});
  }
}

// ── Tracking-Parameter aus URLs entfernen ("Saubere Link-Adresse kopieren") ──
// Alles mit utm_-Präfix wird generisch entfernt, der Rest sind bekannte
// Klick-IDs der großen Werbenetzwerke/Plattformen.
const TRACKING_PARAMS = new Set([
  'gclid','gclsrc','dclid','wbraid','gbraid','fbclid','msclkid','twclid','yclid','ttclid',
  'igshid','igsh','si','mc_cid','mc_eid','_hsenc','_hsmi','hsCtaTracking','vero_id','vero_conv',
  'oly_anon_id','oly_enc_id','ref_src','ref_url','spm','scm','share_source','share_medium',
  'trk','trkCampaign','sc_channel','sc_campaign','ck_subscriber_id','pk_campaign','pk_kwd',
  'piwik_campaign','matomo_campaign','s_kwcid','ef_id','epik','cmpid','icid','ncid','sourceId',
]);
function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    let removed = 0;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key) || /^utm_/i.test(key)) { u.searchParams.delete(key); removed++; }
    }
    return { url: u.toString(), removed };
  } catch { return { url: raw, removed: 0 }; }
}

function attachWebviewEvents(wv, id) {
  attachShortcutForwarding(wv, id);
  wv.addEventListener('new-window', e => { e.preventDefault(); if(e.url) createTab(e.url); });
  const handleNav = (url) => {
    const tab = tabs.find(t => t.id === id);
    if (tab) {
      tab.url = url;
      if (activeTabId === id) {
        document.getElementById('urlbar').value = url;
        updateSecBadge(url); updateBookmarkBtn(url); updateAiCtxUrl();
      }
      injectAdHideCss(tab);
      saveSessionTabs();
    }
  };
  // Trefferzahl der Seitensuche an die Such-Leiste melden
  wv.addEventListener('found-in-page', e => { if (id === activeTabId) handleFoundInPage(e.result); });
  // Gemerkte Zoomstufe der Domain wiederherstellen (erst wenn die Seite steht,
  // vorher setzt Chromium den Faktor beim Navigieren wieder zurück)
  wv.addEventListener('dom-ready', () => {
    if (!wv.isConnected) return; // Webview schon aus DOM entfernt
    const tab = tabs.find(t => t.id === id);
    if (tab) applyStoredZoom(wv, tab.url);
    if (cfg.pipButton !== false) wv.executeJavaScript(PIP_BUTTON_SCRIPT).catch(() => {});
  });
  wv.addEventListener('did-navigate', e => handleNav(e.url));
  wv.addEventListener('did-navigate-in-page', e => { if (e.isMainFrame) handleNav(e.url); });
  wv.addEventListener('did-stop-loading', () => {
    if (!wv.isConnected) return;
    const tab = tabs.find(t => t.id === id);
    if (activeTabId === id && tab) {
      injectAdHideCss(tab);
      window.__kpCurrentContext = { url: tab.url, title: tab.title || tab.url };
      // did-stop-loading kann mehrfach pro Seite feuern (SPAs) — nur bei echtem URL-Wechsel weiterreichen,
      // sonst spammt das den AI-Kontext-Push und lässt mehrere Sendungen überlappend racen.
      if (tab.url !== _lastPushedCtxUrl) {
        _lastPushedCtxUrl = tab.url;
        if (window.electronAPI) window.electronAPI.aiContextUpdate(window.__kpCurrentContext);
        autoSendCtxIfEnabled();
      }
    }
  });
  wv.addEventListener('page-title-updated', e => {
    const tab = tabs.find(t => t.id === id);
    if (tab) { tab.title = e.title || tab.url; if (!tab.incognito) addToHistory(tab.url, tab.title); renderTabBar(); }
  });
  wv.addEventListener('page-favicon-updated', e => {
    const tab = tabs.find(t => t.id === id);
    if (tab && e.favicons?.length) {
      tab.favicon = e.favicons[0];
      faviconCacheSet(tab.url, tab.favicon); // per Hostname cachen
      renderTabBar();
    }
  });
  wv.addEventListener('context-menu', e => {
    e.preventDefault();
    const p  = e.params     || {};
    const ef = p.editFlags  || {};
    const mf = p.mediaFlags || {};
    const items = [];

    // ── EDITIERBARE FELDER (Input, Textarea, contenteditable) ──────────
    if (p.isEditable) {
      if (ef.canUndo)      items.push({ label: '↩ Rückgängig',      click: () => wv.executeJavaScript('document.execCommand("undo")').catch(()=>{}) });
      if (ef.canRedo)      items.push({ label: '↪ Wiederherstellen', click: () => wv.executeJavaScript('document.execCommand("redo")').catch(()=>{}) });
      if (ef.canUndo || ef.canRedo) items.push('-');
      if (ef.canCut)       items.push({ label: '✂ Ausschneiden',    accel: 'Strg+X', click: () => wv.executeJavaScript('document.execCommand("cut")').catch(()=>{}) });
      if (ef.canCopy)      items.push({ label: '📋 Kopieren',        accel: 'Strg+C', click: () => wv.executeJavaScript('document.execCommand("copy")').catch(()=>{}) });
      if (ef.canPaste)     items.push({ label: '📋 Einfügen',        accel: 'Strg+V', click: () => wv.executeJavaScript('document.execCommand("paste")').catch(()=>{}) });
      if (ef.canSelectAll) items.push({ label: '⬛ Alles auswählen', accel: 'Strg+A', click: () => wv.executeJavaScript('document.execCommand("selectAll")').catch(()=>{}) });
      items.push('-');
    }

    // ── TEXTAUSWAHL (nur auf nicht-editierbaren Elementen) ─────────────
    if (p.selectionText && !p.isEditable) {
      const sel = p.selectionText.trim();
      const selPreview = sel.length > 25 ? sel.slice(0,25)+'…' : sel;
      items.push(
        { label: '📋 Kopieren', accel: 'Strg+C', click: () => navigator.clipboard.writeText(sel) },
        { label: `🔍 Nach "${selPreview}" suchen`, click: () => {
          const engine = (cfg.searchEngine === 'custom' ? cfg.customSearchUrl : cfg.searchEngine) || 'https://www.google.com/search?q=';
          createTab(engine + encodeURIComponent(sel));
        }},
        '-',
        { label: '📄 Zusammenfassen', click: () => sendToAI(
          `Fasse folgenden Text kurz und prägnant auf Deutsch zusammen:\n\n${sel}`
        )},
        { label: '✨ Vereinfachen',   click: () => sendToAI(
          `Schreibe folgenden Text in einfacher, klarer Sprache um (Zielgruppe: Laie):\n\n${sel}`
        )},
        { label: '💬 Erklären',       click: () => sendToAI(
          `Erkläre folgenden Text verständlich und ausführlich auf Deutsch:\n\n${sel}`
        )},
      );
      items.push('-');
    }

    // ── LINK ───────────────────────────────────────────────────────────
    if (p.linkURL) {
      items.push(
        { label: '🔗 Link in neuem Tab öffnen',     click: () => createTab(p.linkURL) },
        { label: '🕵️ Link in Inkognito-Tab öffnen', click: () => createTab(p.linkURL, true) },
        '-',
        { label: '💾 Linkziel speichern',            click: () => window.electronAPI?.downloads?.startUrl(p.linkURL) },
        { label: '📋 Link-Adresse kopieren',          click: () => navigator.clipboard.writeText(p.linkURL) },
      );
      // Nur anbieten, wenn wirklich etwas zu entfernen ist (sonst ausgegraut,
      // wie in Edge/Chrome)
      const cleaned = cleanUrl(p.linkURL);
      items.push({
        label: '🧹 Saubere Link-Adresse kopieren',
        disabled: cleaned.removed === 0,
        click: () => { navigator.clipboard.writeText(cleaned.url); showToast(`${cleaned.removed} Tracking-Parameter entfernt`); },
      });
      if (p.linkText) items.push({ label: '📋 Linktext kopieren', click: () => navigator.clipboard.writeText(p.linkText) });
      items.push({ label: '🔖 Lesezeichen für Link', click: () => {
        const bm = loadBookmarks();
        if (!bm.some(b => b.url === p.linkURL)) {
          bm.push({ url: p.linkURL, title: p.linkText || p.linkURL, favicon: null });
          saveBookmarks(bm); renderBookmarksBar();
          showToast('Lesezeichen hinzugefügt');
        } else {
          showToast('Bereits als Lesezeichen gespeichert');
        }
      }});
      items.push('-');
    }

    // ── BILD ───────────────────────────────────────────────────────────
    // blob:-URLs sind an den Guest-Renderer der Seite gebunden – weder ein neuer
    // Tab noch ein Main-Prozess-Download/Copy (net.request) kann sie auflösen.
    if (p.mediaType === 'image' && p.srcURL && !p.srcURL.startsWith('blob:')) {
      items.push(
        { label: '🖼 Bild in neuem Tab öffnen', click: () => createTab(p.srcURL) },
        { label: '📋 Bild kopieren', click: async () => {
          const ok = await window.electronAPI?.copyImage?.(p.srcURL);
          showToast(ok ? 'Bild kopiert' : 'Bild konnte nicht kopiert werden');
        }},
        { label: '📋 Bild-URL kopieren',         click: () => navigator.clipboard.writeText(p.srcURL) },
        { label: '💾 Bild speichern',            click: () => window.electronAPI?.downloads?.startUrl(p.srcURL) },
        { label: '🔍 Bild mit Google Lens suchen', click: () => createTab('https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(p.srcURL)) },
      );
      items.push('-');
    }

    // ── VIDEO ───────────────────────────────────────────────────────────
    if (p.mediaType === 'video') {
      // 2. Parameter = userGesture. Ohne ihn scheitern requestPictureInPicture()
      // und requestFullscreen() mit "NotAllowedError: Must be handling a user
      // gesture" — der Fehler wurde vorher stillschweigend verschluckt.
      const jsV = (code) => wv.executeJavaScript(`(function(){const v=document.querySelector('video');if(!v)return;${code}})()`, true)
        .catch(err => showToast('Nicht möglich: ' + String(err?.message || err).split(':').pop().trim()));
      items.push(
        { label: mf.isPaused ? '▶ Abspielen' : '⏸ Pausieren',     click: () => jsV('v.paused?v.play():v.pause()') },
        { label: mf.isMuted  ? '🔊 Ton an'   : '🔇 Ton aus',       click: () => jsV('v.muted=!v.muted') },
        { label: '⏩ Geschwindigkeit', submenu: [
          { label: '0.25×',     click: () => jsV('v.playbackRate=0.25') },
          { label: '0.5×',      click: () => jsV('v.playbackRate=0.5') },
          { label: '0.75×',     click: () => jsV('v.playbackRate=0.75') },
          { label: '1× Normal', click: () => jsV('v.playbackRate=1') },
          { label: '1.25×',     click: () => jsV('v.playbackRate=1.25') },
          { label: '1.5×',      click: () => jsV('v.playbackRate=1.5') },
          { label: '2×',        click: () => jsV('v.playbackRate=2') },
          { label: '3×',        click: () => jsV('v.playbackRate=3') },
        ]},
        { label: mf.isLooping          ? '🔁 Schleife aus'        : '🔁 Schleife an',        click: () => jsV('v.loop=!v.loop') },
        { label: mf.isControlsVisible  ? '🎛 Steuerung ausblenden' : '🎛 Steuerung anzeigen', click: () => jsV('v.controls=!v.controls') },
        { label: '⛶ Vollbild',                                                                  click: () => jsV('v.requestFullscreen?.()') },
        { label: mf.isShowingPictureInPicture ? '🎞 Bild-im-Bild beenden' : '🎞 Bild-im-Bild', click: () => jsV('v.requestPictureInPicture?.()') },
      );
      if (p.srcURL && !p.srcURL.startsWith('blob:')) {
        items.push(
          '-',
          { label: '📋 Video-URL kopieren', click: () => navigator.clipboard.writeText(p.srcURL) },
          { label: '💾 Video speichern',    click: () => window.electronAPI?.downloads?.startUrl(p.srcURL) },
        );
      }
      items.push('-');
    }

    // ── AUDIO ───────────────────────────────────────────────────────────
    if (p.mediaType === 'audio' && p.srcURL) {
      const jsA = (code) => wv.executeJavaScript(`(function(){const a=document.querySelector('audio');if(!a)return;${code}})()`, true).catch(()=>{});
      items.push(
        { label: mf.isPaused ? '▶ Abspielen' : '⏸ Pausieren', click: () => jsA('a.paused?a.play():a.pause()') },
        { label: mf.isMuted  ? '🔊 Ton an'   : '🔇 Ton aus',   click: () => jsA('a.muted=!a.muted') },
        { label: '📋 Audio-URL kopieren', click: () => navigator.clipboard.writeText(p.srcURL) },
      );
      items.push('-');
    }

    // ── SEITENNAVIGATION ────────────────────────────────────────────────
    // Zurück/Vorwärts ausgrauen wenn es nichts zu navigieren gibt (wie Chrome)
    items.push(
      { label: '← Zurück',    accel: 'Alt+←',  disabled: !wv.canGoBack(),    click: () => wv.goBack() },
      { label: '→ Vorwärts',  accel: 'Alt+→',  disabled: !wv.canGoForward(), click: () => wv.goForward() },
      { label: '↻ Neu laden', accel: 'Strg+R', click: () => wv.reload() },
    );

    // ── SEITEN-AKTIONEN ──────────────────────────────────────────────────
    items.push(
      '-',
      { label: '⬛ Alles auswählen', accel: 'Strg+A', click: () => wv.executeJavaScript('document.execCommand("selectAll")').catch(()=>{}) },
      { label: '🖨 Drucken',              accel: 'Strg+P', click: () => wv.print() },
      { label: '💾 Seite speichern unter', accel: 'Strg+S', click: () => {
        const wcId = wv.getWebContentsId?.();
        if (wcId) window.electronAPI?.savePage?.(wcId);
      }},
      { label: '📸 Bildschirmfoto aufnehmen', click: async () => {
        const wcId = wv.getWebContentsId?.();
        if (!wcId) return;
        const res = await window.electronAPI?.screenshot?.(wcId);
        if (res?.ok) showToast('Bildschirmfoto gespeichert');
        else if (res && !res.cancelled) showToast(res.error || 'Aufnahme fehlgeschlagen');
      }},
      { label: '🌐 Seite übersetzen', click: () => {
        const src = wv.getURL?.();
        if (src) createTab('https://translate.google.com/translate?sl=auto&tl=de&u=' + encodeURIComponent(src));
      }},
      { label: '🔍 Quellcode anzeigen',   accel: 'Strg+U', click: () => {
        const src = wv.getURL?.();
        if (src && !src.startsWith('view-source:')) createTab('view-source:' + src);
      }},
    );

    // ── DESIGN-TOOLS ─────────────────────────────────────────────────────────
    const designItems = [];
    if (cfg.features?.eyedropper !== false) {
      designItems.push({ label: '🎨 Farbe aufnehmen', click: async () => {
        if (!window.EyeDropper) { showToast('EyeDropper-API nicht unterstützt'); return; }
        try {
          const res = await new EyeDropper().open();
          await navigator.clipboard.writeText(res.sRGBHex);
          showColorToast(res.sRGBHex);
        } catch {}
      }});
    }
    if (cfg.features?.fontInspector !== false) {
      designItems.push({ label: '🔤 Schrift inspizieren', click: () => {
        const cx = p.x, cy = p.y;
        wv.executeJavaScript(`
          (function(){
            var el = document.elementFromPoint(${cx}, ${cy});
            if (!el) return null;
            var walk = el;
            while (walk && walk !== document.body && walk.children.length && !walk.textContent.trim()) walk = walk.parentElement;
            if (walk && walk !== document.body) el = walk;
            var s = window.getComputedStyle(el);
            return {
              tag: el.tagName.toLowerCase(),
              fontFamily: s.fontFamily, fontSize: s.fontSize,
              fontWeight: s.fontWeight, fontStyle: s.fontStyle,
              lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
              color: s.color, textAlign: s.textAlign,
            };
          })()
        `).then(info => {
          if (info) showFontInspector(info, wvRect.left + cx, wvRect.top + cy);
        }).catch(() => {});
      }});
    }
    if (designItems.length > 0) items.push('-', ...designItems);

    // ── GERÄTEVORSCHAU ──────────────────────────────────────────────────
    if (cfg.features?.devicePreview !== false) {
      items.push(
        '-',
        { label: '📱 Gerätevorschau', submenu: [
          { label: '🖥  Desktop',                 click: () => setDevicePreview(null) },
          '-',
          { label: '▯  Tablet  768×1024',         click: () => setDevicePreview('tab-v', 768, 1024) },
          { label: '▭  Tablet quer  1024×768',    click: () => setDevicePreview('tab-h', 1024, 768) },
          '-',
          { label: '▯  Smartphone  390×844',      click: () => setDevicePreview('mob-v', 390, 844) },
          { label: '▭  Smartphone quer  844×390', click: () => setDevicePreview('mob-h', 844, 390) },
        ]},
      );
    }

    items.push(
      '-',
      // inspectElement öffnet die DevTools direkt auf dem angeklickten Element
      // (wie "Untersuchen" in Chrome/Edge) statt nur generisch die DevTools.
      { label: '🔎 Untersuchen', click: () => wv.inspectElement(p.x, p.y) },
      { label: '🛠 DevTools',    click: () => wv.openDevTools() },
    );

    // p.x/p.y sind Koordinaten im Webview-Koordinatenraum (relativ zur Webview-Oberkante).
    // Für position:fixed-Positionierung des Menüs Viewport-Koordinaten berechnen.
    const wvRect = wv.getBoundingClientRect();
    showCtxMenu(items, wvRect.left + p.x, wvRect.top + p.y);
  });
}

// ── SESSION SPEICHERN ─────────────────────────────────────────────────────────
let _saveSessionTimer = null;
function saveSessionTabs() {
  clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    const activeIdx = tabs.findIndex(t => t.id === activeTabId);
    saveSession(tabs, groups, Math.max(0, activeIdx));
  }, 400);
}

function createTab(url, incognito) {
  const id = ++tabIdCounter;
  const isNewTab = !url || url === 'newtab';
  const content = document.getElementById('content');
  let webviewEl = null, newtabEl = null;

  if (isNewTab) {
    newtabEl = document.createElement('div');
    newtabEl.className = 'newtab-page';
    if (incognito) newtabEl.dataset.incognito = '1';
    buildNewtabContent(newtabEl);
    content.appendChild(newtabEl);
  } else {
    webviewEl = document.createElement('webview');
    // Inkognito: nicht-persistente Partition pro Tab → wird nie auf Platte geschrieben,
    // Cookies/Login/Verlauf verschwinden mit dem Tab.
    webviewEl.setAttribute('partition', incognito ? ('kp-incognito-' + id) : 'persist:kp');
    if (cfg.allowPopups) webviewEl.setAttribute('allowpopups', '');
    webviewEl.setAttribute('src', normalize(url));
    content.appendChild(webviewEl);
    attachWebviewEvents(webviewEl, id);
  }

  const cachedFav = isNewTab ? null : faviconCacheGet(url);
  const tab = { id, url: isNewTab ? 'newtab' : url, title: isNewTab ? 'Neuer Tab' : (url||'Neuer Tab'), favicon: cachedFav, isNewTab, webviewEl, newtabEl, incognito: !!incognito, groupId: null };
  tabs.push(tab);
  activateTab(id);
  renderTabBar();
  saveSessionTabs();
  return tab;
}

function buildNewtabContent(el) {
  const incognito = el.dataset.incognito === '1';
  el.innerHTML = incognito
    ? `<div class="newtab-card" style="background:rgba(30,15,50,.92);border-color:rgba(168,85,247,.3)">
        <h1>🕵️ Inkognito-Tab</h1>
        <p>Verlauf, Cookies und Anmeldedaten dieses Tabs werden nach dem Schließen nicht gespeichert.</p>
        <input class="s-input" style="width:100%;height:44px;border-radius:999px;font-size:.95rem;margin-bottom:1.5rem" placeholder="Suchen oder URL eingeben …"/>
      </div>`
    : `<div class="newtab-card">
    <h1>${escHtml(cfg.browserName)}</h1>
    <p>${escHtml(cfg.browserSubtitle)}</p>
    <input class="s-input" style="width:100%;height:44px;border-radius:999px;font-size:.95rem;margin-bottom:1.5rem" placeholder="Suchen oder URL eingeben …"/>
    <div class="quick-links">${cfg.quickLinks.map(ql=>`<button class="quick-btn" data-url="${escHtml(ql.url)}">${escHtml(ql.label)}</button>`).join('')}</div>
  </div>`;
  applyBgToElement(el);
  el.querySelectorAll('.quick-btn').forEach(b => b.addEventListener('click', () => navigateActiveTab(b.dataset.url)));
  const hs = el.querySelector('input');
  if (hs) hs.addEventListener('keydown', e => { if(e.key==='Enter') navigateActiveTab(hs.value); });
}

function activateTab(id) {
  activeTabId = id;
  tabs.forEach(t => {
    if (t.webviewEl) t.webviewEl.classList.toggle('active', t.id === id);
    if (t.newtabEl)  t.newtabEl.classList.toggle('active',  t.id === id);
  });
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    document.getElementById('urlbar').value = tab.isNewTab ? '' : (tab.url||'');
    updateSecBadge(tab.url); updateBookmarkBtn(tab.url); updateAiCtxUrl();
  }
  renderTabBar();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (!tab.isNewTab && !tab.incognito && tab.url) _lastClosedTabUrl = tab.url;
  if (tab.webviewEl) tab.webviewEl.remove();
  if (tab.newtabEl)  tab.newtabEl.remove();
  tabs.splice(idx, 1);
  if (!tabs.length) createTab('newtab');
  else activateTab(tabs[Math.min(idx, tabs.length-1)].id);
  renderTabBar();
  saveSessionTabs();
}

function renderTabBar() {
  const bar = document.getElementById('tabBar');
  const newBtn = document.getElementById('newTabBtn');
  const winCtrl = document.getElementById('winControls');
  bar.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '') + (t.incognito ? ' incognito' : '');
    el.title = t.title || t.url;
    el.dataset.title = t.title || t.url;
    const group = t.groupId ? groups.find(g => g.id === t.groupId) : null;
    if (group) {
      el.dataset.groupColor = group.color;
      el.style.setProperty('--group-color', group.color);
    }
    const safeTabIcon = t.favicon ? safeFaviconUrl(t.favicon) : null;
    const iconHtml = t.incognito ? `<i data-lucide="glasses" width="14" height="14"></i>` : (safeTabIcon ? `<img src="${escHtml(safeTabIcon)}" class="tab-favicon">` : `<i data-lucide="${t.isNewTab?'file-plus':'globe'}" width="14" height="14"></i>`);
    const dotHtml = group ? `<span class="tab-group-dot" style="background:${escHtml(group.color)}"></span>` : '';
    el.innerHTML = `<span class="tab-icon-wrap">${iconHtml}</span>${dotHtml}<span class="tab-title">${escHtml(t.title)}</span><span class="close-tab"><i data-lucide="x" width="12" height="12"></i></span>`;
    el.addEventListener('click', e => { e.target.closest('.close-tab') ? closeTab(t.id) : activateTab(t.id); });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu([
        { label:'Tab neu laden',    click: () => { if(t.webviewEl) t.webviewEl.reload(); } },
        { label:'Tab duplizieren',  click: () => createTab(t.url) },
        '-',
        { label:'Tab schließen',    click: () => closeTab(t.id), danger: true },
      ], e.clientX, e.clientY);
    });
    bar.appendChild(el);
  });
  bar.appendChild(newBtn);
  if (winCtrl) bar.appendChild(winCtrl);
  renderLucide();
}

function activeTab() { return tabs.find(t => t.id === activeTabId); }

function navigateActiveTab(input) {
  const url = normalize(input);
  const tab = activeTab();
  if (!tab) return;
  if (tab.isNewTab) {
    tab.isNewTab = false; tab.url = url; tab.title = url;
    if (tab.newtabEl) { tab.newtabEl.remove(); tab.newtabEl = null; }
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:kp');
    if (cfg.allowPopups) wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', url);
    tab.webviewEl = wv;
    document.getElementById('content').appendChild(wv);
    wv.classList.add('active');
    attachWebviewEvents(wv, tab.id);
  } else {
    tab.url = url;
    tab.webviewEl.setAttribute('src', url);
  }
  document.getElementById('urlbar').value = url;
  renderTabBar();
}

function normalize(input) {
  const v = String(input||'').trim();
  if (!v) return 'newtab';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^view-source:/i.test(v)) return v;
  if (/^chrome-extension:\/\//i.test(v)) return v;
  if (v.includes('.') && !v.includes(' ')) return 'https://' + v;
  const engine = cfg.searchEngine === 'custom' ? (cfg.customSearchUrl||'https://www.google.com/search?q=') : cfg.searchEngine;
  return engine + encodeURIComponent(v);
}

function updateSecBadge(url) {
  const badge = document.getElementById('secBadge');
  if (!url || url === 'newtab') { badge.innerHTML = `<i data-lucide="lock" width="14" height="14"></i>`; badge.className = ''; }
  else if (/^https:/.test(url)) { badge.innerHTML = `<i data-lucide="lock" width="14" height="14"></i>`; badge.className = 'ok'; }
  else { badge.innerHTML = `<i data-lucide="triangle-alert" width="14" height="14"></i>`; badge.className = 'warn'; }
  renderLucide();
}

// ── TASTENKÜRZEL ─────────────────────────────────────────────────────────────
let _lastClosedTabUrl = null;
function handleShortcut(e) {
  const ctrl = e.control ?? (e.ctrlKey || e.metaKey);
  const shift = e.shift ?? e.shiftKey;
  const alt   = e.alt   ?? e.altKey;
  const key = (e.key || '').toLowerCase();
  // Gerätevorschau per Escape verlassen – auch wenn der Fokus in der
  // vorgeschauten Seite selbst liegt (siehe attachShortcutForwarding unten).
  // Escape: erst die Suchleiste schließen, dann die Gerätevorschau verlassen
  if (key === 'escape' && document.getElementById('findBar')?.classList.contains('open')) { closeFindBar(); return true; }
  if (key === 'escape' && typeof _dvActive !== 'undefined' && _dvActive) { setDevicePreview(null); return true; }
  if (ctrl && !shift && key === 't') { createTab('newtab'); return true; }
  if (ctrl && shift && key === 't') { if (_lastClosedTabUrl) createTab(_lastClosedTabUrl); return true; }
  if (ctrl && shift && key === 'n') { createTab('newtab', true); return true; }
  if (ctrl && !shift && key === 'w') { if (activeTabId != null) closeTab(activeTabId); return true; }
  if (ctrl && key === 'tab') {
    if (!tabs.length) return true;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    const next = shift ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
    activateTab(tabs[next].id);
    return true;
  }
  if (ctrl && key === 'l') {
    const ub = document.getElementById('urlbar');
    ub.focus(); ub.select();
    return true;
  }
  if (ctrl && key === 'r') { const t = activeTab(); if (t && t.webviewEl) t.webviewEl.reload(); return true; }
  if (ctrl && key === 'd') { toggleBookmark(); return true; }
  if (ctrl && key === ',') { openSettings(); return true; }
  // Seite durchsuchen
  if (ctrl && key === 'f') { openFindBar(); return true; }
  // Zoom: '+' liegt je nach Layout auf verschiedenen Tasten, daher mehrere Namen
  if (ctrl && (key === '+' || key === '=' || key === 'add'))      { changeZoom(+1); return true; }
  if (ctrl && (key === '-' || key === '_' || key === 'subtract')) { changeZoom(-1); return true; }
  if (ctrl && key === '0')                                        { changeZoom(0);  return true; }
  // Vollbild
  if (key === 'f11') { window.electronAPI?.toggleFullscreen?.(); return true; }
  // Navigation per Alt+Pfeil (Standard in allen Browsern)
  if (alt && key === 'arrowleft')  { const t = activeTab(); if (t?.webviewEl?.canGoBack())    t.webviewEl.goBack();    return true; }
  if (alt && key === 'arrowright') { const t = activeTab(); if (t?.webviewEl?.canGoForward()) t.webviewEl.goForward(); return true; }
  // Seite speichern / drucken / Quelltext — bisher nur im Kontextmenü erreichbar
  if (ctrl && key === 's') {
    const wv = activeTab()?.webviewEl; const wcId = wv?.getWebContentsId?.();
    if (wcId) window.electronAPI?.savePage?.(wcId);
    return true;
  }
  if (ctrl && key === 'p') { activeTab()?.webviewEl?.print(); return true; }
  if (ctrl && key === 'u') {
    const src = activeTab()?.webviewEl?.getURL?.();
    if (src && !src.startsWith('view-source:')) createTab('view-source:' + src);
    return true;
  }
  return false;
}

// Electron kann für denselben Tastendruck sowohl 'before-input-event' (Webview-Fokus)
// als auch das normale Host-'keydown' feuern → ohne Sperre führt das den Shortcut doppelt aus.
let _shortcutGuardUntil = 0;
function handleShortcutOnce(e) {
  if (e.repeat) return false;
  if (Date.now() < _shortcutGuardUntil) return true;
  const handled = handleShortcut(e);
  if (handled) _shortcutGuardUntil = Date.now() + 300;
  return handled;
}
document.addEventListener('keydown', e => {
  if (handleShortcutOnce(e)) e.preventDefault();
});

// Auch abfangen wenn der Fokus in einer Webseite liegt (Webviews bekommen sonst keine Host-Shortcuts)
function attachShortcutForwarding(wv, id) {
  wv.addEventListener('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // Nur das gerade AKTIVE Webview darf Shortcuts weiterreichen — sonst feuert
    // 'before-input-event' bei mehreren offenen Tabs für jedes gemountete Webview
    // gleichzeitig und Aktionen wie Ctrl+T/Ctrl+W passieren doppelt.
    if (id !== activeTabId) return;
    if (handleShortcutOnce({ control: input.control || input.meta, shift: input.shift, alt: input.alt, key: input.key, repeat: input.isAutoRepeat })) {
      event.preventDefault();
    }
  });
}

// ── Window context menu (inputs) ──────────────────────────────────────────────
// Wichtig: DOM-'contextmenu'-Events aus dem Inhalt eines <webview> bubblen NICHT
// zum Host-Dokument hoch (eigener Prozess/Guest) – dieser Listener feuert also
// nur für Rechtsklicks auf der eigenen App-UI (Toolbar, New-Tab-Seite, etc.),
// niemals doppelt für echte Webseiten. Deshalb muss hier auch für die New-Tab-
// Seite ein Fallback-Menü existieren, sonst zeigt Electron dort sein natives
// Standardmenü.
window.addEventListener('contextmenu', e => {
  const target = e.target;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    e.preventDefault();
    const isUrlBar = target.id === 'urlbar';
    const items = [
      { label:'↩ Rückgängig',      click: () => { document.execCommand('undo'); } },
      '-',
      { label:'✂ Ausschneiden',    click: () => { document.execCommand('cut'); } },
      { label:'📋 Kopieren',        click: () => { document.execCommand('copy'); } },
      { label:'📋 Einfügen',        click: async () => { const t = await navigator.clipboard.readText().catch(()=>''); if(t) { document.execCommand('insertText', false, t); } } },
    ];
    if (isUrlBar) {
      items.push({ label:'📋 Einfügen und aufrufen', click: async () => {
        const t = await navigator.clipboard.readText().catch(() => '');
        if (t) navigateActiveTab(t.trim());
      }});
    }
    items.push('-', { label:'Alles auswählen', click: () => { target.select?.(); } });
    showCtxMenu(items, e.clientX, e.clientY);
    return;
  }
  // Andere Host-UI-Elemente (Tab-Leiste, "Neuer Tab"-Button, …) haben ihre
  // eigenen contextmenu-Handler, die e.preventDefault() bereits aufgerufen
  // haben – in dem Fall hier nichts tun, um keine doppelten Menüs zu zeigen.
  if (e.defaultPrevented) return;

  // Innerhalb eines offenen Overlays (Einstellungen, Passwörter, Verlauf, …)
  // ergibt ein Navigations-Menü keinen Sinn – nur das native Menü unterdrücken.
  if (target.closest?.('.overlay.open')) { e.preventDefault(); return; }

  // Reduziertes Fallback-Menü für die App-Chrome / New-Tab-Seite (keine echte
  // Webseite im Fokus → keine Bild-/Link-/Video-Optionen sinnvoll).
  e.preventDefault();
  const tab   = activeTab();
  const wv2   = tab?.webviewEl || null;
  showCtxMenu([
    { label: '← Zurück',    accel: 'Alt+←',  disabled: !wv2 || !wv2.canGoBack(),    click: () => wv2.goBack() },
    { label: '→ Vorwärts',  accel: 'Alt+→',  disabled: !wv2 || !wv2.canGoForward(), click: () => wv2.goForward() },
    { label: '↻ Neu laden', accel: 'Strg+R', disabled: !wv2,                        click: () => wv2.reload() },
    '-',
    { label: '🔖 Lesezeichen', accel: 'Strg+D', disabled: !tab || tab.isNewTab || !tab.url, click: () => toggleBookmark() },
  ], e.clientX, e.clientY);
});
