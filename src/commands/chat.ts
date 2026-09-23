import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import axios from 'axios';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function proxyHeaders() {
  return {
    Authorization: `Bearer ${process.env.PROXY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchModels(): Promise<string[]> {
  try {
    const res = await axios.get(`${process.env.PROXY_API_URL}/v1/models`, {
      headers: proxyHeaders(),
      timeout: 5000,
    });
    return (res.data?.data ?? []).map((m: any) => m.id as string).sort();
  } catch {
    return [];
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat với AI model qua Proxy')
    .addStringOption(opt =>
      opt.setName('message').setDescription('Tin nhắn của bạn').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('model')
        .setDescription(`Model AI (mặc định: ${DEFAULT_MODEL})`)
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('system')
        .setDescription('System prompt (tùy chọn)')
        .setRequired(false)
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const models = await fetchModels();
    const filtered = models
      .filter(m => m.toLowerCase().includes(focused))
      .slice(0, 25);
    await interaction.respond(filtered.map(m => ({ name: m, value: m })));
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const message = interaction.options.getString('message', true);
    const model   = interaction.options.getString('model') ?? DEFAULT_MODEL;
    const system  = interaction.options.getString('system') ?? null;

    try {
      await interaction.deferReply();
    } catch {
      return;
    }

    try {
      await interaction.editReply(`⏳ Đang gọi **${model}**...`);

      const messages: { role: string; content: string }[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: message });

      const res = await axios.post(
        `${process.env.PROXY_API_URL}/v1/chat/completions`,
        { model, messages, max_tokens: 2048 },
        { headers: proxyHeaders(), timeout: 60000 }
      );

      const reply = res.data?.choices?.[0]?.message?.content ?? '*(no response)*';
      const usage = res.data?.usage;

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `🤖 ${model}` })
        .setDescription(reply.slice(0, 4000))
        .setFooter({
          text: usage
            ? `↑ ${usage.prompt_tokens} tokens  ↓ ${usage.completion_tokens} tokens`
            : model,
        });

      await interaction.editReply({ content: '', embeds: [embed] });
    } catch (err: any) {
      const msg = err.response?.data?.error?.message ?? err.message;
      await interaction.editReply(`❌ Lỗi: ${msg}`).catch(() => {});
    }
  },
};
