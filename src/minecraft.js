// HviK Link in der App: CurseForge-Profil einrichten, Mod aktuell halten, Profil über CurseForge starten.
// Macht dasselbe wie früher EINRICHTEN.bat - nur automatisch und vor jedem Start.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { shell } = require('electron');

const SUFFIX = ' (HviK Link)';
const SKIP = new Set(['saves', 'logs', 'crash-reports', 'screenshots', 'backups', 'simplebackups']);  // beim Kopieren eines Modpacks weglassen

function run(cmd, args) {
  return new Promise(res => execFile(cmd, args, { windowsHide: true }, (err, out) => res(String(out || ''))));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** CurseForge-Ordner "Instances" suchen (gleiche Orte wie EINRICHTEN.bat, plus selbst gewählter). */
function instanceRoots(custom) {
  const home = os.homedir();
  const c = [custom, path.join(home, 'curseforge', 'minecraft', 'Instances'), path.join(home, 'Documents', 'Curseforge', 'Minecraft', 'Instances'),
             path.join(home, 'Documents', 'CurseForge', 'minecraft', 'Instances')];
  for (const d of 'CDEFGH') c.push(`${d}:\\curseforge\\minecraft\\Instances`, `${d}:\\CurseForge\\Minecraft\\Instances`);
  const seen = new Set();
  return c.filter(p => p && fs.existsSync(p) && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

async function readInstances(roots) {
  const out = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name), f = path.join(dir, 'minecraftinstance.json');
      try {
        const j = JSON.parse(await fsp.readFile(f, 'utf8'));
        out.push({ dir, root, folder: d.name, name: j.name || d.name, guid: j.guid, project: j.projectID || (j.installedModpack && j.installedModpack.addonID) || null });
      } catch { /* kein Profil */ }
    }
  }
  return out;
}

async function cfRunning() {
  return /CurseForge\.exe/i.test(await run('tasklist', ['/FI', 'IMAGENAME eq CurseForge.exe', '/NH']));
}

/** CurseForge schließen (muss zu sein, wenn ein Profil angelegt wird - sonst überschreibt es die Profilliste wieder). */
async function closeCurseForge(say) {
  if (!(await cfRunning())) return;
  say('CurseForge wird kurz geschlossen …');
  await run('taskkill', ['/IM', 'CurseForge.exe']);
  for (let i = 0; i < 16 && await cfRunning(); i++) await sleep(500);
  await run('taskkill', ['/F', '/IM', 'CurseForge.exe']);
  await run('taskkill', ['/F', '/IM', 'Curse.Agent.Host.exe']);
  await sleep(1000);
  if (await cfRunning()) throw new Error('CurseForge lässt sich nicht schließen – bitte selbst beenden (auch unten rechts im Infobereich).');
}

async function copyDir(src, dst, say) {
  let n = 0;
  async function walk(s, d, top) {
    await fsp.mkdir(d, { recursive: true });
    for (const e of await fsp.readdir(s, { withFileTypes: true })) {
      if (top && SKIP.has(e.name.toLowerCase())) continue;
      const a = path.join(s, e.name), b = path.join(d, e.name);
      if (e.isDirectory()) await walk(a, b, false);
      else { await fsp.copyFile(a, b); if (++n % 200 === 0) say(`Kopiere das Modpack … ${n} Dateien`); }
    }
  }
  await walk(src, dst, true);
}

/** Ist CurseForge überhaupt installiert? Sonst Download-Seite öffnen und klar sagen, was zu tun ist. */
async function ensureCurseForge() {
  const exe = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CurseForge Windows', 'CurseForge.exe'),
               path.join(process.env.ProgramFiles || '', 'CurseForge Windows', 'CurseForge.exe')].find(p => fs.existsSync(p));
  if (exe) return;
  const proto = await run('reg', ['query', 'HKCR\\curseforge', '/ve']);  // anders installiert? Dann gibt es wenigstens den Link-Handler
  if (/curseforge/i.test(proto)) return;
  shell.openExternal('https://www.curseforge.com/download/app');
  throw Object.assign(new Error('Für Minecraft brauchst du die kostenlose CurseForge-App – ich habe die Download-Seite geöffnet. '
    + 'Installieren, einmal starten und mit deinem Microsoft-Konto anmelden, dann nochmal ▶ Spielen.'), { code: 'NO_CF' });
}

