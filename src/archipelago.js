// Archipelago in der App: Starterpaket holen, eigene Datei + Adresse + Name eintragen, einmal einrichten, starten.
// Die Starterpakete (EINRICHTEN.bat / START.bat) bleiben, wie sie sind - die App nimmt nur das Drumherum ab.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const AdmZip = require('adm-zip');
const mcap = require('./mcap');

const ROOT = path.join(os.homedir(), 'HviK Archipelago');   // der "Archi-Spiele-Ordner"
const ROMS = path.join(ROOT, 'ROMs');
let AP_DIR = 'C:\\ProgramData\\Archipelago';   // Standard - wo es wirklich liegt, sagt apInfo()
const AP_SETUP = 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.7/Setup.Archipelago.0.6.7.exe';

// Spiele, die eine eigene Datei vom Spieler brauchen (z. B. ROM): wo sie in host.yaml eingetragen wird
const ROM_NEEDS = {
  'super-mario-world': { label: 'Super Mario World (USA) – ROM', ext: ['sfc', 'smc'], names: /mario.?world|smw/i, sizes: [524288, 524800],
                         section: 'smw_options', key: 'rom_file', file: 'Super Mario World (USA).sfc' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
function detached(exe, args, cwd) {
  spawn(exe, args, { cwd: cwd || path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref();
}
const exists = p => fs.existsSync(p);

function ps(command) {  // PowerShell-Befehl ausführen und warten
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
                                     { windowsHide: true }, (err, out) => res({ ok: !err, out: String(out || '') })));
}
const psq = s => `'${String(s).replace(/'/g, "''")}'`;  // PowerShell-String in einfachen Anführungszeichen

const AP_VERSION = '0.6.7';
const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

/** Archipelago aus der Windows-Programmliste: Version ("Archipelago 0.6.7") und Ordner - nicht jeder hat es unter ProgramData.
 *  Setzt AP_DIR auf den gefundenen Ordner; {version: null, found: false}, wenn es nirgends liegt. */
async function apInfo() {
  const r = await ps("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Archipelago*' } | ForEach-Object { $_.DisplayName + '|' + $_.InstallLocation + '|' + $_.'Inno Setup: App Path' }");
  const dirs = [], versions = {};
  for (const line of r.out.split(/\r?\n/)) {
    const [name, loc, app] = line.split('|');
    const v = (/Archipelago\s+(\d+\.\d+\.\d+)/.exec(name || '') || [])[1] || null;
    for (const d of [loc, app]) if (d && d.trim()) { const dir = d.trim().replace(/[\\/]+$/, ''); dirs.push(dir); versions[dir.toLowerCase()] = v; }
  }
  dirs.push('C:\\ProgramData\\Archipelago', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Archipelago'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Archipelago'), path.join(os.homedir(), 'Archipelago'));
  const dir = dirs.find(d => exists(path.join(d, 'ArchipelagoLauncher.exe')));
  if (!dir) return { version: null, found: false };
  AP_DIR = dir;
  return { version: versions[dir.toLowerCase()] || null, found: true };
}
const launcher = () => path.join(AP_DIR, 'ArchipelagoLauncher.exe');

/** Archipelago 0.6.7 da (und nicht älter)? Sonst Installer laden und (mit Admin-Abfrage) still installieren bzw. aktualisieren. */
async function ensureArchipelago(ctx) {
  const { version: v, found } = await apInfo();
  if (found) {
    if (!v || !older(v, AP_VERSION)) return;
    ctx.say(`Dein Archipelago ist Version ${v} – für unsere Runden brauchst du ${AP_VERSION}. Ich aktualisiere es …`);
  } else {
    ctx.say('Archipelago fehlt noch – lade den Installer …');
  }
  const file = path.join(os.tmpdir(), 'Setup.Archipelago.0.6.7.exe');
  await fsp.writeFile(file, await ctx.download(AP_SETUP));
  ctx.say('Installiere Archipelago – bitte die Windows-Abfrage mit „Ja“ bestätigen …');
  await ps(`Start-Process -FilePath ${psq(file)} -ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART' -Verb RunAs -Wait`);
  const { version: after, found: ok } = await apInfo();  // der Installer nimmt den alten Ordner, falls es schon mal installiert war
  if (!ok) throw new Error('Archipelago wurde nicht installiert (Windows-Abfrage abgelehnt?). Bitte nochmal ▶ Spielen.');
  if (after && older(after, AP_VERSION)) throw new Error(`Archipelago ist noch Version ${after} – das Update hat nicht geklappt (Windows-Abfrage abgelehnt?). Bitte nochmal ▶ Spielen.`);
}

/** Starterpaket in "HviK Archipelago\<Ordner>" - einmal laden, bei neuem Release aktualisieren. Eigene Dateien bleiben. */
async function ensurePackage(info, ctx) {
  const dir = path.join(ROOT, info.starter.folder);
  const markFile = path.join(dir, '.hvik-paket.json');
  let mark = {};
  try { mark = JSON.parse(await fsp.readFile(markFile, 'utf8')); } catch { /* neu */ }
  if (mark.url !== info.starter.url || !exists(path.join(dir, 'tools'))) {
    ctx.say(mark.url ? 'Neue Version des Starterpakets – aktualisiere …' : `Lade das Starterpaket für ${info.game.name} …`);
    const zip = new AdmZip(await ctx.download(info.starter.url));
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    // manche Pakete haben einen Oberordner (HviK-Minecraft/...) - den weglassen, damit alles direkt im Spielordner liegt
    const top = entries.length && entries.every(e => e.entryName.split('/')[0] === entries[0].entryName.split('/')[0] && e.entryName.includes('/'))
      ? entries[0].entryName.split('/')[0] + '/' : '';
    for (const e of entries) {
      const rel = e.entryName.slice(top.length);
      const target = path.join(dir, ...rel.split('/'));
      if (!path.resolve(target).startsWith(path.resolve(dir))) continue;  // keine Pfade aus dem Ordner heraus
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, e.getData());
    }
    // Minecraft-Paket: fest eingetragenen Server durch den der Runde ersetzen (Runden laufen auch auf anderen Ports)
    const mcStart = path.join(dir, 'tools', 'start.ps1');
    if (exists(mcStart)) {
      let s = await fsp.readFile(mcStart, 'utf8');
      if (s.includes('/connect hvik.org 38281')) {
        s = s.replace('Copy-ToClipboard "/connect hvik.org 38281"', 'Copy-ToClipboard ("/connect " + ($HviK.Server -replace \':\', \' \'))')
             .split('(/connect hvik.org 38281 ist kopiert)').join('(/connect $($HviK.Server -replace \':\', \' \') ist kopiert)');
        await fsp.writeFile(mcStart, s);
      }
    }
    await fsp.writeFile(markFile, JSON.stringify({ ...mark, url: info.starter.url }, null, 2));
    mark.url = info.starter.url;
  }
  return { dir, mark, markFile };
}

