const path = require("path");
const fs = require("fs");
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
  EmbedBuilder
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

// --------- HELP EMBED ---------
function createHelpEmbed() {
  return new EmbedBuilder()
    .setTitle("🎵 Musikbot – Hilfe")
    .setDescription("Übersicht über die wichtigsten Befehle des Musikbots.")
    .addFields(
      {
        name: "Slash-Befehle",
        value: [
          "`/play <query>` – Spielt einen Song oder fügt ihn zur Queue hinzu.",
          "`/skip` – Überspringt den aktuellen Song.",
          "`/stop` – Stoppt die Wiedergabe und leert die Queue.",
          "`/leave` – Verlässt den Voice-Channel.",
          "`/setvoice <Channel>` – Setzt den Standard-Voice-Channel.",
          "`/settext <Channel>` – Setzt den Steuer-Textkanal.",
          "`/volume <0–150>` – Stellt die Lautstärke ein.",
          "`/np` – Zeigt den aktuell spielenden Track.",
          "`/autoplay add <url>` – Fügt eine URL zur Autoplayliste hinzu.",
          "`/autoplay remove <index>` – Entfernt einen Eintrag (1-basiert).",
          "`/autoplay list` – Zeigt die Autoplayliste.",
          "`/autoplay clear` – Leert die Autoplayliste.",
          "`/about` – Infos über den Bot.",
          "`/help` – Zeigt dieses Hilfe-Embed."
        ].join("\\n"),
      },
      {
        name: "Prefix-Befehle",
        value: [
          `\`${COMMAND_PREFIX}play <query>\` – Spielt einen Song oder fügt ihn zur Queue hinzu.`,
          `\`${COMMAND_PREFIX}skip\` – Überspringt den aktuellen Song.`,
          `\`${COMMAND_PREFIX}stop\` – Stoppt die Wiedergabe und leert die Queue.`,
          `\`${COMMAND_PREFIX}leave\` – Verlässt den Voice-Channel.`,
          `\`${COMMAND_PREFIX}setvoice\` – Setzt den Standard-Voice-Channel (aktueller Voice).`,
          `\`${COMMAND_PREFIX}settext\` – Setzt den Steuer-Textkanal (aktueller Channel).`,
          `\`${COMMAND_PREFIX}volume <0–150>\` oder \`${COMMAND_PREFIX}vol <0–150>\` – Stellt die Lautstärke ein.`,
          `\`${COMMAND_PREFIX}np\` – Zeigt den aktuellen Track.`,
          `\`${COMMAND_PREFIX}autoplay add <url>\`,`,
          `\`${COMMAND_PREFIX}autoplay remove|rm <index>\`,`,
          `\`${COMMAND_PREFIX}autoplay list\` oder \`${COMMAND_PREFIX}autoplay\`,`,
          `\`${COMMAND_PREFIX}autoplay clear\`,`,
          `\`${COMMAND_PREFIX}about\` – Infos über den Bot.`,
          `\`${COMMAND_PREFIX}help\` – Zeigt dieses Hilfe-Embed.`
        ].join("\\n"),
      }
    )
    .setColor(0x5865f2);
}

if (!DISCORD_TOKEN) {
  console.warn("[WARN] DISCORD_TOKEN ist nicht gesetzt. Der Bot kann sich nicht einloggen.");
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

// guildId -> { textChannelId, voiceChannelId }

function loadGuildSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      addLog("[config] Keine gespeicherten Settings gefunden.");
      return;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    if (!raw) return;
    const obj = JSON.parse(raw);
    const entries = Object.entries(obj);
    for (const [gid, val] of entries) {
      if (val && typeof val === "object") {
        guildSettings.set(gid, {
          textChannelId: val.textChannelId || null,
          voiceChannelId: val.voiceChannelId || null,
          volume: typeof val.volume === "number" ? val.volume : 100,
          autoplaylist: Array.isArray(val.autoplaylist) ? val.autoplaylist : [],
          autoplayIndex: typeof val.autoplayIndex === "number" ? val.autoplayIndex : 0,
        });
      }
    }
    addLog(`[config] ${guildSettings.size} Server-Settings geladen.`);
  } catch (err) {
    addLog("[config] Fehler beim Laden der Settings: " + err.message);
  }
}

let saveTimeout = null;
function scheduleSaveGuildSettings() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const obj = {};
      for (const [gid, val] of guildSettings.entries()) {
        obj[gid] = val;
      }
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf8");
      addLog("[config] Server-Settings gespeichert.");
    } catch (err) {
      addLog("[config] Fehler beim Speichern der Settings: " + err.message);
    }
  }, 1000);
}

