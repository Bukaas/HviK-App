// HviK Desktop-App: Fenster mit eigener Titelleiste, darin hvik.org (Login über Discord wie auf der Seite).
const { app, BrowserWindow, WebContentsView, ipcMain, shell, nativeTheme, session, dialog, Menu } = require('electron');
const minecraft = require('./minecraft');
const archipelago = require('./archipelago');
const spiel = require('./spiel');
const background = require('./background');
const path = require('path');
const fs = require('fs');

const SITE = process.env.HVIK_SITE || 'https://hvik.org';
const BAR = 40;  // Höhe der Titelleiste
// Im App-Fenster bleiben nur hvik.org und der Discord-Login - Einladungen, Kanäle usw. gehen ins Discord-Programm bzw. den Browser
const ALLOWED = [/^https:\/\/(www\.|werkstatt\.)?hvik\.org([/?#]|$)/,  // werkstatt.hvik.org = Werkstatt (zweite Spielkopie zum Bauen)
                 /^https:\/\/(\w+\.)?discord(app)?\.com\/(oauth2|login|api\/(v\d+\/)?oauth2|register|2fa|verify|reset)/,
                 /^https:\/\/(\w+\.)?hcaptcha\.com\//];

nativeTheme.themeSource = 'dark';
app.setAppUserModelId('org.hvik.app');
if (process.env.HVIK_PROFILE) app.setPath('userData', process.env.HVIK_PROFILE);  // nur für Tests: eigenes Profil neben der echten App
if (!app.requestSingleInstanceLock()) app.exit(0);  // läuft schon -> sofort raus (die laufende App holt sich nach vorne)

const stateFile = () => path.join(app.getPath('userData'), 'fenster.json');
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveBounds(win) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), max: win.isMaximized() })); } catch { /* egal */ }
}

let win, view, firstLoad = true;
// Neues Design (Einstellungen → Design: Neu): Fenster ohne Rahmen und durchsichtig, links Platz für die Leiste,
// die hinter dem Fenster hervorschaut. Gilt ab App-Start (Umschalten startet die App neu).
let NEU = false;
let fly = null, flyHideT = null, flyShown = false, flyAt = 0, flyH = 0;  // Untermenü-Fenster (neues Design)
const RAIL_ZONE = 104, PAD = 14, NBAR = 36;  // passen zu shell-neu.html (--zone / --pad / --bar)
const startUrl = () => (NEU ? SITE + '/app/start' : SITE);  // neues Design: eigene Startseite

