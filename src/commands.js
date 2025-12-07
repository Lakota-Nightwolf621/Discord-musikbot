// commands.js
const { SlashCommandBuilder, ChannelType } = require("discord.js");

/**
 * Build an array of SlashCommandBuilder objects.
 * Ensure every builder has a valid description string before calling toJSON().
 */
const builders = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Spielt einen Song oder fügt ihn zur Queue hinzu.")
    .addStringOption(o => o.setName("query").setDescription("YouTube-Link oder Suchbegriff").setRequired(true)),

  new SlashCommandBuilder()
    .setName("np")
    .setDescription("Zeigt den aktuell spielenden Track."),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Überspringt den aktuellen Song."),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stoppt die Wiedergabe und leert die Queue."),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Lässt den Bot den Voice-Channel verlassen."),

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

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Zeigt die Hilfeübersicht."),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Zeigt Latenz, Prozess- und Lavalink-Status.")
];

// Validate and ensure descriptions are strings, then export JSON
for (const b of builders) {
  // If description is missing or not a string, set a safe default
  try {
    const desc = b.description;
    if (typeof desc !== "string" || desc.trim() === "") {
      // fallback default
      b.setDescription("No description provided.");
    }
  } catch (e) {
    // Some versions of the builder may not expose .description; ignore and continue
    try { b.setDescription("No description provided."); } catch {}
  }
}

const commands = builders.map(b => b.toJSON());

module.exports = { commands };
