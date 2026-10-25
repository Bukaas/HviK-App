// Hintergrund: Symbol im Infobereich, Autostart, Windows-Benachrichtigungen, "Spiel läuft", Protokoll für "Fehler melden".
const { app, Tray, Menu, Notification, nativeImage, shell } = require('electron');
const { execFile } = require('child_process');
const toast = require('./toast');
const presence = require('./presence');
const overlay = require('./overlay');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  autostart: false,   // Autostart mit Windows: aus, nur in den Einstellungen anschaltbar
  tray: true,         // Schließen = im Hintergrund weiterlaufen (für Benachrichtigungen)
  notify: { lobbys: true, round: true, items: true, mentions: true, bell: true, liga: true, termine: true, admin: true, turnier: true,
            spieler: true, hints: true, ziel: true, online: true, erfolge: true },
  toastMode: 'auto',   // Popups unten rechts: 'auto' = nicht während Vollbild-Spielen, 'immer', 'aus'
  design: 'neu',       // App-Design: nur noch 'neu' (altes Design seit 25.10. weg)
  palette: 'ozean',    // Farbwelt des neuen Designs: aurora, ozean, glut, gift, sakura, rot
  discord: true,       // Discord-Status, solange ein Spiel läuft
  spielzeit: true,     // Spielzeit mitzählen
  overlay: false,      // Overlay im Spiel (Archipelago-Fortschritt) - an/aus auch mit Strg+Alt+O
  overlayPos: 'oben-rechts',
};

