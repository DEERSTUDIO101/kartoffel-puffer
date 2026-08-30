// ── AI PROVIDERS ─────────────────────────────────────────────────────────────
const AI_PROVIDERS = [
  { id:'claude',     name:'Claude',      url:'https://claude.ai',             color:'#d97706' },
  { id:'chatgpt',    name:'ChatGPT',     url:'https://chatgpt.com',           color:'#10a37f' },
  { id:'gemini',     name:'Gemini',      url:'https://gemini.google.com',     color:'#4285f4' },
  { id:'perplexity', name:'Perplexity',  url:'https://www.perplexity.ai',     color:'#7c3aed' },
  { id:'copilot',    name:'Copilot',     url:'https://copilot.microsoft.com', color:'#0078d4' },
  { id:'grok',       name:'Grok',        url:'https://grok.com',              color:'#1d9bf0' },
  { id:'deepseek',   name:'DeepSeek',    url:'https://chat.deepseek.com',     color:'#3b82f6' },
  { id:'mistral',    name:'Mistral',     url:'https://chat.mistral.ai',       color:'#f97316' },
];

// ── AI SIDEBAR ────────────────────────────────────────────────────────────────
let aiSidebarOpen = false, _aiWindowOpen = false;
let aiWebviews = {};
let aiBrowserModeOn = false;
let _lastAutoCtxUrl = null;
let _lastAutoOpenedUrl = null;
let _linkScanTimer = null;
let _ctxExplainedProviders = new Set();
let _lastPushedCtxUrl = null;

function buildAiProviderTabs() {
  const container    = document.getElementById('aiProviderTabs');
  const wvContainer  = document.getElementById('aiWebviewContainer');
  container.innerHTML = '';
  const enabled = AI_PROVIDERS.filter(p => cfg.aiEnabledProviders.includes(p.id));
  enabled.forEach(provider => {
    const tab = document.createElement('div');
    tab.className = 'ai-tab' + (cfg.aiActiveProvider === provider.id ? ' active' : '');
    tab.innerHTML = `<span class="ai-dot" style="background:${provider.color}"></span>${provider.name}`;
    tab.addEventListener('click', () => switchAiProvider(provider.id));
    container.appendChild(tab);
    if (!aiWebviews[provider.id]) {
      const wv = document.createElement('webview');
      wv.className = 'ai-webview';
      wv.setAttribute('partition', 'persist:kp-ai-' + provider.id);
      wv.setAttribute('src', provider.url);
      wvContainer.appendChild(wv);
      aiWebviews[provider.id] = wv;
    }
    aiWebviews[provider.id].classList.toggle('active', cfg.aiActiveProvider === provider.id);
  });
}

function switchAiProvider(id) {
  cfg.aiActiveProvider = id; saveSettings();
  Object.entries(aiWebviews).forEach(([pid, wv]) => wv.classList.toggle('active', pid === id));
  document.querySelectorAll('#aiProviderTabs .ai-tab').forEach((tab, i) => {
    const p = AI_PROVIDERS.filter(p => cfg.aiEnabledProviders.includes(p.id))[i];
    if (p) tab.classList.toggle('active', p.id === id);
  });
}

function updateAiCtxUrl() {
  const tab = activeTab();
  document.getElementById('aiCtxUrl').textContent = (tab && !tab.isNewTab) ? tab.url : '—';
}

async function sendCtxToCurrentAi() {
  const tab = activeTab();
  if (!tab || tab.isNewTab) return;
  const wv = aiWebviews[cfg.aiActiveProvider];
  if (!wv) return;
  let pageText = '';
  try {
    pageText = await tab.webviewEl.executeJavaScript(
      '(document.body && document.body.innerText || "").slice(0, 4000)'
    );
  } catch {}
  const msg = pageText
    ? `Ich schaue gerade auf: "${tab.title}" (${tab.url})\n\nSeiteninhalt (Auszug):\n${pageText}`
    : `Ich schaue gerade auf: "${tab.title}" (${tab.url})`;
  injectAiText(wv, msg);
}

function injectAiText(wv, text, submit) {
  const code = `(function(){
    const sel=['div[contenteditable="true"][data-testid]','p[contenteditable="true"]','div[contenteditable="true"]','textarea','input[type="text"]'];
    let el=null;
    for(const s of sel){const f=document.querySelector(s);if(f){el=f;break;}}
    if(!el)return false;
    el.focus();
    if(el.isContentEditable){el.textContent=${JSON.stringify(text)};el.dispatchEvent(new InputEvent('input',{bubbles:true}));}
    else{el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));}
    if(${!!submit}){
      setTimeout(()=>{
        const opts={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};
        el.dispatchEvent(new KeyboardEvent('keydown',opts));
        el.dispatchEvent(new KeyboardEvent('keyup',opts));
      },150);
    }
    return true;
  })()`;
  wv.executeJavaScript(code).catch(() => {});
}

