const path = require("path");
const fs = require("fs");
const os = require("os"); // Für System-Infos
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
  ButtonStyle,
  ComponentType
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

if (!DISCORD_TOKEN) {
  console.warn("[WARN] DISCORD_TOKEN fehlt!");
}

// --------- LOGGING ---------
const logBuffer = [];
const MAX_LOG_LINES = 500;
function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

// --------- SYSTEM STATS HELPER ---------
function getSystemStats() {
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const usedMem = totalMem - freeMem;
  const memUsage = Math.round((usedMem / totalMem) * 100);
  const load = os.loadavg()[0]; // 1 Minute Load Average
  return {
    ramUsed: (usedMem / 1024 / 1024).toFixed(2) + " MB",
    ramPercent: memUsage,
    cpuLoad: load.toFixed(2) + "%",
    uptime: (os.uptime() / 3600).toFixed(2) + " h"
  };
}

// --------- GUILD SETTINGS PERSISTENZ ---------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(DATA_DIR, "guild-settings.json");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
        textChannelId: val.textChannelId || null, // Nur noch für Text wichtig
        volume: val.volume || 100,
        autoplaylist: val.autoplaylist || [],
        autoplayIndex: val.autoplayIndex || 0,
      });
    }
    addLog(`[config] ${guildSettings.size} Server-Settings geladen.`);
  } catch (err) {
    addLog("[config] Fehler beim Laden: " + err.message);
  }
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

// --------- LAVALINK SETUP ---------
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

// --------- INTERACTIVE EMBED BUILDER ---------
function createNowPlayingEmbed(track, player, status = "Spielt gerade") {
  const slider = "▬".repeat(10).split("");
  // Simple Progress Bar (nur wenn Duration bekannt und > 0)
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
      { name: "Lautstärke", value: `${player.volume}%`, inline: true },
      { name: "Fortschritt", value: bar, inline: false }
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

// Map speichert die letzte Nachricht pro Gilde, um sie zu updaten/löschen
const playerMessages = new Map();

// --------- LAVALINK EVENTS ---------
client.lavalink.on("nodeConnect", (node) => {
  lavalinkReady = true;
  addLog(`[lavalink] Node verbunden: ${node.id}`);
});

client.lavalink.on("trackStart", async (player, track) => {
  addLog(`[player ${player.guildId}] Start: ${track.info.title}`);
  
  // Settings speichern/laden für Volume
  const s = ensureGuildSettings(player.guildId);
  if(player.volume !== s.volume) await player.setVolume(s.volume);

  // Sende Interaktives Embed
  const channel = client.channels.cache.get(player.textChannelId);
  if (channel) {
    // Altes löschen falls vorhanden
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
  // Autoplay Check
  const s = ensureGuildSettings(player.guildId);
  if (s.autoplaylist && s.autoplaylist.length > 0) {
    const url = s.autoplaylist[s.autoplayIndex % s.autoplaylist.length];
    s.autoplayIndex = (s.autoplayIndex + 1) % s.autoplaylist.length;
    scheduleSaveGuildSettings();

    addLog(`[autoplay] Spiele nächsten Track: ${url}`);
    const res = await player.search({ query: url }, client.user);
    if (res.tracks.length) {
      await player.queue.add(res.tracks[0]);
      await player.play();
      return;
    }
  }
  
  // Wenn wirklich Ende: Aufräumen
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

// --------- BUTTON INTERACTION HANDLER ---------
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: "Kein Player aktiv.", ephemeral: true });

    // Voice Check
    const { channel } = interaction.member.voice;
    if (!channel || channel.id !== player.voiceChannelId) {
        return interaction.reply({ content: "Du musst in meinem Voice-Channel sein!", ephemeral: true });
    }

    try {
      if (interaction.customId === "pause") {
        const isPaused = player.paused;
        await player.pause(!isPaused);
        await interaction.update({ components: [createPlayerButtons(!isPaused)] });
      } 
      else if (interaction.customId === "skip") {
        await player.skip();
        await interaction.reply({ content: "⏭️ Übersprungen.", ephemeral: true });
      } 
      else if (interaction.customId === "stop") {
        await player.stop();
        await player.queue.clear();
        await interaction.update({ content: "⏹️ Gestoppt.", components: [] });
      }
      else if (interaction.customId === "list") {
        const q = player.queue.tracks.map((t, i) => `${i+1}. ${t.info.title}`).join("\n").substr(0, 1000) || "Leer";
        await interaction.reply({ content: `**Queue:**\n${q}`, ephemeral: true });
      }
    } catch (e) { console.error(e); }
  }
});

// --------- SLASH COMMANDS ---------
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder().setName("play").setDescription("Song abspielen")
      .addStringOption(o => o.setName("query").setDescription("URL oder Suche").setRequired(true)),
    new SlashCommandBuilder().setName("stop").setDescription("Stoppt Wiedergabe"),
    new SlashCommandBuilder().setName("skip").setDescription("Überspringt Song"),
    new SlashCommandBuilder().setName("leave").setDescription("Verlässt Voice"),
    new SlashCommandBuilder().setName("about").setDescription("Bot Status & Infos"),
    new SlashCommandBuilder().setName("help").setDescription("Zeigt alle Befehle"),
    new SlashCommandBuilder().setName("volume").setDescription("Lautstärke ändern")
      .addIntegerOption(o => o.setName("value").setDescription("0-150").setRequired(true)),
    new SlashCommandBuilder().setName("autoplay").setDescription("Autoplay Liste verwalten")
       .addSubcommand(s => s.setName("add").setDescription("Add URL").addStringOption(o => o.setName("url").setRequired(true)))
       .addSubcommand(s => s.setName("list").setDescription("Liste zeigen"))
       .addSubcommand(s => s.setName("clear").setDescription("Liste leeren")),
  ];
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    addLog("[discord] Commands registriert.");
  } catch (e) { console.error(e); }
}

