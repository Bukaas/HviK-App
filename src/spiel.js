// HviK Community Place – Spielen aus dem Launcher.
// Normal: fertige Spiel-Version aus GitHub (Bukaas/HviK-Spiel, Releases) nach %LOCALAPPDATA%\HviK Spiel laden, aktuell halten, starten.
// Tester (Einstellung spielModus = 'projekt'): Spiel direkt aus dem eigenen HviK-Welt-Ordner (git pull + Godot).
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const REPO = 'Bukaas/HviK-Spiel';
const ZIEL = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'HviK Spiel');
const EXE = 'HviK Community Place.exe';

let kind = null;
let laden = null;                     // {prozent, text}
let relZeit = 0, rel = null;          // neueste Version (GitHub, 5 Min. merken)
let fetchZeit = 0, fetchStand = null; // Projekt-Modus: git-Stand

const laeuft = () => !!(kind && kind.exitCode === null);
const modus = einst => (einst.spielModus === 'projekt' ? 'projekt' : 'version');

// ---------------------------------------------------------------- fertige Version (für alle)
async function neuste() {
  if (rel && Date.now() - relZeit < 300000) return rel;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'HviK-App', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(r.status === 404 ? 'Noch keine Spiel-Version veröffentlicht' : `GitHub antwortet nicht (${r.status})`);
  const d = await r.json();
  const zip = (d.assets || []).find(a => a.name.endsWith('.zip'));
  if (!zip) throw new Error('Die neueste Spiel-Version hat keine Datei');
  rel = { version: d.tag_name.replace(/^v/, ''), url: zip.browser_download_url, groesse: zip.size, notiz: d.body || '' };
  relZeit = Date.now();
  return rel;
}

function installiert() {
  try { return fs.readFileSync(path.join(ZIEL, 'version.txt'), 'utf8').trim(); } catch { return ''; }
}

const mb = b => (b / 1048576).toFixed(0) + ' MB';

async function statusVersion() {
  const v = installiert() && fs.existsSync(path.join(ZIEL, EXE)) ? installiert() : '';
  if (laden) return { modus: 'version', installiert: !!v, laedt: true, prozent: laden.prozent, version: v, text: laden.text, ordner: ZIEL };
  let n = null, fehler = '';
  try { n = await neuste(); } catch (err) { fehler = err.message; }
  return { modus: 'version', installiert: !!v, laeuft: laeuft(), version: v, neuste: n ? n.version : '', update: !!(v && n && n.version !== v),
           groesse: n ? mb(n.groesse) : '', ordner: ZIEL, fehler };
}

