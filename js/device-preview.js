// ── Gerätevorschau (Responsive Design Mode) ──────────────────────────────────
// Wird ausschließlich über das Rechtsklick-Kontextmenü (js/tabs.js) angesteuert.
const DEVICE_PRESETS = {
  'desktop':  { name: 'Desktop',           w: null, h: null },
  'tab-v':    { name: 'Tablet',            w: 768,  h: 1024 },
  'tab-h':    { name: 'Tablet quer',       w: 1024, h: 768  },
  'mob-v':    { name: 'Smartphone',        w: 390,  h: 844  },
  'mob-h':    { name: 'Smartphone quer',   w: 844,  h: 390  },
};

let _dvActive = null;

function setDevicePreview(id, w, h) {
  _dvActive = id || null;
  const content  = document.getElementById('content');
  const exitBar  = document.getElementById('dvExitBar');
  const exitLbl  = document.getElementById('dvExitLabel');

  if (!id || id === 'desktop') {
    content.classList.remove('device-preview');
    content.style.removeProperty('--dv-w');
    content.style.removeProperty('--dv-h');
    exitBar?.classList.remove('open');
    _dvActive = null;
  } else {
    content.classList.add('device-preview');
    content.style.setProperty('--dv-w', w + 'px');
    content.style.setProperty('--dv-h', h + 'px');
    if (exitLbl) exitLbl.textContent = `Gerätevorschau · ${(DEVICE_PRESETS[id]?.name) || id} ${w}×${h}`;
    exitBar?.classList.add('open');
  }
}

// Vorschau beenden: Button-Klick. Die Escape-Taste läuft über
// handleShortcut() in js/tabs.js, weil die auch von der vorgeschauten
// Seite selbst (Webview-Fokus) über before-input-event weitergeleitet wird –
// ein einfacher document-'keydown'-Listener würde dort nicht feuern.
document.getElementById('dvExitBtn')?.addEventListener('click', () => setDevicePreview(null));