loadGuildSettings();

// ---- Runtime state for autoplay & now playing ----
const runtimeState = new Map();
function ensureRuntime(gid) {
  let rt = runtimeState.get(gid);
  if (!rt) { rt = { current: null, autoplayPending: false, isAutoplayCurrent: false }; runtimeState.set(gid, rt); }
  return rt;
}
async function playAutoplayNext(guildId) {
  const settings = ensureGuildSettings(guildId);
  const list = settings.autoplaylist || [];
  if (!list.length) return false;
  const url = list[settings.autoplayIndex] || list[0];
  settings.autoplayIndex = (settings.autoplayIndex + 1) % list.length;
  scheduleSaveGuildSettings();
  const player = client.lavalink.getPlayer(guildId);
  if (!player) return false;
  const res = await player.search({ query: url }, client.user);
  if (!res?.tracks?.length) return false;
  await player.queue.add(res.tracks[0]);
  const rt = ensureRuntime(guildId);
  rt.autoplayPending = true;
  if (!player.playing && !player.paused) { await player.play(); }
  return true;
}
async function interruptAutoplayForUser(guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (!player) return;
  const rt = ensureRuntime(guildId);
  if (rt.isAutoplayCurrent) { try { await player.stop(); } catch {} }
}

function getGuildVolume(guildId) {
  const s = ensureGuildSettings(guildId);
  return typeof s.volume === "number" ? s.volume : 100;
}
function setGuildVolume(guildId, v) {
  const s = ensureGuildSettings(guildId);
  let val = Number(v);
  if (!Number.isFinite(val)) val = 100;
  if (val < 0) val = 0;
  if (val > 150) val = 150;
  s.volume = val;
  scheduleSaveGuildSettings();
  return val;
}
async function applyGuildVolume(guildId) {
  const p = client.lavalink.getPlayer(guildId);
  if (!p) return;
  const vol = getGuildVolume(guildId);
  try { await p.setVolume(vol); } catch {}
}

// --------- DISCORD + LAVALINK ---------
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
  nodes: [
    {
      authorization: LAVALINK_PASSWORD,
      host: LAVALINK_HOST,
      port: LAVALINK_PORT,
      id: LAVALINK_ID,
    },
  ],
  sendToShard: (guildId, payload) =>
    client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  client: {
    id: "0", // wird beim init überschrieben
    username: "MusicBot",
  },
  playerOptions: {
    defaultSearchPlatform: "ytmsearch",
    volumeDecrementer: 0.75,
    clientBasedPositionUpdateInterval: 150,
  },
});

client.on("raw", (d) => client.lavalink.sendRawData(d));

client.lavalink.on("nodeConnect", (node) => {
  lavalinkReady = true;
  addLog(`[lavalink] Node verbunden: ${node.id}`);
});

client.lavalink.on("nodeDisconnect", (node) => {
  lavalinkReady = false;
  addLog(`[lavalink] Node getrennt: ${node.id}`);
});

client.lavalink.on("trackStart", async (player, track) => {
  const rt = ensureRuntime(player.guildId);
  rt.current = { title: track.info?.title, uri: track.info?.uri };
  rt.isAutoplayCurrent = !!rt.autoplayPending;
  rt.autoplayPending = false;
  addLog(
    `[player ${player.guildId}] Starte Track: ${track.info.title} (${track.info.uri})`
  );
  await applyGuildVolume(player.guildId);
});

client.lavalink.on("queueEnd", async (player) => {
  addLog(`[player ${player.guildId}] Queue leer`);
  const settings = ensureGuildSettings(player.guildId);
  if (settings.autoplaylist && settings.autoplaylist.length) {
    try { await playAutoplayNext(player.guildId); } catch (e) { addLog(`[autoplay] Fehler: ${e.message}`); }
  }
});

client.once("ready", async () => {
  addLog(`[discord] Eingeloggt als ${client.user.tag}`);
  await client.lavalink.init({ id: client.user.id, username: client.user.username });
  addLog("[discord] Slash-Commands registrieren...");
  await registerSlashCommands();
});

