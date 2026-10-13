// Overlay <- Hauptprozess (Inhalt)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ovApi', { on: fn => ipcRenderer.on('ov', (e, d) => fn(d)) });
