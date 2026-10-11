// HviK Desktop-App: Fenster mit eigener Titelleiste, darin hvik.org (Login über Discord wie auf der Seite).
const { app, BrowserWindow, WebContentsView, ipcMain, shell, nativeTheme, session, dialog } = require('electron');
const minecraft = require('./minecraft');
const path = require('path');
const fs = require('fs');

const SITE = process.env.HVIK_SITE || 'https://hvik.org';
const BAR = 40;  // Höhe der Titelleiste
const ALLOWED = [/^https:\/\/(www\.)?hvik\.org(\/|$)/, /^https:\/\/(\w+\.)?discord\.com\//, /^https:\/\/(\w+\.)?discordapp\.com\//,
                 /^https:\/\/(\w+\.)?hcaptcha\.com\//];

nativeTheme.themeSource = 'dark';
app.setAppUserModelId('org.hvik.app');
if (!app.requestSingleInstanceLock()) app.quit();

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
  win = new BrowserWindow({
    width: b.width || 1320, height: b.height || 840, x: b.x, y: b.y, minWidth: 940, minHeight: 600,
    title: 'HviK', backgroundColor: '#0d0f13', show: false,
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0f13', symbolColor: '#c9ced8', height: BAR },
    webPreferences: { preload: path.join(__dirname, 'shell-preload.js') },
  });
  if (b.max) win.maximize();
  win.loadFile(path.join(__dirname, 'shell.html'));
  win.once('ready-to-show', () => win.show());

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
  wc.on('did-finish-load', () => {
    if (firstLoad) { firstLoad = false; view.setVisible(true); win.webContents.send('ready'); }
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;  // -3 = abgebrochen (z. B. Weiterleitung)
    view.setVisible(false);
    firstLoad = true;
    win.webContents.send('offline', desc);
  });
  wc.loadURL(SITE);
}

ipcMain.on('nav-cmd', (e, cmd) => {
  const wc = view.webContents;
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (cmd === 'reload') wc.reload();
  else if (cmd === 'home') wc.loadURL(SITE);
  else if (cmd === 'retry') { win.webContents.send('loading'); wc.loadURL(SITE); }
  else if (cmd === 'update-install') autoUpdater.quitAndInstall(true, true);
});

// ---------- Selbst-Update über GitHub-Releases (Bukaas/HviK-App) ----------
const { autoUpdater } = require('electron-updater');
function setupUpdates() {
  if (!app.isPackaged) return;  // beim Entwickeln (npm start) nicht
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;  // spätestens beim nächsten Schließen
  autoUpdater.on('download-progress', p => win && win.webContents.send('update', { state: 'loading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => win && win.webContents.send('update', { state: 'ready', version: i.version }));
  autoUpdater.on('error', e => console.warn('Update:', e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 2 * 60 * 60 * 1000);
}

// ---------- HviK Link (Minecraft) - nur für Seiten von hvik.org ----------
const settingsFile = () => path.join(app.getPath('userData'), 'einstellungen.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
const fromSite = e => { try { return new URL(e.senderFrame.url).origin === new URL(SITE).origin; } catch { return false; } };
async function siteGet(url, json) {
  const r = await session.fromPartition('persist:hvik').fetch(url.startsWith('http') ? url : SITE + url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`hvik.org antwortet nicht (${r.status}).`);
  return json ? r.json() : Buffer.from(await r.arrayBuffer());
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
  const say = text => { try { e.sender.send('mc-progress', text); } catch { /* Seite gewechselt */ } };
  try {
    say('Hole die Lobby-Daten …');
    const info = await lobbyInfo(code);
    return { ok: true, ...(await minecraft.play(info, { say, get: u => siteGet(u, false), settings: loadSettings() })) };
  } catch (err) {
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

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(() => { createWindow(); setupUpdates(); });
app.on('window-all-closed', () => app.quit());
