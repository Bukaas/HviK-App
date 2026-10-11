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
const AP_DIR = 'C:\\ProgramData\\Archipelago';
const AP_SETUP = 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.7/Setup.Archipelago.0.6.7.exe';

// Spiele, die eine eigene Datei vom Spieler brauchen (z. B. ROM): wo sie in host.yaml eingetragen wird
const ROM_NEEDS = {
  'super-mario-world': { label: 'Super Mario World (USA) – ROM', ext: ['sfc', 'smc'], names: /mario.?world|smw/i, sizes: [524288, 524800],
                         section: 'smw_options', key: 'rom_file', file: 'Super Mario World (USA).sfc' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => fs.existsSync(p);

function ps(command) {  // PowerShell-Befehl ausführen und warten
  return new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
                                     { windowsHide: true }, (err, out) => res({ ok: !err, out: String(out || '') })));
}
const psq = s => `'${String(s).replace(/'/g, "''")}'`;  // PowerShell-String in einfachen Anführungszeichen

/** Archipelago 0.6.7 da? Sonst Installer laden und (mit Admin-Abfrage) still installieren. */
async function ensureArchipelago(ctx) {
  if (exists(path.join(AP_DIR, 'ArchipelagoLauncher.exe'))) return;
  ctx.say('Archipelago fehlt noch – lade den Installer …');
  const file = path.join(os.tmpdir(), 'Setup.Archipelago.0.6.7.exe');
  await fsp.writeFile(file, await ctx.download(AP_SETUP));
  ctx.say('Installiere Archipelago – bitte die Windows-Abfrage mit „Ja“ bestätigen …');
  await ps(`Start-Process -FilePath ${psq(file)} -ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART' -Verb RunAs -Wait`);
  if (!exists(path.join(AP_DIR, 'ArchipelagoLauncher.exe'))) throw new Error('Archipelago wurde nicht installiert (Windows-Abfrage abgelehnt?). Bitte nochmal ▶ Spielen.');
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

async function setup(pkg, info, ctx) {
  if (pkg.mark.setupDone || !exists(path.join(pkg.dir, 'EINRICHTEN.bat'))) return;
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

/** Minecraft: eigene Welt = Archipelago-Server auf dem eigenen PC (Archipelago-Client) - oder der zugeteilte HviK-Server.
 *  Gespielt wird mit dem CurseForge-Profil mit Shadern, der Server steht schon in der Serverliste. */
async function playMinecraft(pkg, info, ctx) {
  if (info.mode === 'server') {
    if (!info.game_server) throw new Error('Dir ist noch kein Server zugeteilt – erst „Server anfragen“, ein Admin bestätigt dann.');
    return mcap.play({ name: 'HviK Archipelago – Server', ip: info.game_server }, ctx);
  }
  ctx.say('Starte deinen Archipelago-Minecraft-Server (Fenster offen lassen, beim ersten Mal alles mit JA bestätigen) …');
  await start(pkg, info, ctx);
  const r = await mcap.play({ name: 'HviK Archipelago (dein PC)', ip: 'localhost' }, ctx);
  return { ...r, hint: 'Warte im Server-Fenster auf „Server Running“, dann in Minecraft: Mehrspieler → „HviK Archipelago (dein PC)“ → im Chat Strg+V (connect) und /start.' };
}

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
  if (info.game.slug === 'minecraft') return { folder: pkg.dir, ...(await playMinecraft(pkg, info, ctx)) };
  await start(pkg, info, ctx);
  return { folder: pkg.dir };
}

async function status(info) {
  if (!info.starter) return { ready: false, known: false };
  let mark = {};
  try { mark = JSON.parse(await fsp.readFile(path.join(ROOT, info.starter.folder, '.hvik-paket.json'), 'utf8')); } catch { /* neu */ }
  return { known: true, ready: !!mark.setupDone, archipelago: exists(path.join(AP_DIR, 'ArchipelagoLauncher.exe')), folder: path.join(ROOT, info.starter.folder) };
}

module.exports = { play, status, ROOT };
