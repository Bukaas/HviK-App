// HviK Desktop-App: Fenster mit eigener Titelleiste, darin hvik.org (Login über Discord wie auf der Seite).
const { app, BrowserWindow, WebContentsView, ipcMain, shell, nativeTheme, session, dialog, Menu } = require('electron');
const minecraft = require('./minecraft');
const archipelago = require('./archipelago');
const background = require('./background');
const path = require('path');
const fs = require('fs');

const SITE = process.env.HVIK_SITE || 'https://hvik.org';
const BAR = 40;  // Höhe der Titelleiste
// Im App-Fenster bleiben nur hvik.org und der Discord-Login - Einladungen, Kanäle usw. gehen ins Discord-Programm bzw. den Browser
const ALLOWED = [/^https:\/\/(www\.)?hvik\.org([/?#]|$)/, /^https:\/\/(\w+\.)?discord(app)?\.com\/(oauth2|login|api\/(v\d+\/)?oauth2|register|2fa|verify|reset)/,
                 /^https:\/\/(\w+\.)?hcaptcha\.com\//];

nativeTheme.themeSource = 'dark';
app.setAppUserModelId('org.hvik.app');
if (!app.requestSingleInstanceLock()) app.exit(0);  // läuft schon -> sofort raus (die laufende App holt sich nach vorne)

const stateFile = () => path.join(app.getPath('userData'), 'fenster.json');
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveBounds(win) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), max: win.isMaximized() })); } catch { /* egal */ }
}

let win, view, firstLoad = true;

function layout() {
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) });
}

function sendNav() {
  const wc = view.webContents;
  win.webContents.send('nav', {
    title: wc.getTitle(), url: wc.getURL(),
    back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(), loading: wc.isLoading(),
  });
}

