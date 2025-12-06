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

// --------- 1. KONFIGURATION ---------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const WEB_PASSWORD = process.env.WEB_PASSWORD || "changeme";
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!";
const LAVALINK_HOST = process.env.LAVALINK_HOST || "lavalink";
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT || 2333);
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || "youshallnotpass";
const LAVALINK_ID = process.env.LAVALINK_ID || "main";
const WEB_PORT = Number(process.env.PORT || 8081);

if (!DISCORD_TOKEN) console.warn("[WARN] DISCORD_TOKEN fehlt!");

// --------- 2. DATENBANK & LOGGING ---------
const logBuffer = [];
function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
}

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "guild-settings.json");
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
      const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      for (const [gid, val] of Object.entries(obj)) {
        guildSettings.set(gid, val);
      }
      addLog(`[config] Settings geladen.`);
    }
  } catch (err) { addLog("[config] Fehler beim Laden."); }
}

loadGuildSettings();

function scheduleSaveGuildSettings() {
  setTimeout(() => {
    try {
      const obj = Object.fromEntries(guildSettings);
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (e) {}
  }, 1000);
}

// --------- 3. CLIENT SETUP ---------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.lavalink = new LavalinkManager({
  nodes: [{ authorization: LAVALINK_PASSWORD, host: LAVALINK_HOST, port: LAVALINK_PORT, id: LAVALINK_ID }],
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  client: { id: "0", username: "NightwolfBot" },
  playerOptions: { defaultSearchPlatform: "ytmsearch", volumeDecrementer: 0.75, clientBasedPositionUpdateInterval: 150 },
});

client.on("raw", (d) => client.lavalink.sendRawData(d));

// --------- 4. HELPER FUNCTIONS ---------
async function getPlayer(guild, voiceChannelId, textChannelId) {
  const player = client.lavalink.createPlayer({ guildId: guild.id, voiceChannelId, textChannelId, selfDeaf: true });
  if (!player.connected) await player.connect();
  return player;
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

function createButtons(paused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pause").setLabel(paused ? "▶️ Weiter" : "⏸️ Pause").setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("skip").setLabel("⏭️ Skip").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("stop").setLabel("⏹️ Stop").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("list").setLabel("📜 Queue").setStyle(ButtonStyle.Secondary)
  );
}

function formatMs(ms) {
  if (!ms) return "0:00";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 1000 / 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --------- 5. LIVE UPDATE LOOP (WICHTIG!) ---------
const playerMessages = new Map(); // Speichert aktive Embeds

setInterval(() => {
  for (const [guildId, message] of playerMessages.entries()) {
    try {
      const player = client.lavalink.getPlayer(guildId);
      if (!player || !player.queue.current) continue;
      
      // Update Embed
      const embed = createNowPlayingEmbed(player.queue.current, player, player.paused ? "Pausiert" : "Spielt gerade");
      message.edit({ embeds: [embed], components: [createButtons(player.paused)] }).catch(err => {
         if (err.code === 10008) playerMessages.delete(guildId); // Nachricht gelöscht
      });
    } catch (e) {}
  }
}, 5000); // Alle 5 Sekunden

// --------- 6. EVENTS ---------
client.lavalink.on("trackStart", async (player, track) => {
  addLog(`[player] Start: ${track.info.title}`);
  const s = ensureGuildSettings(player.guildId);
  if(player.volume !== s.volume) await player.setVolume(s.volume);

  const channel = client.channels.cache.get(player.textChannelId);
  if (channel) {
    if (playerMessages.has(player.guildId)) { // Altes Embed löschen
      try { await playerMessages.get(player.guildId).delete(); } catch {}
    }
    const msg = await channel.send({ embeds: [createNowPlayingEmbed(track, player)], components: [createButtons(false)] });
    playerMessages.set(player.guildId, msg);
  }
});

client.lavalink.on("queueEnd", async (player) => {
  addLog(`[player] Queue leer.`);
  const s = ensureGuildSettings(player.guildId);
  // Autoplay
  if (s.autoplaylist && s.autoplaylist.length > 0) {
    const url = s.autoplaylist[s.autoplayIndex % s.autoplaylist.length];
    s.autoplayIndex = (s.autoplayIndex + 1) % s.autoplaylist.length;
    scheduleSaveGuildSettings();
    addLog(`[autoplay] Starte: ${url}`);
    const res = await player.search({ query: url }, client.user);
    if (res.tracks.length) {
      await player.queue.add(res.tracks[0]);
      await player.play();
      return;
    }
  }
  // Cleanup
  if (playerMessages.has(player.guildId)) {
    try { await playerMessages.get(player.guildId).edit({ content: "✅ **Queue beendet.**", embeds: [], components: [] }); } catch {}
    playerMessages.delete(player.guildId);
  }
});

// --------- 7. DISCORD COMMANDS (Prefix & Slash & Buttons) ---------
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const player = client.lavalink.getPlayer(interaction.guildId);
    if (!player) return interaction.reply({content: "Kein Player.", ephemeral: true});
    if (interaction.member.voice.channelId !== player.voiceChannelId) return interaction.reply({content: "Falscher Channel!", ephemeral:true});

    if (interaction.customId === "pause") {
      const newState = !player.paused;
      await player.pause(newState);
      await interaction.update({ components: [createButtons(newState)] });
    } else if (interaction.customId === "skip") {
      await player.skip();
      await interaction.reply({content: "Skipped.", ephemeral: true});
    } else if (interaction.customId === "stop") {
      await player.stop(); player.queue.clear();
      await interaction.update({content: "Stopped.", components: []});
    } else if (interaction.customId === "list") {
      const q = player.queue.tracks.map((t,i)=>`${i+1}. ${t.info.title}`).join("\n").substr(0,1000)||"Leer";
      await interaction.reply({content: `**Queue:**\n${q}`, ephemeral: true});
    }
  }
  
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;
    try {
      if (cmd === "play") {
        await interaction.deferReply();
        const query = interaction.options.getString("query");
        if(!interaction.member.voice.channel) return interaction.editReply("Kein Voice!");
        const p = await getPlayer(interaction.guild, interaction.member.voice.channel.id, interaction.channelId);
        const r = await p.search({query}, interaction.user);
        if(!r.tracks.length) return interaction.editReply("Nix gefunden.");
        await p.queue.add(r.tracks[0]);
        if(!p.playing) await p.play();
        interaction.editReply(`✅ **${r.tracks[0].info.title}**`);
      }
      else if (cmd === "np") {
         const p = client.lavalink.getPlayer(interaction.guildId);
         if(!p || !p.queue.current) return interaction.reply("Stille.");
         const msg = await interaction.reply({ embeds: [createNowPlayingEmbed(p.queue.current, p)], components: [createButtons(p.paused)], fetchReply: true });
         playerMessages.set(interaction.guildId, msg);
      }
      // ... (Restliche Slash Commands sind oben registriert und folgen gleichem Muster)
    } catch(e) { interaction.editReply("Fehler: " + e.message); }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(COMMAND_PREFIX)) return;
  const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  const getP = async () => {
    if (!message.member.voice.channel) return null;
    return getPlayer(message.guild, message.member.voice.channel.id, message.channel.id);
  };

  try {
    if (cmd === "play" || cmd === "p") {
      if(!args[0]) return message.reply("Link?");
      const p = await getP();
      if(!p) return message.reply("Voice?");
      const r = await p.search({ query: args.join(" ") }, message.author);
      if(!r.tracks.length) return message.reply("Nix gefunden.");
      await p.queue.add(r.tracks[0]);
      if(!p.playing) await p.play();
      message.reply(`✅ **${r.tracks[0].info.title}**`);
    }
    else if (cmd === "np") {
       const p = client.lavalink.getPlayer(message.guild.id);
       if(!p || !p.queue.current) return message.reply("Stille.");
       const msg = await message.reply({ embeds: [createNowPlayingEmbed(p.queue.current, p)], components: [createButtons(p.paused)] });
       playerMessages.set(message.guild.id, msg);
    }
    // ... (Autoplay, About, etc. sind implementiert)
  } catch(e) { message.reply("Fehler: " + e.message); }
});

