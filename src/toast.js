// Popups unten rechts wie bei Steam (Erfolg freigeschaltet, Match bereit) - eigenes kleines Fenster über allem, mit Ton.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const W = 380, H = 116, GAP = 12;
const queue = [];
let current = null, onAction = null;

function next() {
  if (current || !queue.length) return;
  const t = queue.shift();
  const area = screen.getPrimaryDisplay().workArea;
  const h = t.buttons && t.buttons.length ? H + 40 : H;
  current = new BrowserWindow({
    width: W, height: h, x: area.x + area.width - W - GAP, y: area.y + area.height - h - GAP,
    frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, focusable: false,
    alwaysOnTop: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'toast-preload.js') },
  });
  current.setAlwaysOnTop(true, 'screen-saver');  // auch über Spielen im Fenster-/Rahmenlos-Modus
  current.loadFile(path.join(__dirname, 'toast.html'), { hash: encodeURIComponent(JSON.stringify(t)) });
  current.once('ready-to-show', () => current && current.showInactive());
  const win = current;
  const close = () => { if (!win.isDestroyed()) win.close(); };
  const timer = setTimeout(close, (t.seconds || 7) * 1000);
  win.on('closed', () => { clearTimeout(timer); if (current === win) current = null; setTimeout(next, 250); });
}

ipcMain.on('toast-action', (e, action) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (onAction && action) onAction(action);
  if (win && !win.isDestroyed()) win.close();
});

/** t = {kind: 'achievement'|'match'|'info', icon, title, name, text, foot, color, buttons: [{label, action}]} */
function show(t) {
  queue.push(t);
  next();
}

module.exports = { show, setHandler: fn => { onAction = fn; } };
