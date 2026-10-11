// Popup -> Hauptprozess (Knöpfe)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', { act: action => ipcRenderer.send('toast-action', action) });
