// index.js
// Hauptprozess: Config, Lavalink, Persistenz, Web API.
// Commands, Embeds und Message-Handling sind in message.js ausgelagert.

const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, REST, Routes } = require("discord.js");
const { LavalinkManager } = require("lavalink-client");

// Externe Module
const registerMessageHandlers = require("./message");
const { commands } = require("./commands");

// --------- ENV / KONFIG ---------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const WEB_PASSWORD = process.env.WEB_PASSWORD || "changeme";
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!";
const LAVALINK_HOST = process.env.LAVALINK_HOST || "lavalink";
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT || 2333);
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || "youshallnotpass";
const LAVALINK_ID = process.env.LAVALINK_ID || "main";
const WEB_PORT = Number(process.env.PORT || 8081);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(DATA_DIR, "guild-settings.json");

if (!DISCORD_TOKEN) console.warn("[WARN] DISCORD_TOKEN fehlt!");

// --------- LOGGING & PERSISTENCE ---------
const logBuffer = [];
const MAX_LOG_LINES = 500;
function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const guildSettings = new Map();
function ensureGuildSettings(gid) {
  const current = guildSettings.get(gid) || {};
  if (typeof current.volume !== "number") current.volume = 100;
  if (!Array.isArray(current.autoplaylist)) current.autoplaylist = [];
  if (typeof current.autoplayIndex !== "number") current.autoplayIndex = 0;
  guildSettings.set(gid, current);
  return current;
}

function loadGuildSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8") || "{}";
      const obj = JSON.parse(raw);
      for (const [gid, val] of Object.entries(obj)) guildSettings.set(gid, val);
      addLog(`[config] Settings geladen (${guildSettings.size})`);
    } else {
      addLog("[config] Keine gespeicherten Settings gefunden.");
    }
  } catch (e) {
    addLog("[config] Fehler beim Laden: " + (e && e.message));
  }
}
loadGuildSettings();

let saveTimeout = null;
function scheduleSaveGuildSettings() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const obj = Object.fromEntries(guildSettings);
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf8");
      addLog("[config] Settings gespeichert.");
    } catch (e) {
      addLog("[config] Fehler beim Speichern: " + (e && e.message));
    }
  }, 1000);
}

// --------- DISCORD CLIENT & LAVALINK ---------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

client.lavalink = new LavalinkManager({
  nodes: [{ authorization: LAVALINK_PASSWORD, host: LAVALINK_HOST, port: LAVALINK_PORT, id: LAVALINK_ID }],
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  client: { id: "0", username: "MusicBot" },
  playerOptions: { defaultSearchPlatform: "ytmsearch", volumeDecrementer: 0.75, clientBasedPositionUpdateInterval: 150 },
});

client.on("raw", (d) => client.lavalink.sendRawData(d));

// Lavalink lifecycle logging
let lavalinkReady = false;
client.lavalink.on("nodeConnect", (node) => { lavalinkReady = true; addLog(`[lavalink] Node connected: ${node.id}`); });
client.lavalink.on("nodeDisconnect", (node, reason) => { lavalinkReady = false; addLog(`[lavalink] Node disconnected: ${node?.id} reason=${reason}`); });
client.lavalink.on("nodeError", (node, err) => addLog(`[lavalink] Node error: ${node?.id} ${err?.message || err}`));

// --------- CORE: Player helpers (werden an message.js übergeben) ---------
async function getOrCreatePlayer(guild, voiceChannelId, textChannelId) {
  const player = await client.lavalink.createPlayer({ guildId: guild.id, voiceChannelId, textChannelId, selfDeaf: true, selfMute: false });
  if (!player.connected) await player.connect();
  return player;
}

function getGuildVolume(guildId) {
  const s = ensureGuildSettings(guildId);
  return typeof s.volume === "number" ? s.volume : 100;
}
function setGuildVolume(guildId, v) {
  const s = ensureGuildSettings(guildId);
  let val = Number(v);
  if (!Number.isFinite(val)) val = 100;
  val = Math.max(0, Math.min(150, val));
  s.volume = val;
  scheduleSaveGuildSettings();
  try { const p = client.lavalink.getPlayer(guildId); if (p) p.setVolume(val).catch(() => {}); } catch {}
  return val;
}
async function applyGuildVolume(guildId) {
  const p = client.lavalink.getPlayer(guildId);
  if (!p) return;
  try { await p.setVolume(getGuildVolume(guildId)); } catch {}
}

