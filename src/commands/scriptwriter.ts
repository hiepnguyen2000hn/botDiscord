import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { extractArticle, generateScript, DEFAULT_SCRIPT_MODEL } from '../utils/scriptGenerator';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scriptwriter')
    .setDescription('Viết kịch bản video ngắn (Hook/Body/CTA) từ 1 bài báo')
    .addStringOption(opt =>
      opt.setName('url').setDescription('Link bài báo').setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const url = interaction.options.getString('url', true).trim();
    await interaction.deferReply();

    try {
      await interaction.editReply('⏳ Đang lấy nội dung bài báo...');
      const article = await extractArticle(url);

      await interaction.editReply('⏳ Đang viết kịch bản...');
      const script = await generateScript(article);

      const embed = new EmbedBuilder()
        .setColor(0x43b581)
        .setTitle(article.title.slice(0, 256))
        .setURL(url)
        .setDescription(script.slice(0, 4000))
        .setFooter({ text: `Model: ${DEFAULT_SCRIPT_MODEL}` });

      if (article.image) embed.setImage(article.image);

      await interaction.editReply({ content: '', embeds: [embed] });
    } catch (err: any) {
      const msg = err.response?.data?.error?.message ?? err.message;
      await interaction.editReply(`❌ Lỗi: ${msg}`).catch(() => {});
    }
  },
};
