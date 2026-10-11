// Läuft in hvik.org: die Seite kann erkennen, dass sie in der App läuft (später: Minecraft starten, Benachrichtigungen ...).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('hvikApp', {
  version: (process.argv.find(a => a.startsWith('--hvik-version=')) || '').split('=')[1] || '',
  platform: process.platform,
});
