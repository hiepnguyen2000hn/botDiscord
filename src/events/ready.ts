import { Client } from 'discord.js';

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client: Client) {
    console.log(`✅ Bot đã online: ${client.user?.tag}`);
  },
};
