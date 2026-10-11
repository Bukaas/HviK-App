// Discord-Status (Rich Presence): solange ein Spiel über ▶ Spielen läuft, steht es im Discord-Profil - mit Knopf zur Homepage.
const { Client } = require('@xhayper/discord-rpc');

let client = null, ready = false, clientId = null, logo = 'https://hvik.org/static/logo.png';
let wanted = null;          // was angezeigt werden soll (oder null = nichts)
let retryTimer = null;

async function connect() {
  if (!clientId || client) return;
  client = new Client({ clientId, transport: { type: 'ipc' } });
  client.on('ready', () => { ready = true; apply(); });
  client.on('disconnected', () => { ready = false; client = null; schedule(); });
  try {
    await client.login();
  } catch {  // Discord läuft nicht -> später nochmal
    ready = false;
    client = null;
    schedule();
  }
}
function schedule() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 60 * 1000);
}

async function apply() {
  if (!ready || !client || !client.user) return;
  try {
    if (!wanted) { await client.user.clearActivity(); return; }
    await client.user.setActivity({
      details: wanted.details.slice(0, 120),
      state: (wanted.state || 'HviK Community').slice(0, 120),
      startTimestamp: wanted.since,
      largeImageKey: logo,
      largeImageText: 'HviK Community – Headshot voll ins Knie',
      buttons: [{ label: 'Zur HviK Community', url: 'https://hvik.org' }],
    });
  } catch { /* Discord gerade weg - beim nächsten Verbinden */ }
}

/** Einmal beim Start: Client-ID von hvik.org */
function start(cfg) {
  clientId = cfg && cfg.discord_client_id;
  if (cfg && cfg.logo) logo = cfg.logo;
  connect();
}

/** running = {label, icon, title, at} oder null; enabled = Einstellung "Discord-Status" */
function update(running, enabled) {
  wanted = running && enabled ? { details: `${running.icon || '🎮'} ${running.label}`, state: running.title || 'HviK Community', since: running.at } : null;
  if (!client) connect(); else apply();
}

module.exports = { start, update };
