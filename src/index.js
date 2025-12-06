// index.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const { LavalinkManager } = require("lavalink-client");

// --------- CONFIG / ENV ---------
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
function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
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
      const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8") || "{}");
      for (const [gid, val] of Object.entries(obj)) guildSettings.set(gid, val);
      addLog(`[config] Settings geladen (${guildSettings.size})`);
    } else addLog("[config] Keine gespeicherten Settings gefunden.");
  } catch (e) { addLog("[config] Fehler beim Laden: " + (e && e.message)); }
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
    } catch (e) { addLog("[config] Fehler beim Speichern: " + (e && e.message)); }
  }, 1000);
}

// --------- DISCORD + LAVALINK SETUP ---------
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

client.on("raw", d => client.lavalink.sendRawData(d));

// Lavalink events
let lavalinkReady = false;
client.lavalink.on('nodeConnect', node => { lavalinkReady = true; addLog(`[lavalink] Node connected: ${node.id}`); });
client.lavalink.on('nodeDisconnect', (node, reason) => { lavalinkReady = false; addLog(`[lavalink] Node disconnected: ${node?.id} reason=${reason}`); });
client.lavalink.on('nodeError', (node, err) => addLog(`[lavalink] Node error: ${node?.id} ${err?.message || err}`));

// --------- HELP EMBED ---------
function createHelpEmbed() {
  return new EmbedBuilder()
    .setTitle("🎵 Musikbot – Hilfe")
    .setDescription("Übersicht über die wichtigsten Befehle.")
    .addFields(
      { name: "Slash", value: "`/play <query>`, `/np`, `/skip`, `/stop`, `/leave`, `/setvoice`, `/settext`, `/volume`, `/autoplay`" },
      { name: "Prefix", value: `\`${COMMAND_PREFIX}play\`, \`${COMMAND_PREFIX}np\`, \`${COMMAND_PREFIX}skip\`, \`${COMMAND_PREFIX}stop\`, \`${COMMAND_PREFIX}help\`` }
    ).setColor(0x5865f2);
}

// --------- HELPERS: Player, Volume, Autoplay ---------
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
  return val;
}
async function applyGuildVolume(guildId) {
  const p = client.lavalink.getPlayer(guildId);
  if (!p) return;
  try { await p.setVolume(getGuildVolume(guildId)); } catch {}
}

// Autoplay helpers (kept minimal)
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

// --------- Voice channel resolution (kein Zwang mehr) ---------
async function resolveVoiceChannelId(guild, member) {
  // 1) Member voice
  try {
    if (member && member.voice && member.voice.channelId) return member.voice.channelId;
  } catch (e) {}
  // 2) Saved setting
  const s = ensureGuildSettings(guild.id);
  if (s.voiceChannelId) return s.voiceChannelId;
  // 3) Fallback: first available voice channel in guild cache
  const first = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice);
  if (first) return first.id;
  return null;
}

// --------- Play / Control handlers (angepasst) ---------
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

// --------- Now Playing helpers ---------
function formatMs(ms) {
  if (!ms) return "0:00";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 1000 / 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function createNowPlayingEmbed(track, player, status = "Spielt gerade") {
  const slider = "▬".repeat(15).split("");
  if (track.info.length > 0) {
    const pct = Math.min(player.position / track.info.length, 1);
    const idx = Math.floor(pct * 15);
    if (idx >= 0 && idx < 15) slider[idx] = "🔘";
  }
  return new EmbedBuilder()
    .setColor(0xff0033)
    .setTitle("🎶 " + status)
    .setDescription(`**[${track.info.title}](${track.info.uri})**\nby ${track.info.author}`)
    .addFields(
      { name: "Zeit", value: `\`${formatMs(player.position)} / ${formatMs(track.info.length)}\``, inline: true },
      { name: "Volume", value: `\`${player.volume}%\``, inline: true },
      { name: "Fortschritt", value: slider.join(""), inline: false }
    )
    .setThumbnail(track.info.artworkUrl || null)
    .setFooter({ text: "Nightwolf Entertainments", iconURL: client.user?.displayAvatarURL() });
}

// --------- Live update loop (embeds) ---------
const playerMessages = new Map();
setInterval(() => {
  for (const [guildId, message] of playerMessages.entries()) {
    try {
      const player = client.lavalink.getPlayer(guildId);
      if (!player || !player.queue.current) continue;
      const embed = createNowPlayingEmbed(player.queue.current, player, player.paused ? "Pausiert" : "Spielt gerade");
      message.edit({ embeds: [embed], components: [createButtons(player.paused)] }).catch(err => {
        if (err && err.code === 10008) playerMessages.delete(guildId);
      });
    } catch (e) {}
  }
}, 5000);

function createButtons(paused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pause").setLabel(paused ? "▶️ Weiter" : "⏸️ Pause").setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("skip").setLabel("⏭️ Skip").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("stop").setLabel("⏹️ Stop").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("list").setLabel("📜 Queue").setStyle(ButtonStyle.Secondary)
  );
}

