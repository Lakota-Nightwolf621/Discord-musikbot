// commands.js
const { SlashCommandBuilder, ChannelType } = require("discord.js");

/**
 * commands: Array von Slash-Command JSONs (für Registrierung)
 */
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Spielt einen Song oder fügt ihn zur Queue hinzu.")
    .addStringOption(o => o.setName("query").setDescription("YouTube-Link oder Suchbegriff").setRequired(true)),

  new SlashCommandBuilder().setName("np").setDescription("Zeigt den aktuell spielenden Track."),
  new SlashCommandBuilder().setName("skip").setDescription("Überspringt den aktuellen Song."),
  new SlashCommandBuilder().setName("stop").setDescription("Stoppt die Wiedergabe und leert die Queue."),
  new SlashCommandBuilder().setName("leave").setDescription("Lässt den Bot den Voice-Channel verlassen."),

  new SlashCommandBuilder()
    .setName("setvoice")
    .setDescription("Setzt den Standard-Voice-Channel für diesen Server.")
    .addChannelOption(o => o.setName("channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(false)),

  new SlashCommandBuilder()
    .setName("settext")
    .setDescription("Setzt den Steuer-Textkanal.")
    .addChannelOption(o => o.setName("channel").addChannelTypes(ChannelType.GuildText).setRequired(false)),

  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Stellt die Lautstärke (0–150%) ein.")
    .addIntegerOption(o => o.setName("value").setDescription("0–150").setRequired(true)),

  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Verwaltet die Autoplayliste.")
    .addSubcommand(sc => sc.setName("add").setDescription("URL hinzufügen").addStringOption(o => o.setName("url").setRequired(true)))
    .addSubcommand(sc => sc.setName("remove").setDescription("Eintrag entfernen").addIntegerOption(o => o.setName("index").setRequired(true)))
    .addSubcommand(sc => sc.setName("list").setDescription("Autoplayliste anzeigen"))
    .addSubcommand(sc => sc.setName("clear").setDescription("Autoplayliste leeren")),

  new SlashCommandBuilder().setName("help").setDescription("Zeigt die Hilfeübersicht."),

  // Ping command
  new SlashCommandBuilder().setName("ping").setDescription("Zeigt Latenz, Prozess- und Lavalink-Status.")
].map(c => c.toJSON());

/**
 * handlers: reine Handler-Funktionen, die mit ctx arbeiten.
 * ctx muss mindestens enthalten:
 * { client, handlePlay, handleSkip, handleStop, handleLeave, ensureGuildSettings, scheduleSaveGuildSettings, setGuildVolume }
 */
const handlers = {
  play: async (interaction, ctx) => {
    const query = interaction.options.getString("query");
    await interaction.deferReply();
    try {
      const track = await ctx.handlePlay(interaction.guild, interaction.member, query, interaction.channelId);
      await interaction.editReply(`✅ **${track.info.title}** wurde zur Queue hinzugefügt.`);
    } catch (e) {
      await interaction.editReply(`Fehler: ${e && e.message}`);
    }
  },

  np: async (interaction, ctx) => {
    const p = ctx.client.lavalink.getPlayer(interaction.guildId);
    if (!p || !p.queue.current) return interaction.reply("Stille.");
    const now = p.queue.current;
    return interaction.reply({ content: `Now Playing: **${now.info.title}** — ${now.info.author}` });
  },

  skip: async (interaction, ctx) => {
    try {
      await ctx.handleSkip(interaction.guildId);
      await interaction.reply("⏭️ Übersprungen.");
    } catch (e) {
      await interaction.reply(`Fehler: ${e && e.message}`);
    }
  },

  stop: async (interaction, ctx) => {
    try {
      await ctx.handleStop(interaction.guildId);
      await interaction.reply("⏹️ Gestoppt.");
    } catch (e) {
      await interaction.reply(`Fehler: ${e && e.message}`);
    }
  },

  leave: async (interaction, ctx) => {
    try {
      await ctx.handleLeave(interaction.guildId);
      await interaction.reply("👋 Voice verlassen.");
    } catch (e) {
      await interaction.reply(`Fehler: ${e && e.message}`);
    }
  },

  setvoice: async (interaction, ctx) => {
    const ch = interaction.options.getChannel("channel") || interaction.member.voice.channel;
    if (!ch) return interaction.reply({ content: "Kein Channel angegeben und du bist nicht in einem Voice-Channel.", ephemeral: true });
    const s = ctx.ensureGuildSettings(interaction.guildId);
    s.voiceChannelId = ch.id;
    ctx.scheduleSaveGuildSettings();
    await interaction.reply(`🎧 Standard-Voice-Channel gesetzt auf **${ch.name || ch.id}**`);
  },

  settext: async (interaction, ctx) => {
    const ch = interaction.options.getChannel("channel") || interaction.channel;
    const s = ctx.ensureGuildSettings(interaction.guildId);
    s.textChannelId = ch.id;
    ctx.scheduleSaveGuildSettings();
    await interaction.reply(`💬 Steuer-Textkanal gesetzt auf **${ch.name || ch.id}**`);
  },

  volume: async (interaction, ctx) => {
    const val = interaction.options.getInteger("value");
    if (typeof ctx.setGuildVolume === "function") {
      const newv = ctx.setGuildVolume(interaction.guildId, val);
      await interaction.reply(`🔊 Lautstärke gesetzt auf ${newv}%`);
    } else {
      const s = ctx.ensureGuildSettings(interaction.guildId);
      let newv = Number(val);
      if (!Number.isFinite(newv)) newv = 100;
      newv = Math.max(0, Math.min(150, newv));
      s.volume = newv;
      ctx.scheduleSaveGuildSettings();
      try { const p = ctx.client.lavalink.getPlayer(interaction.guildId); if (p) await p.setVolume(newv); } catch {}
      await interaction.reply(`🔊 Lautstärke gesetzt auf ${newv}%`);
    }
  },

  autoplay: async (interaction, ctx) => {
    const sub = interaction.options.getSubcommand(false);
    const s = ctx.ensureGuildSettings(interaction.guildId);
    if (sub === "add") {
      const url = interaction.options.getString("url");
      s.autoplaylist.push(url);
      ctx.scheduleSaveGuildSettings();
      await interaction.reply("✅ hinzugefügt");
    } else if (sub === "remove") {
      const idx = interaction.options.getInteger("index");
      if (Number.isFinite(idx) && idx >= 1 && idx <= s.autoplaylist.length) {
        s.autoplaylist.splice(idx - 1, 1);
        if (s.autoplayIndex >= s.autoplaylist.length) s.autoplayIndex = 0;
        ctx.scheduleSaveGuildSettings();
        await interaction.reply("✅ entfernt");
      } else {
        await interaction.reply("Ungültiger Index");
      }
    } else if (sub === "list") {
      await interaction.reply("Autoplay:\n" + (s.autoplaylist.map((u, i) => `${i + 1}. ${u}`).join("\n") || "leer"));
    } else if (sub === "clear") {
      s.autoplaylist = [];
      s.autoplayIndex = 0;
      ctx.scheduleSaveGuildSettings();
      await interaction.reply("✅ geleert");
    } else {
      await interaction.reply("Unbekannter Subcommand");
    }
  },

  help: async (interaction, ctx) => {
    await interaction.reply({ content: "Nutze das Webinterface oder !help für Details.", ephemeral: true });
  },

  // Ping handler
  ping: async (interaction, ctx) => {
    await interaction.deferReply();
    try {
      const start = Date.now();
      // Discord WS ping
      const wsPing = ctx.client.ws?.ping ?? null;
      // Lavalink status
      const lavalinkNodes = ctx.client.lavalink?.nodes || new Map();
      const lavalinkStatus = lavalinkNodes.size ? Array.from(lavalinkNodes.values()).map(n => `${n.id}:${n.connected ? "ok" : "down"}`).join(", ") : "no-nodes";
      // process stats
      const mem = process.memoryUsage().rss;
      const memMB = (mem / 1024 / 1024).toFixed(2);
      const uptimeH = (process.uptime() / 3600).toFixed(2);

      const latency = Date.now() - start;
      await interaction.editReply(`Pong — RTT ${latency}ms; WS ${wsPing ?? "n/a"}ms; Lavalink: ${lavalinkStatus}; RAM ${memMB} MB; Uptime ${uptimeH} h`);
    } catch (e) {
      await interaction.editReply("Fehler beim Ping: " + (e && e.message));
    }
  }
};

module.exports = { commands, handlers };