function createWindow() {
  const b = loadBounds();
  // gespeicherte Position nur nehmen, wenn sie noch auf einem Bildschirm liegt (z. B. zweiter Monitor abgesteckt)
  const { screen } = require('electron');
  const visible = b.x != null && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 100 > a.x && b.x < a.x + a.width - 100 && b.y + 40 > a.y && b.y < a.y + a.height - 40;
  });
  if (!visible) { delete b.x; delete b.y; }
  win = new BrowserWindow({
    width: b.width || 1320, height: b.height || 840, x: b.x, y: b.y, minWidth: 940, minHeight: 600,
    title: 'HviK', backgroundColor: '#0d0f13', show: false,
    icon: path.join(__dirname, 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0f13', symbolColor: '#c9ced8', height: BAR },
    webPreferences: { preload: path.join(__dirname, 'shell-preload.js') },
  });
  if (b.max) win.maximize();
  win.loadFile(path.join(__dirname, 'shell.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--versteckt')) win.show(); });  // Autostart: nur ins Symbol unten rechts

  view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'site-preload.js'), partition: 'persist:hvik',
                      additionalArguments: [`--hvik-version=${app.getVersion()}`] },
  });
  view.setBackgroundColor('#0d0f13');
  win.contentView.addChildView(view);
  view.setVisible(false);  // erst zeigen, wenn die Seite geladen ist (bis dahin Ladebildschirm)
  layout();
  win.on('resize', layout);
  win.on('close', () => saveBounds(win));

  const wc = view.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} HviKApp/${app.getVersion()}`);  // die Seite erkennt die App daran
  wc.setWindowOpenHandler(({ url }) => {  // neue Fenster: eigene Seiten im App-Fenster, alles andere im Browser
    if (ALLOWED.some(r => r.test(url))) wc.loadURL(url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!ALLOWED.some(r => r.test(url))) { e.preventDefault(); shell.openExternal(url); }
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, sendNav);
  wc.on('found-in-page', (e, r) => win.webContents.send('find-result', { matches: r.matches, active: r.activeMatchOrdinal }));
  wc.on('did-navigate', () => { if (finding) stopFind(); });
  wc.on('did-finish-load', () => {
    if (firstLoad) { firstLoad = false; view.setVisible(true); win.webContents.send('ready'); }
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;  // -3 = abgebrochen (z. B. Weiterleitung)
    view.setVisible(false);
    firstLoad = true;
    win.webContents.send('offline', desc);
    win.webContents.send('guide', background.getGuide());
    setTimeout(() => { if (firstLoad) { win.webContents.send('loading'); view.webContents.loadURL(SITE); } }, 15000);  // von selbst nochmal versuchen
  });
  wc.loadURL(SITE);
  shortcuts(wc);
  shortcuts(win.webContents);
  // aus dem Infobereich geöffnet: offene Update-Frage bzw. "Neu in Version" jetzt zeigen
  win.on('show', () => { setTimeout(() => { askUpdate(); showWhatsNew(); }, 800); });
}

// Tastenkürzel - wirken immer auf die Seite (das versteckte Standard-Menü ist aus, sonst lädt Strg+R die Titelleiste neu)
function shortcuts(contents) {
  contents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = (i.key || '').toLowerCase(), ctrl = i.control || i.meta, v = view.webContents;
    const hit = fn => { e.preventDefault(); fn(); };
    if (k === 'f5' || (ctrl && k === 'r')) hit(() => (i.shift ? v.reloadIgnoringCache() : v.reload()));
    else if (i.alt && k === 'arrowleft') hit(() => v.navigationHistory.canGoBack() && v.navigationHistory.goBack());
    else if (i.alt && k === 'arrowright') hit(() => v.navigationHistory.canGoForward() && v.navigationHistory.goForward());
    else if (ctrl && (k === '+' || k === '=' || k === 'add')) hit(() => v.setZoomLevel(Math.min(v.getZoomLevel() + .5, 4)));
    else if (ctrl && (k === '-' || k === 'subtract')) hit(() => v.setZoomLevel(Math.max(v.getZoomLevel() - .5, -3)));
    else if (ctrl && k === '0') hit(() => v.setZoomLevel(0));
    else if (k === 'f12' || (ctrl && i.shift && k === 'i')) hit(() => { if (!app.isPackaged) v.openDevTools({ mode: 'detach' }); });
    else if (ctrl && k === 'f') hit(() => { win.webContents.focus(); win.webContents.send('find-open'); });
    else if (k === 'escape' && finding) hit(() => stopFind());
  });
}

// ---------- Strg+F: Suchen auf der Seite (Suchfeld oben in der Leiste) ----------
let finding = false;
function stopFind() {
  finding = false;
  view.webContents.stopFindInPage('keepSelection');
  win.webContents.send('find-close');
}
ipcMain.on('find', (e, text, opts) => {
  if (!view) return;
  if (!text) { view.webContents.stopFindInPage('clearSelection'); win.webContents.send('find-result', { matches: 0, active: 0 }); return; }
  finding = true;
  view.webContents.findInPage(text, { forward: !(opts && opts.back), findNext: !!(opts && opts.next) });
});
ipcMain.on('find-stop', () => stopFind());

ipcMain.on('nav-cmd', (e, cmd) => {
  const wc = view.webContents;
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (cmd === 'reload') wc.reload();
  else if (cmd === 'home') wc.loadURL(SITE);
  else if (cmd === 'notes') wc.loadURL(SITE + '/app#patchnotes');
  else if (cmd === 'settings') wc.loadURL(SITE + '/app/einstellungen');
  else if (cmd === 'game-open') { const g = background.getRunning(); if (g && g.url) wc.loadURL(SITE + g.url); }
  else if (cmd === 'game-clear') background.setRunning(null);
  else if (cmd === 'retry') { win.webContents.send('loading'); wc.loadURL(SITE); }
  else if (cmd === 'update-install') autoUpdater.quitAndInstall(true, true);
});

// ---------- Selbst-Update über GitHub-Releases (Bukaas/HviK-App) ----------
const { autoUpdater } = require('electron-updater');
function setupUpdates() {
  if (!app.isPackaged) return;  // beim Entwickeln (npm start) nicht
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;  // spätestens beim nächsten Schließen
  autoUpdater.on('update-available', i => win && win.webContents.send('update', { state: 'loading', percent: 0, version: i.version }));
  autoUpdater.on('download-progress', p => win && win.webContents.send('update', { state: 'loading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => {
    ready = i.version;
    checking = false;
    readyNotes = Array.isArray(i.releaseNotes) ? i.releaseNotes.map(n => n.note).join('\n') : (i.releaseNotes || '');
    if (win) win.webContents.send('update', { state: 'ready', version: i.version });
    // immer: kleine Windows-Benachrichtigung unten an der Taskleiste - Klick installiert
    background.notifyAction(`✨ Update ${i.version} ist da`, (plain(latest && latest.version === i.version ? latest.notes : readyNotes).split('\n')[0] || 'Neue Version der HviK-App.')
      + '\nKlick hier zum Installieren (App startet kurz neu).', () => autoUpdater.quitAndInstall(true, true));
    askUpdate();
  });
  autoUpdater.on('error', e => { checking = false; console.warn('Update:', e && e.message); });
  autoUpdater.on('update-not-available', () => { checking = false; });
  const check = () => {
    if (ready) return askUpdate();
    if (checking) return;
    checking = true;
    autoUpdater.checkForUpdates().catch(() => { checking = false; });
  };
  check();
  setInterval(check, 30 * 60 * 1000);  // alle 30 Minuten - ist schon eins geladen, wird nochmal gefragt
  // "Push": jede Minute kurz bei hvik.org nachsehen - neue Version veröffentlicht -> sofort laden und fragen
  setInterval(async () => {
    try {
      const r = await session.fromPartition('persist:hvik').fetch(`${SITE}/api/app/latest`, { cache: 'no-store' });
      const l = await r.json();
      if (l.version) latest = l;
      if (l.version && newer(l.version, app.getVersion()) && !ready) check();
    } catch { /* offline */ }
  }, 60 * 1000);
}
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// Update fertig geladen -> mitten im Bild fragen (im HviK-Look der Seite, sonst Windows-Dialog), mit Patchnote
let ready = null, readyNotes = '', latest = null, asking = false, laterAt = 0, checking = false;
const plain = s => String(s || '').replace(/<\/(li|p)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/^\s*[-*]\s*/gm, '• ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{2,}/g, '\n').trim();
async function askUpdate() {
  // nur fragen, wenn man das Fenster auch sieht (sonst reicht die Benachrichtigung; beim Öffnen wird gefragt)
  if (!ready || asking || !win || !win.isVisible() || win.isMinimized() || Date.now() - laterAt < 25 * 60 * 1000) return;
  asking = true;
  const notes = plain(latest && latest.version === ready ? latest.notes : readyNotes);
  const text = `Version ${ready} der HviK-App ist da (du hast ${app.getVersion()}).` + (notes ? `\n\nNeu:\n${notes}` : '') +
    '\n\nJetzt neu starten und aktualisieren? Das dauert nur ein paar Sekunden.';
  let yes = null;
  try {
    yes = await view.webContents.executeJavaScript(
      `typeof hvikConfirm === 'function' ? hvikConfirm(${JSON.stringify(text)}, {title: 'Update verfügbar', icon: '✨', ok: 'Jetzt aktualisieren', cancel: 'Später', danger: false}) : null`, true);
  } catch { yes = null; }
  if (yes === null) {  // Seite ohne HviK-Dialoge (z. B. offline) -> Windows-Fenster
    const r = await dialog.showMessageBox(win, { type: 'info', title: 'Update verfügbar', message: `Version ${ready} der HviK-App ist da.`,
      detail: (notes ? `Neu:\n${notes}\n\n` : '') + 'Jetzt neu starten und aktualisieren?', buttons: ['Jetzt aktualisieren', 'Später'], defaultId: 0, cancelId: 1 });
    yes = r.response === 0;
  }
  asking = false;
  if (yes) autoUpdater.quitAndInstall(true, true);
  else laterAt = Date.now();
}

// ---------- HviK Link (Minecraft) - nur für Seiten von hvik.org ----------
const settingsFile = () => path.join(app.getPath('userData'), 'einstellungen.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
const fromSite = e => { try { return new URL(e.senderFrame.url).origin === new URL(SITE).origin; } catch { return false; } };
async function siteGet(url, json) {
  const r = await session.fromPartition('persist:hvik').fetch(url.startsWith('http') ? url : SITE + url, { cache: 'no-store' });
  if (!r.ok) throw httpError(r.status);
  return json ? r.json() : Buffer.from(await r.arrayBuffer());
}
async function sitePost(url, body) {
  const r = await session.fromPartition('persist:hvik').fetch(SITE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store' });
  if (!r.ok) throw httpError(r.status);
  return r.json();
}
// hvik.org hat geantwortet, aber mit Fehler (z. B. 401 = nicht eingeloggt) - das ist KEIN Verbindungsproblem
function httpError(status) {
  return Object.assign(new Error(`hvik.org antwortet nicht (${status}).`), { status });
}
// Verbindung weg/wieder da: Leiste oben zeigt es an; kam die Seite nicht, wird sie neu geladen
function onNet(ok) {
  if (win) win.webContents.send('net', ok);
  if (ok && firstLoad) { win.webContents.send('loading'); view.webContents.loadURL(SITE); }
}
async function lobbyInfo(code) {
  const info = await siteGet(`/api/mclink/app/${encodeURIComponent(code)}`, true);
  if (!info.ok) throw new Error(info.message || 'Lobby nicht gefunden.');
  return info;
}
let playing = false;
ipcMain.handle('mc-status', async (e, code) => {
  if (!fromSite(e)) return null;
  try { return { ok: true, ...(await minecraft.status(await lobbyInfo(code), loadSettings())) }; }
  catch (err) { return { ok: false, message: err.message }; }
});
ipcMain.handle('mc-play', async (e, code) => {
  if (!fromSite(e)) return null;
  if (playing) return { ok: false, message: 'Läuft schon …' };
  playing = true;
  const say = text => { background.note('minecraft', text); try { e.sender.send('mc-progress', text); } catch { /* Seite gewechselt */ } };
  try {
    say('Hole die Lobby-Daten …');
    const info = await lobbyInfo(code);
    const r = await minecraft.play(info, { say, get: u => siteGet(u, false), settings: loadSettings() });
    background.setRunning({ label: 'Minecraft (HviK Link)', icon: '⛏️', url: `/games/minecraft/${encodeURIComponent(code)}`, title: info.title, procs: ['javaw.exe'] });
    return { ok: true, ...r };
  } catch (err) {
    background.note('fehler', 'Minecraft: ' + err.message);
    if (err.status === 401) { view.webContents.loadURL(SITE + '/login'); return { ok: false, message: 'Bitte zuerst einloggen.' }; }
    return { ok: false, message: err.message, code: err.code || '' };
  } finally {
    playing = false;
  }
});
ipcMain.handle('mc-pick-root', async e => {
  if (!fromSite(e)) return null;
  const r = await dialog.showOpenDialog(win, { title: 'CurseForge-Ordner „Instances“ wählen (CurseForge: Einstellungen → Minecraft)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  saveSettings({ ...loadSettings(), cfRoot: r.filePaths[0] });
  return { ok: true, path: r.filePaths[0] };
});

// ---------- Archipelago - nur für Seiten von hvik.org ----------
async function download(url) {  // öffentliche Dateien (GitHub-Releases)
  const r = await session.fromPartition('persist:hvik').fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}
async function downloadNamed(url) {  // eigene Datei von hvik.org (mit Login), Dateiname aus der Antwort
  const r = await session.fromPartition('persist:hvik').fetch(SITE + url, { cache: 'no-store' });
  // Leitet hvik.org mit ?fehler=... zurück, steht die Meldung in der Adresse (r.url kann bei Electron leer sein!)
  let err = null;
  try { err = r.url ? new URL(r.url).searchParams.get('fehler') : null; } catch { err = null; }
  if (err) throw new Error(err);
  if (r.status === 401) throw httpError(401);
  if (!r.ok || /text\/html/.test(r.headers.get('content-type') || '')) throw new Error('Deine Datei ist gerade nicht abrufbar – gleich nochmal versuchen.');
  const m = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') || '');
  return { name: path.basename(m ? m[1] : 'datei'), data: Buffer.from(await r.arrayBuffer()) };
}
async function roundInfo(rid) {
  const info = await siteGet(`/api/archipelago/app/${encodeURIComponent(rid)}`, true);
  if (!info.ok) throw new Error(info.message || 'Runde nicht gefunden.');
  return info;
}
let apBusy = false;
ipcMain.handle('ap-status', async (e, rid) => {
  if (!fromSite(e)) return null;
  try {
    const info = await roundInfo(rid);
    return { ok: true, ...(await archipelago.status(info)), game_server: info.game_server, server_state: info.server_state, server_possible: info.server_possible };
  }
  catch (err) { return { ok: false, message: err.message }; }
});
ipcMain.handle('ap-play', async (e, rid, setupOnly, mode) => {
  if (!fromSite(e)) return null;
  if (apBusy) return { ok: false, message: 'Läuft schon …' };
  apBusy = true;
  const say = text => { background.note('archipelago', text); try { e.sender.send('ap-progress', text); } catch { /* Seite gewechselt */ } };
  try {
    say('Hole die Runden-Daten …');
    const info = { ...(await roundInfo(rid)), setupOnly: !!setupOnly, mode: mode === 'server' ? 'server' : 'lokal' };
    const pickFile = async (title, ext) => {
      const r = await dialog.showOpenDialog(win, { title, defaultPath: app.getPath('downloads'), properties: ['openFile'],
                                                  filters: [{ name: title, extensions: ext }, { name: 'Alle Dateien', extensions: ['*'] }] });
      return r.canceled ? null : r.filePaths[0];
    };
    const r = await archipelago.play(info, { say, download, downloadNamed, pickFile, settings: loadSettings() });
    if (!r.setupOnly) background.setRunning({ label: info.game.name, icon: info.game.icon, url: `/events/archipelago/runde/${encodeURIComponent(rid)}#anleitung`,
                                              title: `Archipelago: ${info.title || 'Runde'}`, procs: GAME_PROCS[info.game.slug] || [] });
    if (r.guide) background.setGuide(r.guide);
    return { ok: true, ...r };
  } catch (err) {
    background.note('fehler', 'Archipelago: ' + err.message);
    if (err.status === 401) { view.webContents.loadURL(SITE + '/login'); return { ok: false, message: 'Bitte zuerst einloggen.' }; }
    return { ok: false, message: err.message };
  } finally {
    apBusy = false;
  }
});
ipcMain.handle('ap-client', async (e, name) => {
  if (!fromSite(e)) return null;
  try { await archipelago.apInfo(); await archipelago.openClient(String(name)); return { ok: true }; } catch (err) { return { ok: false, message: err.message }; }
});
ipcMain.handle('ap-open-folder', async (e, folder) => {
  if (!fromSite(e)) return null;
  const target = folder && path.resolve(folder).startsWith(archipelago.ROOT) ? folder : archipelago.ROOT;
  fs.mkdirSync(target, { recursive: true });
  return shell.openPath(target);
});