// --------- Events: trackStart / queueEnd ---------
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

// --------- Interaction & Message Handling (Slash + Prefix) ---------
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton && interaction.isButton()) {
      // button handling (same as before)
      const player = client.lavalink.getPlayer(interaction.guildId);
      if (!player) return interaction.reply({ content: "Kein Player.", ephemeral: true });
      if (interaction.member.voice.channelId !== player.voiceChannelId) return interaction.reply({ content: "Falscher Channel!", ephemeral: true });
      if (interaction.customId === "pause") {
        const newState = !player.paused; await player.pause(newState); await interaction.update({ components: [createButtons(newState)] });
      } else if (interaction.customId === "skip") { await player.skip(); await interaction.reply({ content: "Skipped.", ephemeral: true }); }
      else if (interaction.customId === "stop") { await player.stop(); player.queue.clear(); await interaction.update({ content: "Stopped.", components: [] }); }
      else if (interaction.customId === "list") { const q = player.queue.tracks.map((t,i)=>`${i+1}. ${t.info.title}`).join("\n").substr(0,1000)||"Leer"; await interaction.reply({ content: `**Queue:**\n${q}`, ephemeral: true }); }
      return;
    }

    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      if (cmd === "play") {
        await interaction.deferReply();
        const query = interaction.options.getString("query");
        const guild = interaction.guild;
        const member = interaction.member;
        try {
          const track = await handlePlay(guild, member, query, interaction.channelId);
          await interaction.editReply(`✅ **${track.info.title}** wurde zur Queue hinzugefügt.`);
        } catch (e) { await interaction.editReply("Fehler: " + (e && e.message)); }
      } else if (cmd === "np") {
        const p = client.lavalink.getPlayer(interaction.guildId);
        if (!p || !p.queue.current) return interaction.reply("Stille.");
        const embed = createNowPlayingEmbed(p.queue.current, p, p.paused ? "Pausiert" : "Spielt gerade");
        const msg = await interaction.reply({ embeds: [embed], components: [createButtons(p.paused)], fetchReply: true });
        playerMessages.set(interaction.guildId, msg);
      } else if (cmd === "skip") {
        try { await handleSkip(interaction.guildId); await interaction.reply("⏭️ Übersprungen."); } catch (e) { await interaction.reply("Fehler: " + (e && e.message)); }
      } else if (cmd === "stop") {
        try { await handleStop(interaction.guildId); await interaction.reply("⏹️ Gestoppt."); } catch (e) { await interaction.reply("Fehler: " + (e && e.message)); }
      } else if (cmd === "leave") {
        try { await handleLeave(interaction.guildId); await interaction.reply("👋 Voice verlassen."); } catch (e) { await interaction.reply("Fehler: " + (e && e.message)); }
      } else if (cmd === "setvoice") {
        const ch = interaction.options.getChannel("channel") || interaction.member.voice.channel;
        if (!ch) return interaction.reply({ content: "Kein Channel angegeben und du bist nicht in einem Voice-Channel.", ephemeral: true });
        const s = ensureGuildSettings(interaction.guildId); s.voiceChannelId = ch.id; scheduleSaveGuildSettings();
        await interaction.reply(`🎧 Standard-Voice-Channel gesetzt auf **${ch.name || ch.id}**`);
      } else if (cmd === "settext") {
        const ch = interaction.options.getChannel("channel") || interaction.channel;
        const s = ensureGuildSettings(interaction.guildId); s.textChannelId = ch.id; scheduleSaveGuildSettings();
        await interaction.reply(`💬 Steuer-Textkanal gesetzt auf **${ch.name || ch.id}**`);
      } else if (cmd === "volume") {
        const val = interaction.options.getInteger("value");
        const newv = setGuildVolume(interaction.guildId, val);
        await interaction.reply(`🔊 Lautstärke gesetzt auf ${newv}%`);
      } else if (cmd === "autoplay") {
        const sub = interaction.options.getSubcommand(false);
        const s = ensureGuildSettings(interaction.guildId);
        if (sub === "add") { const url = interaction.options.getString("url"); s.autoplaylist.push(url); scheduleSaveGuildSettings(); await interaction.reply("✅ hinzugefügt"); }
        else if (sub === "remove") { const idx = interaction.options.getInteger("index"); if (Number.isFinite(idx) && idx>=1 && idx<=s.autoplaylist.length) { s.autoplaylist.splice(idx-1,1); scheduleSaveGuildSettings(); await interaction.reply("✅ entfernt"); } else await interaction.reply("Ungültiger Index"); }
        else if (sub === "list") await interaction.reply("Autoplay:\n" + (s.autoplaylist.map((u,i)=>`${i+1}. ${u}`).join("\n")||"leer"));
        else if (sub === "clear") { s.autoplaylist = []; scheduleSaveGuildSettings(); await interaction.reply("✅ geleert"); }
      } else if (cmd === "help") {
        await interaction.reply({ embeds: [createHelpEmbed()], ephemeral: true });
      }
    }
  } catch (err) {
    console.error("interaction error:", err);
    try { if (interaction.replied || interaction.deferred) await interaction.editReply("Fehler: " + (err && err.message)); else await interaction.reply("Fehler: " + (err && err.message)); } catch {}
  }
});

