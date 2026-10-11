// Minecraft für Archipelago: CurseForge-Profil "Minecraft 26.2 (HviK Archipelago)" - NeoForge 26.2 mit Sodium + Iris
// und Complementary-Shadern (von Modrinth), Server-Eintrag in der Serverliste, Start über CurseForge.
// Die Archipelago-Mod läuft nur auf dem Server (lokal über den Archipelago-Client oder auf dem HviK-Server).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const minecraft = require('./minecraft');

const NAME = 'Minecraft 26.2 (HviK Archipelago)';
const MC = '26.2';
const LOADER = 'neoforge';
const MODS = ['sodium', 'iris', 'jei'];              // Modrinth-Projekte: Shader brauchen Iris (+ Sodium), JEI für Rezepte
// die üblichen Shader aus den Modpacks - liegen bereit, im Spiel nur noch auswählen. Der erste ist vorausgewählt.
const SHADERS = ['complementary-reimagined', 'complementary-unbound', 'bsl-shaders', 'makeup-ultra-fast-shaders',
                 'sildurs-vibrant-shaders', 'photon-shader', 'bliss-shader'];

async function modrinthLatest(project, opts, get) {
  const q = new URLSearchParams({ game_versions: JSON.stringify([MC]), ...(opts.loader ? { loaders: JSON.stringify([opts.loader]) } : {}) });
  const list = JSON.parse((await get(`https://api.modrinth.com/v2/project/${project}/version?${q}`)).toString('utf8'));
  const v = list.find(x => x.version_type === 'release') || list[0];
  if (!v) throw new Error(`${project} gibt es (noch) nicht für Minecraft ${MC}.`);
  const f = v.files.find(x => x.primary) || v.files[0];
  return { url: f.url, name: f.filename, sha1: f.hashes && f.hashes.sha1 };
}

// ---------- servers.dat (NBT, unkomprimiert): Liste mit unseren Server-Einträgen ----------
function nbtString(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); }
function serversDat(entries) {
  const parts = [Buffer.from([10]), nbtString(''), Buffer.from([9]), nbtString('servers'), Buffer.from([10])];
  const n = Buffer.alloc(4); n.writeInt32BE(entries.length); parts.push(n);
  for (const e of entries) {
    parts.push(Buffer.from([8]), nbtString('name'), nbtString(e.name), Buffer.from([8]), nbtString('ip'), nbtString(e.ip),
               Buffer.from([1]), nbtString('hidden'), Buffer.from([0]), Buffer.from([0]));  // Compound-Ende
  }
  parts.push(Buffer.from([0]));  // Ende des Wurzel-Compounds
  return Buffer.concat(parts);
}

/** Profil anlegen (einmal) und Shader-Mods/-Paket aktuell halten. */
async function ensureProfile(ctx) {
  const roots = minecraft.instanceRoots(ctx.settings.cfRoot);
  if (!roots.length) throw Object.assign(new Error('Den CurseForge-Ordner habe ich nicht gefunden – ist CurseForge installiert?'), { code: 'NO_ROOT' });
  const all = await minecraft.readInstances(roots);
  let inst = all.find(i => i.name === NAME || i.folder === NAME), created = false;
  if (!inst) {
    await minecraft.closeCurseForge(ctx.say);
    ctx.say(`Lege das CurseForge-Profil „${NAME}“ an …`);
    const dir = path.join(roots[0], NAME), guid = crypto.randomUUID();
    await fsp.mkdir(dir, { recursive: true });
    const tpl = (await fsp.readFile(path.join(__dirname, 'vorlagen', 'neoforge-26.2.json'), 'utf8'))
      .split('__NAME__').join(NAME).split('__PATH__').join((dir + '\\').split('\\').join('\\\\'))
      .split('__GUID__').join(guid).split('__DATE__').join(new Date().toISOString());
    await fsp.writeFile(path.join(dir, 'minecraftinstance.json'), tpl, 'utf8');
    inst = { dir, name: NAME, guid };
    created = true;
  }
  const mods = path.join(inst.dir, 'mods'), packs = path.join(inst.dir, 'shaderpacks'), config = path.join(inst.dir, 'config');
  for (const d of [mods, packs, config]) await fsp.mkdir(d, { recursive: true });
  try {
    for (const m of MODS) {
      const f = await modrinthLatest(m, { loader: LOADER }, ctx.download);
      if (!fs.existsSync(path.join(mods, f.name))) {
        ctx.say(`Lade ${m} (${f.name}) …`);
        for (const old of (await fsp.readdir(mods)).filter(x => x.toLowerCase().startsWith(m))) await fsp.unlink(path.join(mods, old)).catch(() => {});
        await fsp.writeFile(path.join(mods, f.name), await ctx.download(f.url));
      }
    }
    let first = null;
    for (const sp of SHADERS) {
      try {
        const s = await modrinthLatest(sp, {}, ctx.download);
        first = first || s.name;
        if (!fs.existsSync(path.join(packs, s.name))) {
          ctx.say(`Lade Shader: ${s.name} …`);
          await fsp.writeFile(path.join(packs, s.name), await ctx.download(s.url));
        }
      } catch (e) { /* ein fehlender Shader ist kein Grund, nicht zu spielen */ }
    }
    const iris = path.join(config, 'iris.properties');
    if (first && !fs.existsSync(iris)) await fsp.writeFile(iris, `enableShaders=true\nshaderPack=${first}\n`);  // danach entscheidet der Spieler selbst
  } catch (e) {
    if (!created && fs.existsSync(path.join(mods))) ctx.say('Shader-Update gerade nicht möglich – spiele mit dem bisherigen Stand.');
    else throw e;
  }
  return { inst, created };
}

/** Profil vorbereiten, Server eintragen, über CurseForge starten. server = {name, ip} */
async function play(server, ctx) {
  const { inst, created } = await ensureProfile(ctx);
  await fsp.writeFile(path.join(inst.dir, 'servers.dat'), serversDat([server]));
  ctx.say(created ? 'Profil fertig – CurseForge startet Minecraft (beim ersten Mal lädt es Minecraft/NeoForge nach) …' : 'Minecraft startet über CurseForge …');
  await minecraft.launch(inst.guid, ctx.say);
  return { profile: inst.name };
}

module.exports = { play, NAME, serversDat };
