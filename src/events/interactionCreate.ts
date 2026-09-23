import { Interaction } from 'discord.js';
import { BotClient } from '../index';

module.exports = {
  name: 'interactionCreate',
  async execute(interaction: Interaction) {
    // Handle autocomplete
    if (interaction.isAutocomplete()) {
      const client = interaction.client as BotClient;
      const command = client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try { await command.autocomplete(interaction); } catch {}
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const client = interaction.client as BotClient;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const msg = { content: '❌ Có lỗi xảy ra khi thực thi lệnh.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  },
};