// Prefix message commands (kept simple)
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(COMMAND_PREFIX)) return;
  const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  try {
    if (cmd === "play" || cmd === "p") {
      const query = args.join(" ");
      if (!query) return message.reply("Bitte gib einen Suchbegriff oder Link an.");
      const track = await handlePlay(message.guild, message.member, query, message.channel.id);
      await message.reply(`▶️ **${track.info.title}** wurde zur Queue hinzugefügt.`);
    } else if (cmd === "np") {
      const p = client.lavalink.getPlayer(message.guild.id);
      if (!p || !p.queue.current) return message.reply("Stille.");
      const embed = createNowPlayingEmbed(p.queue.current, p, p.paused ? "Pausiert" : "Spielt gerade");
      const msg = await message.reply({ embeds: [embed], components: [createButtons(p.paused)] });
      playerMessages.set(message.guild.id, msg);
    } else if (cmd === "skip") { await handleSkip(message.guild.id); await message.reply("⏭️ Übersprungen."); }
    else if (cmd === "stop") { await handleStop(message.guild.id); await message.reply("⏹️ Gestoppt."); }
    else if (cmd === "leave") { await handleLeave(message.guild.id); await message.reply("👋 Voice verlassen."); }
    else if (cmd === "setvoice") {
      const vc = message.member.voice.channel;
      if (!vc) return message.reply("Bitte gehe zuerst in einen Voice-Channel oder nutze /setvoice <channel>.");
      const s = ensureGuildSettings(message.guild.id); s.voiceChannelId = vc.id; scheduleSaveGuildSettings();
      await message.reply(`🎧 Voice-Channel gesetzt auf **${vc.name}**.`);
    } else if (cmd === "settext") {
      const s = ensureGuildSettings(message.guild.id); s.textChannelId = message.channel.id; scheduleSaveGuildSettings();
      await message.reply(`💬 Steuer-Textkanal gesetzt auf **${message.channel.name}**.`);
    } else if (cmd === "help") { await message.reply({ embeds: [createHelpEmbed()] }); }
  } catch (err) {
    console.error(err);
    await message.reply("Fehler: " + (err && err.message));
  }
});