// Autoplay helpers
const runtimeState = new Map();
function ensureRuntime(gid) {
  let rt = runtimeState.get(gid);
  if (!rt) { rt = { current: null, autoplayPending: false, isAutoplayCurrent: false }; runtimeState.set(gid, rt); }
  return rt;
}
async function playAutoplayNext(guildId) {
  const s = ensureGuildSettings(guildId);
  if (!s.autoplaylist || !s.autoplaylist.length) return false;
  const url = s.autoplaylist[s.autoplayIndex % s.autoplaylist.length];
  s.autoplayIndex = (s.autoplayIndex + 1) % s.autoplaylist.length;
  scheduleSaveGuildSettings();
  const player = client.lavalink.getPlayer(guildId);
  if (!player) return false;
  const res = await player.search({ query: url }, client.user);
  if (!res?.tracks?.length) return false;
  await player.queue.add(res.tracks[0]);
  const rt = ensureRuntime(guildId);
  rt.autoplayPending = true;
  if (!player.playing && !player.paused) await player.play();
  return true;
}
async function interruptAutoplayForUser(guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (!player) return;
  const rt = ensureRuntime(guildId);
  if (rt.isAutoplayCurrent) { try { await player.stop(); } catch {} }
}

// Voice resolution
async function resolveVoiceChannelId(guild, member) {
  try { if (member && member.voice && member.voice.channelId) return member.voice.channelId; } catch (e) {}
  const s = ensureGuildSettings(guild.id);
  if (s.voiceChannelId) return s.voiceChannelId;
  const first = guild.channels.cache.find(c => c.type === 2 || c.type === 13);
  if (first) return first.id;
  return null;
}

// Core control handlers
async function handlePlay(guild, userMember, query, textChannelId = null) {
  const voiceChannelId = await resolveVoiceChannelId(guild, userMember);
  if (!voiceChannelId) throw new Error("Kein Voice-Channel verfügbar. Bitte trete einem Voice-Channel bei oder setze einen Standard mit /setvoice.");
  const player = await getOrCreatePlayer(guild, voiceChannelId, textChannelId);
  const res = await player.search({ query }, userMember || client.user);
  if (!res?.tracks?.length) throw new Error("Keine Treffer gefunden.");
  await player.queue.add(res.tracks[0]);
  await interruptAutoplayForUser(guild.id);
  if (!player.playing) await player.play();
  return res.tracks[0];
}
async function handleSkip(guildId) {
  const p = client.lavalink.getPlayer(guildId);
  if (!p) throw new Error("Kein Player für diesen Server.");
  if (!p.queue.current) throw new Error("Kein Track läuft.");
  await p.skip();
}
async function handleStop(guildId) {
  const p = client.lavalink.getPlayer(guildId);
  if (!p) throw new Error("Kein Player für diesen Server.");
  await p.queue.clear();
  await p.stop();
}
async function handleLeave(guildId) {
  const p = client.lavalink.getPlayer(guildId);
  if (p) { await p.destroy(); client.lavalink.deletePlayer(guildId); }
}

// --------- Player message tracking (wird an message.js übergeben) ---------
const playerMessages = new Map();

// --------- Lavalink events: trackStart / queueEnd (logging + volume) ---------
client.lavalink.on("trackStart", async (player, track) => {
  const rt = ensureRuntime(player.guildId);
  rt.current = { title: track.info?.title, uri: track.info?.uri };
  rt.isAutoplayCurrent = !!rt.autoplayPending;
  rt.autoplayPending = false;
  addLog(`[player ${player.guildId}] Start: ${track.info.title}`);
  await applyGuildVolume(player.guildId);
});

client.lavalink.on("queueEnd", async (player) => {
  addLog(`[player ${player.guildId}] Queue leer`);
  const s = ensureGuildSettings(player.guildId);
  if (s.autoplaylist && s.autoplaylist.length) {
    try { await playAutoplayNext(player.guildId); } catch (e) { addLog("[autoplay] " + (e && e.message)); }
  }
  if (playerMessages.has(player.guildId)) {
    try { await playerMessages.get(player.guildId).edit({ content: "✅ **Queue beendet.**", embeds: [], components: [] }); } catch {}
    playerMessages.delete(player.guildId);
  }
});

// --------- WEB SERVER (Status, NP, Autoplay, Logs) ---------
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function auth(req, res, next) {
  if (req.headers["x-api-key"] !== WEB_PASSWORD) return res.status(401).json({ error: "No Auth" });
  next();
}

