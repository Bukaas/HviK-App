// Hintergrund: Symbol im Infobereich, Autostart, Windows-Benachrichtigungen, "Spiel läuft", Protokoll für "Fehler melden".
const { app, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  autostart: false,   // Autostart mit Windows: aus, nur in den Einstellungen anschaltbar
  tray: true,         // Schließen = im Hintergrund weiterlaufen (für Benachrichtigungen)
  notify: { lobbys: true, round: true, items: true, mentions: true, bell: true, liga: true, termine: true, admin: true },
};

let ctx = null;            // { win, view, site, loadSettings, saveSettings, fetchJson }
let tray = null, quitting = false, trayHintShown = false;
const log = [];            // letzte Meldungen/Fehler für "Fehler melden"
let running = null;        // gerade gestartetes Spiel {label, icon, url, at}
let lastGuide = null;      // letzte Anleitung (auch offline abrufbar)
let online = true, fails = 0, adminOff = false, pollNo = 0;
const quick = { mc: [], ap: [], next: null };  // für das Schnellstart-Menü im Infobereich
const remindedTermine = new Set();

function settings() {
  const s = ctx.loadSettings();
  return { ...DEFAULTS, ...s, notify: { ...DEFAULTS.notify, ...(s.notify || {}) } };
}

function note(kind, text) {
  log.push(`${new Date().toISOString().slice(11, 19)} [${kind}] ${text}`);
  if (log.length > 60) log.shift();
}

function show(url) {
  const { win, view } = ctx;
  if (!win) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (url) view.webContents.loadURL(url.startsWith('http') ? url : ctx.site + url);
}

function notify(title, body, url) {
  note('push', `${title} – ${body}`);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'icon.png'), silent: false });
  n.on('click', () => show(url));
  n.show();
}

// ---------- Symbol im Infobereich + Schließen = Hintergrund ----------
function setupTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));  // tray@2x.png wird bei hoher Auflösung von selbst genommen
  tray.setToolTip('HviK');
  updateMenu();
  tray.on('click', () => show());
  ctx.win.on('close', e => {
    if (quitting || !settings().tray) return;
    e.preventDefault();
    ctx.win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      notify('HviK läuft im Hintergrund weiter', 'Damit du Benachrichtigungen bekommst. Ganz beenden: Rechtsklick auf das HviK-Symbol unten rechts → Beenden.');
    }
  });
  app.on('before-quit', () => { quitting = true; });
}