// ---------- Nach einem Update: einmal "Neu in Version x.y" mit der Patchnote zeigen ----------
let whatsNewBusy = false;
async function showWhatsNew() {
  const v = app.getVersion();
  if (whatsNewBusy || loadSettings().seenVersion === v || !win || !win.isVisible() || win.isMinimized()) return;  // erst, wenn man's sieht
  whatsNewBusy = true;
  try {
    const hasDialog = await view.webContents.executeJavaScript("typeof hvikAlert === 'function'", true);
    if (!hasDialog) return;  // z. B. Login-Seite - beim nächsten Laden nochmal
    const n = await siteGet(`/api/app/notes/${encodeURIComponent(v)}`, true);
    const notes = n && n.version ? plain(n.notes) : '';
    const text = (notes || 'Die App ist auf dem neuesten Stand.') + (n && n.date ? `\n\n📅 ${n.date} · 🕒 ${n.time} Uhr` : '') +
      '\n\nAlle Patchnotes: 📜 oben in der Leiste.';
    saveSettings({ ...loadSettings(), seenVersion: v });  // vorher merken - so kommt es auch beim Neuladen nur einmal
    await view.webContents.executeJavaScript(
      `hvikAlert(${JSON.stringify(text)}, {title: ${JSON.stringify(`Neu in Version ${v}`)}, icon: '✨', ok: 'Alles klar'})`, true);
  } catch { /* offline o. ä. - nächstes Mal */ } finally {
    whatsNewBusy = false;
  }
}

