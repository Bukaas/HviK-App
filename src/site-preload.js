// Läuft in hvik.org: die Seite erkennt die App und kann Minecraft (HviK Link) starten.
const { contextBridge, ipcRenderer } = require('electron');

// App-Design: data-design am <html> + beim neuen Design die zusätzliche Stildatei der Seite
function applyDesign(d) {
  const set = () => {
    document.documentElement.dataset.design = d;
    let link = document.getElementById('hvik-design-neu');
    if (d === 'neu' && !link && document.head) {
      link = Object.assign(document.createElement('link'), { id: 'hvik-design-neu', rel: 'stylesheet',
                                                            href: '/static/design-neu.css?v=' + Math.floor(Date.now() / 36e5) });
      document.head.append(link);
    } else if (d !== 'neu' && link) link.remove();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', set, { once: true }); else set();
}
ipcRenderer.invoke('app-design').then(applyDesign).catch(() => {});
ipcRenderer.on('design', (e, d) => applyDesign(d));
// Farbwelt des neuen Designs (data-palette am <html>, design-neu.css färbt danach)
function applyPalette(p) {
  const set = () => { document.documentElement.dataset.palette = p || 'ozean'; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', set, { once: true }); else set();
  if (document.documentElement) set();
}
ipcRenderer.invoke('app-palette').then(applyPalette).catch(() => {});
ipcRenderer.on('palette', (e, p) => applyPalette(p));

contextBridge.exposeInMainWorld('hvikApp', {
  settings: patch => ipcRenderer.invoke('app-settings', patch || null),
  diag: () => ipcRenderer.invoke('app-diag'),
  testNotify: () => ipcRenderer.invoke('app-test-notify'),
  testToast: () => ipcRenderer.invoke('app-test-toast'),
  overlayPreview: () => ipcRenderer.invoke('app-overlay-preview'),
  open: which => ipcRenderer.invoke('app-open', which),
  move: what => ipcRenderer.invoke('app-move', what),
  onMoveProgress: fn => { ipcRenderer.removeAllListeners('app-move-progress'); ipcRenderer.on('app-move-progress', (e, t) => fn(t)); },
  version: (process.argv.find(a => a.startsWith('--hvik-version=')) || '').split('=')[1] || '',
  platform: process.platform,
  mc: {
    status: code => ipcRenderer.invoke('mc-status', code),
    play: code => ipcRenderer.invoke('mc-play', code),
    pickFolder: () => ipcRenderer.invoke('mc-pick-root'),
    onProgress: fn => { ipcRenderer.removeAllListeners('mc-progress'); ipcRenderer.on('mc-progress', (e, t) => fn(t)); },
  },
  spiel: {   // Launcher: HviK Community Place
    status: () => ipcRenderer.invoke('spiel-status'),
    installieren: () => ipcRenderer.invoke('spiel-installieren'),
    starten: name => ipcRenderer.invoke('spiel-starten', name || ''),
    modus: m => ipcRenderer.invoke('spiel-modus', m),
  },
  ap: {
    status: rid => ipcRenderer.invoke('ap-status', rid),
    play: (rid, setupOnly, mode) => ipcRenderer.invoke('ap-play', rid, !!setupOnly, mode || ''),
    openFolder: folder => ipcRenderer.invoke('ap-open-folder', folder),
    openClient: name => ipcRenderer.invoke('ap-client', name),
    onProgress: fn => { ipcRenderer.removeAllListeners('ap-progress'); ipcRenderer.on('ap-progress', (e, t) => fn(t)); },
  },
});
