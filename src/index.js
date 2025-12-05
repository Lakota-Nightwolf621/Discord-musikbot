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

// --------- ENV ---------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const WEB_PASSWORD = process.env.WEB_PASSWORD || "changeme";
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!";
const LAVALINK_HOST = process.env.LAVALINK_HOST || "lavalink";
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT || 2333);
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || "youshallnotpass";
const LAVALINK_ID = process.env.LAVALINK_ID || "main";
const WEB_PORT = Number(process.env.PORT || 8080);

if (!DISCORD_TOKEN) console.warn("[WARN] DISCORD_TOKEN fehlt!");

// --------- LOGGING ---------
const logBuffer = [];
const MAX_LOG_LINES = 500;
function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

// --------- SYSTEM STATS (Container/Bot specific) ---------
function getSystemStats() {
  // RAM nur vom Bot-Prozess (RSS = Resident Set Size)
  const usedMem = process.memoryUsage().rss;
  const totalSystemMem = os.totalmem();
  
  const load = os.loadavg()[0]; // CPU Load
  return {
    ramUsed: (usedMem / 1024 / 1024).toFixed(2) + " MB",
    ramPercent: Math.round((usedMem / totalSystemMem) * 100), // Anteil am Gesamtsystem
    cpuLoad: load.toFixed(2) + "%",
    uptime: (process.uptime() / 3600).toFixed(2) + " h" // Uptime des Bots, nicht des Servers
  };
}

// --------- GUILD SETTINGS PERSISTENZ ---------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(DATA_DIR, "guild-settings.json");
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
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    if (!raw) return;
    const obj = JSON.parse(raw);
    for (const [gid, val] of Object.entries(obj)) {
      guildSettings.set(gid, {
        textChannelId: val.textChannelId || null,
        voiceChannelId: val.voiceChannelId || null, // Wieder da für Web-Settings
        volume: val.volume || 100,
        autoplaylist: val.autoplaylist || [],
        autoplayIndex: val.autoplayIndex || 0,
      });
    }
    addLog(`[config] ${guildSettings.size} Server-Settings geladen.`);
  } catch (err) { addLog("[config] Fehler: " + err.message); }
}

let saveTimeout = null;
function scheduleSaveGuildSettings() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const obj = Object.fromEntries(guildSettings);
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) { console.error(err); }
  }, 1000);
}
loadGuildSettings();

// --------- DISCORD CLIENT ---------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

let lavalinkReady = false;

client.lavalink = new LavalinkManager({
  nodes: [{
    authorization: LAVALINK_PASSWORD,
    host: LAVALINK_HOST,
    port: LAVALINK_PORT,
    id: LAVALINK_ID,
  }],
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  client: { id: "0", username: "NightwolfBot" },
  playerOptions: {
    defaultSearchPlatform: "ytmsearch",
    volumeDecrementer: 0.75,
    clientBasedPositionUpdateInterval: 150,
  },
});

client.on("raw", (d) => client.lavalink.sendRawData(d));

// --------- HELPER: PLAYER & EMBEDS ---------
async function getPlayer(guild, voiceChannelId, textChannelId) {
  const player = client.lavalink.createPlayer({
    guildId: guild.id,
    voiceChannelId,
    textChannelId,
    selfDeaf: true
  });
  if (!player.connected) await player.connect();
  return player;
}

function createNowPlayingEmbed(track, player, status = "Spielt gerade") {
  const slider = "▬".repeat(10).split("");
  if (track.info.length && track.info.length > 0) {
     const pct = Math.min(player.position / track.info.length, 1);
     const idx = Math.floor(pct * 10);
     if (idx >= 0 && idx < 10) slider[idx] = "🔘";
  }
  const bar = slider.join("");

  return new EmbedBuilder()
    .setColor(0xff0055)
    .setTitle("🎶 " + status)
    .setDescription(`**[${track.info.title}](${track.info.uri})**\nby ${track.info.author}`)
    .addFields(
      { name: "Dauer", value: `\`${formatMs(player.position)} / ${formatMs(track.info.length)}\``, inline: true },
      { name: "Volume", value: `${player.volume}%`, inline: true },
      { name: "Progress", value: bar, inline: false }
    )
    .setThumbnail(track.info.artworkUrl || track.info.thumbnail || null)
    .setFooter({ text: "Nightwolf Entertainments", iconURL: client.user?.displayAvatarURL() });
}

function createPlayerButtons(paused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pause").setLabel(paused ? "▶️ Resume" : "⏸️ Pause").setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("skip").setLabel("⏭️ Skip").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("stop").setLabel("⏹️ Stop").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("list").setLabel("📜 Queue").setStyle(ButtonStyle.Secondary)
  );
}

const playerMessages = new Map();

// --------- LAVALINK EVENTS ---------
client.lavalink.on("nodeConnect", (node) => {
  lavalinkReady = true;
  addLog(`[lavalink] Node verbunden: ${node.id}`);
});

