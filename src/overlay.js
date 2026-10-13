// Overlay im Spiel: kleines, durchklickbares Fenster immer im Vordergrund – während einer laufenden Archipelago-Runde,
// in der man mitspielt: eigener Fortschritt, letzte Items, offene Hints. An/aus in den Einstellungen oder mit Strg+Alt+O.
// Hinweis: Über Spielen im exklusiven Vollbild kann Windows nichts anzeigen – dort "Rahmenloses Fenster" im Spiel wählen.
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const W = 320, H = 300, M = 16;
let win = null, ctx = null, timer = null, round = null, after = 0, lines = [], preview = false, previewT = null;

function enabled() { return !!ctx.settings().overlay; }

function place() {
  if (!win || win.isDestroyed()) return;
  const a = screen.getPrimaryDisplay().workArea, pos = ctx.settings().overlayPos || 'oben-rechts';
  const x = pos.endsWith('links') ? a.x + M : a.x + a.width - W - M;
  const y = pos.startsWith('unten') ? a.y + a.height - H - M : pos.startsWith('mitte') ? a.y + Math.round((a.height - H) / 2) : a.y + M;
  win.setBounds({ x, y, width: W, height: H });
}

function ensureWin() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({ width: W, height: H, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true,
                            focusable: false, alwaysOnTop: true, show: false, hasShadow: false,
                            webPreferences: { preload: path.join(__dirname, 'overlay-preload.js') } });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);  // komplett durchklickbar - stört im Spiel nie
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.on('closed', () => { win = null; });
  place();
  return win;
}

function send(data) {
  const w = ensureWin();
  const go = () => { w.webContents.send('ov', { ...data, bottom: (ctx.settings().overlayPos || '').startsWith('unten'), palette: ctx.settings().palette || 'ozean', opacity: ctx.settings().overlayOpacity || 0.92 }); if (!w.isVisible()) w.showInactive(); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
}

function hide() { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); }

async function tick() {
  if (preview) return;
  const mine = ctx.apMine();
  if (!enabled() || !mine.length) { hide(); round = null; return; }
  const r = mine[0];
  if (!round || round.id !== r.id) { round = r; after = 0; lines = []; }
  let live;
  try { live = await ctx.fetchJson(`/events/archipelago/runde/${encodeURIComponent(r.id)}/live?after=${after}`); } catch { return; }
  if (!live || !live.running) { hide(); return; }
  for (const m of live.messages || []) {
    after = Math.max(after, m.id || 0);
    const parts = m.parts || [];
    // nur, was mich betrifft: Items an mich / von mir, Ziel erreicht
    if (m.type === 'ItemSend' && parts.some(p => p.k === 'me')) lines.push({ parts, t: m.time });
    else if (m.type === 'Goal') lines.push({ parts, t: m.time });
  }
  lines = lines.slice(-5);
  const meSlot = live.me;
  const row = (live.slots || []).find(s => s.slot === meSlot) || null;
  const hints = (live.hints || []).filter(h => h.receiver === meSlot || h.finder === meSlot).slice(0, 3)
    .map(h => ({ mine: h.receiver === meSlot, item: h.item, k: h.k, who: h.receiver === meSlot ? h.finder : h.receiver, location: h.location }));
  send({ title: r.title || 'Archipelago', row, lines, hints, me: meSlot, connected: live.connected });
}

// Vorschau aus den Einstellungen: 8 Sekunden Beispielinhalt
function showPreview() {
  preview = true;
  clearTimeout(previewT);
  place();
  send({ title: 'Vorschau · Archipelago', me: 'Du', connected: true,
         row: { icon: '🍄', game: 'Super Mario World', online: true, checked: 42, total: 157, received: 18, goal_items: { label: '🥚 Yoshi-Eier', have: 6, need: 25 }, loc_bars: [{ label: '🪙 Drachenmünzen-Level', have: 3, need: 15 }] },
         lines: [{ parts: [{ t: 'Kenzuto', k: 'player' }, { t: ' schickt dir ', k: 'text' }, { t: 'Feder', k: 'item-prog' }] },
                 { parts: [{ t: 'Du', k: 'me' }, { t: ' schickst ', k: 'text' }, { t: 'Schwimmen', k: 'item-prog' }, { t: ' an Leeni', k: 'text' }] }],
         hints: [{ mine: true, item: 'Blauer Schalter', k: 'item-prog', who: 'Galaxy', location: 'Keller 2' }] });
  previewT = setTimeout(() => { preview = false; hide(); tick().catch(() => {}); }, 8000);
}

function toggle() {
  const on = !enabled();
  ctx.saveSettings({ ...ctx.loadSettings(), overlay: on });
  if (!on) hide(); else tick().catch(() => {});
  return on;
}

function start(c) {
  ctx = c;
  clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), 3000);
  screen.on('display-metrics-changed', place);
}

module.exports = { _win: () => win, start, toggle, showPreview, place, refresh: () => { place(); tick().catch(() => {}); } };
