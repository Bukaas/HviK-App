// Toasts unten rechts wie bei Steam (Erfolg, Match bereit, jemand ist im Spiel, Hint ...) - eigene kleine Fenster über allem, mit Ton.
// Bis zu 3 gleichzeitig, übereinander gestapelt; der Rest wartet.
// Läuft ein Spiel im Vollbild, warten sie, bis man wieder raus ist - ein Fenster darüber würde das Spiel sonst auf den Desktop werfen.
const { BrowserWindow, screen, ipcMain } = require('electron');
const { execFile } = require('child_process');
const path = require('path');

const W = 380, H = 116, SMALL = 84, GAP = 10, MAX = 3;
const MAX_WAIT = 15 * 60 * 1000;  // so lange dürfen Toasts aufs Ende des Vollbild-Spiels warten
const queue = [];
const active = [];  // [{win, h}] - unten = ältester
let onAction = null;
let getMode = () => 'auto';  // 'auto' = nicht während Vollbild-Spielen, 'immer', 'aus'
let retry = null;

// Windows fragen, ob gerade etwas im Vollbild läuft (wie "Nicht stören" bei Spielen):
// 2 = Vollbild-Programm, 3 = Direct3D-Vollbild (Spiel), 4 = Präsentationsmodus
const FS_SCRIPT = `Add-Type -Namespace H -Name Q -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);';
$s = 0; [void][H.Q]::SHQueryUserNotificationState([ref]$s); $s`;
let fsCache = { at: 0, busy: false };
function fullscreen() {
  if (Date.now() - fsCache.at < 5000) return Promise.resolve(fsCache.busy);
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FS_SCRIPT], { windowsHide: true, timeout: 8000 },
    (err, out) => {
      const state = parseInt(String(out || '').trim(), 10);
      fsCache = { at: Date.now(), busy: !err && [2, 3, 4].includes(state) };
      res(fsCache.busy);
    }));
}

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

let checking = false;
async function next() {
  if (checking) return;
  checking = true;
  try {
    // zu alt gewordene (z. B. "Max ist online" von vor einer halben Stunde) nicht mehr zeigen
    for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].force && Date.now() - queue[i]._at > MAX_WAIT) queue.splice(i, 1);
    if (!queue.length || active.length >= MAX) return;
    const mode = getMode();
    if (mode === 'aus') { queue.splice(0, queue.length, ...queue.filter(t => t.force)); }
    else if (mode === 'auto' && !queue.every(t => t.force) && await fullscreen()) {
      // Vollbild: Test-Popups trotzdem, der Rest wartet - in 15 s nochmal schauen
      const forced = queue.filter(t => t.force);
      queue.splice(0, queue.length, ...queue.filter(t => !t.force));
      forced.forEach(open);
      clearTimeout(retry);
      retry = setTimeout(next, 15000);
      return;
    }
    while (active.length < MAX && queue.length) open(queue.shift());
  } finally {
    checking = false;
  }
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

/** t = {kind, icon, title, name, text, foot, color|colorHex, buttons: [{label, action}], small, quiet, seconds, force}
 *  force: auch bei "Aus"/Vollbild zeigen (Test-Popup aus den Einstellungen) */
function show(t) {
  if (getMode() === 'aus' && !t.force) return;
  // gleiche Meldung nicht doppelt in der Warteschlange
  if (queue.some(q => q.title === t.title && q.name === t.name && q.text === t.text)) return;
  queue.push({ ...t, _at: Date.now() });
  next();
}

module.exports = { show, fullscreen, setHandler: fn => { onAction = fn; }, setMode: fn => { getMode = fn; } };
