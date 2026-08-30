const { contextBridge, ipcRenderer } = require('electron');

// Jeder IPC-Kanal darf nur einen Listener auf einmal haben.
// on1() entfernt zuerst alle alten Listener auf dem Kanal, dann registriert es den neuen.
function on1(channel, handler) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  winMinimize: ()  => ipcRenderer.send('win-minimize'),
  winMaximize: ()  => ipcRenderer.send('win-maximize'),
  winClose:    ()  => ipcRenderer.send('win-close'),
  toggleFullscreen: () => ipcRenderer.send('win-fullscreen'),

  // AI window
  aiWindowOpen:     (opts) => ipcRenderer.send('ai-window-open', opts),
  aiWindowClose:    ()     => ipcRenderer.send('ai-window-close'),
  onAiWindowClosed: (cb)   => on1('ai-window-closed', cb),

  // Push context to AI window (call this whenever active tab changes)
  aiContextUpdate: (ctx) => ipcRenderer.send('ai-context-update', ctx),

  // Receive "open this URL" from AI window
  onOpenUrlFromAi: (cb) => on1('open-url-from-ai', (_e, url) => cb(url)),

  // Clipboard
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  clipboardRead:  ()     => ipcRenderer.invoke('clipboard:read'),

  // Passwords (verschlüsselter Tresor, Master-Passwort erforderlich)
  passwords: {
    isSetup:  ()           => ipcRenderer.invoke('passwords:isSetup'),
    isLocked: ()           => ipcRenderer.invoke('passwords:isLocked'),
    setup:    (pw)         => ipcRenderer.invoke('passwords:setup', pw),
    list:     ()           => ipcRenderer.invoke('passwords:list'),
    save:     (entry)      => ipcRenderer.invoke('passwords:save', entry),
    get:      (site)       => ipcRenderer.invoke('passwords:get', site),
    delete:   (site, user) => ipcRenderer.invoke('passwords:delete', site, user),
    unlock:   (pw)         => ipcRenderer.invoke('passwords:unlock', pw),
    lock:     ()           => ipcRenderer.invoke('passwords:lock'),
  },

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Auto-Update
  onUpdateReady:   (cb) => on1('update-ready', cb),
  installUpdate:   ()   => ipcRenderer.send('update-install'),
  checkForUpdates: ()   => ipcRenderer.send('update-check'),
  setTrackerBlock: (enabled) => ipcRenderer.send('set-tracker-block', enabled),
  setAdBlock:  (enabled) => ipcRenderer.send('set-ad-block', enabled),
  getAdBlock:  ()        => ipcRenderer.invoke('get-ad-block'),

  // Downloads
  downloads: {
    list:         ()    => ipcRenderer.invoke('downloads:list'),
    openFile:     (id)  => ipcRenderer.invoke('downloads:openFile', id),
    showInFolder: (id)  => ipcRenderer.invoke('downloads:showInFolder', id),
    clear:        ()    => ipcRenderer.invoke('downloads:clear'),
    startUrl:     (url) => ipcRenderer.invoke('downloads:url', url),
  },

  // Seite speichern unter (via native Save-Dialog)
  savePage:   (wcId) => ipcRenderer.invoke('page:save', wcId),
  screenshot: (wcId) => ipcRenderer.invoke('page:screenshot', wcId),

  // Bild in Zwischenablage kopieren (läuft im Main-Prozess, umgeht CORS)
  copyImage: (url) => ipcRenderer.invoke('image:copy', url),

  // Erweiterungen
  extensions: {
    list:       ()              => ipcRenderer.invoke('ext:list'),
    popup:      (key, anchor)   => ipcRenderer.invoke('ext:popup', key, anchor),
    toggle:     (key, enabled)  => ipcRenderer.invoke('ext:toggle', key, enabled),
    install:    ()              => ipcRenderer.invoke('ext:install'),
    remove:     (key)           => ipcRenderer.invoke('ext:remove', key),
    openFolder: (key)           => ipcRenderer.invoke('ext:openFolder', key),
  },
  onExtensionsUpdate: (cb) => on1('extensions-update', (_e, list) => cb(list)),

  // Berechtigungen
  onPermissionRequest: (cb) => on1('permission-request', (_e, req) => cb(req)),
  permissionRespond:   (id, allow) => ipcRenderer.send('permission-response', id, allow),
  permissionsList:       () => ipcRenderer.invoke('permissions:list'),
  permissionsReset:      () => ipcRenderer.invoke('permissions:reset'),
  permissionsSet:        (key, value)      => ipcRenderer.invoke('permissions:set', key, value),
  permissionsSetDefault: (perm, mode)      => ipcRenderer.invoke('permissions:setDefault', perm, mode),

  // Browserdaten löschen (Cookies/Cache/Website-Daten der Tab-Session)
  clearData: (opts) => ipcRenderer.invoke('data:clear', opts),
  onDownloadsUpdate: (cb) => on1('downloads-update', (_e, list) => cb(list)),
  onUpdateStatus:    (cb) => on1('update-status',    (_e, data) => cb(data)),

  // Browser-Import (Lesezeichen, Passwörter, Verlauf aus installierten Browsern)
  browserImport: {
    detect:   ()     => ipcRenderer.invoke('import:detectBrowsers'),
    run:      (args) => ipcRenderer.invoke('import:run', args),
    fromFile: (args) => ipcRenderer.invoke('import:fromFile', args),
  },
  openFilePicker: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
});