// Woran man erkennt, dass das Spiel läuft (für Spielzeit + "Spiel läuft") - Spiele ohne Eintrag zählen nicht mit
const GAME_PROCS = { minecraft: ['javaw.exe'], 'super-mario-world': ['snes9x-x64.exe'], 'the-binding-of-isaac': ['isaac-ng.exe'],
                     'kingdom-hearts-2': ['KINGDOM HEARTS II FINAL MIX.exe'], 'super-mario-64': ['sm64.us.f3dex2e.exe', 'sm64.jp.f3dex2e.exe'] };

// ---------- Einstellungen + Fehler melden (Seite /app/einstellungen) ----------
ipcMain.handle('app-settings', async (e, patch) => {
  if (!fromSite(e)) return null;
  if (patch && typeof patch === 'object') {
    const allowed = {};
    for (const k of ['autostart', 'tray', 'discord', 'spielzeit']) if (k in patch) allowed[k] = !!patch[k];
    if (['auto', 'immer', 'aus'].includes(patch.toastMode)) allowed.toastMode = patch.toastMode;
    if (patch.notify && typeof patch.notify === 'object')
      allowed.notify = { ...background.settings().notify, ...Object.fromEntries(Object.entries(patch.notify).map(([k, v]) => [k, !!v])) };
    saveSettings({ ...loadSettings(), ...allowed });
    background.applyAutostart();
    background.refreshPresence();
  }
  return { ...background.settings(), cfRoot: loadSettings().cfRoot || null, apRoot: archipelago.ROOT };
});
ipcMain.handle('app-diag', async e => (fromSite(e) ? background.diag() : null));
ipcMain.handle('app-test-toast', async e => { if (fromSite(e)) background.testToast(); });
ipcMain.handle('app-test-notify', async e => {
  if (fromSite(e)) background.notify('🔔 So sehen Benachrichtigungen aus', 'Ein Klick drauf bringt dich zur passenden Seite.', '/app/einstellungen');
});
ipcMain.handle('app-open', async (e, which) => {
  if (!fromSite(e)) return null;
  const dir = which === 'roms' ? path.join(archipelago.ROOT, 'ROMs') : archipelago.ROOT;
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

app.on('second-instance', () => {
  if (!win) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);  // kein verstecktes Standard-Menü (Strg+R, Entwicklertools ...) - die Kürzel kommen aus shortcuts()
  createWindow();
  setupUpdates();
  background.start({ win, view, site: SITE, loadSettings, saveSettings, fetchJson: u => siteGet(u, true), postJson: sitePost, onNet });
  view.webContents.on('did-finish-load', showWhatsNew);
  win.webContents.on('did-finish-load', () => win.webContents.send('game', background.getRunning()));
});
app.on('window-all-closed', () => app.quit());
