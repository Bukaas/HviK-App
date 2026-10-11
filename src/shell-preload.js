// Titelleiste <-> Hauptprozess
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellApi', {
  cmd: c => ipcRenderer.send('nav-cmd', c),
  on: (ev, fn) => ipcRenderer.on(ev, (e, data) => fn(data)),
});