app.get("/api/status", auth, async (req, res) => {
  try {
    if (client.guilds.cache.size === 0) await client.guilds.fetch();
    const mem = process.memoryUsage().rss;
    const sys = {
      ramUsed: (mem / 1024 / 1024).toFixed(2) + " MB",
      cpuLoad: (os.loadavg && os.loadavg()[0] ? (os.loadavg()[0]).toFixed(2) : "n/a"),
      uptime: (process.uptime() / 3600).toFixed(2) + " h",
    };
    res.json({ botOnline: !!client.user, botTag: client.user ? client.user.tag : null, lavalinkReady, system: sys, guilds: client.guilds.cache.map(g => ({ id: g.id, name: g.name })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/np", auth, async (req, res) => {
  try {
    const gid = req.query.guildId;
    if (!gid) return res.status(400).json({ error: "missing_guildId" });
    const p = client.lavalink.getPlayer(gid);
    if (!p || !p.queue.current) return res.json({ playing: false });
    const pos = Number(p.position ?? p.state?.position ?? p.state?.playbackDuration ?? 0) || 0;
    const dur = Number(p.queue.current.info?.length ?? p.queue.current.info?.duration ?? 0) || 0;
    res.json({
      playing: true,
      title: p.queue.current.info?.title ?? null,
      author: p.queue.current.info?.author ?? null,
      position: pos,
      duration: dur,
      paused: !!p.paused
    });
  } catch (e) {
    addLog("[api/np] error: " + (e && e.message));
    res.status(500).json({ error: e.message || "unknown" });
  }
});


// Autoplay endpoints
app.get("/api/autoplay/:gid", auth, (req, res) => res.json({ list: ensureGuildSettings(req.params.gid).autoplaylist }));
app.post("/api/autoplay/:gid/add", auth, (req, res) => { const s = ensureGuildSettings(req.params.gid); if (req.body.url) s.autoplaylist.push(req.body.url); scheduleSaveGuildSettings(); res.json({ list: s.autoplaylist }); });
app.post("/api/autoplay/:gid/clear", auth, (req, res) => { const s = ensureGuildSettings(req.params.gid); s.autoplaylist = []; scheduleSaveGuildSettings(); res.json({ list: [] }); });

// Logs endpoint
app.get("/api/logs", auth, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const start = Math.max(0, logBuffer.length - limit);
    const slice = logBuffer.slice(start);
    res.json({ lines: slice, total: logBuffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message || "unknown" });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.listen(WEB_PORT, () => addLog(`Webinterface auf Port ${WEB_PORT}`));

// --------- STARTUP: login, lavalink init, register message handlers ---------
async function registerSlashCommandsGlobal() {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    addLog("[discord] Slash-Commands registriert (global).");
  } catch (e) {
    addLog("[discord] Slash-Register Fehler: " + (e && e.message));
  }
}

client.once("ready", async () => {
  addLog(`[discord] Eingeloggt als ${client.user.tag}`);
  try {
    await client.lavalink.init({ id: client.user.id, username: client.user.username });
    addLog("[lavalink] init aufgerufen");
  } catch (e) {
    addLog("[lavalink] init fehlgeschlagen: " + (e && e.message));
  }

  try { await registerSlashCommandsGlobal(); } catch (e) {}

  // Registriere message/interaction handler (komplette Logik in message.js)
  registerMessageHandlers({
    client,
    COMMAND_PREFIX,
    DISCORD_TOKEN,
    handlePlay,
    handleSkip,
    handleStop,
    handleLeave,
    ensureGuildSettings,
    scheduleSaveGuildSettings,
    setGuildVolume,
    playerMessages
  });

  addLog("[startup] Message handlers registriert (message.js).");
});

// Login
client.login(DISCORD_TOKEN).catch(err => { console.error("Login-Fehler:", err); addLog("Fehler beim Einloggen des Discord-Bots."); });

// --------- Graceful shutdown ---------
process.on("SIGTERM", async () => { addLog("SIGTERM empfangen"); try { await client.destroy(); } catch {} process.exit(0); });
process.on("SIGINT", async () => { addLog("SIGINT empfangen"); try { await client.destroy(); } catch {} process.exit(0); });
process.on("uncaughtException", err => { console.error("Uncaught Exception:", err); process.exit(1); });

// --------- Export core handlers (falls externe Module sie benötigen) ---------
module.exports = {
  handlePlay,
  handleSkip,
  handleStop,
  handleLeave,
  ensureGuildSettings,
  scheduleSaveGuildSettings,
  setGuildVolume
};
