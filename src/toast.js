// Toasts unten rechts wie bei Steam (Erfolg, Match bereit, jemand ist im Spiel, Hint ...) - eigene kleine Fenster über allem, mit Ton.
// Bis zu 3 gleichzeitig, übereinander gestapelt; der Rest wartet.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const W = 380, H = 116, SMALL = 84, GAP = 10, MAX = 3;
const queue = [];
const active = [];  // [{win, h}] - unten = ältester
let onAction = null;

function heightOf(t) {
  return (t.small ? SMALL : H) + (t.buttons && t.buttons.length ? 40 : 0);
}
// alle offenen Toasts von unten nach oben anordnen
function layout() {
  const area = screen.getPrimaryDisplay().workArea;
  let y = area.y + area.height - GAP;
  for (const a of active) {
    y -= a.h;
    if (!a.win.isDestroyed()) a.win.setBounds({ x: area.x + area.width - W - GAP, y, width: W, height: a.h });
    y -= GAP / 2;
  }
}

function next() {
  while (active.length < MAX && queue.length) open(queue.shift());
}

function open(t) {
  const h = heightOf(t);
  const win = new BrowserWindow({
    width: W, height: h, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, focusable: false,
    alwaysOnTop: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'toast-preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');  // auch über Spielen im Fenster-/Rahmenlos-Modus
  const entry = { win, h };
  active.push(entry);
  layout();
  win.loadFile(path.join(__dirname, 'toast.html'), { hash: encodeURIComponent(JSON.stringify(t)) });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
  const timer = setTimeout(() => { if (!win.isDestroyed()) win.close(); }, (t.seconds || 7) * 1000);
  win.on('closed', () => {
    clearTimeout(timer);
    const i = active.indexOf(entry);
    if (i >= 0) active.splice(i, 1);
    layout();
    setTimeout(next, 200);
  });
}

ipcMain.on('toast-action', (e, action) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (onAction && action) onAction(action);
  if (win && !win.isDestroyed()) win.close();
});

/** t = {kind, icon, title, name, text, foot, color|colorHex, buttons: [{label, action}], small, quiet, seconds} */
function show(t) {
  // gleiche Meldung nicht doppelt in der Warteschlange
  if (queue.some(q => q.title === t.title && q.name === t.name && q.text === t.text)) return;
  queue.push(t);
  next();
}

module.exports = { show, setHandler: fn => { onAction = fn; } };
