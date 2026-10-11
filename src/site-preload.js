// Läuft in hvik.org: die Seite erkennt die App und kann Minecraft (HviK Link) starten.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hvikApp', {
  settings: patch => ipcRenderer.invoke('app-settings', patch || null),
  diag: () => ipcRenderer.invoke('app-diag'),
  testNotify: () => ipcRenderer.invoke('app-test-notify'),
  testToast: () => ipcRenderer.invoke('app-test-toast'),
  open: which => ipcRenderer.invoke('app-open', which),
  version: (process.argv.find(a => a.startsWith('--hvik-version=')) || '').split('=')[1] || '',
  platform: process.platform,
  mc: {
    status: code => ipcRenderer.invoke('mc-status', code),
    play: code => ipcRenderer.invoke('mc-play', code),
    pickFolder: () => ipcRenderer.invoke('mc-pick-root'),
    onProgress: fn => { ipcRenderer.removeAllListeners('mc-progress'); ipcRenderer.on('mc-progress', (e, t) => fn(t)); },
  },
  ap: {
    status: rid => ipcRenderer.invoke('ap-status', rid),
    play: (rid, setupOnly, mode) => ipcRenderer.invoke('ap-play', rid, !!setupOnly, mode || ''),
    openFolder: folder => ipcRenderer.invoke('ap-open-folder', folder),
    openClient: name => ipcRenderer.invoke('ap-client', name),
    onProgress: fn => { ipcRenderer.removeAllListeners('ap-progress'); ipcRenderer.on('ap-progress', (e, t) => fn(t)); },
  },
});
