// commands.js
const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play').addStringOption(o=>o.setName('query').setRequired(true)),
  new SlashCommandBuilder().setName('np').setDescription('Now Playing'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave voice'),
  new SlashCommandBuilder().setName('setvoice').setDescription('Set default voice').addChannelOption(o=>o.setName('channel').addChannelTypes(2,13).setRequired(false)),
  new SlashCommandBuilder().setName('settext').setDescription('Set text channel').addChannelOption(o=>o.setName('channel').addChannelTypes(0).setRequired(false)),
  new SlashCommandBuilder().setName('volume').setDescription('Volume').addIntegerOption(o=>o.setName('value').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('Help'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Autoplay')
    .addSubcommand(sc=>sc.setName('add').addStringOption(o=>o.setName('url').setRequired(true)))
    .addSubcommand(sc=>sc.setName('remove').addIntegerOption(o=>o.setName('index').setRequired(true)))
    .addSubcommand(sc=>sc.setName('list'))
    .addSubcommand(sc=>sc.setName('clear'))
].map(c => c.toJSON());

module.exports = { commands };