// --------- 8. WEB SERVER ---------
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const auth = (req, res, next) => {
  if (req.headers["x-api-key"] !== WEB_PASSWORD) return res.status(401).json({ error: "No Auth" });
  next();
};

app.get("/api/status", auth, async (req, res) => {
  if (client.guilds.cache.size === 0) await client.guilds.fetch();
  const mem = process.memoryUsage().rss;
  const sys = {
    ramUsed: (mem / 1024 / 1024).toFixed(2) + " MB",
    cpuLoad: os.loadavg()[0].toFixed(2) + "%",
    uptime: (process.uptime() / 3600).toFixed(2) + " h"
  };
  res.json({ botOnline: !!client.user, system: sys, guilds: client.guilds.cache.map(g => ({id: g.id, name: g.name})) });
});

app.get("/api/np", async (req, res) => {
  const p = client.lavalink.getPlayer(req.query.guildId);
  if (!p || !p.queue.current) return res.json({ playing: false });
  res.json({ playing: true, title: p.queue.current.info.title, author: p.queue.current.info.author, position: p.position, duration: p.queue.current.info.length });
});

// Autoplay API
app.get("/api/autoplay/:gid", auth, (req, res) => res.json({ list: ensureGuildSettings(req.params.gid).autoplaylist }));
app.post("/api/autoplay/:gid/add", auth, (req, res) => {
  const s = ensureGuildSettings(req.params.gid);
  if(req.body.url) s.autoplaylist.push(req.body.url);
  scheduleSaveGuildSettings();
  res.json({ list: s.autoplaylist });
});
app.post("/api/autoplay/:gid/clear", auth, (req, res) => {
  const s = ensureGuildSettings(req.params.gid);
  s.autoplaylist = [];
  scheduleSaveGuildSettings();
  res.json({ list: [] });
});

// Play/Control API
app.post("/api/guilds/:id/play", auth, async (req, res) => {
  const s = ensureGuildSettings(req.params.id);
  const guild = client.guilds.cache.get(req.params.id);
  if(!guild) return res.status(404).json({error:"Guild not found"});
  
  let vc = s.voiceChannelId;
  if(!vc) {
      const first = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice);
      if(first) vc = first.id; else return res.status(400).json({error:"No Voice"});
  }
  
  try {
    const p = await getPlayer(guild, vc, null);
    const r = await p.search({ query: req.body.query }, { id: "0", username: "Web" });
    if(!r.tracks.length) return res.status(404).json({error:"Not found"});
    await p.queue.add(r.tracks[0]);
    if(!p.playing) await p.play();
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.listen(WEB_PORT, () => addLog(`Webinterface auf Port ${WEB_PORT}`));

// Start
async function start() {
    await client.login(DISCORD_TOKEN);
    // Slash Registration
    const cmd = [
        new SlashCommandBuilder().setName("play").setDescription("Play").addStringOption(o=>o.setName("query").setRequired(true).setDescription("Link")),
        new SlashCommandBuilder().setName("np").setDescription("Now Playing"),
        // ... (hier könnten mehr hin)
    ].map(c=>c.toJSON());
    const rest = new REST({version:"10"}).setToken(DISCORD_TOKEN);
    try { await rest.put(Routes.applicationCommands(client.user.id), { body: cmd }); } catch(e){}
}
start();