let ctx = null;            // { win, view, site, loadSettings, saveSettings, fetchJson }
let tray = null, quitting = false, trayHintShown = false;
const log = [];            // letzte Meldungen/Fehler für "Fehler melden"
let running = null;        // gerade gestartetes Spiel {label, icon, url, at}
let lastGuide = null;      // letzte Anleitung (auch offline abrufbar)
let online = true, fails = 0, pollNo = 0;
const quick = { mc: [], ap: [], apMine: [], next: null };  // für das Schnellstart-Menü im Infobereich

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
  // Schaut man gerade genau auf diese Seite, braucht es keine Windows-Benachrichtigung
  try {
    const cur = new URL(ctx.view.webContents.getURL()), want = url ? new URL(url, ctx.site) : null;
    if (want && ctx.win.isVisible() && ctx.win.isFocused() && !ctx.win.isMinimized() && cur.pathname === want.pathname) { note('push (gesehen)', title); return; }
  } catch { /* egal */ }
  notifyAction(title, body, () => show(url));
}
// Windows-Benachrichtigung mit eigener Aktion beim Klick (z. B. Update installieren)
const keep = new Set();  // Benachrichtigungen festhalten, sonst räumt der Speicher sie weg und der Klick geht ins Leere
function notifyAction(title, body, onClick) {
  note('push', `${title} – ${body}`);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'icon.png'), silent: false });
  keep.add(n);
  n.on('click', () => { keep.delete(n); onClick && onClick(); });
  n.on('close', () => keep.delete(n));
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
    if (!trayHintShown && !ctx.loadSettings().trayHintShown) {  // nur ein einziges Mal (gemerkt)
      trayHintShown = true;
      ctx.saveSettings({ ...ctx.loadSettings(), trayHintShown: true });
      notify('HviK läuft im Hintergrund weiter', 'Damit du Benachrichtigungen bekommst. Ganz beenden: Rechtsklick auf das HviK-Symbol unten rechts → Beenden.');
    }
  });
  // Beim Beenden: gesammelte Spielzeit noch schnell abgeben (höchstens 3 Sekunden warten)
  let flushedOnQuit = false;
  app.on('before-quit', e => {
    quitting = true;
    if (flushedOnQuit || !track || !running || track.pending < 60 || !settings().spielzeit) return;
    e.preventDefault();
    flushedOnQuit = true;
    Promise.race([flushPlaytime(true), new Promise(r => setTimeout(r, 3000))]).finally(() => app.quit());
  });
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
             { label: `🎮 Overlay im Spiel: ${settings().overlay ? 'an' : 'aus'} (Strg+Alt+O)`, click: () => { overlay.toggle(); updateMenu(); } },
             { label: '📜 Patchnotes', click: () => show('/app#patchnotes') }, { label: '⚙️ Einstellungen', click: () => show('/app/einstellungen') },
             { type: 'separator' }, { label: 'Beenden', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- Autostart ----------
function applyAutostart() {
  try { app.setLoginItemSettings({ openAtLogin: !!settings().autostart, args: ['--versteckt'] }); } catch { /* egal */ }
}

// ---------- Benachrichtigungen: alle 30 s bei hvik.org nachsehen ----------
const seen = { mc: null, ap: null, apStatus: {}, bell: null, liga: null, confirms: null, chat: {}, chatPrimed: {}, hints: new Set(), online: null };
const lastOnline = {};  // user_id -> zuletzt online gesehen (ms) - "ist online" nur nach mind. 10 Min. Pause
let polling = false;  // nie zwei Abfragen gleichzeitig (sonst doppelte Meldungen)
async function safePoll() {
  if (polling) return;
  polling = true;
  try { await poll(); } catch (e) { note('fehler', 'Benachrichtigungen: ' + e.message); } finally { polling = false; }
}
async function poll() {
  const s = settings();
  pollNo++;
  // EINE Abfrage für alles (Online-Meldung, Lobbys, Runden, Glocke, Liga, Turnier, Termine, Admin, Chat)
  const chatWanted = {};
  for (const c of quick.apMine) chatWanted[c.id] = seen.chat[c.id] || 0;
  let f;
  try {
    f = await ctx.postJson('/api/app/feed', { activity: running ? `${running.icon || '🎮'} ${running.label}` : '', termine: pollNo % 2 === 1,
                                               chat: (s.notify.items || s.notify.mentions) ? chatWanted : {} });
    fails = 0;
    if (!online) { online = true; ctx.onNet(true); note('netz', 'wieder verbunden'); }
  } catch (e) {
    if (e.status) {  // hvik.org hat geantwortet (z. B. 401 = nicht eingeloggt) -> Verbindung ist da, nur ohne Login gibt es nichts zu melden
      fails = 0;
      if (!online) { online = true; ctx.onNet(true); }
      updateMenu();
      return;
    }
    if (++fails >= 2 && online) { online = false; ctx.onNet(false); note('netz', 'keine Verbindung: ' + e.message); }
    updateMenu();
    return;
  }
  // Wer kommt online? (kleiner Toast, nur wenn jemand mind. 10 Minuten weg war)
  if (Array.isArray(f.online)) {
    const now = Date.now();
    for (const u of f.online) {
      const before = lastOnline[u.id];
      if (seen.online && s.notify.online && (!before || now - before > 10 * 60 * 1000))
        toast.show({ kind: 'info', small: true, quiet: true, icon: '🟢', title: 'HviK Community', name: `${u.name} ist online`,
                     text: u.activity ? `🎮 ${u.activity}` : '', colorHex: '#43b581', seconds: 5 });
      lastOnline[u.id] = now;
    }
    seen.online = true;
  }
  // Minecraft-Lobbys
  const mc = f.mc;
  if (mc && mc.items) {
    const open = mc.items.filter(c => c.status === 'lobby');
    if (seen.mc && s.notify.lobbys) for (const c of open) if (!seen.mc.has(c.code) && !c.mine)
      notify('⛏️ Neue Minecraft-Lobby', `„${c.name}“ ist offen – ${c.members.length} dabei. Klick zum Beitreten.`, `/games/minecraft`);
    seen.mc = new Set(open.map(c => c.code));
    quick.mc = open;
  }
  // Archipelago-Runden + "deine Runde startet"
  const ap = f.ap;
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
    quick.apMine = ap.items.filter(x => x.mine && x.status === 'running');
  }
  // Chat/Items in meinen laufenden Runden (kommt gleich mit)
  for (const c of quick.apMine) if (f.chat && f.chat[c.id]) handleChat(c, f.chat[c.id], s);
  // Glocke (festgesteckt, Erfolge)
  const b = f.bell;
  if (s.notify.bell && b && b.items) {
    const keys = new Set();
    for (const it of b.items) {
      if (it.seen) continue;
      if (it.kind === 'achievements') {  // jeder Erfolg einzeln merken - sonst ploppen beim nächsten alle nochmal auf
        for (const a of it.items) {
          const k = 'ach:' + a.name;
          keys.add(k);
          if (seen.bell && !seen.bell.has(k) && s.notify.erfolge) {
            note('erfolg', a.name);
            toast.show({ kind: 'achievement', icon: a.icon, title: '🏅 Erfolg freigeschaltet', name: a.name, text: a.desc,
                         foot: `${a.difficulty} · ${a.pct} % der Community haben ihn`, color: a.difficulty, seconds: 7,
                         buttons: [{ label: 'Ansehen', action: 'open:/profil' }] });
          }
        }
        continue;
      }
      const k = it.key;
      if (!k) continue;
      keys.add(k);
      if (seen.bell && !seen.bell.has(k) && it.kind === 'stuck')
        notify('🧱 Jemand braucht dich', `${it.who} braucht ${it.item ? '„' + it.item + '“' : 'etwas'} aus deiner Welt (${it.world}).`, it.url);
    }
    seen.bell = keys;
  }
  // Liga / Turnier: Herausforderungen und Bestätigungen
  if (s.notify.liga) {
    const l = f.liga, cf = f.confirms;
    const keys = new Set([...(l && l.items || []).map(i => `liga:${i.kind}:${i.id}`), ...(cf && cf.items || []).map(i => `perk:${i.tournament_id}:${i.perk_id}`)]);
    if (seen.liga) for (const k of keys) if (!seen.liga.has(k)) {
      if (k.startsWith('liga:challenge')) notify('⚔️ Neue Herausforderung', 'Du wurdest in der Liga herausgefordert.', '/liga');
      else if (k.startsWith('liga:confirm')) notify('✅ Ergebnis bestätigen', 'Dein Gegner hat ein Ergebnis gemeldet – bitte bestätigen.', '/liga');
      else if (k.startsWith('perk:')) notify('🧩 Turnier: Bestätigung nötig', 'Für dein Turnier musst du etwas bestätigen.', '/tournaments');
      else notify('🔔 Liga', 'Es gibt etwas Neues in der Liga.', '/liga');
    }
    seen.liga = keys;
  }
  // Turnier: "Dein Match ist bereit" (mit Knöpfen Zum Match / Voice-Kanal)
  const mm = f.match;
  if (s.notify.turnier && mm && mm.items) {
    const keys = new Set(mm.items.map(m => m.key));
    if (seen.match) for (const m of mm.items) if (!seen.match.has(m.key)) {
      note('turnier', `Match ${m.number}: ${m.me} vs ${m.opponent}`);
      toast.show({ kind: 'match', urgent: true, icon: '⚔️', title: `Dein Match ist bereit · ${m.tournament}`, name: `${m.me} vs ${m.opponent}`,
                   text: `Spiel ${m.number} – viel Erfolg!`, colorHex: '#f4c150', seconds: 25,
                   buttons: [{ label: '⚔️ Zum Match', action: `open:${m.url}` }, { label: '🔊 In meinen Voice-Kanal', action: `voice:${m.id}:${m.side}` }] });
    }
    seen.match = keys;
    // Gegner hat ein Ergebnis gemeldet -> ich muss es bestätigen
    const ck = new Set(mm.items.filter(m => m.confirm).map(m => m.confirm_key));
    if (seen.matchConfirm) for (const m of mm.items) if (m.confirm && !seen.matchConfirm.has(m.confirm_key)) {
      note('turnier', `Ergebnis bestätigen: Spiel ${m.number}`);
      toast.show({ kind: 'match', urgent: true, icon: '✅', title: `Ergebnis bestätigen · ${m.tournament}`, name: `${m.me} vs ${m.opponent}`,
                   text: `${m.reported} – stimmt das?`, colorHex: '#f4c150', seconds: 25,
                   buttons: [{ label: '✅ Zum Bestätigen', action: `open:${m.url}` }] });
    }
    seen.matchConfirm = ck;
  }
  // Termine: 15 Minuten vorher erinnern (erinnerte merken sich die Einstellungen - kein Doppel nach Neustart)
  const tm = f.termine;
  if (tm && tm.items) {
    const now = Date.now() / 1000;
    quick.next = tm.items.find(x => x.at > now) || null;
    if (s.notify.termine) {
      const done = new Set(ctx.loadSettings().reminded || []);
      for (const x of tm.items) {
        const left = x.at - now;
        if (left > 0 && left <= 15 * 60 && !done.has(x.key)) {
          done.add(x.key);
          ctx.saveSettings({ ...ctx.loadSettings(), reminded: [...done].slice(-50) });
          notify(`${x.icon} In ${Math.max(1, Math.round(left / 60))} Min.: ${x.title}`, `${x.time} Uhr – klick für Details.`, x.url);
        }
      }
    }
  }
  // Admin-Meldungen (kommen nur für Admins mit)
  const a = f.admin;
  if (s.notify.admin && a && a.items) {
    const keys = new Set(a.items.map(i => i.key));
    if (seen.admin) for (const i of a.items) if (!seen.admin.has(i.key)) notify(i.title, i.text, i.url);
    seen.admin = keys;
  }
  updateMenu();
}

