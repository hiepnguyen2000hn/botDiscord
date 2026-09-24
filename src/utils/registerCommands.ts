import { REST, Routes } from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const commands: any[] = [];
const commandsPath = path.join(__dirname, '..', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

console.log(`Tìm thấy ${commandFiles.length} file trong ${commandsPath}: ${commandFiles.join(', ')}`);

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
      commands.push(command.data.toJSON());
      console.log(`  ✅ ${file} → /${command.data.name}`);
    } else {
      console.warn(`  ⚠️  ${file} không có "data" export, bị bỏ qua`);
    }
  } catch (err: any) {
    console.error(`  ❌ ${file} lỗi khi load, bị bỏ qua:`, err.message);
  }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

(async () => {
  console.log(`\nĐang đăng ký ${commands.length} slash command: ${commands.map(c => c.name).join(', ')}...`);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });
  console.log('✅ Đăng ký thành công!');
})();