// --------- WEB SERVER (Status inkl. RAM/CPU/Uptime) ---------
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
      uptime: (process.uptime() / 3600).toFixed(2) + " h"
    };
    res.json({ botOnline: !!client.user, botTag: client.user ? client.user.tag : null, lavalinkReady, system: sys, guilds: client.guilds.cache.map(g => ({ id: g.id, name: g.name })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/np", auth, async (req, res) => {
  const gid = req.query.guildId;
  if (!gid) return res.status(400).json({ error: "missing_guildId" });
  const p = client.lavalink.getPlayer(gid);
  if (!p || !p.queue.current) return res.json({ playing: false });
  res.json({ playing: true, title: p.queue.current.info.title, author: p.queue.current.info.author, position: p.position, duration: p.queue.current.info.length, paused: p.paused });
});

// Autoplay endpoints (kept)
app.get("/api/autoplay/:gid", auth, (req, res) => res.json({ list: ensureGuildSettings(req.params.gid).autoplaylist }));
app.post("/api/autoplay/:gid/add", auth, (req, res) => { const s = ensureGuildSettings(req.params.gid); if (req.body.url) s.autoplaylist.push(req.body.url); scheduleSaveGuildSettings(); res.json({ list: s.autoplaylist }); });
app.post("/api/autoplay/:gid/clear", auth, (req, res) => { const s = ensureGuildSettings(req.params.gid); s.autoplaylist = []; scheduleSaveGuildSettings(); res.json({ list: [] }); });

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.listen(WEB_PORT, () => addLog(`Webinterface auf Port ${WEB_PORT}`));

// --------- START: login + lavalink init + slash registration ---------
async function registerSlashCommands() {
  try {
    const commands = [
      new SlashCommandBuilder().setName("play").setDescription("Play").addStringOption(o=>o.setName("query").setRequired(true).setDescription("Link or query")),
      new SlashCommandBuilder().setName("np").setDescription("Now Playing"),
      new SlashCommandBuilder().setName("skip").setDescription("Skip"),
      new SlashCommandBuilder().setName("stop").setDescription("Stop"),
      new SlashCommandBuilder().setName("leave").setDescription("Leave voice"),
      new SlashCommandBuilder().setName("setvoice").setDescription("Set default voice").addChannelOption(o=>o.setName("channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(false)),
      new SlashCommandBuilder().setName("settext").setDescription("Set text channel").addChannelOption(o=>o.setName("channel").addChannelTypes(ChannelType.GuildText).setRequired(false)),
      new SlashCommandBuilder().setName("volume").setDescription("Volume").addIntegerOption(o=>o.setName("value").setRequired(true)),
      new SlashCommandBuilder().setName("help").setDescription("Help"),
      new SlashCommandBuilder().setName("autoplay").setDescription("Autoplay")
        .addSubcommand(sc=>sc.setName("add").addStringOption(o=>o.setName("url").setRequired(true)))
        .addSubcommand(sc=>sc.setName("remove").addIntegerOption(o=>o.setName("index").setRequired(true)))
        .addSubcommand(sc=>sc.setName("list"))
        .addSubcommand(sc=>sc.setName("clear"))
    ].map(c=>c.toJSON());
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    addLog("[discord] Slash-Commands registriert.");
  } catch (e) { addLog("[discord] Slash-Register Fehler: " + (e && e.message)); }
}

client.once("ready", async () => {
  addLog(`[discord] Eingeloggt als ${client.user.tag}`);
  try {
    await client.lavalink.init({ id: client.user.id, username: client.user.username });
    addLog("[lavalink] init aufgerufen");
  } catch (e) { addLog("[lavalink] init fehlgeschlagen: " + (e && e.message)); }
  await registerSlashCommands();
});

client.login(DISCORD_TOKEN).catch(err => { console.error("Login-Fehler:", err); addLog("Fehler beim Einloggen des Discord-Bots."); });

// --------- Graceful shutdown ---------
process.on('SIGTERM', async () => { addLog('SIGTERM empfangen'); try { await client.destroy(); } catch {} process.exit(0); });
process.on('SIGINT', async () => { addLog('SIGINT empfangen'); try { await client.destroy(); } catch {} process.exit(0); });
process.on('uncaughtException', err => { console.error('Uncaught Exception:', err); process.exit(1); });