/** Profil "<Pack> (HviK Link)" finden oder anlegen. */
async function ensureProfile(info, ctx) {
  await ensureCurseForge();
  const { say, get, settings } = ctx;
  const pack = info.pack;
  const roots = instanceRoots(settings.cfRoot);
  if (!roots.length) throw Object.assign(new Error('Den CurseForge-Ordner habe ich nicht gefunden.'), { code: 'NO_ROOT' });
  const all = await readInstances(roots);
  if (pack.vanilla) {
    const name = `Vanilla ${pack.mc}${SUFFIX}`;
    const have = all.find(i => i.name === name || i.folder === name);
    if (have) return { inst: have, created: false };
    await closeCurseForge(say);
    say('Lege das Profil „' + name + '“ an …');
    const dir = path.join(roots[0], name);
    await fsp.mkdir(dir, { recursive: true });
    const guid = crypto.randomUUID();
    let tpl = (await get(pack.template)).toString('utf8');
    tpl = tpl.split('__NAME__').join(name).split('__PATH__').join((dir.replace(/\\+$/, '') + '\\').split('\\').join('\\\\'))
             .split('__GUID__').join(guid).split('__DATE__').join(new Date().toISOString());
    await fsp.writeFile(path.join(dir, 'minecraftinstance.json'), tpl, 'utf8');
    return { inst: { dir, name, guid }, created: true };
  }
  const mine = all.find(i => i.folder.endsWith(SUFFIX) && String(i.project) === String(pack.cf_project));
  if (mine) return { inst: mine, created: false };
  const src = all.find(i => !i.folder.endsWith(SUFFIX) && (String(i.project) === String(pack.cf_project) || i.folder.startsWith(pack.name)));
  if (!src) {
    shell.openExternal(`curseforge://install?addonId=${pack.cf_project}${pack.cf_file ? `&fileId=${pack.cf_file}` : ''}`);
    throw new Error(`${pack.name} ist in CurseForge noch nicht installiert – ich habe die Installation geöffnet. Danach nochmal ▶ Spielen.`);
  }
  await closeCurseForge(say);
  const name = src.folder + SUFFIX, dir = path.join(src.root, name);
  say(`Kopiere „${src.folder}“ nach „${name}“ (ohne Welten, das kann ein paar Minuten dauern) …`);
  await copyDir(src.dir, dir, say);
  const jf = path.join(dir, 'minecraftinstance.json');
  const j = JSON.parse(await fsp.readFile(jf, 'utf8'));
  j.name = name;
  if ('installPath' in j) j.installPath = dir.replace(/\\+$/, '') + '\\';
  j.guid = crypto.randomUUID();
  await fsp.writeFile(jf, JSON.stringify(j), 'utf8');
  return { inst: { dir, name, guid: j.guid }, created: true };
}