async function registerSlashCommands() {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName("play")
        .setDescription("Spielt einen Song oder fügt ihn zur Queue hinzu.")
        .addStringOption((opt) =>
          opt
            .setName("query")
            .setDescription("YouTube-Link oder Suchbegriff")
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Überspringt den aktuellen Song."),
      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stoppt die Wiedergabe und leert die Queue."),
      new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Verlässt den Voice-Channel."),
      new SlashCommandBuilder()
        .setName("setvoice")
        .setDescription("Setzt den Standard-Voice-Channel für diesen Server.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Voice-Channel")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("settext")
        .setDescription("Setzt den Steuer-Textkanal für diesen Server.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Text-Channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("about")
        .setDescription("Infos zum Musikbot anzeigen."),

      new SlashCommandBuilder().setName("help").setDescription("Zeigt eine Hilfeübersicht für den Musikbot."),

      new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Stellt die Lautstärke (0–150%) ein.")
        .addIntegerOption(o => o.setName("value").setDescription("0–150").setRequired(true)),

      new SlashCommandBuilder().setName("np").setDescription("Zeigt den aktuell spielenden Track."),

      new SlashCommandBuilder()
        .setName("autoplay")
        .setDescription("Verwaltet die Autoplayliste.")
        .addSubcommand(sc => sc.setName("add").setDescription("URL zur Autoplayliste hinzufügen").addStringOption(o => o.setName("url").setDescription("Medien-URL").setRequired(true)))
        .addSubcommand(sc => sc.setName("remove").setDescription("Eintrag aus Autoplayliste entfernen").addIntegerOption(o => o.setName("index").setDescription("1-basiert").setRequired(true)))
        .addSubcommand(sc => sc.setName("list").setDescription("Autoplayliste anzeigen"))
        .addSubcommand(sc => sc.setName("clear").setDescription("Autoplayliste leeren")),

    ].map((c) => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    addLog("[discord] Slash-Commands erfolgreich registriert.");
  } catch (err) {
    console.error(err);
    addLog("[discord] Fehler beim Registrieren der Slash-Commands.");
  }
}

async function getOrCreatePlayer(guild, voiceChannelId, textChannelId) {
  const player = await client.lavalink.createPlayer({
    guildId: guild.id,
    voiceChannelId,
    textChannelId,
    selfDeaf: true,
    selfMute: false,
  });
  if (!player.connected) await player.connect();
  return player;
}

async function handlePlay(guild, user, query) {
  const settings = guildSettings.get(guild.id) || {};
  const voiceChannelId = settings.voiceChannelId;
  const textChannelId = settings.textChannelId;

  if (!voiceChannelId) {
    throw new Error("Kein Voice-Channel gesetzt. Nutze /setvoice im Discord oder wähle ihn im Web-Interface.");
  }

  const player = await getOrCreatePlayer(guild, voiceChannelId, textChannelId);
  const searchResult = await player.search({ query }, user);
  if (!searchResult || !Array.isArray(searchResult.tracks) || !searchResult.tracks.length) {
    throw new Error("Keine Treffer gefunden.");
  }
  const track = searchResult.tracks[0];
  await player.queue.add(track);
  await interruptAutoplayForUser(guild.id);

  addLog(
    `[queue ${guild.id}] Track in Queue gelegt: ${track.info.title} (${track.info.uri})`
  );
  if (!player.playing) await player.play();
  return track;
}

async function handleSkip(guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (!player) throw new Error("Kein Player für diesen Server.");
  if (!player.queue.current) throw new Error("Kein Track läuft gerade.");
  await player.skip();
}

async function handleStop(guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (!player) throw new Error("Kein Player für diesen Server.");
  await player.queue.clear();
  await player.stop();
}

async function handleLeave(guildId) {
  const player = client.lavalink.getPlayer(guildId);
  if (player) {
    await player.destroy();
    client.lavalink.deletePlayer(guildId);
  }
}

// ------ Discord Message-Commands ------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(COMMAND_PREFIX)) return;

  const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (!cmd) return;

  try {
    if (cmd === "play" || cmd === "p") {
      const query = args.join(" ");
      if (!query) return message.reply("Bitte gib einen Suchbegriff oder Link an.");
      const track = await handlePlay(message.guild, message.author, query);
      await message.reply(
        `▶️ **${track.info.title}** wurde zur Queue hinzugefügt.`
      );
    } else if (cmd === "skip") {
      await handleSkip(message.guild.id);
      await message.reply("⏭️ Übersprungen.");
    } else if (cmd === "stop") {
      await handleStop(message.guild.id);
      await message.reply("⏹️ Wiedergabe gestoppt und Queue geleert.");
    } else if (cmd === "leave") {
      await handleLeave(message.guild.id);
      await message.reply("👋 Voice-Channel verlassen.");
    } else if (cmd === "setvoice") {
      const vc = message.member.voice.channel;
      if (!vc) return message.reply("Bitte gehe zuerst in einen Voice-Channel.");
      const settings = guildSettings.get(message.guild.id) || {};
      settings.voiceChannelId = vc.id;
      guildSettings.set(message.guild.id, settings);
      scheduleSaveGuildSettings();
      await message.reply(`🎧 Voice-Channel gesetzt auf **${vc.name}**.`);
    } else if (cmd === "settext") {
      const settings = guildSettings.get(message.guild.id) || {};
      settings.textChannelId = message.channel.id;
      guildSettings.set(message.guild.id, settings);
      scheduleSaveGuildSettings();
      await message.reply(`💬 Steuer-Textkanal gesetzt auf **${message.channel.name}**.`);
    } else if (cmd === "about") {
      await message.reply(
        "🎵 Nightwolf Entertainments Musikbot – mit Webinterface und Lavalink.\n" +
          `Prefix: \`${COMMAND_PREFIX}\`\n` +
          "Nutze /play oder !play, um Songs abzuspielen."
      );
    } else if (cmd === "help" || cmd === "h") {
      const embed = createHelpEmbed();
      await message.reply({ embeds: [embed] });
    }
  } catch (err) {
    console.error(err);
    await message.reply(
      `Es ist ein Fehler aufgetreten: ${(err && err.message) || err}`
    );
  }
});

