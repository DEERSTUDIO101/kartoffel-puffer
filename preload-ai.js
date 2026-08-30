const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiAPI', {
  // Window controls (for the AI window's own titlebar)
  minimize: ()        => ipcRenderer.send('ai-window-minimize'),
  close:    ()        => ipcRenderer.send('ai-window-close'),
  drag:     (dx, dy) => ipcRenderer.send('ai-win-drag', { dx, dy }),

  // Get current browser context (URL, title, text)
  getContext: () => ipcRenderer.invoke('ai-get-context'),

  // Get enabled providers + active tab from the main window at detach time
  getInitConfig: () => ipcRenderer.invoke('ai-get-init-config'),

  // Tell the browser to open a URL
  openUrl: (url) => ipcRenderer.send('ai-open-url', url),

  // Receive live context pushes from the browser
  onBrowserContext: (cb) => ipcRenderer.on('browser-context', (_e, ctx) => cb(ctx)),

  // Clipboard
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
});