client.lavalink.on("trackStart", async (player, track) => {
  addLog(`[player ${player.guildId}] Start: ${track.info.title}`);
  
  const s = ensureGuildSettings(player.guildId);
  if(player.volume !== s.volume) await player.setVolume(s.volume);

  // Embed senden
  const channel = client.channels.cache.get(player.textChannelId);
  if (channel) {
    if (playerMessages.has(player.guildId)) {
      try { await playerMessages.get(player.guildId).delete(); } catch {}
    }
    try {
      const msg = await channel.send({ 
        embeds: [createNowPlayingEmbed(track, player)], 
        components: [createPlayerButtons(false)] 
      });
      playerMessages.set(player.guildId, msg);
    } catch (e) { console.error("Embed Error", e); }
  }
});

client.lavalink.on("queueEnd", async (player) => {
  addLog(`[player ${player.guildId}] Queue leer.`);
  const s = ensureGuildSettings(player.guildId);
  
  // Autoplay Logic
  if (s.autoplaylist && s.autoplaylist.length > 0) {
    const url = s.autoplaylist[s.autoplayIndex % s.autoplaylist.length];
    s.autoplayIndex = (s.autoplayIndex + 1) % s.autoplaylist.length;
    scheduleSaveGuildSettings();

    addLog(`[autoplay] Spiele: ${url}`);
    const res = await player.search({ query: url }, client.user);
    if (res.tracks.length) {
      await player.queue.add(res.tracks[0]);
      await player.play();
      return;
    }
  }

  if (playerMessages.has(player.guildId)) {
    try { 
      const msg = playerMessages.get(player.guildId);
      await msg.edit({ content: "✅ **Queue beendet.**", embeds: [], components: [] }); 
    } catch {}
    playerMessages.delete(player.guildId);
  }
});

// --------- DISCORD READY ---------
client.once("ready", async () => {
  addLog(`[discord] Eingeloggt als ${client.user.tag}`);
  await client.lavalink.init({ id: client.user.id, username: client.user.username });
  await registerSlashCommands();
});

// --------- PREFIX COMMANDS (WIEDER DA!) ---------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(COMMAND_PREFIX)) return;

  const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  // Helper für Prefix
  const getPrefixPlayer = async () => {
    const { channel } = message.member.voice;
    if (!channel) return null;
    return getPlayer(message.guild, channel.id, message.channel.id);
  };

  try {
    if (cmd === "play" || cmd === "p") {
      const query = args.join(" ");
      if (!query) return message.reply("Bitte Link/Suche angeben.");
      
      const player = await getPrefixPlayer();
      if(!player) return message.reply("Du musst im Voice sein.");

      const res = await player.search({ query }, message.author);
      if (!res.tracks.length) return message.reply("Nichts gefunden.");

      const track = res.tracks[0];
      await player.queue.add(track);
      if (!player.playing) await player.play();
      await message.reply(`✅ **${track.info.title}** hinzugefügt.`);
    }

    else if (cmd === "skip" || cmd === "s") {
      const player = client.lavalink.getPlayer(message.guild.id);
      if (player) { await player.skip(); message.react("⏭️"); }
    }

    else if (cmd === "stop") {
      const player = client.lavalink.getPlayer(message.guild.id);
      if (player) { await player.stop(); player.queue.clear(); message.react("⏹️"); }
    }
    
    else if (cmd === "leave") {
       const player = client.lavalink.getPlayer(message.guild.id);
       if(player) await player.destroy();
       message.react("👋");
    }

    else if (cmd === "help") {
      message.reply(`Befehle: ${COMMAND_PREFIX}play, ${COMMAND_PREFIX}skip, ${COMMAND_PREFIX}stop, ${COMMAND_PREFIX}leave`);
    }
  } catch (e) {
    console.error(e);
    message.reply("Fehler: " + e.message);
  }
});