function handleChat(c, r, s) {
  const after = seen.chat[c.id];
  const last = (r.messages || []).reduce((m, x) => Math.max(m, x.id || 0), after || 0);
  if (seen.chatPrimed[c.id]) for (const m of r.messages || []) {  // beim ersten Mal nur merken, nicht alles Alte melden
    const text = (m.parts || []).map(p => p.t).join('');
    const item = (m.parts || []).find(p => /^item/.test(p.k));
    // jemand startet seine Welt (nur echte Spiele - keine Website-/Tracker-Verbindungen, nicht man selbst)
    const join = /^(.+?) \(Team #\d+\) playing (.+?) has joined/.exec(text);
    if (m.type === 'Join') {
      if (join && s.notify.spieler && join[1] !== r.me && !/TextOnly|Tracker|HintGame/.test(text))
        toast.show({ kind: 'info', small: true, quiet: true, icon: '🟢', title: `Im Spiel · ${c.title}`, name: `${join[1]} ist im Spiel`,
                     text: join[2], colorHex: '#7bd88f', seconds: 6, buttons: [] });
      continue;
    }
    const goal = /^(.+?) \(Team #\d+\) has completed their goal/.exec(text);
    if (m.type === 'Goal' && goal) {
      if (s.notify.ziel) toast.show({ kind: 'info', icon: '🏁', title: `Ziel erreicht · ${c.title}`, name: `${goal[1]} hat sein Ziel geschafft!`,
                                      text: goal[1] === r.me ? 'Glückwunsch! 🎉' : 'Gut gemacht!', colorHex: '#f4c150', seconds: 8 });
      continue;
    }
    if (m.type === 'Release' || m.type === 'Collect') {
      const who = (/^(.+?) \(Team/.exec(text) || [])[1] || 'Jemand';
      if (s.notify.ziel) toast.show({ kind: 'info', small: true, quiet: true, icon: m.type === 'Release' ? '📤' : '📥', title: c.title,
                                      name: m.type === 'Release' ? `${who} hat seine Welt freigegeben` : `${who} hat seine Items eingesammelt`,
                                      text: m.type === 'Release' ? 'Alle Items daraus sind verschickt.' : '', colorHex: '#9b5de5', seconds: 6 });
      continue;
    }
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
  // Hints, die mich betreffen: mein Item liegt irgendwo / jemand braucht etwas aus meiner Welt
  for (const h of r.hints || []) {
    const k = `${c.id}:${h.key}`;
    if (seen.hints.has(k)) continue;
    seen.hints.add(k);
    if (!seen.chatPrimed[c.id] || !s.notify.hints) continue;
    const mine = h.receiver === r.me;
    toast.show({ kind: 'info', icon: '💡', title: `Hint · ${c.title}`, name: mine ? `Dein ${h.item}` : `${h.receiver} braucht ${h.item}`,
                 text: mine ? `liegt bei ${h.finder}: ${h.location}` : `aus deiner Welt: ${h.location}`, colorHex: '#ffd166', seconds: 10,
                 buttons: [{ label: 'Zur Runde', action: `open:${c.url}` }] });
  }
  seen.chatPrimed[c.id] = true;
}

// ---------- "Spiel läuft" ----------
// Spielzeit: solange das Spiel (Prozess) läuft, jede Minute mitzählen; alle 5 Min. an hvik.org. Ist es zu, endet "läuft".
let track = null;  // {procs, seen, lastSeen, pending, startedAt}
function procList() {
  return new Promise(res => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 << 20 },
    (err, out) => res(err ? null : new Set(String(out).split(/\r?\n/).map(l => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase()).filter(Boolean)))));
}
async function flushPlaytime(force) {
  if (!track || !running || track.pending < (force ? 60 : 300) || !settings().spielzeit) return;
  const seconds = track.pending;
  track.pending = 0;
  try { await ctx.postJson('/api/spielzeit', { game: running.label, icon: running.icon, seconds }); } catch { track.pending += seconds; }
}
async function trackTick() {
  // Spiele ohne Prozess-Erkennung: "läuft" (und der Discord-Status) endet spätestens nach 4 Stunden von selbst
  if (running && !track && Date.now() - running.at > 4 * 60 * 60 * 1000) { note('spiel', `${running.label}: nach 4 Std. beendet`); setRunning(null); return; }
  if (!track || !running) return;
  const list = await procList();
  if (!list) return;
  const on = track.procs.some(p => list.has(p.toLowerCase()));
  const now = Date.now();
  if (on) { track.seen = true; track.lastSeen = now; track.pending += 60; await flushPlaytime(false); return; }
  // Spiel zu (5 Min. weg) oder nie aufgetaucht (20 Min.) -> fertig
  if ((track.seen && now - track.lastSeen > 5 * 60 * 1000) || (!track.seen && now - track.startedAt > 20 * 60 * 1000)) {
    await flushPlaytime(true);
    note('spiel', `${running.label} beendet`);
    setRunning(null);
  }
}

function setRunning(r) {
  if (!r && track) flushPlaytime(true);
  running = r ? { ...r, at: Date.now() } : null;
  track = r && r.procs && r.procs.length ? { procs: r.procs, seen: false, lastSeen: 0, pending: 0, startedAt: Date.now() } : null;
  presence.update(running, settings().discord);
  if (ctx.win) ctx.win.webContents.send('game', running);
  if (tray) tray.setToolTip(running ? `HviK – ${running.icon} ${running.label} läuft` : 'HviK');
  updateMenu();
}
function setGuide(g) { lastGuide = g || null; if (ctx.win) ctx.win.webContents.send('guide', lastGuide); }

function start(c) {
  ctx = c;
  overlay.start({ settings, loadSettings: c.loadSettings, saveSettings: c.saveSettings, fetchJson: c.fetchJson, apMine: () => quick.apMine });
  toast.setMode(() => settings().toastMode);
  toast.setLook(() => (settings().design === 'neu' ? { palette: settings().palette || 'ozean' } : null));
  toast.setOnHeld(t => {
    note('vollbild', `wartet: ${t.title}`);
    try { shell.beep(); } catch { /* egal */ }
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.flashFrame(true);  // Taskleiste blinkt, bis man die App anklickt
  });
  toast.setHandler(async action => {
    if (action.startsWith('open:')) return show(action.slice(5));
    if (action.startsWith('voice:')) {
      const [, id, side] = action.split(':');
      let r;
      try { r = await ctx.postJson(`/tournaments/api/matches/${id}/channel`, { side }); } catch (e) { r = { ok: false, message: 'hvik.org ist gerade nicht erreichbar.' }; }
      toast.show({ kind: 'info', icon: r.ok ? '🔊' : '⚠️', title: r.ok ? 'Voice-Kanal' : 'Hat nicht geklappt', name: r.ok ? 'Du wurdest verschoben' : '',
                   text: r.message || (r.ok ? '' : 'Bist du schon in einem Voice-Kanal im Discord?'), colorHex: r.ok ? '#7bd88f' : '#ff4d5e', seconds: 6 });
    }
  });
  ctx.fetchJson('/api/app/config').then(cfg => presence.start(cfg)).catch(() => {});
  setInterval(() => trackTick().catch(() => {}), 60 * 1000);
  setupTray();
  applyAutostart();
  setTimeout(safePoll, 8000);
  setInterval(() => safePoll(), 30 * 1000);
  // Turnier/Liga: alle 4 s ein winziger Fingerabdruck – ändert sich etwas (Match bereit, Ergebnis gemeldet,
  // Herausforderung), sofort die große Abfrage machen statt bis zu 30 s zu warten
  let stand = null;
  setInterval(async () => {
    if (!online) return;
    try {
      const v = (await ctx.fetchJson('/api/seitenstand?b=turniere,liga')).v;
      if (v && stand && v !== stand) { safePoll(); if (ctx.onChange) ctx.onChange(); }
      if (v) stand = v;
    } catch { /* nächster Versuch */ }
  }, 4000);
}

function diag() {
  return { version: app.getVersion(), os: `${os.type()} ${os.release()} (${os.arch()})`, log: log.slice(-40), settings: settings() };
}

function refreshPresence() { presence.update(running, settings().discord); }
function testToast() {
  toast.show({ kind: 'achievement', icon: '🏅', title: '🏅 Erfolg freigeschaltet', name: 'So sieht ein Erfolg aus', text: 'So kommen Meldungen unten rechts – während Vollbild-Spielen warten sie, bis du wieder raus bist.', foot: 'Test', color: 'legendär', seconds: 7, force: true });
}
module.exports = { overlay, start, settings, applyAutostart, notify, notifyAction, note, setRunning, refreshPresence, testToast, getRunning: () => running, setGuide, getGuide: () => lastGuide,
                   isOnline: () => online, diag, DEFAULTS };