// Schnellstart: laufendes Spiel, offene Lobbys/Runden, nächster Termin
function updateMenu() {
  if (!tray) return;
  const items = [{ label: 'HviK öffnen', click: () => show() }];
  if (running) items.push({ label: `▶ ${running.icon || '🎮'} ${running.label} – Anleitung`, click: () => show(running.url) });
  if (!online) items.push({ label: '⚠ Keine Verbindung zu hvik.org', enabled: false });
  items.push({ type: 'separator' });
  const lobbys = [
    ...quick.mc.map(c => ({ label: `⛏️ ${c.name} (${c.members.length})${c.mine ? ' – deine' : ''}`, click: () => show(`/games/minecraft/${c.code}`) })),
    ...quick.ap.map(c => ({ label: `🧩 ${c.title} (${c.players.length})${c.mine ? ' – deine' : ''}`, click: () => show(c.url) })),
  ];
  items.push(lobbys.length ? { label: `🎮 Offene Lobbys (${lobbys.length})`, submenu: lobbys } : { label: '🎮 Gerade keine offene Lobby', enabled: false });
  items.push({ label: '⛏️ Minecraft (HviK Link)', click: () => show('/games/minecraft') }, { label: '🧩 Archipelago', click: () => show('/events/archipelago') });
  if (quick.next) items.push({ label: `🗓️ ${quick.next.time} ${quick.next.title}`, click: () => show(quick.next.url) });
  items.push({ label: '🗓️ Alle Termine', click: () => show('/termine') }, { type: 'separator' },
             { label: '📜 Patchnotes', click: () => show('/app#patchnotes') }, { label: '⚙️ Einstellungen', click: () => show('/app/einstellungen') },
             { type: 'separator' }, { label: 'Beenden', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- Autostart ----------
function applyAutostart() {
  try { app.setLoginItemSettings({ openAtLogin: !!settings().autostart, args: ['--versteckt'] }); } catch { /* egal */ }
}

// ---------- Benachrichtigungen: alle 30 s bei hvik.org nachsehen ----------
const seen = { mc: null, ap: null, apStatus: {}, bell: null, liga: null, confirms: null, chat: {} };
async function poll() {
  const s = settings();
  pollNo++;
  const get = async u => { try { return await ctx.fetchJson(u); } catch { return null; } };
  // "Wer ist online?" + Verbindung prüfen
  try {
    await ctx.postJson('/api/online', { activity: running ? `${running.icon || '🎮'} ${running.label}` : '' });
    fails = 0;
    if (!online) { online = true; ctx.onNet(true); note('netz', 'wieder verbunden'); }
  } catch (e) {
    if (++fails >= 2 && online) { online = false; ctx.onNet(false); note('netz', 'keine Verbindung: ' + e.message); }
    updateMenu();
    return;
  }
  // Minecraft-Lobbys
  const mc = await get('/api/mclink/lobbys');
  if (mc && mc.items) {
    const open = mc.items.filter(c => c.status === 'lobby');
    if (seen.mc && s.notify.lobbys) for (const c of open) if (!seen.mc.has(c.code) && !c.mine)
      notify('⛏️ Neue Minecraft-Lobby', `„${c.name}“ ist offen – ${c.members.length} dabei. Klick zum Beitreten.`, `/games/minecraft`);
    seen.mc = new Set(open.map(c => c.code));
    quick.mc = open;
  }
  // Archipelago-Runden + "deine Runde startet"
  const ap = await get('/api/archipelago/lobbys');
  if (ap && ap.items) {
    if (seen.ap && s.notify.lobbys) for (const c of ap.items) if (!seen.ap.has(c.id) && c.status === 'lobby' && !c.mine)
      notify('🧩 Neue Archipelago-Runde', `„${c.title}“ – ${c.host} sammelt Mitspieler.`, c.url);
    for (const c of ap.items) {
      const before = seen.apStatus[c.id];
      if (before && before !== c.status && c.mine && s.notify.round) {
        if (c.status === 'running') notify('▶ Deine Runde läuft!', `„${c.title}“ ist gestartet – jetzt auf ▶ Spielen.`, c.url);
        if (c.status === 'error') notify('⚠️ Runde konnte nicht starten', `„${c.title}“ – schau auf die Runden-Seite.`, c.url);
      }
      seen.apStatus[c.id] = c.status;
    }
    seen.ap = new Set(ap.items.map(c => c.id));
    quick.ap = ap.items.filter(c => c.status === 'lobby' || c.mine);
    // Chat/Items in meinen laufenden Runden
    if (s.notify.items || s.notify.mentions) for (const c of ap.items.filter(x => x.mine && x.status === 'running')) await pollChat(c, s);
  }
  // Glocke (festgesteckt, Erfolge)
  if (s.notify.bell) {
    const b = await get('/api/glocke');
    if (b && b.items) {
      const keys = new Set();
      for (const it of b.items) {
        const k = it.key || (it.kind === 'achievements' ? 'ach:' + it.items.map(a => a.id || a.name).join(',') : null);
        if (!k || it.seen) continue;
        keys.add(k);
        if (seen.bell && !seen.bell.has(k)) {
          if (it.kind === 'stuck') notify('🧱 Jemand braucht dich', `${it.who} braucht ${it.item ? '„' + it.item + '“' : 'etwas'} aus deiner Welt (${it.world}).`, it.url);
          else if (it.kind === 'achievements') notify('🏅 Erfolg freigeschaltet!', it.items.map(a => `${a.icon} ${a.name}`).join(', '), '/profil');
        }
      }
      seen.bell = keys;
    }
  }
  // Liga / Turnier: Herausforderungen und Bestätigungen
  if (s.notify.liga) {
    const l = await get('/api/liga/offen'), cf = await get('/api/bestaetigen');
    const keys = new Set([...(l && l.items || []).map(i => `liga:${i.kind}:${i.id}`), ...(cf && cf.items || []).map(i => `perk:${i.tournament_id}:${i.perk_id}`)]);
    if (seen.liga) for (const k of keys) if (!seen.liga.has(k)) {
      if (k.startsWith('liga:challenge')) notify('⚔️ Neue Herausforderung', 'Du wurdest in der Liga herausgefordert.', '/liga');
      else if (k.startsWith('liga:confirm')) notify('✅ Ergebnis bestätigen', 'Dein Gegner hat ein Ergebnis gemeldet – bitte bestätigen.', '/liga');
      else if (k.startsWith('perk:')) notify('🧩 Turnier: Bestätigung nötig', 'Für dein Turnier musst du etwas bestätigen.', '/tournaments');
      else notify('🔔 Liga', 'Es gibt etwas Neues in der Liga.', '/liga');
    }
    seen.liga = keys;
  }
  // Termine: 15 Minuten vorher erinnern
  if (pollNo % 2 === 1) {
    const tm = await get('/api/termine');
    if (tm && tm.items) {
      const now = Date.now() / 1000;
      quick.next = tm.items.find(x => x.at > now) || null;
      if (s.notify.termine) for (const x of tm.items) {
        const left = x.at - now;
        if (left > 0 && left <= 15 * 60 && !remindedTermine.has(x.key)) {
          remindedTermine.add(x.key);
          notify(`${x.icon} In ${Math.max(1, Math.round(left / 60))} Min.: ${x.title}`, `${x.time} Uhr – klick für Details.`, x.url);
        }
      }
    }
  }
  // Admin-Meldungen (nur für Admins - sonst antwortet hvik.org mit 403 und wir fragen nicht mehr)
  if (!adminOff && s.notify.admin) {
    try {
      const a = await ctx.fetchJson('/api/app/admin');
      const keys = new Set((a.items || []).map(i => i.key));
      if (seen.admin) for (const i of a.items || []) if (!seen.admin.has(i.key)) notify(i.title, i.text, i.url);
      seen.admin = keys;
    } catch (e) {
      if (/403/.test(e.message)) adminOff = true;
    }
  }
  updateMenu();
}

async function pollChat(c, s) {
  const after = seen.chat[c.id];
  let r;
  try { r = await ctx.fetchJson(`${c.url}/live?after=${after || 0}`); } catch { return; }
  if (!r || !r.running || !r.messages) return;
  const last = r.messages.reduce((m, x) => Math.max(m, x.id || 0), after || 0);
  if (after != null) for (const m of r.messages) {
    const text = (m.parts || []).map(p => p.t).join('');
    const item = (m.parts || []).find(p => /^item/.test(p.k));
    if (/^chat$/i.test(m.type || '')) {  // im Chat erwähnt (nicht die eigenen Nachrichten)
      const me = String(r.me || '').toLowerCase();
      if (me && s.notify.mentions && text.toLowerCase().includes(me) && !text.toLowerCase().startsWith(me + ':'))
        notify(`💬 Erwähnt in „${c.title}“`, text, c.url);
      continue;
    }
    if (m.type === 'ItemSend' && item && s.notify.items) {
      // "Sender sent Item to Empfänger (Ort)" bzw. "Name found their Item" - Empfänger = letzter Spielername
      const names = (m.parts || []).filter(p => p.k === 'player' || p.k === 'me');
      const toMe = names.length > 0 && names[names.length - 1].k === 'me';
      const important = item.k === 'item-prog' || item.k === 'item-trap';
      if (toMe && important) notify(item.k === 'item-trap' ? '🪤 Falle für dich!' : '🎁 Wichtiges Item für dich', text, c.url);
    }
  }
  seen.chat[c.id] = last;
}

// ---------- "Spiel läuft" ----------
function setRunning(r) {
  running = r ? { ...r, at: Date.now() } : null;
  if (ctx.win) ctx.win.webContents.send('game', running);
  if (tray) tray.setToolTip(running ? `HviK – ${running.icon} ${running.label} läuft` : 'HviK');
  updateMenu();
}
function setGuide(g) { lastGuide = g || null; if (ctx.win) ctx.win.webContents.send('guide', lastGuide); }

function start(c) {
  ctx = c;
  setupTray();
  applyAutostart();
  setTimeout(poll, 8000);
  setInterval(() => poll().catch(e => note('fehler', 'Benachrichtigungen: ' + e.message)), 30 * 1000);
}

function diag() {
  return { version: app.getVersion(), os: `${os.type()} ${os.release()} (${os.arch()})`, log: log.slice(-40), settings: settings() };
}

module.exports = { start, settings, applyAutostart, notify, note, setRunning, getRunning: () => running, setGuide, getGuide: () => lastGuide,
                   isOnline: () => online, diag, DEFAULTS };
