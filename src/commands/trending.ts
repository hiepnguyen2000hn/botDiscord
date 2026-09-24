import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import googleTrends from '@alkalisummer/google-trends-js';
import type { TrendingKeyword } from '@alkalisummer/google-trends-js';

const GEO = 'VN';
const TRENDING_HOURS = 24; // GoogleTrendsTrendingHours.oneDay
const MAX_RESULTS = 15;

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'Tr+';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'N+';
  return String(n);
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'vừa xong';
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trending')
    .setDescription('Xem từ khoá đang thịnh hành trên Google Trends Việt Nam (24h qua)'),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
      const res = await googleTrends.realTimeTrends({ geo: GEO, trendingHours: TRENDING_HOURS });

      if (res.error) {
        return interaction.editReply(`❌ Lỗi lấy dữ liệu Google Trends: ${res.error.message}`);
      }

      const keywords: TrendingKeyword[] = (res.data ?? []).slice(0, MAX_RESULTS);

      if (!keywords.length) {
        return interaction.editReply('❌ Không có dữ liệu trending nào trong 24h qua.');
      }

      const lines = keywords.map((k, i) => {
        const growth = k.trafficGrowthRate ? ` • 📈 +${k.trafficGrowthRate}%` : '';
        return `**#${i + 1} ${k.keyword}**\n> 🔍 ${formatNum(k.traffic)} lượt tìm kiếm${growth} • ⏱ ${formatRelativeTime(new Date(k.activeTime))}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x4285f4)
        .setTitle('🔥 Đang thịnh hành — Việt Nam (24h qua)')
        .setDescription(lines.join('\n\n').slice(0, 4000))
        .setFooter({ text: 'Nguồn: Google Trends • Bấm số bên dưới để xem bài viết liên quan' })
        .setTimestamp();

      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let i = 0; i < keywords.length; i += 5) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          keywords.slice(i, i + 5).map((_, j) =>
            new ButtonBuilder()
              .setCustomId(`trending_art_${i + j}`)
              .setLabel(`#${i + j + 1}`)
              .setStyle(ButtonStyle.Secondary)
          )
        );
        rows.push(row);
      }

      const reply = await interaction.editReply({ embeds: [embed], components: rows });

      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 10 * 60 * 1000,
      });

      collector.on('collect', async (btn: ButtonInteraction) => {
        const idx = Number(btn.customId.replace('trending_art_', ''));
        const keyword = keywords[idx];
        if (!keyword) return;

        await btn.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const artRes = await googleTrends.trendingArticles({
            articleKeys: keyword.articleKeys,
            articleCount: 3,
          });

          if (artRes.error || !artRes.data?.length) {
            await btn.editReply(`❌ Không tìm thấy bài viết liên quan cho **${keyword.keyword}**.`);
            return;
          }

          const articleEmbeds = artRes.data.slice(0, 3).map(a =>
            new EmbedBuilder()
              .setColor(0x4285f4)
              .setTitle(a.title.slice(0, 256))
              .setURL(a.link)
              .setAuthor({ name: a.mediaCompany })
              .setImage(a.image || null)
          );

          await btn.editReply({ content: `📰 Bài viết liên quan đến **${keyword.keyword}**`, embeds: articleEmbeds });
        } catch (err: any) {
          console.error('Trending articles error:', err);
          await btn.editReply(`❌ Lỗi: ${err.message}`);
        }
      });
    } catch (err: any) {
      console.error('Trending error:', err);
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
    }
  },
};
