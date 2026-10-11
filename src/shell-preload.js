// Titelleiste <-> Hauptprozess
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellApi', {
  cmd: c => ipcRenderer.send('nav-cmd', c),
  find: (text, opts) => ipcRenderer.send('find', text, opts || {}),
  findStop: () => ipcRenderer.send('find-stop'),
  on: (ev, fn) => ipcRenderer.on(ev, (e, data) => fn(data)),
});
