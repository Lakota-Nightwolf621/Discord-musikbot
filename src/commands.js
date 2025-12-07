// 
const { SlashCommandBuilder, ChannelType } = require("discord.js");

/**
 * Vollständig definierte Slash-Commands mit Description für Commands und Options.
 */

const builders = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Spielt einen Song oder fügt ihn zur Queue hinzu.")
    .addStringOption(o =>
      o.setName("query")
       .setDescription("YouTube-Link oder Suchbegriff, z. B. 'Never Gonna Give You Up'")
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("np")
    .setDescription("Zeigt den aktuell spielenden Track und Fortschritt."),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Überspringt den aktuellen Song in der Queue."),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stoppt die Wiedergabe und leert die Queue."),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Lässt den Bot den Voice-Channel verlassen."),

  new SlashCommandBuilder()
    .setName("setvoice")
    .setDescription("Setzt den Standard-Voice-Channel für diesen Server.")
    .addChannelOption(o =>
      o.setName("channel")
       .setDescription("Wähle den Voice-Channel, der als Standard gesetzt werden soll")
       .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("settext")
    .setDescription("Setzt den Steuer-Textkanal für Bot-Nachrichten.")
    .addChannelOption(o =>
      o.setName("channel")
       .setDescription("Wähle den Textkanal, der als Steuerkanal gesetzt werden soll")
       .addChannelTypes(ChannelType.GuildText)
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Stellt die Lautstärke des Players ein (0–150%).")
    .addIntegerOption(o =>
      o.setName("value")
       .setDescription("Lautstärke in Prozent (0 bis 150)")
       .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Verwaltet die Autoplay-Liste des Servers.")
    .addSubcommand(sc =>
      sc.setName("add")
        .setDescription("Fügt eine URL zur Autoplay-Liste hinzu")
        .addStringOption(o => o.setName("url").setDescription("Medien-URL (z. B. YouTube)").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("remove")
        .setDescription("Entfernt einen Eintrag aus der Autoplay-Liste")
        .addIntegerOption(o => o.setName("index").setDescription("1-basierter Index des Eintrags").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("list")
        .setDescription("Zeigt die aktuelle Autoplay-Liste an")
    )
    .addSubcommand(sc =>
      sc.setName("clear")
        .setDescription("Leert die Autoplay-Liste")
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Zeigt die Hilfeübersicht mit den wichtigsten Befehlen."),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Zeigt Latenz, Prozess- und Lavalink-Status.")
];

// Serialisieren in JSON für die Registrierung
const commands = builders.map((b, idx) => {
  try {
    return b.toJSON();
  } catch (err) {
    const name = (b && b.name) || `builder_index_${idx}`;
    // Falls serialisierung fehlschlägt, setze eine Default-Description und versuche erneut
    try {
      if (typeof b.setDescription === "function") b.setDescription("No description provided.");
      return b.toJSON();
    } catch (inner) {
      throw new Error(`commands.js: Failed to serialize command ${name} (index ${idx}): ${inner?.message || inner || err?.message || err}`);
    }
  }
});

module.exports = { commands };