// ------ Discord Slash Commands ------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const cmd = interaction.commandName;

  try {
    if (cmd === "play") {
      const query = interaction.options.getString("query", true);
      await interaction.deferReply();
      const track = await handlePlay(interaction.guild, interaction.user, query);
      await interaction.editReply(`▶️ **${track.info.title}** wurde zur Queue hinzugefügt.`);
    } else if (cmd === "skip") {
      await interaction.deferReply({ ephemeral: true });
      await handleSkip(interaction.guild.id);
      await interaction.editReply("⏭️ Übersprungen.");
    } else if (cmd === "stop") {
      await interaction.deferReply({ ephemeral: true });
      await handleStop(interaction.guild.id);
      await interaction.editReply("⏹️ Wiedergabe gestoppt und Queue geleert.");
    } else if (cmd === "leave") {
      await interaction.deferReply({ ephemeral: true });
      await handleLeave(interaction.guild.id);
      await interaction.editReply("👋 Voice-Channel verlassen.");
    } else if (cmd === "setvoice") {
      const channel = interaction.options.getChannel("channel", true);
      if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
        return interaction.reply({ content: "Bitte einen gültigen Voice-Channel angeben.", ephemeral: true });
      }
      const settings = guildSettings.get(interaction.guild.id) || {};
      settings.voiceChannelId = channel.id;
      guildSettings.set(interaction.guild.id, settings);
      scheduleSaveGuildSettings();
      await interaction.reply({ content: `🎧 Voice-Channel gesetzt auf **${channel.name}**.`, ephemeral: false });
    } else if (cmd === "settext") {
      const channel = interaction.options.getChannel("channel", true);
      if (!channel || !channel.isTextBased()) {
        return interaction.reply({ content: "Bitte einen gültigen Text-Channel angeben.", ephemeral: true });
      }
      const settings = guildSettings.get(interaction.guild.id) || {};
      settings.textChannelId = channel.id;
      guildSettings.set(interaction.guild.id, settings);
      scheduleSaveGuildSettings();
      await interaction.reply({ content: `💬 Steuer-Textkanal gesetzt auf **${channel.name}**.`, ephemeral: false });
    } else if (cmd === "about") {
      await interaction.reply({
        content:
          "🎵 Nightwolf Entertainments Musikbot – mit Webinterface und Lavalink.\n" +
          `Prefix: \`${COMMAND_PREFIX}\`\n` +
          "Nutze /play oder !play, um Songs abzuspielen.",
        ephemeral: false,
      });
    } else if (cmd === "help") {
      const embed = createHelpEmbed();
      await interaction.reply({ embeds: [embed] });
    } else if (cmd === "volume") {
      const v = interaction.options.getInteger("value", true);
      const newV = setGuildVolume(interaction.guild.id, v);
      await applyGuildVolume(interaction.guild.id);
      await interaction.reply({ content: `🔊 Lautstärke gesetzt auf **${newV}%**.`, ephemeral: false });
    } else if (cmd === "np") {
      const player = client.lavalink.getPlayer(interaction.guild.id);
      if (!player || !player.queue.current) {
        return interaction.reply({ content: "Es läuft gerade nichts.", ephemeral: true });
      }
      const t = player.queue.current;
      await interaction.reply({ content: `🎶 Aktuell: **${t.info?.title}** — ${t.info?.uri}` });
    } else if (cmd === "autoplay") {
      const sub = interaction.options.getSubcommand(false);
      const gid = interaction.guild.id;
      if (sub === "add") {
        const url = interaction.options.getString("url", true).trim();
        const s = ensureGuildSettings(gid);
        s.autoplaylist.push(url);
        scheduleSaveGuildSettings();
        await interaction.reply({ content: `✅ URL zur Autoplayliste hinzugefügt.`, ephemeral: false });
      } else if (sub === "remove") {
        const idx = interaction.options.getInteger("index", true);
        const s = ensureGuildSettings(gid);
        if (Number.isFinite(idx) && idx >= 1 && idx <= s.autoplaylist.length) {
          s.autoplaylist.splice(idx - 1, 1);
          if (s.autoplayIndex >= s.autoplaylist.length) s.autoplayIndex = 0;
          scheduleSaveGuildSettings();
          await interaction.reply({ content: `🗑️ Eintrag ${idx} entfernt.`, ephemeral: false });
        } else {
          await interaction.reply({ content: `Ungültiger Index.`, ephemeral: true });
        }
      } else if (sub === "list") {
        const s = ensureGuildSettings(gid);
        if (!s.autoplaylist.length) return interaction.reply({ content: "Autoplayliste ist leer.", ephemeral: true });
        const list = s.autoplaylist.map((u, i) => `${i + 1}. ${u}`).join("\n");
        await interaction.reply({ content: `Autoplayliste:\n${list}` });
      } else if (sub === "clear") {
        const s = ensureGuildSettings(gid);
        s.autoplaylist = [];
        s.autoplayIndex = 0;
        scheduleSaveGuildSettings();
        await interaction.reply({ content: "Autoplayliste geleert.", ephemeral: false });
      } else {
        await interaction.reply({ content: "Unbekannter Autoplay-Subcommand.", ephemeral: true });
      }
    } else {
      await interaction.reply({ content: "Unbekannter Befehl.", ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    const msg = (err && err.message) || String(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Es ist ein Fehler aufgetreten: ${msg}`);
      } else {
        await interaction.reply({ content: `Es ist ein Fehler aufgetreten: ${msg}`, ephemeral: true });
      }
    } catch (e) {
      console.error("Fehler beim Senden der Fehler-Antwort:", e);
    }
  }
});

// --------- WEB SERVER ---------
const app = express();
app.use(cors());
app.use(bodyParser.json());

function authMiddleware(req, res, next) {
  const token = req.headers["x-api-key"];
  if (!token || token !== WEB_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/status", authMiddleware, (req, res) => {
  res.json({
    botOnline: !!client.user,
    botTag: client.user ? client.user.tag : null,
    lavalinkReady,
    guilds: client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
    })),
  });
});

app.get("/api/logs", authMiddleware, (req, res) => {
  res.json({ lines: logBuffer });
});

app.get("/api/guilds", authMiddleware, (req, res) => {
  res.json({
    guilds: client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
    })),
  });
});

app.get("/api/guilds/:id/details", authMiddleware, async (req, res) => {
  try {
    const guildId = req.params.id;
    const guild = await client.guilds.fetch(guildId);

    // Wichtig: nur Cache verwenden, keine zusätzlichen Discord-HTTP-Calls.
    const fetched = guild.channels.cache;

    const textChannels = [];
    const voiceChannels = [];

    for (const [id, ch] of fetched) {
      if (!ch) continue;
      if (ch.viewable === false) continue;

      try {
        if (typeof ch.isTextBased === "function" && ch.isTextBased()) {
          textChannels.push({ id: ch.id, name: ch.name || ch.id });
        }

        if (
          ch.type === ChannelType.GuildVoice ||
          ch.type === ChannelType.GuildStageVoice ||
          ch.type === 2 ||
          ch.type === 13
        ) {
          voiceChannels.push({ id: ch.id, name: ch.name || ch.id });
        }
      } catch (innerErr) {
        console.error("[guild-details] Channel-Analyse Fehler:", innerErr);
      }
    }

    textChannels.sort((a, b) => a.name.localeCompare(b.name));
    voiceChannels.sort((a, b) => a.name.localeCompare(b.name));

    const settings = guildSettings.get(guild.id) || {};

    res.json({
      id: guild.id,
      name: guild.name,
      textChannels,
      voiceChannels,
      settings,
    });
  } catch (err) {
    console.error("[guild-details] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Lesen der Server-Daten." });
  }
});
app.post("/api/guilds/:id/settings", authMiddleware, (req, res) => {
  const guildId = req.params.id;
  const { textChannelId, voiceChannelId } = req.body || {};
  const settings = guildSettings.get(guildId) || {};
  if (typeof textChannelId === "string") settings.textChannelId = textChannelId || null;
  if (typeof voiceChannelId === "string") settings.voiceChannelId = voiceChannelId || null;
  guildSettings.set(guildId, settings);
  scheduleSaveGuildSettings();
  addLog(`[config ${guildId}] Config per Webinterface geändert`);
  res.json({ ok: true, settings });
});

app.post("/api/guilds/:id/play", authMiddleware, async (req, res) => {
  try {
    const guildId = req.params.id;
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: "query fehlt" });
    const guild = await client.guilds.fetch(guildId);
    const fakeUser = { id: "0", username: "WebUI" };
    const track = await handlePlay(guild, fakeUser, query);
    res.json({
      ok: true,
      track: {
        title: track.info.title,
        uri: track.info.uri,
        author: track.info.author,
        length: track.info.length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

app.post("/api/guilds/:id/skip", authMiddleware, async (req, res) => {
  try {
    const guildId = req.params.id;
    await handleSkip(guildId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

app.post("/api/guilds/:id/stop", authMiddleware, async (req, res) => {
  try {
    const guildId = req.params.id;
    await handleStop(guildId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

app.post("/api/guilds/:id/leave", authMiddleware, async (req, res) => {
  try {
    const guildId = req.params.id;
    await handleLeave(guildId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err && err.message) || String(err) });
  }
});

// Static files (Web-UI)
const publicPath = path.join(__dirname, "..", "public");
app.use(express.static(publicPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// ---- API: Autoplay & Now Playing ----
app.get("/api/np", (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: "missing_guildId" });
  const player = client.lavalink.getPlayer(guildId);
  if (!player || !player.queue.current) return res.json({ guildId, nowPlaying: null });
  const t = player.queue.current;
  res.json({ guildId, nowPlaying: { title: t.info?.title, uri: t.info?.uri } });
});

app.get("/api/autoplay/:guildId", (req, res) => {
  const gid = req.params.guildId;
  const s = ensureGuildSettings(gid);
  res.json({ guildId: gid, autoplaylist: s.autoplaylist, autoplayIndex: s.autoplayIndex });
});

app.post("/api/autoplay/:guildId/add", (req, res) => {
  const gid = req.params.guildId;
  const url = (req.body?.url || "").trim();
  if (!gid || !url) return res.status(400).json({ error: "missing_guildId_or_url" });
  const s = ensureGuildSettings(gid);
  s.autoplaylist.push(url);
  scheduleSaveGuildSettings();
  res.json({ guildId: gid, autoplaylist: s.autoplaylist, autoplayIndex: s.autoplayIndex });
});

app.post("/api/autoplay/:guildId/remove", (req, res) => {
  const gid = req.params.guildId;
  const index = Number(req.body?.index);
  const s = ensureGuildSettings(gid);
  if (Number.isFinite(index) && index >= 1 && index <= s.autoplaylist.length) {
    s.autoplaylist.splice(index-1, 1);
    if (s.autoplayIndex >= s.autoplaylist.length) s.autoplayIndex = 0;
    scheduleSaveGuildSettings();
  }
  res.json({ guildId: gid, autoplaylist: s.autoplaylist, autoplayIndex: s.autoplayIndex });
});

app.post("/api/autoplay/:guildId/clear", (req, res) => {
  const gid = req.params.guildId;
  const s = ensureGuildSettings(gid);
  s.autoplaylist = [];
  s.autoplayIndex = 0;
  scheduleSaveGuildSettings();
  res.json({ guildId: gid, autoplaylist: s.autoplaylist, autoplayIndex: s.autoplayIndex });
});
app.listen(WEB_PORT, () => {
  addLog(`Webinterface läuft auf Port ${WEB_PORT}`);
});

// Discord Login
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Login-Fehler:", err);
  addLog("Fehler beim Einloggen des Discord-Bots.");
});