/** deine-runde: eigene Datei (frisch von hvik.org) + Server-Adresse; name.txt = Name in der Runde. */
async function writeRound(dir, info, ctx) {
  const mine = path.join(dir, 'deine-runde');
  await fsp.mkdir(mine, { recursive: true });
  for (const f of await fsp.readdir(mine)) await fsp.rm(path.join(mine, f), { recursive: true, force: true });  // alte Runde weg
  if (info.file) {
    ctx.say('Lade deine Datei für diese Runde …');
    const { name, data } = await ctx.downloadNamed(info.file);
    await fsp.writeFile(path.join(mine, name), data);
  }
  await fsp.writeFile(path.join(mine, 'server.txt'), (info.server || '') + '\r\n');
  // Die Paket-Skripte haben C:\ProgramData\Archipelago fest drin - auf den Ordner setzen, wo Archipelago wirklich liegt
  const hv = path.join(dir, 'tools', 'hvik.ps1');
  if (exists(hv)) {
    const s = await fsp.readFile(hv, 'utf8');
    const t = s.replace(/^(\s*ApDir\s*=\s*)"[^"]*"/m, (m, a) => `${a}"${AP_DIR.replace(/"/g, '')}"`);
    if (t !== s) await fsp.writeFile(hv, t);
  }
  await fsp.writeFile(path.join(dir, 'name.txt'), info.slot);
}

// ---------- ROM & Co.: erst ROMs-Ordner, dann Downloads, sonst fragen - danach liegt sie im ROMs-Ordner ----------
async function findIn(dir, need, depth) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && need.ext.includes(path.extname(e.name).slice(1).toLowerCase())) {
      const size = (await fsp.stat(p)).size;
      if (need.sizes.includes(size) && (need.names.test(e.name) || dir === ROMS)) return p;
    }
  }
  if (depth > 0) for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) {
    const r = await findIn(path.join(dir, e.name), need, depth - 1);
    if (r) return r;
  }
  return null;
}

async function moveInto(src, destDir, name) {
  await fsp.mkdir(destDir, { recursive: true });
  const dst = path.join(destDir, name);
  if (path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase()) return dst;
  try { await fsp.rename(src, dst); }
  catch { await fsp.copyFile(src, dst); await fsp.unlink(src).catch(() => {}); }  // anderes Laufwerk
  return dst;
}

/** host.yaml: einen Wert in einem Abschnitt setzen (wie Set-HostYamlValue in den Paketen). */
async function setHostYaml(section, key, value) {
  const file = path.join(AP_DIR, 'host.yaml');
  const lines = exists(file) ? (await fsp.readFile(file, 'utf8')).split(/\r?\n/) : [];
  const line = `  ${key}: ${value}`;
  const out = [];
  let inSec = false, done = false;
  for (const l of lines) {
    if (/^\S/.test(l)) {
      if (inSec && !done) { out.push(line); done = true; }
      inSec = l.replace(/\s+$/, '') === `${section}:`;
    } else if (inSec && new RegExp(`^\\s+${key}:`).test(l)) { out.push(line); done = true; continue; }
    out.push(l);
  }
  if (inSec && !done) { out.push(line); done = true; }
  if (!done) out.push(`${section}:`, line);
  try { await fsp.writeFile(file, out.join('\n')); }
  catch (e) { throw new Error(`Konnte Archipelagos host.yaml nicht schreiben (${e.code}).`); }
}

async function ensureRom(info, ctx) {
  const need = ROM_NEEDS[info.game.slug];
  if (!need) return;
  let rom = await findIn(ROMS, need, 0);
  if (!rom) {
    ctx.say(`Suche deine ${need.label} im Download-Ordner …`);
    const found = (await findIn(path.join(os.homedir(), 'Downloads'), need, 1)) || (await findIn(AP_DIR, need, 0));
    let src = found;
    if (!src) {
      ctx.say(`Bitte deine ${need.label} auswählen …`);
      src = await ctx.pickFile(`${need.label} auswählen`, need.ext);
      if (!src) throw new Error(`Ohne ${need.label} geht es nicht – nochmal ▶ Spielen und die Datei auswählen.`);
      if (!need.sizes.includes((await fsp.stat(src)).size)) throw new Error('Das sieht nicht nach der richtigen ROM aus (falsche Größe). Gebraucht wird „Super Mario World (USA)“ als .sfc.');
    }
    rom = src.toLowerCase().startsWith(AP_DIR.toLowerCase())   // aus dem Archipelago-Ordner nur kopieren
      ? (await fsp.mkdir(ROMS, { recursive: true }), await fsp.copyFile(src, path.join(ROMS, need.file)), path.join(ROMS, need.file))
      : await moveInto(src, ROMS, need.file);
    ctx.say(`ROM liegt jetzt in „HviK Archipelago\\ROMs“ – nächstes Mal wird nicht mehr gefragt.`);
  }
  await setHostYaml(need.section, need.key, JSON.stringify(rom));
}

// ---------- Einrichten (einmal) und Starten - in einem Konsolenfenster, wie per Doppelklick ----------
function runConsole(dir, title, inner, wait) {
  const bat = path.join(dir, wait ? '.hvik-einrichten.bat' : '.hvik-start.bat');
  fs.writeFileSync(bat, ['@echo off', 'chcp 65001 >nul', `title ${title}`, `cd /d "${dir}"`, ...inner].join('\r\n') + '\r\n');
  return new Promise(res => {
    const p = spawn('cmd.exe', ['/c', `start "" ${wait ? '/wait ' : ''}cmd /c "${bat}"`],
                    { cwd: dir, windowsHide: true, detached: !wait, windowsVerbatimArguments: true });
    if (!wait) { p.unref(); res(); } else p.on('exit', () => res());
  });
}

// Einrichten ohne Fenster: Skripte ohne Rückfragen laufen unsichtbar, SMW macht die App selbst
const SILENT_SETUP = new Set(['minecraft', 'the-binding-of-isaac']);
function runHidden(dir, script) {
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: dir, windowsHide: true, maxBuffer: 4 << 20 }, (err, out, errOut) => res({ code: err ? (err.code || 1) : 0, out: String(out || '') + String(errOut || '') })));
}
async function setupSmw(ctx) {
  if (!exists(path.join(AP_DIR, 'host.yaml'))) {  // Archipelago legt seine Einstellungen beim ersten Start an
    ctx.say('Archipelago legt einmal seine Einstellungen an …');
    detached(launcher(), []);
    for (let i = 0; i < 30 && !exists(path.join(AP_DIR, 'host.yaml')); i++) await sleep(500);
    await sleep(1500);
    await new Promise(r => execFile('taskkill', ['/IM', 'ArchipelagoLauncher.exe', '/F'], { windowsHide: true }, () => r()));
  }
}

async function setup(pkg, info, ctx) {
  if (pkg.mark.setupDone || !exists(path.join(pkg.dir, 'EINRICHTEN.bat'))) return;
  if (info.game.slug === 'super-mario-world' || SILENT_SETUP.has(info.game.slug)) {
    ctx.say(`Richte ${info.game.name} einmalig ein …`);
    if (info.game.slug === 'super-mario-world') await setupSmw(ctx);
    else {
      const r = await runHidden(pkg.dir, path.join(pkg.dir, 'tools', 'einrichten.ps1'));
      if (r.code !== 0) {
        const why = r.out.split(/\r?\n/).filter(l => /\[!\]/.test(l)).map(l => l.replace(/^\s*\[!\]\s*/, '')).join(' ');
        throw new Error('Einrichten hat nicht geklappt: ' + (why || 'unbekannter Fehler') );
      }
    }
    pkg.mark.setupDone = new Date().toISOString();
    await fsp.writeFile(pkg.markFile, JSON.stringify(pkg.mark, null, 2));
    return;
  }
  ctx.say('Einmaliges Einrichten läuft im Fenster – dort den Anweisungen folgen und am Ende schließen …');
  const code = path.join(pkg.dir, '.hvik-einrichten-code.txt');
  await fsp.rm(code, { force: true });
  const viaPs = exists(path.join(pkg.dir, 'tools', 'einrichten.ps1'));
  await runConsole(pkg.dir, `HviK Archipelago - ${info.game.name} einrichten`, viaPs ? [
    'powershell -NoProfile -ExecutionPolicy Bypass -File "tools\\einrichten.ps1"',
    'set CODE=%errorlevel%', 'echo %CODE%> .hvik-einrichten-code.txt', 'echo.',
    'if "%CODE%"=="0" (echo  Fertig eingerichtet - Fenster schliessen, dann geht es weiter.) else (echo  Da hat etwas nicht geklappt - Meldung oben lesen.)',
    'pause',
  ] : ['call EINRICHTEN.bat', 'echo %errorlevel%> .hvik-einrichten-code.txt'], true);
  const result = exists(code) ? (await fsp.readFile(code, 'utf8')).trim() : '';
  if (result !== '0') throw new Error('Das Einrichten ist nicht fertig geworden – Meldung im Fenster lesen und nochmal ▶ Spielen.');
  pkg.mark.setupDone = new Date().toISOString();
  await fsp.writeFile(pkg.markFile, JSON.stringify(pkg.mark, null, 2));
}

async function start(pkg, info, ctx) {
  ctx.say('Starte …');
  await runConsole(pkg.dir, `HviK Archipelago - ${info.game.name}`, ['call START.bat'], false);
}

// ---------- Direkt starten (ohne START.bat) + Schritt-für-Schritt-Anleitung für das, was man selbst machen muss ----------
async function roundFile(dir, re) {
  const mine = path.join(dir, 'deine-runde');
  const f = (await fsp.readdir(mine).catch(() => [])).find(x => re.test(x));
  if (!f) throw new Error('Deine Datei für diese Runde fehlt – ist die Runde schon gestartet? Sonst gleich nochmal ▶ Spielen.');
  return path.join(mine, f);
}
const hostPort = s => String(s || '').replace(':', ' ');
/** Archipelago-Clients, die die Seite über die Anleitung öffnen darf */
const CLIENTS = ['KH2 Client', 'Isaac Client', 'SNI Client', 'Text Client'];
const lastConn = {};  // Client -> {server, slot}: der Knopf in der Anleitung verbindet dann genauso direkt
/** Client öffnen - mit conn gleich verbunden (der Launcher reicht alles nach "--" an den Client weiter) */
function openClient(name, conn) {
  if (!CLIENTS.includes(name)) throw new Error('Unbekannter Client.');
  if (conn && conn.server) lastConn[name] = conn;
  const c = lastConn[name];
  if (!exists(launcher())) throw new Error('Archipelago nicht gefunden – einmal ▶ Spielen drücken, dann richtet die App es ein.');
  detached(launcher(), c ? [name, '--', '--connect', c.server, ...(c.slot ? ['--name', c.slot] : [])] : [name]);
}

const STARTERS = {
  /** Minecraft: eigene Welt = Archipelago-Server auf dem eigenen PC (Archipelago-Client) - oder der zugeteilte HviK-Server.
   *  Gespielt wird mit dem CurseForge-Profil mit Shadern + JEI, der Server steht schon in der Serverliste. */
  async minecraft(pkg, info, ctx) {
    if (info.mode === 'server') {
      if (!info.game_server) throw new Error('Dir ist noch kein Server zugeteilt.');
      const r = await mcap.play({ name: 'HviK Archipelago – Server', ip: info.game_server }, ctx);
      return { ...r, guide: { title: 'Minecraft – auf dem HviK-Server', steps: [
        { text: 'Minecraft startet über CurseForge (Profil mit Shadern und JEI).' },
        { text: 'Mehrspieler → „HviK Archipelago – Server“ → Beitreten.' },
        { text: 'Die Mod ist schon mit Archipelago verbunden. Wenn alle da sind, im Chat:', copy: '/start' },
        { text: 'Shader wechseln: Esc → Optionen → Grafik → Shader-Pakete. Rezepte: mit der Maus über ein Item und R drücken (JEI).' },
      ] } };
    }
    const apmc = await roundFile(pkg.dir, /\.apmc$/i);
    ctx.say('Starte deinen Archipelago-Minecraft-Server …');
    detached(launcher(), [apmc]);
    const r = await mcap.play({ name: 'HviK Archipelago (dein PC)', ip: 'localhost' }, ctx);
    return { ...r, guide: { title: 'Minecraft – deine eigene Welt', steps: [
      { text: 'Im Fenster „Minecraft Client“ läuft dein eigener Server. Beim allerersten Mal fragt er nach EULA, Java, NeoForge und Mod: alles mit „Ja“ bestätigen. Warten, bis „Server Running“ steht – das Fenster offen lassen.' },
      { text: 'Minecraft startet gleichzeitig über CurseForge (Profil mit Shadern und JEI; beim ersten Mal lädt CurseForge noch Minecraft nach).' },
      { text: 'Im Spiel: Mehrspieler → „HviK Archipelago (dein PC)“ → Beitreten.' },
      { text: 'Die Mod verbindet sich von selbst mit Archipelago. Falls im Chat nichts von „connected“ steht: T drücken und einfügen:', copy: `/connect ${hostPort(info.server)}` },
      { text: 'Los geht\'s mit:', copy: '/start' },
      { text: '!hint, !missing usw. gehen direkt im Minecraft-Chat. Shader: Esc → Optionen → Grafik → Shader-Pakete. Rezepte: Maus über ein Item + R (JEI).' },
    ] } };
  },

  async 'super-mario-world'(pkg, info, ctx) {
    const patch = await roundFile(pkg.dir, /\.apsmw$/i);
    await setHostYaml('sni_options', 'snes_rom_start', JSON.stringify(path.join(pkg.dir, 'snes9x', 'snes9x-x64.exe')));
    ctx.say('Starte SNI Client und Emulator …');
    detached(path.join(AP_DIR, 'ArchipelagoSNIClient.exe'), ['--connect', info.server, patch]);
    return { guide: { title: 'Super Mario World', steps: [
      { text: 'Der SNI Client patcht deine ROM und startet den Emulator (snes9x) – das dauert ein paar Sekunden.' },
      { text: 'Verbunden ist alles, wenn im SNI Client „… has joined“ steht. Dann einfach spielen!' },
      { text: 'Falls er nicht verbindet: im SNI Client oben die Adresse eintragen → Connect:', copy: info.server },
    ] } };
  },

  async 'the-binding-of-isaac'(pkg, info, ctx) {
    ctx.say('Starte The Binding of Isaac und den Isaac Client …');
    detached('cmd.exe', ['/c', 'start', '', 'steam://rungameid/250900'], pkg.dir);
    openClient('Isaac Client', { server: info.server, slot: info.slot });
    return { guide: { title: 'The Binding of Isaac', steps: [
      { text: 'Isaac startet über Steam, der Isaac Client geht auf und verbindet sich von selbst mit deiner Runde.' },
      { text: 'Er fragt nach dem Speicherplatz (1–3): den Spielstand, den du in Isaac benutzt.' },
      { text: 'Falls er doch nicht verbindet: oben ins Server-Feld einfügen → Connect:', copy: info.server },
      { text: 'Und als Name:', copy: info.slot },
      { text: 'Im Spiel: Mods-Menü → „The Archipelago of Isaac“ muss an sein → neuen Run starten.' },
      { text: 'Client-Befehle: /savefile 1-3 (Speicherplatz wechseln), /resync (Items neu holen).' },
    ], clients: ['Isaac Client'] } };
  },

  async 'kingdom-hearts-2'(pkg, info, ctx) {
    const seed = await roundFile(pkg.dir, /^AP-.*\.zip$/i);
    const mm = path.join(pkg.dir, 'OpenKH', 'openkh', 'OpenKh.Tools.ModsManager.exe');
    if (!exists(mm)) throw new Error('Der OpenKH Mod Manager fehlt – das Einrichten ist nicht fertig geworden. Nochmal ▶ Spielen.');
    ctx.say('Öffne den OpenKH Mod Manager und den KH2 Client …');
    detached(mm, []);
    openClient('KH2 Client', { server: info.server, slot: info.slot });  // verbindet sich gleich mit der Runde und wartet dann auf KH2
    return { guide: { title: 'Kingdom Hearts II', steps: [
      { text: 'Im OpenKH Mod Manager: grünes Plus → „Select and install Mod Archive“ → deine Seed-Datei wählen (Pfad zum Einfügen):', copy: seed },
      { text: 'Die Seed GANZ NACH OBEN schieben. Alte Seeds aus früheren Runden abhaken.' },
      { text: '„Mod Loader“ → „Build and Run“. KH2 startet. Neue Runde = NEUER Spielstand → du landest im Garden of Assemblage.' },
      { text: 'Der KH2 Client ist schon offen und mit deiner Runde verbunden – sobald du im Garden of Assemblage bist, findet er das Spiel von selbst. Er muss die ganze Zeit offen bleiben.' },
      { text: 'Client aus Versehen zu? Knopf unten öffnet ihn wieder, gleich verbunden. „Cannot Open Process“: den Client als Administrator starten.' },
      { text: 'Falls er doch nicht verbindet: oben die Adresse eintragen → Connect:', copy: info.server },
      { text: 'Und als Name:', copy: info.slot },
    ], clients: ['KH2 Client'] } };
  },
};

/** ▶ Spielen (Runde läuft) bzw. ⚙️ Einrichten (Runde noch in der Lobby). */
async function play(info, ctx) {
  if (!info.starter) throw new Error(`Für ${info.game.name} gibt es noch kein Starterpaket – bitte die Anleitung auf hvik.org nehmen.`);
  await fsp.mkdir(ROOT, { recursive: true });
  await ensureArchipelago(ctx);
  const pkg = await ensurePackage(info, ctx);
  await writeRound(pkg.dir, info, ctx);
  await setup(pkg, info, ctx);
  await ensureRom(info, ctx);
  if (info.setupOnly) return { folder: pkg.dir, setupOnly: true };
  if (STARTERS[info.game.slug]) return { folder: pkg.dir, ...(await STARTERS[info.game.slug](pkg, info, ctx)) };
  await start(pkg, info, ctx);  // andere Spiele: wie bisher über START.bat
  return { folder: pkg.dir };
}

async function status(info) {
  if (!info.starter) return { ready: false, known: false };
  const ap = await apInfo();
  let mark = {};
  try { mark = JSON.parse(await fsp.readFile(path.join(ROOT, info.starter.folder, '.hvik-paket.json'), 'utf8')); } catch { /* neu */ }
  return { known: true, ready: !!mark.setupDone, archipelago: ap.found, folder: path.join(ROOT, info.starter.folder) };
}

module.exports = { play, status, openClient, apInfo, ROOT };
