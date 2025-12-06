// message.js
const { REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { commands, handlers } = require("./commands");

/**
 * registerMessageHandlers(ctx)
 * ctx must include:
 * { client, COMMAND_PREFIX, DISCORD_TOKEN, handlePlay, handleSkip, handleStop, handleLeave, ensureGuildSettings, scheduleSaveGuildSettings, setGuildVolume, playerMessages }
 */
module.exports = function registerMessageHandlers(ctx = {}) {
  const {
    client,
    COMMAND_PREFIX = "!",
    DISCORD_TOKEN = process.env.DISCORD_TOKEN,
    handlePlay,
    handleSkip,
    handleStop,
    handleLeave,
    ensureGuildSettings,
    scheduleSaveGuildSettings,
    setGuildVolume,
    playerMessages = new Map()
  } = ctx;

  if (!client) throw new Error("message.js: client is required");

  // --- UI helpers ---
  function formatMs(ms) {
    if (!ms) return "0:00";
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 1000 / 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function createNowPlayingEmbed(track, player, status = "Spielt gerade") {
    const slider = "▬".repeat(15).split("");
    try {
      if (track.info.length > 0) {
        const pct = Math.min(player.position / track.info.length, 1);
        const idx = Math.floor(pct * 15);
        if (idx >= 0 && idx < 15) slider[idx] = "🔘";
      }
    } catch (e) {}
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

  function createHelpEmbed(prefix = COMMAND_PREFIX) {
    return new EmbedBuilder()
      .setTitle("🎵 Musikbot – Hilfe")
      .setDescription("Übersicht über die wichtigsten Befehle.")
      .addFields(
        { name: "Slash", value: "`/play <query>`, `/np`, `/skip`, `/stop`, `/leave`, `/setvoice`, `/settext`, `/volume`, `/autoplay`" },
        { name: "Prefix", value: `\`${prefix}play\`, \`${prefix}np\`, \`${prefix}skip\`, \`${prefix}stop\`, \`${prefix}help\`` }
      )
      .setColor(0x5865f2);
  }

  // --- Slash registration ---
  async function registerSlashCommands() {
    const token = DISCORD_TOKEN || process.env.DISCORD_TOKEN;
    if (!token) {
      console.warn("message.js: Kein DISCORD_TOKEN gefunden, Slash-Commands werden nicht registriert.");
      return;
    }
    try {
      const rest = new REST({ version: "10" }).setToken(token);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log("[message.js] Slash-Commands registriert.");
    } catch (err) {
      console.error("[message.js] Fehler beim Registrieren der Slash-Commands:", err);
    }
  }

  // --- Interaction handler (Buttons + Slash) ---
  client.on("interactionCreate", async (interaction) => {
    try {
      // Buttons
      if (interaction.isButton && interaction.isButton()) {
        const player = client.lavalink.getPlayer(interaction.guildId);
        if (!player) return interaction.reply({ content: "Kein Player vorhanden.", ephemeral: true });

        if (interaction.member && interaction.member.voice && player.voiceChannelId && interaction.member.voice.channelId !== player.voiceChannelId) {
          return interaction.reply({ content: "Du bist nicht im gleichen Voice-Channel.", ephemeral: true });
        }

        switch (interaction.customId) {
          case "pause": {
            const newState = !player.paused;
            await player.pause(newState);
            await interaction.update({ components: [createButtons(newState)] });
            break;
          }
          case "skip": {
            try { await player.skip(); await interaction.reply({ content: "⏭️ Übersprungen.", ephemeral: true }); } catch (e) { await interaction.reply({ content: "Fehler beim Skip: " + (e && e.message), ephemeral: true }); }
            break;
          }
          case "stop": {
            try { await player.stop(); player.queue.clear(); await interaction.update({ content: "⏹️ Gestoppt.", components: [] }); } catch (e) { await interaction.reply({ content: "Fehler beim Stop: " + (e && e.message), ephemeral: true }); }
            break;
          }
          case "list": {
            const q = player.queue.tracks.map((t, i) => `${i + 1}. ${t.info.title}`).join("\n").slice(0, 1900) || "Leer";
            await interaction.reply({ content: `**Queue:**\n${q}`, ephemeral: true });
            break;
          }
          default:
            await interaction.reply({ content: "Unbekannter Button.", ephemeral: true });
        }
        return;
      }

      // Slash commands: dispatch to handlers from commands.js
      if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
        const name = interaction.commandName;
        const handler = handlers[name];
        if (typeof handler === "function") {
          // build ctx for handlers
          const hctx = {
            client,
            handlePlay,
            handleSkip,
            handleStop,
            handleLeave,
            ensureGuildSettings,
            scheduleSaveGuildSettings,
            setGuildVolume
          };
          await handler(interaction, hctx);
        } else {
          await interaction.reply({ content: "Unbekannter Befehl", ephemeral: true });
        }
      }
    } catch (err) {
      console.error("interaction handler error:", err);
      try {
        if (interaction.replied || interaction.deferred) await interaction.editReply("Fehler: " + (err && err.message));
        else await interaction.reply({ content: "Fehler: " + (err && err.message), ephemeral: true });
      } catch {}
    }
  });

  // --- Prefix message handler ---
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
        const track = await handlePlay(message.guild, message.member, query, message.channel.id);
        return message.reply(`▶️ **${track.info.title}** wurde zur Queue hinzugefügt.`);
      }

      if (cmd === "np") {
        const p = client.lavalink.getPlayer(message.guild.id);
        if (!p || !p.queue.current) return message.reply("Stille.");
        const embed = createNowPlayingEmbed(p.queue.current, p, p.paused ? "Pausiert" : "Spielt gerade");
        const msg = await message.reply({ embeds: [embed], components: [createButtons(p.paused)] });
        playerMessages.set(message.guild.id, msg);
        return;
      }

      if (cmd === "skip") { await handleSkip(message.guild.id); return message.reply("⏭️ Übersprungen."); }
      if (cmd === "stop") { await handleStop(message.guild.id); return message.reply("⏹️ Gestoppt."); }
      if (cmd === "leave") { await handleLeave(message.guild.id); return message.reply("👋 Voice verlassen."); }

      if (cmd === "setvoice") {
        const vc = message.member.voice.channel;
        if (!vc) return message.reply("Bitte gehe zuerst in einen Voice-Channel oder nutze /setvoice <channel>.");
        const s = ensureGuildSettings(message.guild.id); s.voiceChannelId = vc.id; scheduleSaveGuildSettings();
        return message.reply(`🎧 Voice-Channel gesetzt auf **${vc.name}**.`);
      }

      if (cmd === "settext") {
        const s = ensureGuildSettings(message.guild.id); s.textChannelId = message.channel.id; scheduleSaveGuildSettings();
        return message.reply(`💬 Steuer-Textkanal gesetzt auf **${message.channel.name}**.`);
      }

      if (cmd === "about") {
        return message.reply(
          "🎵 Nightwolf Entertainments Musikbot – mit Webinterface und Lavalink.\n" +
          `Prefix: \`${COMMAND_PREFIX}\`\n` +
          "Nutze /play oder !play, um Songs abzuspielen."
        );
      }

      if (cmd === "help" || cmd === "h") {
        const embed = createHelpEmbed(COMMAND_PREFIX);
        return message.reply({ embeds: [embed] });
      }
    } catch (err) {
      console.error("message handler error:", err);
      try { return message.reply("Fehler: " + (err && err.message)); } catch {}
    }
  });

  // --- register slash commands when client is ready ---
  client.once("ready", async () => {
    try { await registerSlashCommands(); } catch (e) { console.error("Slash-Register failed:", e); }
  });

  // --- return UI factories for index.js if needed ---
  return { createNowPlayingEmbed, createButtons, createHelpEmbed };
};