// --------- COMMAND HANDLER ---------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  // -- Helper: Get/Create Player (AUTO JOIN) --
  const getPlayer = async () => {
    const { channel } = interaction.member.voice;
    if (!channel) throw new Error("Du musst in einem Voice-Channel sein!");
    
    // Player erstellen oder holen
    const player = client.lavalink.createPlayer({
      guildId: interaction.guildId,
      voiceChannelId: channel.id,
      textChannelId: interaction.channelId,
      selfDeaf: true
    });
    if (!player.connected) await player.connect();
    return player;
  };

  try {
    if (cmd === "play") {
      await interaction.deferReply();
      const query = interaction.options.getString("query");
      const player = await getPlayer();
      
      const res = await player.search({ query }, interaction.user);
      if (!res.tracks.length) return interaction.editReply("Nichts gefunden.");

      // Autoplay Logik: Wenn User was wünscht, unterbricht er Autoplay NICHT sofort, 
      // aber es wird in die Queue gesteckt und vor dem nächsten Autoplay-Song gespielt.
      // Wenn der User "sofort" will, müsste man player.queue.add(track, { unshift: true }) machen.
      // Standard: Einfach in Queue adden.
      
      const track = res.tracks[0];
      await player.queue.add(track);
      
      if (!player.playing) await player.play();

      await interaction.editReply(`✅ **${track.info.title}** zur Queue hinzugefügt.`);
    }

    else if (cmd === "stop") {
       const player = client.lavalink.getPlayer(interaction.guildId);
       if (player) { await player.stop(); player.queue.clear(); }
       await interaction.reply("Gestoppt.");
    }

    else if (cmd === "skip") {
       const player = client.lavalink.getPlayer(interaction.guildId);
       if (player) await player.skip();
       await interaction.reply("Skipped.");
    }

    else if (cmd === "leave") {
       const player = client.lavalink.getPlayer(interaction.guildId);
       if (player) await player.destroy();
       await interaction.reply("Bye 👋");
    }

    else if (cmd === "about") {
       const stats = getSystemStats();
       const embed = new EmbedBuilder()
         .setTitle("🐺 Nightwolf Status")
         .setColor(0x00ffaa)
         .addFields(
           { name: "RAM Usage", value: stats.ramUsed, inline: true },
           { name: "CPU Load", value: stats.cpuLoad, inline: true },
           { name: "Uptime", value: stats.uptime, inline: true },
           { name: "Library", value: "Lavalink-Client v2", inline: true }
         );
       await interaction.reply({ embeds: [embed] });
    }

    else if (cmd === "help") {
       // Generiert Hilfe automatisch aus den registrierten Slash Commands (hardcoded list for now for speed)
       const list = [
         "`/play <url>` - Musik abspielen",
         "`/stop` - Stoppen & Queue leeren",
         "`/skip` - Lied überspringen",
         "`/volume <0-150>` - Lautstärke",
         "`/autoplay add/list` - Autoplay verwalten",
         "`/about` - Systemstatus",
         "`/leave` - Bot kicken"
       ].join("\n");
       const embed = new EmbedBuilder().setTitle("Befehlsliste").setDescription(list).setColor(0x5865f2);
       await interaction.reply({ embeds: [embed] });
    }

    else if (cmd === "volume") {
       const val = interaction.options.getInteger("value");
       const player = await getPlayer();
       await player.setVolume(val);
       // Speichern
       const s = ensureGuildSettings(interaction.guildId);
       s.volume = val; 
       scheduleSaveGuildSettings();
       await interaction.reply(`Volume: ${val}%`);
    }

    else if (cmd === "autoplay") {
       const sub = interaction.options.getSubcommand();
       const s = ensureGuildSettings(interaction.guildId);
       if(sub === "add") {
         const url = interaction.options.getString("url");
         s.autoplaylist.push(url);
         await interaction.reply("Zur Autoplaylist hinzugefügt.");
       } else if (sub === "list") {
         await interaction.reply(`Autoplay Tracks: ${s.autoplaylist.length}`);
       } else if (sub === "clear") {
         s.autoplaylist = [];
         await interaction.reply("Autoplay geleert.");
       }
       scheduleSaveGuildSettings();
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied) await interaction.reply({ content: "Fehler: " + err.message, ephemeral: true });
  }
});

// --------- WEB SERVER ---------
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// API: Status & Stats
app.get("/api/status", (req, res) => {
  const token = req.headers["x-api-key"];
  if (token !== WEB_PASSWORD) return res.status(401).json({ error: "No Auth" });

  res.json({
    botOnline: !!client.user,
    lavalinkReady,
    system: getSystemStats()
  });
});

// API: Now Playing Data (für Echtzeit)
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

// API: Logs
app.get("/api/logs", (req, res) => {
  if (req.headers["x-api-key"] !== WEB_PASSWORD) return res.status(401).send([]);
  res.json({ lines: logBuffer });
});

// Fallback für HTML
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(WEB_PORT, () => addLog(`Webinterface auf Port ${WEB_PORT}`));

// Utils
function formatMs(ms) {
  if(!ms) return "0:00";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 1000 / 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

client.login(DISCORD_TOKEN);