// "Innen": maximiert, Vollbild, an eine Bildschirmhälfte angedockt oder links am Bildschirmrand -> Leiste ins Fenster,
// kein durchsichtiger Rand (Fenster reicht bis an die Bildschirmkante, Knöpfe sitzen in der Ecke)
function isInner() {
  if (win.isMaximized() || win.isFullScreen()) return true;
  const { screen } = require('electron');
  const b = win.getBounds(), wa = screen.getDisplayMatching(b).workArea, near = (a, c) => Math.abs(a - c) <= 6;
  const left = b.x <= wa.x + 6, right = near(b.x + b.width, wa.x + wa.width), full = near(b.y, wa.y) && near(b.y + b.height, wa.y + wa.height);
  return left || (full && right);
}
let innerNow = null;
// Windows + durchsichtiges Fenster ohne Rahmen: Die eingebettete Seite zeichnet sich manchmal nicht (schwarzes/leeres Bild),
// bis man das Fenster bewegt. Abhilfe: Ansicht kurz um 1 px ändern + neu zeichnen lassen – nach Anzeigen, Wiederherstellen,
// Fokus, Aufwachen und Laden (höchstens alle 400 ms).
let anstossZeit = 0;
function anstossen() {
  if (!win || win.isDestroyed() || !view) return;
  const jetzt = Date.now();
  if (jetzt - anstossZeit < 400) return;
  anstossZeit = jetzt;
  try {
    const b = view.getBounds();
    view.setBounds({ ...b, height: Math.max(0, b.height - 1) });
    setTimeout(() => {
      try { layout(); view.webContents.invalidate(); win.webContents.invalidate(); } catch { /* Fenster weg */ }
    }, 40);
  } catch { /* Fenster weg */ }
}
function layout() {
  const [w, h] = win.getContentSize();
  if (!NEU) { view.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) }); return; }
  const inner = isInner();
  const pad = inner ? 0 : PAD;
  view.setBounds({ x: RAIL_ZONE, y: pad + NBAR, width: Math.max(0, w - RAIL_ZONE - pad), height: Math.max(0, h - pad - NBAR - pad) });
  view.setBorderRadius(inner ? 0 : 16);
  flyClose(true);  // Fenster bewegt/Größe geändert: Untermenü zu (Position stimmt sonst nicht mehr)
  if (inner !== innerNow) { innerNow = inner; win.webContents.send('max', inner); }
}
// Andocken wie bei Windows: Fenster an den linken/rechten Rand ziehen = Hälfte, nach oben = maximiert
// (bei rahmenlosen, durchsichtigen Fenstern macht Windows das nicht zuverlässig selbst)
let dockFrom = null;
let lastToggle = 0;
function toggleMax() {
  if (Date.now() - lastToggle < 400) return;  // Doppelklick nicht doppelt zählen
  lastToggle = Date.now();
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();  // auch angedockt: wie bei Windows erst groß, beim nächsten Mal zurück auf die angedockte Größe
}
function snapAfterMove(fake) {
  if (!NEU || win.isMaximized()) return;
  const { screen } = require('electron');
  const c = fake || screen.getCursorScreenPoint(), d = screen.getDisplayNearestPoint(c), wa = d.workArea, b = d.bounds;
  if (c.y <= b.y + 2) { dockFrom = win.getBounds(); win.maximize(); return; }
  const leftEdge = c.x <= b.x + 2, rightEdge = c.x >= b.x + b.width - 3;
  if (!leftEdge && !rightEdge) return;
  dockFrom = dockFrom || win.getBounds();
  if (wa.height > wa.width) {
    // Hochkant-Bildschirm: halbe Breite wäre zu schmal -> volle Breite, obere bzw. untere Hälfte (je nachdem, wo die Maus ist)
    const h2 = Math.round(wa.height / 2), top = c.y < wa.y + wa.height / 2;
    win.setBounds({ x: wa.x, y: top ? wa.y : wa.y + wa.height - h2, width: wa.width, height: h2 });
    return;
  }
  const w2 = Math.min(wa.width, Math.max(Math.round(wa.width / 2), win.getMinimumSize()[0]));  // nie schmaler als die App sein kann
  win.setBounds({ x: leftEdge ? wa.x : wa.x + wa.width - w2, y: wa.y, width: w2, height: wa.height });
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
  NEU = true;  // nur noch das neue Design (25.10.) - alte Einstellung 'alt' wird beim Start umgeschrieben
  if (loadSettings().design !== 'neu') saveSettings({ ...loadSettings(), design: 'neu' });
  const common = { x: b.x, y: b.y, title: 'HviK', show: false, icon: path.join(__dirname, 'icon.ico'),
                   webPreferences: { preload: path.join(__dirname, 'shell-preload.js') } };
  win = NEU
    // neues Design: durchsichtig + ohne Rahmen (Leiste ragt links raus); Größe ziehen macht shell-neu.html über win-resize
    ? new BrowserWindow({ ...common, width: b.width || 1320 + RAIL_ZONE, height: b.height || 840, minWidth: 940 + RAIL_ZONE, minHeight: 600,
                          frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: true })
    : new BrowserWindow({ ...common, width: b.width || 1320, height: b.height || 840, minWidth: 940, minHeight: 600, backgroundColor: '#0d0f13',
                          titleBarStyle: 'hidden', titleBarOverlay: { color: '#0d0f13', symbolColor: '#c9ced8', height: BAR } });
  if (b.max) win.maximize();
  win.loadFile(path.join(__dirname, NEU ? 'shell-neu.html' : 'shell.html'));
  if (NEU) {
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'move']) win.on(ev, layout);
    win.on('moved', () => setTimeout(snapAfterMove, 60));
    if (process.env.HVIK_SNAPTEST) setTimeout(() => {  // nur für Tests: Ende eines Ziehens an Position x,y vortäuschen
      const [x, y] = process.env.HVIK_SNAPTEST.split(',').map(Number);
      snapAfterMove({ x, y });
      setTimeout(() => console.log('snaptest', JSON.stringify(win.getBounds()), 'innen', innerNow), 300);
    }, 6000);  // kurz warten - direkt nach dem Ziehen setzt Windows die Größe sonst zurück
    win.webContents.on('did-finish-load', () => { layout(); applyDesign(); });
  }
  win.once('ready-to-show', () => { if (!process.argv.includes('--versteckt')) win.show(); });
  if (process.env.HVIK_RAILTEST) {  // nur für Tests: Leiste mit Beispiel-Daten füllen, Live-Fenster öffnen, Bilder speichern
    win.setOpacity(0);
    win.once('ready-to-show', () => win.showInactive());
    const out = n => process.env.HVIK_RAILTEST.replace('.png', n + '.png');
    const av = 'https://cdn.discordapp.com/embed/avatars/1.png';
    const mock = { ok: true, online_n: 4, dots: { games: true, events: true },
      online: [{ id: '1', name: 'Kenzuto', avatar: av, activity: '🌙 Kingdom Hearts II', playing: true }, { id: '2', name: 'Leeni', avatar: null, activity: 'in der HviK-App', playing: false },
               { id: '3', name: 'Galaxy', avatar: av, activity: 'auf hvik.org', playing: false }],
      rounds: [{ id: 16, title: 'Neue runde Archipelago', url: '/events/archipelago/runde/16', slot: 'Bukaas',
                 row: { game: 'Minecraft', icon: '⛏️', online: true, received: 17, checked: 48, total: 138 }, hints: [{ item: 'Netherite', k: 'item-prog', finder: 'Kenzuto', location: 'Hollow Bastion Chest' }] }],
      liga: [{ id: 5, slug: 'valorant-solo', league: 'Solo Liga', best_of: 3, at: '20:30', started: true, me: 'a', a: { name: 'Bukaas', avatar: av }, b: { name: 'Samtaman', avatar: av },
               done: [[13, 9]], pending: null, state: 'enter', map_no: 2, map: 'Ascent', url: '/liga/valorant-solo', until: 'heute 22:10' },
             { id: 6, slug: 'valorant-solo', league: 'Solo Liga', best_of: 3, at: '18:00', started: false, me: 'b', a: { name: 'Jannüü', avatar: av }, b: { name: 'Bukaas', avatar: av },
               done: [], pending: null, state: 'start', map_no: 1, map: null, url: '/liga/valorant-solo', until: 'morgen 18:02' }],
      match: [], mc: [{ code: 'ABC', name: 'Testlobby', n: 3, mine: false }],
      next: { title: 'League tunier', icon: '🏆', at: Date.now() / 1000 + 3 * 3600, url: '/tournaments/12', time: '20:00' } };
    setTimeout(async () => {
      win.webContents.send('rail', mock);
      await win.webContents.executeJavaScript("rail.classList.add('open')");
      await new Promise(r => setTimeout(r, 800));
      require('fs').writeFileSync(out(0), (await win.capturePage()).toPNG());
      for (const [i, sel] of [[1, '#live .lv:nth-child(1)'], [2, '#live .lv:nth-child(2)']]) {
        await win.webContents.executeJavaScript(`flyOpenFor = null; document.querySelector('${sel}').dispatchEvent(new MouseEvent('mouseenter'))`);
        await new Promise(r => setTimeout(r, 900));
        require('fs').writeFileSync(out(i), (await fly.webContents.capturePage()).toPNG());
        console.log('railtest', i, JSON.stringify(fly.getBounds()));
      }
      app.exit(0);
    }, 5000);
  }
  if (process.env.HVIK_OVTEST) {  // nur für Tests: Overlay-Vorschau als Bild speichern
    setTimeout(async () => {
      background.overlay.showPreview();
      await new Promise(r => setTimeout(r, 1500));
      const w = background.overlay._win();
      require('fs').writeFileSync(process.env.HVIK_OVTEST, (await w.webContents.capturePage()).toPNG());
      console.log('ovtest', JSON.stringify(w.getBounds()), w.isVisible());
      app.exit(0);
    }, 5000);
  }
  if (process.env.HVIK_DRAGTEST) {  // nur für Tests: Ziehen mit vorgetäuschtem Mauszeiger, Doppelklick in der Leiste
    process.env.HVIK_FAKECURSOR = '1';
    win.setOpacity(0);
    win.once('ready-to-show', () => win.showInactive());
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const at = (x, y) => { process.env.HVIK_FAKECURSOR_NOW = JSON.stringify({ x, y }); };
    const say = t => console.log('dragtest', t, win.isMaximized(), JSON.stringify(win.getBounds()), 'innen', innerNow);
    const ev = { sender: win.webContents };
    setTimeout(async () => {
      win.setBounds({ x: 900, y: 300, width: 1424, height: 840 }); await wait(500); say('start');
      at(1500, 320); ipcMain.emit('win-drag', ev, 'start'); at(1200, 400); await wait(200); at(1, 600); await wait(200);
      ipcMain.emit('win-drag', ev, 'end'); await wait(1500); say('links angedockt');
      at(600, 20); ipcMain.emit('win-drag', ev, 'start'); at(650, 60); await wait(150); at(1500, 500); await wait(200);
      ipcMain.emit('win-drag', ev, 'end'); await wait(800); say('weggezogen (alte Größe?)');
      await win.webContents.executeJavaScript("document.getElementById('strip').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))"); await wait(800); say('doppelklick 1');
      await win.webContents.executeJavaScript("document.getElementById('strip').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))"); await wait(800); say('doppelklick 2');
      await win.webContents.executeJavaScript("document.getElementById('strip').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))"); await wait(800); say('doppelklick 3 (groß)');
      at(1700, 15); ipcMain.emit('win-drag', ev, 'start'); at(1720, 60); await wait(150); at(1800, 400); await wait(200);
      ipcMain.emit('win-drag', ev, 'end'); await wait(800); say('aus maximiert weggezogen');
      app.exit(0);
    }, 5000);
  }
  if (process.env.HVIK_DBLTEST) {  // nur für Tests: zweimal Doppelklick auf die Titelleiste schicken, Zustand ausgeben
    win.setOpacity(0);
    win.once('ready-to-show', () => win.showInactive());
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const ps = `Add-Type -Namespace W -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);'; [void][W.M]::SendMessage([IntPtr]${hwnd}, 0xA3, [IntPtr]2, [IntPtr]0)`;
    const dbl = () => new Promise(r => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', ps], () => setTimeout(r, 1200)));
    setTimeout(async () => {
      console.log('dbltest vorher', win.isMaximized(), JSON.stringify(win.getBounds()));
      await dbl(); console.log('dbltest 1x', win.isMaximized(), JSON.stringify(win.getBounds()));
      await dbl(); console.log('dbltest 2x', win.isMaximized(), JSON.stringify(win.getBounds()));
      app.exit(0);
    }, 5000);
  }
  if (process.env.HVIK_FLYTEST) {  // nur für Tests: unsichtbar starten, Untermenü öffnen, Bild vom Fenster speichern
    win.setOpacity(0);
    win.once('ready-to-show', () => win.showInactive());
    setTimeout(async () => {
      for (const [i, key] of [[1, 'games'], [2, 'events']]) {
        await win.webContents.executeJavaScript(`rail.classList.add('open'); flyOpenFor = null; openFly(document.querySelector('[data-fly=${key}]'))`);
        await new Promise(r => setTimeout(r, 900));
        require('fs').writeFileSync(process.env.HVIK_FLYTEST.replace('.png', i + '.png'), (await win.capturePage()).toPNG());
        console.log('flytest', key, flyShown, JSON.stringify(fly.getBounds()));
        require('fs').writeFileSync(process.env.HVIK_FLYTEST.replace('.png', i + 'f.png'), (await fly.webContents.capturePage()).toPNG());
      }
      app.exit(0);
    }, 5000);
  }  // Autostart: nur ins Symbol unten rechts

  view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'site-preload.js'), partition: 'persist:hvik',
                      additionalArguments: [`--hvik-version=${app.getVersion()}`] },
  });
  view.setBackgroundColor('#0d0f13');
  win.contentView.addChildView(view);
  view.setVisible(false);  // erst zeigen, wenn die Seite geladen ist (bis dahin Ladebildschirm)
  if (NEU) {  // Untermenü-Fenster neben der Leiste (Games, Events & Termine) - liegt über der Seite
    fly = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'shell-preload.js') } });
    fly.setBackgroundColor('#00000000');
    fly.setBorderRadius(20);
    fly.setVisible(false);
    win.contentView.addChildView(fly);
    fly.webContents.loadFile(path.join(__dirname, 'flyout.html'));
    fly.webContents.on('did-finish-load', applyDesign);
  }
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
    setTimeout(sendBadges, 1500);
    setTimeout(railRefresh, 1200);
    if (firstLoad) { firstLoad = false; view.setVisible(true); win.webContents.send('ready'); setTimeout(anstossen, 120); }
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;  // -3 = abgebrochen (z. B. Weiterleitung)
    view.setVisible(false);
    firstLoad = true;
    win.webContents.send('offline', desc);
    win.webContents.send('guide', background.getGuide());
    setTimeout(() => { if (firstLoad) { win.webContents.send('loading'); view.webContents.loadURL(startUrl()); } }, 15000);  // von selbst nochmal versuchen
  });
  // Seite in der Mitte abgestürzt (z. B. Grafikkarte bei den 3D-Spielen überfordert) oder hängt: von selbst neu laden,
  // statt leer zu bleiben (vorher half nur, die ganze App neu zu starten). War es eine 3D-Seite: zurück zur Spiele-Übersicht.
  let lastCrash = 0, hangT = null, lastTry = Date.now();
  const recover = why => {
    background.note('fehler', 'Seite neu geladen: ' + why);
    const again = Date.now() - lastCrash < 30000; lastCrash = Date.now();
    let url = '';
    try { url = wc.getURL(); } catch { /* egal */ }
    if (again || !url || !ALLOWED.some(r => r.test(url))) url = startUrl();
    else if (/\/spiele\/(welt|tisch|memory\/|farbsturm\/|imposter\/)/.test(url)) url = SITE + '/spiele';
    firstLoad = true; view.setVisible(false); win.webContents.send('loading');
    setTimeout(() => { lastTry = Date.now(); wc.loadURL(url); }, 500);
  };
  wc.on('render-process-gone', (e, d) => { if (d.reason !== 'clean-exit') recover(d.reason); });
  wc.on('unresponsive', () => { clearTimeout(hangT); hangT = setTimeout(() => { try { wc.forcefullyCrashRenderer(); } catch { /* egal */ } recover('hängt'); }, 8000); });
  wc.on('responsive', () => clearTimeout(hangT));
  app.on('child-process-gone', (e, d) => { if (d.type === 'GPU' && d.reason !== 'clean-exit' && /\/spiele\//.test(wc.getURL())) recover('Grafik'); });
  // Server kurz weg (502/503/504 beim Neustart): nach ein paar Sekunden selbst neu laden
  wc.on('did-navigate', (e, url, code) => { if (code >= 502 && code <= 504) setTimeout(() => { if (!wc.isLoading()) wc.reload(); }, 4000); });
  wc.on('did-start-loading', () => { lastTry = Date.now(); });
  // Wächter: bleibt die Mitte leer (z. B. weil ein Neuversuch abgebrochen wurde), alle 10 s wieder probieren
  setInterval(() => { if (firstLoad && !wc.isLoading() && Date.now() - lastTry > 12000) { lastTry = Date.now(); win.webContents.send('loading'); wc.loadURL(startUrl()); } }, 10000);
  // Spiel im Vollbild und die App nicht im Vordergrund: Leiste ruhen lassen (keine Animationen). Die Mitte bleibt sichtbar -
  // die Spielseiten drosseln sich ohne Fokus selbst, ein schwarzes Bild beim Raustabben nervt nur.
  let napping = false;
  const nap = on => {
    if (on === napping || firstLoad) return;
    napping = on;
    if (fly && on) flyClose(true);
    try { win.webContents.send('nap', on); } catch { /* egal */ }
  };
  setInterval(() => { if (win && !win.isDestroyed()) nap(!win.isFocused() && require('./toast').fullscreenNow()); }, 3000);
  win.on('focus', () => nap(false));
  win.on('show', () => nap(false));
  for (const ev of ['show', 'restore', 'focus']) win.on(ev, () => setTimeout(anstossen, 80));   // leeres Bild verhindern
  wc.on('did-finish-load', () => setTimeout(anstossen, 120));
  const { powerMonitor } = require('electron');
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(anstossen, 500));
  wc.loadURL(startUrl());
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

// Menüs der Seite (Glocke, wer online ist, Profil) - im neuen Design öffnet sie die Leiste
const SITE_MENUS = {
  bell: "typeof toggleBell === 'function' && toggleBell(new MouseEvent('click'))",
  online: "(document.getElementById('onl') || {classList: {toggle() {}}}).classList.toggle('open')",
  user: "typeof toggleUserMenu === 'function' && toggleUserMenu(new MouseEvent('click'))",
};
// Untermenü neben der Leiste: shell-neu.html sagt, welche Gruppe und auf welcher Höhe; das Fenster liegt über der Seite
function flyOpen(g) {
  if (!fly) return;
  clearTimeout(flyHideT);
  flyAt = g.y || 0;
  flyPlace(flyH || 240);
  fly.setVisible(true); flyShown = true;
  fly.webContents.send('fly-show', g);
}
function flyPlace(h) {
  const [w, wh] = win.getContentSize();
  const top = (innerNow ? 0 : PAD) + NBAR + 6;
  const y = Math.round(Math.max(top, Math.min(wh - h - 12, flyAt - 34)));
  fly.setBounds({ x: RAIL_ZONE + 4, y, width: Math.min(300, w - RAIL_ZONE - 10), height: Math.round(h) });
}
function flyClose(now) {
  if (!fly || !flyShown) return;
  flyShown = false;
  fly.webContents.send('fly-hide');
  clearTimeout(flyHideT);
  flyHideT = setTimeout(() => fly.setVisible(false), now ? 0 : 170);
}
ipcMain.on('nav-cmd', (e, cmd) => {
  const wc = view.webContents;
  cmd = String(cmd || '');
  if (cmd.startsWith('fly:')) {
    const sub = cmd.slice(4);
    if (sub.startsWith('open:')) { try { flyOpen(JSON.parse(sub.slice(5))); } catch { /* egal */ } }
    else if (sub === 'close') flyClose();
    else if (sub.startsWith('size:')) { const h = Math.max(60, Math.min(700, Number(sub.slice(5)) || 0)); flyH = h; if (flyShown) flyPlace(h); }
    else if (sub === 'in' || sub === 'out') win.webContents.send('fly-hover', sub === 'in');
    else if (sub.startsWith('nav:')) win.webContents.send('fly-nav', Number(sub.slice(4)) < 0 ? -1 : 1);
    return;
  }
  if (cmd === 'win-min') return win.minimize();
  if (cmd === 'win-max') return toggleMax();
  if (cmd === 'win-close') return win.close();
  if (cmd.startsWith('go:')) { flyClose(true); win.webContents.send('fly-hover', false); const p = cmd.slice(3); if (/^\/[\w\-/#?=&.]*$/.test(p)) wc.loadURL(SITE + p); return; }
  if (cmd.startsWith('profile:')) { const id = cmd.slice(8); if (/^\d+$/.test(id)) wc.executeJavaScript(`typeof hvikProfile === 'function' && hvikProfile('${id}')`, true).catch(() => {}); return; }
  if (cmd.startsWith('site:')) { const js = SITE_MENUS[cmd.slice(5)]; if (js) { wc.focus(); wc.executeJavaScript(js, true).catch(() => {}); } return; }
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (cmd === 'reload') wc.reload();
  else if (cmd === 'home') wc.loadURL(startUrl());
  else if (cmd === 'notes') wc.loadURL(SITE + '/app#patchnotes');
  else if (cmd === 'settings') wc.loadURL(SITE + '/app/einstellungen');
  else if (cmd === 'game-open') { const g = background.getRunning(); if (g && g.url) wc.loadURL(SITE + g.url); }
  else if (cmd === 'game-clear') background.setRunning(null);
  else if (cmd === 'retry') { win.webContents.send('loading'); wc.loadURL(startUrl()); }
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
  // Updates kommen über hvik.org: alle bekommen die freigegebene Version (Admin → App-Update),
  // Tester sofort die neueste Vorabversion. Wer Tester ist, sagt der Server (nach dem Einloggen).
  const feed = async () => {
    let tester = false;
    try { tester = !!(await (await session.fromPartition('persist:hvik').fetch(`${SITE}/api/app/kanal`, { cache: 'no-store' })).json()).tester; } catch { /* offline */ }
    autoUpdater.setFeedURL({ provider: 'generic', url: `${SITE}/api/app/feed/${tester ? 'beta/' : ''}` });
  };
  const check = async () => {
    if (ready) return askUpdate();
    if (checking) return;
    checking = true;
    await feed();
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
  if (ok && firstLoad) { win.webContents.send('loading'); view.webContents.loadURL(startUrl()); }
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

// ---------- HviK Community Place (Launcher, vorerst Tester: Spiel aus dem eigenen HviK-Welt-Ordner) ----------
ipcMain.handle('spiel-status', async e => {
  if (!fromSite(e)) return null;
  try { return await spiel.status(loadSettings()); } catch (err) { return { installiert: false, fehler: err.message }; }
});
ipcMain.handle('spiel-installieren', async e => {
  if (!fromSite(e)) return null;
  try {
    return await spiel.installieren(loadSettings(), {
      waehleOrdner: async title => { const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] }); return r.canceled ? '' : r.filePaths[0]; },
      waehleDatei: async title => { const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: 'Godot', extensions: ['exe'] }] }); return r.canceled ? '' : r.filePaths[0]; },
      speichern: patch => saveSettings({ ...loadSettings(), ...patch }),
    });
  } catch (err) { return { ok: false, message: err.message }; }
});
ipcMain.handle('spiel-modus', async (e, m) => {   // Tester: 'projekt' (eigener HviK-Welt-Ordner) oder 'version'
  if (!fromSite(e)) return null;
  saveSettings({ ...loadSettings(), spielModus: m === 'projekt' ? 'projekt' : 'version' });
  return { ok: true };
});
ipcMain.handle('spiel-starten', async (e, name) => {
  if (!fromSite(e)) return null;
  let ausweis = '';
  try { const a = await siteGet('/api/spiel/ausweis', true); if (a && a.ok) { ausweis = a.ausweis; name = a.name || name; } } catch { /* ohne Ausweis = Gast */ }
  const r = await spiel.starten(loadSettings(), name, ausweis);
  if (r.ok) background.setRunning({ label: 'HviK Community Place', icon: '🏡', url: '/app/launcher', title: 'In der Welt', procs: [spiel.EXE, 'Godot_v4.7.2-stable_win64.exe'] });
  return r;
});

ipcMain.handle('spiel-lokal', async (e, name) => {   // Admins + Tester: Code aus dem Projektordner in der Testwelt (Kopie der Live-Welt, offline)
  if (!fromSite(e)) return null;
  let live = null;   // aktueller Live-Stand -> wird zur Testwelt (nur in diese Richtung)
  try { const s = await siteGet('/api/spiel/welt_stand', true); if (s && s.ok) live = s; } catch { /* dann die letzte Testwelt */ }
  const r = await spiel.lokal(loadSettings(), name, live);
  if (r.ok) background.setRunning({ label: 'HviK Community Place (Testwelt)', icon: '🧪', url: '/app/launcher', title: 'Testwelt', procs: ['Godot_v4.7.2-stable_win64.exe'] });
  return r;
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
  const rel = folder ? path.relative(archipelago.ROOT, path.resolve(folder)) : '..';
  const target = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.resolve(folder) : archipelago.ROOT;  // nur Ordner darin
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
    for (const k of ['autostart', 'tray', 'discord', 'spielzeit', 'overlay']) if (k in patch) allowed[k] = !!patch[k];
    if (['oben-rechts', 'oben-links', 'mitte-rechts', 'unten-links', 'unten-rechts'].includes(patch.overlayPos)) allowed.overlayPos = patch.overlayPos;
    if (['auto', 'immer', 'aus'].includes(patch.toastMode)) allowed.toastMode = patch.toastMode;
    if (PALETTES.includes(patch.palette)) allowed.palette = patch.palette;
    if (patch.notify && typeof patch.notify === 'object')
      allowed.notify = { ...background.settings().notify, ...Object.fromEntries(Object.entries(patch.notify).map(([k, v]) => [k, !!v])) };
    saveSettings({ ...loadSettings(), ...allowed });
    background.applyAutostart();
    background.refreshPresence();
    applyDesign();
    if ('overlay' in allowed || allowed.overlayPos || allowed.palette) background.overlay.refresh();
  }
  return { ...background.settings(), cfRoot: loadSettings().cfRoot || null, apRoot: archipelago.ROOT, designActive: NEU ? 'neu' : 'alt',
           appDir: path.dirname(process.execPath), canMoveApp: app.isPackaged };
});
ipcMain.handle('app-diag', async e => (fromSite(e) ? background.diag() : null));

