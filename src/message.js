// message.js
// Registriert Slash-Commands, Interaction-Handler (Buttons + Slash) und Prefix-Commands.
// Erwartet beim Aufruf ein ctx-Objekt mit: client, COMMAND_PREFIX, DISCORD_TOKEN, handlePlay, handleSkip, handleStop, handleLeave, ensureGuildSettings, scheduleSaveGuildSettings, setGuildVolume, playerMessages (Map)

const { REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const os = require("os");
const { commands, handlers: commandHandlers } = require("./commands");

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
    if (!ms || Number(ms) <= 0) return "0:00";
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 1000 / 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function getPlayerPosition(player) {
    try {
      return Number(player?.position ?? player?.state?.position ?? player?.state?.playbackDuration ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  function createNowPlayingEmbed(track, player, status = "Spielt gerade") {
    const slider = "▬".repeat(15).split("");
    const length = Number(track?.info?.length ?? track?.info?.duration ?? 0);
    const pos = Number(getPlayerPosition(player) || 0);
    if (length > 0) {
      const pct = Math.min(pos / length, 1);
      const idx = Math.floor(pct * 15);
      if (idx >= 0 && idx < 15) slider[idx] = "🔘";
    }
    return new EmbedBuilder()
      .setColor(0xff0033)
      .setTitle("🎶 " + status)
      .setDescription(`**[${track?.info?.title || "Unbekannt"}](${track?.info?.uri || ""})**\nby ${track?.info?.author || "?"}`)
      .addFields(
        { name: "Zeit", value: `\`${formatMs(pos)} / ${formatMs(length)}\``, inline: true },
        { name: "Volume", value: `\`${player?.volume ?? "n/a"}%\``, inline: true },
        { name: "Fortschritt", value: slider.join(""), inline: false }
      )
      .setThumbnail(track?.info?.artworkUrl || null)
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
        { name: "Slash", value: "`/play <query>`, `/np`, `/skip`, `/stop`, `/leave`, `/setvoice`, `/settext`, `/volume`, `/autoplay`, `/about`" },
        { name: "Prefix", value: `\`${prefix}play\`, \`${prefix}np\`, \`${prefix}skip\`, \`${prefix}stop\`, \`${prefix}help\`, \`${prefix}about\`` }
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
            try {
              if (player.paused) {
                // currently paused -> unpause
                if (typeof player.pause === "function") {
                  await player.pause(false);
                  await interaction.update({ components: [createButtons(false)] });
                } else if (typeof player.play === "function") {
                  await player.play();
                  await interaction.update({ components: [createButtons(false)] });
                } else {
                  await interaction.reply({ content: "Unpause nicht unterstützt.", ephemeral: true });
                }
              } else {
                // currently playing -> pause
                if (typeof player.pause === "function") {
                  await player.pause(true);
                  await interaction.update({ components: [createButtons(true)] });
                } else {
                  await interaction.reply({ content: "Pause nicht unterstützt.", ephemeral: true });
                }
              }
            } catch (e) {
              await interaction.reply({ content: "Fehler: " + (e?.message || e), ephemeral: true });
            }
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

      // Slash commands
      if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
        const name = interaction.commandName;

        // Delegate to commandHandlers if available (commands.js handlers are minimal)
        if (commandHandlers && typeof commandHandlers[name] === "function") {
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
          return await commandHandlers[name](interaction, hctx);
        }

        // Fallbacks for built-in commands if not handled above
        if (name === "play") {
          await interaction.deferReply();
          const query = interaction.options.getString("query");
          try {
            const track = await handlePlay(interaction.guild, interaction.member, query, interaction.channelId);
            await interaction.editReply(`✅ **${track.info.title}** wurde zur Queue hinzugefügt.`);
          } catch (e) {
            await interaction.editReply("Fehler: " + (e && e.message));
          }
          return;
        }

        if (name === "np") {
          const p = client.lavalink.getPlayer(interaction.guildId);
          if (!p || !p.queue.current) return interaction.reply("Stille.");
          const embed = createNowPlayingEmbed(p.queue.current, p, p.paused ? "Pausiert" : "Spielt gerade");
          const msg = await interaction.reply({ embeds: [embed], components: [createButtons(p.paused)], fetchReply: true });
          playerMessages.set(interaction.guildId, msg);
          return;
        }

        if (name === "about") {
          try {
            const mem = process.memoryUsage().rss;
            const memMB = (mem / 1024 / 1024).toFixed(2);
            const cpu = (os.loadavg && os.loadavg()[0]) ? os.loadavg()[0].toFixed(2) : "n/a";
            const uptimeH = (process.uptime() / 3600).toFixed(2);
            const embed = new EmbedBuilder()
              .setTitle("ℹ️ About")
              .setDescription("Nightwolf Entertainments Musikbot Lavalink")
              .addFields(
                { name: "Prefix", value: `\`${COMMAND_PREFIX}\``, inline: true },
                { name: "RAM (RSS)", value: `\`${memMB} MB\``, inline: true },
                { name: "CPU Load (1m)", value: `\`${cpu}\``, inline: true },
                { name: "Hoster", value: `\`https://lakotanightwolf.de\``, inline: true },
              )
              .setColor(0x5865f2)
              .setFooter({ text: "Nightwolf Entertainments", iconURL: client.user?.displayAvatarURL() });
            await interaction.reply({ embeds: [embed], ephemeral: false });
          } catch (e) {
            await interaction.reply({ content: "Fehler beim Abrufen der Systemdaten: " + (e && e.message), ephemeral: true });
          }
          return;
        }

        // other commands handled earlier
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
      // PING (prefix)
      if (cmd === "ping") {
        const start = Date.now();
        const sent = await message.reply("Pong...");
        const rtt = Date.now() - start;
        const wsPing = client.ws?.ping ?? "n/a";
        const mem = process.memoryUsage().rss;
        const memMB = (mem / 1024 / 1024).toFixed(2);
        const lavalinkNodes = client.lavalink?.nodes || new Map();
        const lavalinkStatus = lavalinkNodes.size ? Array.from(lavalinkNodes.values()).map(n => `${n.id}:${n.connected ? "ok" : "down"}`).join(", ") : "no-nodes";
        try { await sent.edit(`Pong — RTT ${rtt}ms; WS ${wsPing}ms; Lavalink: ${lavalinkStatus}; RAM ${memMB} MB`); } catch {}
        return;
      }

      // PLAY
      if (cmd === "play" || cmd === "p") {
        const query = args.join(" ");
        if (!query) return message.reply("Bitte gib einen Suchbegriff oder Link an.");
        const track = await handlePlay(message.guild, message.member, query, message.channel.id);
        return message.reply(`▶️ **${track.info.title}** wurde zur Queue hinzugefügt.`);
      }

      // NP
      if (cmd === "np") {
        const p = client.lavalink.getPlayer(message.guild.id);
        if (!p || !p.queue.current) return message.reply("Stille.");
        const embed = createNowPlayingEmbed(p.queue.current, p, p.paused ? "Pausiert" : "Spielt gerade");
        const msg = await message.reply({ embeds: [embed], components: [createButtons(p.paused)] });
        playerMessages.set(message.guild.id, msg);
        return;
      }

      // SKIP
      if (cmd === "skip") { await handleSkip(message.guild.id); return message.reply("⏭️ Übersprungen."); }

      // STOP
      if (cmd === "stop") { await handleStop(message.guild.id); return message.reply("⏹️ Gestoppt."); }

      // LEAVE
      if (cmd === "leave") { await handleLeave(message.guild.id); return message.reply("👋 Voice verlassen."); }

      // SETVOICE
      if (cmd === "setvoice") {
        const vc = message.member.voice.channel;
        if (!vc) return message.reply("Bitte gehe zuerst in einen Voice-Channel oder nutze /setvoice <channel>.");
        const s = ensureGuildSettings(message.guild.id); s.voiceChannelId = vc.id; scheduleSaveGuildSettings();
        return message.reply(`🎧 Voice-Channel gesetzt auf **${vc.name}**.`);
      }

      // SETTEXT
      if (cmd === "settext") {
        const s = ensureGuildSettings(message.guild.id); s.textChannelId = message.channel.id; scheduleSaveGuildSettings();
        return message.reply(`💬 Steuer-Textkanal gesetzt auf **${message.channel.name}**.`);
      }

      // ABOUT
      if (cmd === "about") {
        try {
          const mem = process.memoryUsage().rss;
          const memMB = (mem / 1024 / 1024).toFixed(2);
          const cpu = (os.loadavg && os.loadavg()[0]) ? os.loadavg()[0].toFixed(2) : "n/a";
          const uptimeH = (process.uptime() / 3600).toFixed(2);
          const embed = new EmbedBuilder()
            .setTitle("ℹ️ About")
            .setDescription("Nightwolf Entertainments Musikbot — Webinterface & Lavalink")
            .addFields(
              { name: "Prefix", value: `\`${COMMAND_PREFIX}\``, inline: true },
              { name: "RAM (RSS)", value: `\`${memMB} MB\``, inline: true },
              { name: "CPU Load (1m)", value: `\`${cpu}\``, inline: true },
              { name: "Uptime", value: `\`${uptimeH} h\``, inline: true }
            )
            .setColor(0x5865f2)
            .setFooter({ text: "Nightwolf Entertainments", iconURL: client.user?.displayAvatarURL() });
          return message.reply({ embeds: [embed] });
        } catch (e) {
          return message.reply("Fehler beim Abrufen der Systemdaten: " + (e && e.message));
        }
      }

      // HELP
      if (cmd === "help" || cmd === "h") {
        const embed = createHelpEmbed(COMMAND_PREFIX);
        return message.reply({ embeds: [embed] });
      }
    } catch (err) {
      console.error("message handler error:", err);
      try { return message.reply("Fehler: " + (err && err.message)); } catch {}
    }
  });

  // --- NowPlaying update loop (refresh active embeds every 5s) ---
  setInterval(async () => {
    for (const [guildId, msg] of playerMessages.entries()) {
      try {
        const player = client.lavalink.getPlayer(guildId);
        if (!player || !player.queue.current) {
          try { await msg.edit({ content: "✅ **Queue beendet.**", embeds: [], components: [] }); } catch {}
          playerMessages.delete(guildId);
          continue;
        }
        const embed = createNowPlayingEmbed(player.queue.current, player, player.paused ? "Pausiert" : "Spielt gerade");
        await msg.edit({ embeds: [embed], components: [createButtons(player.paused)] }).catch(err => {
          if (err && err.code === 10008) playerMessages.delete(guildId);
        });
      } catch (e) {
        if (e && e.code === 10008) playerMessages.delete(guildId);
      }
    }
  }, 5000);

  // --- register slash commands when client is ready ---
  client.once("ready", async () => {
    try { await registerSlashCommands(); } catch (e) { console.error("Slash-Register failed:", e); }
  });

  // --- return UI factories for index.js if needed ---
  return { createNowPlayingEmbed, createButtons, createHelpEmbed };
};
