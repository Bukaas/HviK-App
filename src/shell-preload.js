// Titelleiste <-> Hauptprozess
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellApi', {
  cmd: c => ipcRenderer.send('nav-cmd', c),
  find: (text, opts) => ipcRenderer.send('find', text, opts || {}),
  findStop: () => ipcRenderer.send('find-stop'),
  on: (ev, fn) => ipcRenderer.on(ev, (e, data) => fn(data)),
  // neues Design: durchsichtige Stellen durchklickbar, Größe an den Rändern ziehen
  hitRects: rects => ipcRenderer.send('win-hit-rects', rects),
  resize: msg => ipcRenderer.send('win-resize', msg || null),
  drag: phase => ipcRenderer.send('win-drag', phase),
  // Live-Fenster an der Leiste: Liga-Map eintragen/bestätigen, in den Turnier-Voice-Kanal
  liga: (id, action, body) => ipcRenderer.invoke('rail-liga', id, action, body || {}),
  voice: (id, side) => ipcRenderer.invoke('rail-voice', id, side),
});