// ── AUTO-KONTEXT + AUTO-LINK-ÖFFNEN (Browser-Modus) ─────────────────────────
let _lastAutoCtxTime = 0;
const AUTO_CTX_COOLDOWN_MS = 20000;
async function autoSendCtxIfEnabled() {
  return; // deaktiviert: automatischer Kontext-Versand nervte; nur noch manuell über den 📋-Button
  if (!aiSidebarOpen) return;
  const tab = activeTab();
  if (!tab || tab.isNewTab || tab.url === _lastAutoCtxUrl) return;
  if (Date.now() - _lastAutoCtxTime < AUTO_CTX_COOLDOWN_MS) return;
  const wv = aiWebviews[cfg.aiActiveProvider];
  if (!wv) return;
  _lastAutoCtxUrl = tab.url;
  _lastAutoCtxTime = Date.now();
  let pageText = '';
  try { pageText = await tab.webviewEl.executeJavaScript('(document.body && document.body.innerText || "").slice(0, 4000)'); } catch {}
  const msg = `Kurzer Hinweis: ich schaue mir gerade "${tab.title}" (${tab.url}) an.` +
    (pageText ? `\n\nAuszug vom Seiteninhalt:\n${pageText}` : '') +
    `\n\nDas ist nur zur Info, du musst nicht extra antworten – frag mich einfach falls du dazu was wissen willst.`;
  injectAiText(wv, msg, true);
}

// Findet die zuletzt genannte fremde URL im sichtbaren Text der Seite (nicht nur
// echte <a>-Links, da viele Chat-UIs URLs als reinen Text ohne Verlinkung schreiben).
function _linkScanScript() {
  return `(function(){
    function rootDomain(h){ const p=h.split('.'); return p.slice(-2).join('.'); }
    const selfRoot = rootDomain(location.hostname);
    const text = document.body && document.body.innerText || '';
    const matches = text.match(/https?:\\/\\/[^\\s<>"')]+/g) || [];
    for (let i = matches.length - 1; i >= 0; i--) {
      let raw = matches[i].replace(/[.,;:!?]+$/, '');
      try {
        const u = new URL(raw);
        if (rootDomain(u.hostname) !== selfRoot) return raw;
      } catch {}
    }
    return null;
  })()`;
}

function scanAiReplyForLink() {
  if (!aiBrowserModeOn || !aiSidebarOpen) return;
  const wv = aiWebviews[cfg.aiActiveProvider];
  if (!wv) return;
  wv.executeJavaScript(_linkScanScript()).then(url => {
    if (url && url !== _lastAutoOpenedUrl) {
      _lastAutoOpenedUrl = url;
      createTab(url);
      showToast('Link von AI geöffnet: ' + url);
    }
  }).catch(() => {});
}

function primeLinkScan() {
  // Merkt sich vorhandene Links als "schon gesehen", damit beim Einschalten
  // nicht sofort ein alter Link (z.B. aus einer früheren Antwort) geöffnet wird.
  const wv = aiWebviews[cfg.aiActiveProvider];
  if (!wv) return;
  wv.executeJavaScript(_linkScanScript()).then(url => { if (url) _lastAutoOpenedUrl = url; }).catch(() => {});
}

function setAiBrowserMode(on) {
  aiBrowserModeOn = on;
  const btn = document.getElementById('aiBtnSysPrompt');
  btn?.classList.toggle('active', on);
  if (on) {
    if (_linkScanTimer) clearInterval(_linkScanTimer);
    primeLinkScan();
    _linkScanTimer = setInterval(scanAiReplyForLink, 2500);
  } else if (_linkScanTimer) {
    clearInterval(_linkScanTimer); _linkScanTimer = null;
  }
}

function explainAutoCtxOnce(wv, providerId) {
  return; // deaktiviert zusammen mit autoSendCtxIfEnabled
  if (_ctxExplainedProviders.has(providerId)) return;
  _ctxExplainedProviders.add(providerId);
  const msg = 'Kurzer Hinweis: ich nutze dich hier eingebettet in meinem Browser "Kartoffel Puffer". ' +
    'Ich schicke dir ab und zu automatisch mit, welche Seite ich gerade offen habe (Titel, URL, Textauszug) ' +
    '– das ist reine Info, du musst nicht extra antworten, nutze es einfach wenn ich danach frage.';
  injectAiText(wv, msg, true);
}

function toggleAiSidebar() {
  if (_aiWindowOpen) { window.electronAPI?.aiWindowOpen({ width:450, height:640 }); return; }
  aiSidebarOpen = !aiSidebarOpen;
  document.getElementById('aiSidebar').classList.toggle('open', aiSidebarOpen);
  if (aiSidebarOpen) {
    buildAiProviderTabs(); updateAiCtxUrl();
    const wv = aiWebviews[cfg.aiActiveProvider];
    if (wv) explainAutoCtxOnce(wv, cfg.aiActiveProvider);
    _lastAutoCtxUrl = null; _lastAutoCtxTime = 0;
    setTimeout(autoSendCtxIfEnabled, 1200);
  }
}
