import { REST, Routes } from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const commands: any[] = [];
const commandsPath = path.join(__dirname, '..', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

(async () => {
  console.log('Đang đăng ký slash commands...');
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });
  console.log('✅ Đăng ký thành công!');
})();