async function herunterladen() {
  const n = await neuste();
  laden = { prozent: 0, text: 'Lade …' };
  try {
    fs.mkdirSync(ZIEL, { recursive: true });
    const r = await fetch(n.url, { headers: { 'User-Agent': 'HviK-App' } });
    if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (${r.status})`);
    const gesamt = Number(r.headers.get('content-length')) || n.groesse || 1;
    const datei = path.join(ZIEL, 'download.zip');
    const out = fs.createWriteStream(datei);
    let da = 0;
    const leser = r.body.getReader();
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      da += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(ok => out.once('drain', ok));
      laden = { prozent: Math.min(95, (da / gesamt) * 95), text: `${mb(da)} von ${mb(gesamt)}` };
    }
    await new Promise((ok, fehler) => out.end(err => (err ? fehler(err) : ok())));
    laden = { prozent: 96, text: 'Entpacke …' };
    await new Promise(ok => setImmediate(ok));
    // alte Version weg (Spielstände liegen in %APPDATA%, nicht hier)
    for (const f of fs.readdirSync(ZIEL)) if (f !== 'download.zip') fs.rmSync(path.join(ZIEL, f), { recursive: true, force: true });
    new AdmZip(datei).extractAllTo(ZIEL, true);
    fs.rmSync(datei, { force: true });
    fs.writeFileSync(path.join(ZIEL, 'version.txt'), n.version);
    return { ok: true };
  } finally {
    laden = null;
  }
}

// ---------------------------------------------------------------- Projekt-Modus (Tester)
const git = (ordner, args, timeout = 60000) => new Promise((ok, fehler) =>
  execFile('git', args, { cwd: ordner, timeout, windowsHide: true }, (err, out, errOut) => err ? fehler(new Error((errOut || err.message).trim().split('\n').pop())) : ok(out.trim())));

function istProjekt(p) {
  try { return fs.readFileSync(path.join(p, 'project.godot'), 'utf8').includes('HviK'); } catch { return false; }
}

function godotFinden(einst) {
  if (einst.godotExe && fs.existsSync(einst.godotExe)) return einst.godotExe;
  for (const ordner of ['C:\\Godot', path.join(os.homedir(), 'Godot'), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads')]) {
    try {
      const t = fs.readdirSync(ordner).filter(f => /^Godot_v4\.7.*win64\.exe$/i.test(f) && !/console/i.test(f)).sort().reverse();
      if (t[0]) return path.join(ordner, t[0]);
    } catch { /* gibt es nicht */ }
  }
  return '';
}

function projektFinden(einst) {
  if (einst.spielOrdner && istProjekt(einst.spielOrdner)) return einst.spielOrdner;
  for (const p of [path.join(os.homedir(), 'Documents', 'HviK-Welt'), path.join(os.homedir(), 'Desktop', 'HviK-Welt'), path.join(os.homedir(), 'HviK-Welt'),
                   path.join(os.homedir(), 'Documents', 'GitHub', 'HviK-Welt'), path.join(os.homedir(), 'source', 'repos', 'HviK-Welt')])
    if (istProjekt(p)) return p;
  return '';
}

async function gitStand(ordner) {
  const version = await git(ordner, ['log', '-1', '--format=%h · %cd', '--date=format:%d.%m. %H:%M']).catch(() => '?');
  if (Date.now() - fetchZeit > 60000 || !fetchStand) {
    fetchZeit = Date.now();
    try {
      await git(ordner, ['fetch', '-q'], 30000);
      const hinter = parseInt(await git(ordner, ['rev-list', '--count', 'HEAD..@{u}']), 10) || 0;
      fetchStand = { hinter, neuste: await git(ordner, ['log', '-1', '--format=%h', '@{u}']).catch(() => ''), fehler: '' };
    } catch (err) { fetchStand = { hinter: 0, neuste: '', fehler: 'Update-Prüfung ging nicht: ' + err.message }; }
  }
  return { version, ...fetchStand };
}

async function statusProjekt(einst) {
  const godot = godotFinden(einst), ordner = projektFinden(einst);
  if (!godot || !ordner) return { modus: 'projekt', installiert: false, laeuft: laeuft(), ordner, fehler: !godot ? 'Godot 4.7 nicht gefunden' : 'HviK-Welt-Ordner nicht gefunden' };
  if (laden) return { modus: 'projekt', installiert: true, laedt: true, prozent: laden.prozent, text: laden.text, ordner };
  const s = await gitStand(ordner);
  return { modus: 'projekt', installiert: true, laeuft: laeuft(), ordner, version: s.version, update: s.hinter > 0, neuste: s.neuste + (s.hinter ? ` (+${s.hinter})` : ''), fehler: s.fehler };
}

async function einrichtenProjekt(einst, { waehleOrdner, waehleDatei, speichern }) {
  let godot = godotFinden(einst), ordner = projektFinden(einst);
  if (!godot) {
    godot = await waehleDatei('Godot 4.7 wählen (Godot_v4.7.2-stable_win64.exe)');
    if (!godot) return { ok: false };
    speichern({ godotExe: godot });
  }
  if (!ordner) {
    ordner = await waehleOrdner('Ordner „HviK-Welt“ wählen (das Godot-Projekt aus GitHub)');
    if (!ordner) return { ok: false };
    if (!istProjekt(ordner)) return { ok: false, message: 'Das ist nicht der HviK-Welt-Ordner (project.godot fehlt).' };
    speichern({ spielOrdner: ordner });
  }
  const s = await gitStand(ordner);
  if (s.hinter > 0) {
    laden = { prozent: 50, text: 'Hole den neuesten Stand …' };
    try { await git(ordner, ['pull', '-q', '--rebase', '--autostash'], 180000); }
    catch (err) { return { ok: false, message: 'Update ging nicht: ' + err.message }; }
    finally { laden = null; fetchZeit = 0; }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- nach außen
async function status(einst) {
  return modus(einst) === 'projekt' ? statusProjekt(einst) : statusVersion();
}

async function installieren(einst, hilfen) {
  if (modus(einst) === 'projekt') return einrichtenProjekt(einst, hilfen);
  try { return await herunterladen(); } catch (err) { return { ok: false, message: err.message }; }
}

function starten(einst, name) {
  if (laeuft()) return { ok: false, message: 'Läuft schon.' };
  const extra = name ? ['--', '--name=' + String(name).slice(0, 40)] : [];
  if (modus(einst) === 'projekt') {
    const godot = godotFinden(einst), ordner = projektFinden(einst);
    if (!godot || !ordner) return { ok: false, message: 'Godot oder HviK-Welt-Ordner fehlt.' };
    kind = spawn(godot, ['--path', ordner, ...extra], { cwd: ordner, detached: true, stdio: 'ignore' });
  } else {
    const exe = path.join(ZIEL, EXE);
    if (!fs.existsSync(exe)) return { ok: false, message: 'Das Spiel ist noch nicht installiert.' };
    kind = spawn(exe, extra, { cwd: ZIEL, detached: true, stdio: 'ignore' });
  }
  kind.unref();
  return { ok: true };
}

module.exports = { status, installieren, starten, EXE };