// ---------- Speicherort: App oder Spiele-Ordner auf eine andere Platte verschieben ----------
async function dirSize(dir) {  // Bytes (für Fortschritt + Platz-Prüfung)
  let n = 0;
  for (const d of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) n += await dirSize(p); else n += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return n;
}
async function copyDir(src, dst, onBytes) {
  await fs.promises.mkdir(dst, { recursive: true });
  for (const d of await fs.promises.readdir(src, { withFileTypes: true })) {
    const a = path.join(src, d.name), b = path.join(dst, d.name);
    if (d.isDirectory()) await copyDir(a, b, onBytes);
    else { await fs.promises.copyFile(a, b); onBytes((await fs.promises.stat(a)).size); }
  }
}
ipcMain.handle('app-move', async (e, what) => {
  if (!fromSite(e)) return null;
  const say = t => { try { e.sender.send('app-move-progress', t); } catch { /* Seite weg */ } };
  const r = await dialog.showOpenDialog(win, { title: what === 'app' ? 'Wohin soll die HviK-App?' : 'Wohin sollen die Spiele-Dateien?', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
  const pick = r.filePaths[0];
  if (what === 'daten') {
    const from = archipelago.ROOT, to = path.join(pick, 'HviK Archipelago');
    if (path.resolve(to).toLowerCase() === path.resolve(from).toLowerCase()) return { ok: false, message: 'Das ist schon der aktuelle Ordner.' };
    if (path.resolve(to).toLowerCase().startsWith(path.resolve(from).toLowerCase() + path.sep)) return { ok: false, message: 'Der neue Ordner darf nicht im alten liegen.' };
    if (background.getRunning()) return { ok: false, message: 'Bitte erst das laufende Spiel beenden.' };
    try {
      if (fs.existsSync(from)) {
        say('Prüfe, wie viel es ist …');
        const total = await dirSize(from);
        try { await fs.promises.rename(from, to); }  // gleiche Platte: sofort fertig
        catch {
          let done = 0, last = 0;
          await copyDir(from, to, n => { done += n; if (Date.now() - last > 300) { last = Date.now(); say(`Kopiere … ${Math.round(100 * done / Math.max(1, total))} % (${(done / 1e9).toFixed(1)} von ${(total / 1e9).toFixed(1)} GB)`); } });
          say('Räume den alten Ordner auf …');
          await fs.promises.rm(from, { recursive: true, force: true });
        }
      }
      saveSettings({ ...loadSettings(), dataRoot: pick });
      say('✅ Fertig – die App startet kurz neu.');
      setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
      return { ok: true, folder: to };
    } catch (err) {
      return { ok: false, message: 'Verschieben ging nicht: ' + err.message + ' – die Dateien sind noch am alten Ort.' };
    }
  }
  if (what === 'app') {
    if (!app.isPackaged) return { ok: false, message: 'Geht nur in der installierten App.' };
    const target = /hvik$/i.test(pick) ? pick : path.join(pick, 'HviK');
    if (path.resolve(target).toLowerCase() === path.dirname(process.execPath).toLowerCase()) return { ok: false, message: 'Die App ist schon dort.' };
    try {
      // gleiche Version neu installieren - in den neuen Ordner; der Installer räumt die alte Installation selbst weg
      const v = app.getVersion();
      say('Lade den Installer …');
      const res = await session.fromPartition('persist:hvik').fetch(`https://github.com/Bukaas/HviK-App/releases/download/v${v}/HviK-Setup-${v}.exe`);
      if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
      const exe = path.join(app.getPath('temp'), `HviK-Setup-${v}.exe`);
      await fs.promises.writeFile(exe, Buffer.from(await res.arrayBuffer()));
      say('✅ Die App zieht um – sie schließt sich und startet gleich am neuen Ort neu.');
      const { spawn } = require('child_process');
      // /D muss als letztes und ohne Anführungszeichen kommen (NSIS) -> Befehlszeile selbst bauen
      spawn('cmd.exe', ['/c', 'start', '""', `"${exe}"`, '/S', '--force-run', `/D=${target}`],
            { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true }).unref();
      setTimeout(() => app.exit(0), 1500);  // App zu, damit der Installer die alten Dateien ersetzen kann
      return { ok: true, folder: target };
    } catch (err) {
      return { ok: false, message: 'Umziehen ging nicht: ' + err.message };
    }
  }
  return { ok: false };
});
// Design: Fensterleiste und Seite fragen beim Laden nach und bekommen Änderungen sofort.
// Maßgeblich ist das Fenster, das gerade läuft (NEU) - die gespeicherte Einstellung gilt erst nach dem Neustart.
const PALETTES = ['aurora', 'ozean', 'glut', 'gift', 'sakura', 'rot'];
const palette = () => (PALETTES.includes(background.settings().palette) ? background.settings().palette : 'ozean');
ipcMain.handle('app-design', () => (NEU ? 'neu' : 'alt'));
ipcMain.handle('app-palette', () => palette());
function applyDesign() {
  const d = NEU ? 'neu' : 'alt', p = palette();
  for (const wc of [win && !win.isDestroyed() && win.webContents, view && !view.webContents.isDestroyed() && view.webContents,
                    fly && !fly.webContents.isDestroyed() && fly.webContents]) {
    if (!wc) continue;
    wc.send('design', d);
    wc.send('palette', p);
  }
}

// ---------- Neues Design: Fensterknöpfe, Durchklicken, Größe ziehen, Zähler in der Leiste ----------
// Durchklicken: Die Fensterleiste meldet, wo Fenster, Leiste und Ränder liegen (hitRects). Der Hauptprozess schaut alle 30 ms,
// ob der Mauszeiger auf einer davon ist - Mausereignisse der Seite reichen nicht (über der Zieh-Fläche oben kommen keine an).
let hitRects = [], ignoring = false;
ipcMain.on('win-hit-rects', (e, rects) => { if (NEU && win && e.sender === win.webContents && Array.isArray(rects)) hitRects = rects; });
function setIgnoring(v) {
  if (v === ignoring || !win || win.isDestroyed()) return;
  ignoring = v;
  win.setIgnoreMouseEvents(v, { forward: true });
}
let hitTick = 0;
setInterval(() => {
  if (!NEU || !win || win.isDestroyed() || !win.isVisible()) return;
  if (!win.isFocused() && !drag && !resizing && (++hitTick % 8)) return;  // ohne Fokus nur ~4x pro Sekunde prüfen (spart CPU im Spiel)
  if (innerNow || resizing || drag) return setIgnoring(false);
  // in echten Bildschirmpixeln rechnen: bei Bildschirmen mit unterschiedlicher Skalierung (z. B. hochkant mit 125 %)
  // passen die "logischen" Koordinaten von Mauszeiger und Fenster sonst nicht zusammen -> Klicks gingen durchs Fenster
  const { screen } = require('electron');
  const dip = win.getContentBounds(), win32 = process.platform === 'win32';
  const c = win32 ? screen.dipToScreenPoint(screen.getCursorScreenPoint()) : screen.getCursorScreenPoint();
  const px = win32 ? screen.dipToScreenRect(win, dip) : dip;
  const sf = px.width / Math.max(1, dip.width);
  const x = (c.x - px.x) / sf, y = (c.y - px.y) / sf;
  const inside = x >= 0 && y >= 0 && x < dip.width && y < dip.height;
  const ign = inside && !hitRects.some(r => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  if (process.env.HVIK_DEBUG && (ign !== ignoring || Math.random() < 0.02)) console.log("hit", JSON.stringify({ c, px, dip, x: Math.round(x), y: Math.round(y), inside, ign, rects: hitRects.length }));
  setIgnoring(ign);
}, 30);
ipcMain.on('win-ignore', () => { /* alt (0.17.0): jetzt macht das die Abfrage oben */ });
// Größe ziehen: die Fensterleiste meldet Start, jede Bewegung (Bildschirm-Koordinaten, solange die Taste gedrückt ist) und das Ende.
// Kommt das Loslassen nicht an, passiert einfach nichts mehr - das Fenster wächst nicht von selbst weiter.
let resizing = null;
ipcMain.on('win-resize', (e, msg) => {
  if (!NEU || !win || e.sender !== win.webContents) return;
  if (!msg || msg.phase === 'end') { resizing = null; return; }
  if (msg.phase === 'start') {
    if (win.isMaximized() || !/^(n|s|e|ne|se)$/.test(msg.edge)) return;
    resizing = { edge: msg.edge, sx: msg.x, sy: msg.y, b: win.getBounds(), min: win.getMinimumSize() };
    return;
  }
  if (msg.phase !== 'move' || !resizing) return;
  const { edge, sx, sy, b, min: [mw, mh] } = resizing, dx = msg.x - sx, dy = msg.y - sy, nb = { ...b };
  if (edge.includes('e')) nb.width = Math.max(mw, Math.round(b.width + dx));
  if (edge.includes('s')) nb.height = Math.max(mh, Math.round(b.height + dy));
  if (edge.includes('n')) { nb.height = Math.max(mh, Math.round(b.height - dy)); nb.y = b.y + b.height - nb.height; }
  win.setBounds(nb);
});
// Fenster ziehen (obere Leiste): Start/Ende kommen von shell-neu.html, dazwischen folgt das Fenster dem Mauszeiger.
// Maximiert oder angedockt -> beim ersten Ziehen alte Größe zurück, Mauszeiger bleibt an derselben Stelle der Leiste.
let drag = null, dragT = null;
const cursorNow = () => (process.env.HVIK_FAKECURSOR ? JSON.parse(process.env.HVIK_FAKECURSOR_NOW || '{"x":0,"y":0}') : require('electron').screen.getCursorScreenPoint());
function dragTick() {
  if (!drag || !win || win.isDestroyed()) return;
  const c = cursorNow();
  if (!drag.moved) {
    if (Math.abs(c.x - drag.c.x) + Math.abs(c.y - drag.c.y) < 5) return;  // nur ein Klick, kein Ziehen
    drag.moved = true;
    if (drag.max || drag.docked) {
      const ratio = drag.off.x / Math.max(1, drag.b.width);
      let size;
      if (drag.max) { win.unmaximize(); const nb = win.getBounds(); size = { width: nb.width, height: nb.height }; }
      else size = { width: dockFrom.width, height: dockFrom.height };
      dockFrom = null;
      drag.off = { x: Math.round(ratio * size.width), y: Math.min(drag.off.y, (innerNow ? 0 : PAD) + NBAR - 6) };
      win.setBounds({ x: Math.round(c.x - drag.off.x), y: Math.round(c.y - drag.off.y), ...size });
      return;
    }
  }
  win.setPosition(Math.round(c.x - drag.off.x), Math.round(c.y - drag.off.y));
}
ipcMain.on('win-drag', (e, phase) => {
  if (!NEU || !win || e.sender !== win.webContents) return;
  clearInterval(dragT);
  if (phase === 'start') {
    const c = cursorNow(), b = win.getBounds();
    drag = { c, b, off: { x: c.x - b.x, y: c.y - b.y }, moved: false, max: win.isMaximized(), docked: !win.isMaximized() && !!dockFrom && isInner() };
    dragT = setInterval(dragTick, 8);
    return;
  }
  const moved = drag && drag.moved;
  drag = null;
  if (moved) setTimeout(() => snapAfterMove(process.env.HVIK_FAKECURSOR ? cursorNow() : undefined), 30);  // an den Rand gezogen -> andocken
});

// Live-Teil der Leiste (neues Design): wer online ist, meine Runde, mein Liga-Spiel, mein Match, Lobbys, nächster Termin
let railBusy = false;
async function railRefresh() {
  if (!NEU || railBusy || !win || win.isDestroyed()) return;
  railBusy = true;
  try { const d = await siteGet('/api/app/leiste', true); if (d && d.ok) win.webContents.send('rail', d); } catch { /* offline / nicht eingeloggt */ }
  finally { railBusy = false; }
}
setInterval(railRefresh, 15000);
async function sitePostAny(url, body) {  // wie sitePost, aber auch Fehlerantworten (mit Meldung) zurückgeben
  try {
    const r = await session.fromPartition('persist:hvik').fetch(SITE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store' });
    return await r.json().catch(() => ({ ok: r.ok }));
  } catch { return { ok: false, message: 'hvik.org ist gerade nicht erreichbar.' }; }
}
const fromShell = e => e.sender === (win && win.webContents) || e.sender === (fly && fly.webContents);
ipcMain.handle('rail-liga', async (e, id, action, body) => {
  if (!fromShell(e) || !/^\d+$/.test(String(id)) || !['starten', 'map_melden', 'map_bestaetigen', 'map_ablehnen'].includes(action)) return { ok: false };
  const r = await sitePostAny(`/liga/spiel/${id}/${action}`, action === 'map_melden' ? { score: (body.score || []).slice(0, 2).map(Number) } : {});
  setTimeout(railRefresh, 400);
  return r;
});
ipcMain.handle('rail-voice', async (e, id, side) => {
  if (!fromShell(e) || !/^\d+$/.test(String(id))) return { ok: false };
  return sitePostAny(`/tournaments/api/matches/${id}/channel`, { side: String(side || '') });
});

// Glocken-Zahl, Online-Zahl und Profilbild aus der Seite für die Leiste
async function sendBadges() {
  if (!NEU || !view || view.webContents.isDestroyed() || !win || win.isDestroyed()) return;
  try {
    const b = await view.webContents.executeJavaScript(`(() => { const g = id => document.getElementById(id);
      const bell = g('bell-badge'), chip = document.querySelector('.user-chip img'), name = document.querySelector('.user-chip span');
      return { bell: bell && !bell.hidden ? bell.textContent.trim() : '', onl: (g('onl-n') || {}).textContent || '',
               avatar: chip ? chip.src : '', name: name ? name.textContent.trim() : '' }; })()`, true);
    win.webContents.send('badges', b);
  } catch { /* Seite lädt gerade */ }
}
setInterval(sendBadges, 15000);
ipcMain.handle('app-test-toast', async e => { if (fromSite(e)) background.testToast(); });
ipcMain.handle('app-overlay-preview', async e => { if (fromSite(e)) background.overlay.showPreview(); });
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
  // Overlay im Spiel an/aus - funktioniert auch, während ein Spiel vorne ist
  try { require('electron').globalShortcut.register('CommandOrControl+Alt+O', () => {
    const on = background.overlay.toggle();
    background.notify(on ? '🎮 Overlay an' : '🎮 Overlay aus', on ? 'Erscheint, sobald eine Archipelago-Runde mit dir läuft.' : 'Wieder an: Strg+Alt+O');
  }); } catch { /* Kürzel schon belegt */ }
  background.start({ win, view, site: SITE, loadSettings, saveSettings, fetchJson: u => siteGet(u, true), postJson: sitePost, onNet, onChange: railRefresh });
  view.webContents.on('did-finish-load', showWhatsNew);
  win.webContents.on('did-finish-load', () => { win.webContents.send('game', background.getRunning()); applyDesign(); });
});
app.on('window-all-closed', () => app.quit());