/** Mod auf den Stand von hvik.org bringen + persönliche Link-Daten eintragen. */
async function ensureMod(inst, info, ctx) {
  const mods = path.join(inst.dir, 'mods'), config = path.join(inst.dir, 'config');
  await fsp.mkdir(mods, { recursive: true });
  await fsp.mkdir(config, { recursive: true });
  const target = path.join(mods, info.pack.jar);
  let current = '';
  try { current = sha256(await fsp.readFile(target)); } catch { /* noch nicht da */ }
  const others = (await fsp.readdir(mods)).filter(f => /^hviklink-.*\.jar$/i.test(f) && f !== info.pack.jar);
  if (current !== info.mod.sha256 || others.length) {
    ctx.say(current ? 'Lade das Mod-Update …' : 'Lade die HviK-Link-Mod …');
    const buf = await ctx.get(info.mod.url);
    if (sha256(buf) !== info.mod.sha256) throw new Error('Der Mod-Download ist beschädigt – bitte nochmal versuchen.');
    try {
      for (const f of others) await fsp.unlink(path.join(mods, f));
      await fsp.writeFile(target, buf);
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error('Minecraft läuft noch mit diesem Profil – bitte erst schließen, dann ▶ Spielen.');
      throw e;
    }
    ctx.updated = true;
  }
  const cfg = { server: info.server, code: '', token: info.key, name: info.name };
  await fsp.writeFile(path.join(config, 'hviklink.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------- CurseForge starten + auf das Profil warten (sonst sagt CurseForge beim Kaltstart "not found") ----------
const CF_LOGS = path.join(process.env.APPDATA || '', 'CurseForge', 'logs');
const CF_EXE = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CurseForge Windows', 'CurseForge.exe'),
                path.join(process.env.ProgramFiles || '', 'CurseForge Windows', 'CurseForge.exe')];

/** Neueste CurseForge-Logdatei (full-*.log), die nach "since" angelegt wurde. */
async function cfLog(since) {
  try {
    const dirs = (await fsp.readdir(CF_LOGS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
    for (const d of dirs.slice(0, 8)) {
      const dir = path.join(CF_LOGS, d);
      const f = (await fsp.readdir(dir)).find(x => /^full-.*\.log$/.test(x));
      if (!f) continue;
      const file = path.join(dir, f), st = await fsp.stat(file);
      if (st.birthtimeMs < since - 2000 && st.mtimeMs < since - 2000) return null;
      // jeder Startbefehl öffnet kurz einen zweiten CurseForge-Prozess, der sofort wieder zugeht - dessen Log überspringen
      if ((await fsp.readFile(file, 'utf8')).includes('Unable to obtain single instance lock')) continue;
      return file;
    }
  } catch { /* kein Log */ }
  return null;
}

/** Wartet, bis im CurseForge-Log eine Zeile (nach Position "from") auf das Muster passt. */
async function waitLog(file, from, re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const txt = (await fsp.readFile(file)).subarray(from).toString('utf8');
      const m = txt.match(re);
      if (m) return m[0];
    } catch { /* noch nicht da */ }
    await sleep(500);
  }
  return null;
}

async function launch(guid, say) {
  const uri = `curseforge://launch-game?instanceId=${guid}&gameId=432`;
  const idRe = guid;  // nur Hex und Bindestriche - im Muster unkritisch
  if (!(await cfRunning())) {  // Kaltstart: erst CurseForge öffnen und warten, bis es unser Profil kennt
    const exe = CF_EXE.find(p => fs.existsSync(p));
    const t0 = Date.now();
    say('Starte CurseForge …');
    if (exe) execFile(exe, [], { detached: true, windowsHide: false }).unref();
    else await shell.openExternal('curseforge://');
    let log = null;
    for (let i = 0; i < 40 && !log; i++) { await sleep(500); log = await cfLog(t0); }
    if (log) {
      say('Warte, bis CurseForge das Profil geladen hat …');
      await waitLog(log, 0, new RegExp(`Modpack ${idRe} detected|Scan complete.*${idRe}`), 45000);
      await sleep(1500);
    } else {
      await sleep(8000);
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const log = await cfLog(0);
    const from = log ? (await fsp.stat(log)).size : 0;
    await shell.openExternal(uri);
    if (!log) return;
    const r = await waitLog(log, from, new RegExp(`Modpack ${idRe} not found`), 6000);
    if (!r) return;  // kein "not found" -> CurseForge startet das Spiel
    say('CurseForge kennt das Profil noch nicht – versuche es gleich nochmal …');
    await sleep(3000);
  }
  throw new Error('CurseForge findet das Profil nicht. Bitte in CurseForge einmal „Minecraft“ öffnen und dann nochmal ▶ Spielen.');
}

/** ▶ Spielen: einrichten/aktualisieren, dann das Profil über CurseForge starten. */
async function play(info, ctx) {
  const { inst, created } = await ensureProfile(info, ctx);
  await ensureMod(inst, info, ctx);
  if (!inst.guid) throw new Error('Das Profil hat keine ID – bitte in CurseForge einmal öffnen und nochmal versuchen.');
  ctx.say(created ? 'Profil fertig – CurseForge startet Minecraft (beim ersten Mal lädt es noch Minecraft/Forge nach) …'
                  : (ctx.updated ? 'Mod aktualisiert – Minecraft startet …' : 'Alles aktuell – Minecraft startet …'));
  await launch(inst.guid, ctx.say);
  return { profile: inst.name, created, updated: !!ctx.updated };
}

/** Ist das Profil für dieses Pack schon eingerichtet? (für den Knopf-Text auf der Seite) */
async function status(info, settings) {
  const roots = instanceRoots(settings.cfRoot);
  if (!roots.length) return { profile: null, root: false };
  const all = await readInstances(roots);
  const p = info.pack;
  const inst = p.vanilla ? all.find(i => i.name === `Vanilla ${p.mc}${SUFFIX}` || i.folder === `Vanilla ${p.mc}${SUFFIX}`)
                         : all.find(i => i.folder.endsWith(SUFFIX) && String(i.project) === String(p.cf_project));
  return { profile: inst ? inst.name : null, root: true };
}

module.exports = { play, status, instanceRoots, readInstances, closeCurseForge, launch, ensureCurseForge };
