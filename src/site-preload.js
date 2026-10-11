// Läuft in hvik.org: die Seite erkennt die App und kann Minecraft (HviK Link) starten.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hvikApp', {
  version: (process.argv.find(a => a.startsWith('--hvik-version=')) || '').split('=')[1] || '',
  platform: process.platform,
  mc: {
    status: code => ipcRenderer.invoke('mc-status', code),
    play: code => ipcRenderer.invoke('mc-play', code),
    pickFolder: () => ipcRenderer.invoke('mc-pick-root'),
    onProgress: fn => { ipcRenderer.removeAllListeners('mc-progress'); ipcRenderer.on('mc-progress', (e, t) => fn(t)); },
  },
});