// --------- SLASH & BUTTONS ---------
client.on("interactionCreate", async (interaction) => {
  // Buttons (Embed)
  if (interaction.isButton()) {
    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: "Kein Player.", ephemeral: true });
    
    // Check Voice
    if(interaction.member.voice.channelId !== player.voiceChannelId) 
       return interaction.reply({content:"Falscher Channel!", ephemeral:true});

    if (interaction.customId === "pause") {
      await player.pause(!player.paused);
      await interaction.update({ components: [createPlayerButtons(player.paused)] });
    } else if (interaction.customId === "skip") {
      await player.skip();
      await interaction.reply({ content: "Skipped.", ephemeral: true });
    } else if (interaction.customId === "stop") {
      await player.stop(); player.queue.clear();
      await interaction.update({ content: "Stopped.", components: [] });
    } else if (interaction.customId === "list") {
      const q = player.queue.tracks.map((t,i)=>`${i+1}. ${t.info.title}`).join("\n").substr(0,1000)||"Leer";
      await interaction.reply({ content: `**Queue:**\n${q}`, ephemeral: true });
    }
  }

  // Slash Commands
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;
    try {
      if (cmd === "play") {
        await interaction.deferReply();
        const query = interaction.options.getString("query");
        const { channel } = interaction.member.voice;
        if(!channel) return interaction.editReply("Kein Voice Channel!");
        
        const player = await getPlayer(interaction.guild, channel.id, interaction.channelId);
        const res = await player.search({ query }, interaction.user);
        
        if (!res.tracks.length) return interaction.editReply("Nichts gefunden.");
        await player.queue.add(res.tracks[0]);
        if (!player.playing) await player.play();
        await interaction.editReply(`✅ **${res.tracks[0].info.title}** geladen.`);
      }
      // ... (Restliche Slash Commands analog zu oben, Play war das wichtigste)
      else if (cmd === "stop") {
         const p = client.lavalink.getPlayer(interaction.guildId);
         if(p) { await p.stop(); p.queue.clear(); }
         interaction.reply("Gestoppt.");
      }
      else if (cmd === "skip") {
         const p = client.lavalink.getPlayer(interaction.guildId);
         if(p) await p.skip();
         interaction.reply("Skipped.");
      }
    } catch (e) { interaction.editReply("Fehler: " + e.message); }
  }
});

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder().setName("play").setDescription("Spielen").addStringOption(o=>o.setName("query").setRequired(true).setDescription("Link/Suche")),
    new SlashCommandBuilder().setName("stop").setDescription("Stopp"),
    new SlashCommandBuilder().setName("skip").setDescription("Skip"),
    new SlashCommandBuilder().setName("leave").setDescription("Leave"),
  ].map(c=>c.toJSON());
  
  const rest = new REST({version:"10"}).setToken(DISCORD_TOKEN);
  try { await rest.put(Routes.applicationCommands(client.user.id), { body: commands }); addLog("[discord] Slash CMDs updated."); }
  catch(e){console.error(e);}
}


// --------- WEB SERVER (API) ---------
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Auth Middleware
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== WEB_PASSWORD) return res.status(401).json({ error: "No Auth" });
  next();
}

// 1. Status & Stats
app.get("/api/status", auth, (req, res) => {
  res.json({
    botOnline: !!client.user,
    lavalinkReady,
    system: getSystemStats(),
    // Liste aller Server für das Dropdown
    guilds: client.guilds.cache.map(g => ({ id: g.id, name: g.name }))
  });
});

// 2. Server Details (Channel Liste)
app.get("/api/guilds/:id/details", auth, async (req, res) => {
  const g = client.guilds.cache.get(req.params.id);
  if(!g) return res.status(404).json({error:"Server nicht gefunden"});
  
  const channels = g.channels.cache
    .filter(c => c.type === ChannelType.GuildVoice)
    .map(c => ({ id: c.id, name: c.name }));
  
  const s = guildSettings.get(g.id) || {};
  res.json({ name: g.name, voiceChannels: channels, settings: s });
});

// 3. Settings Speichern
app.post("/api/guilds/:id/settings", auth, (req, res) => {
  const s = ensureGuildSettings(req.params.id);
  if(req.body.voiceChannelId) s.voiceChannelId = req.body.voiceChannelId;
  scheduleSaveGuildSettings();
  res.json({ok:true});
});

// 4. Play via Web
app.post("/api/guilds/:id/play", auth, async (req, res) => {
  const gid = req.params.id;
  const { query } = req.body;
  const s = ensureGuildSettings(gid);
  
  // Wenn kein Channel gesetzt, nimm den ersten verfügbaren oder Fehler
  let vc = s.voiceChannelId;
  if(!vc) {
     const g = client.guilds.cache.get(gid);
     // Auto-Pick first voice
     const first = g.channels.cache.find(c => c.type === ChannelType.GuildVoice);
     if(first) vc = first.id;
     else return res.status(400).json({error: "Kein VoiceChannel gefunden/eingestellt"});
  }

  try {
    const guild = client.guilds.cache.get(gid);
    const player = await getPlayer(guild, vc, null);
    const result = await player.search({ query }, { id: "0", username: "WebUI" });
    if(!result.tracks.length) return res.status(404).json({error:"Nichts gefunden"});
    
    await player.queue.add(result.tracks[0]);
    if(!player.playing) await player.play();
    res.json({ok:true, track: result.tracks[0].info.title});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// 5. Player Control Web
app.post("/api/guilds/:id/:action", auth, async (req, res) => {
   const player = client.lavalink.getPlayer(req.params.id);
   if(!player) return res.status(400).json({error:"Kein Player"});
   
   if(req.params.action === "skip") await player.skip();
   if(req.params.action === "stop") { await player.stop(); player.queue.clear(); }
   res.json({ok:true});
});

// 6. Now Playing API
app.get("/api/np", (req, res) => {
  const gid = req.query.guildId;
  const player = client.lavalink.getPlayer(gid);
  if (!player || !player.queue.current) return res.json({ playing: false });

  res.json({
    playing: true,
    title: player.queue.current.info.title,
    author: player.queue.current.info.author,
    position: player.position,
    duration: player.queue.current.info.length,
    volume: player.volume
  });
});

app.get("/api/logs", auth, (req, res) => res.json({ lines: logBuffer }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(WEB_PORT, () => addLog(`Webinterface auf Port ${WEB_PORT}`));

function formatMs(ms) {
  if(!ms) return "0:00";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 1000 / 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

client.login(DISCORD_TOKEN);
