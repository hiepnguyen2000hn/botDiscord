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
import { extractArticle, generateScript, DEFAULT_SCRIPT_MODEL } from '../utils/scriptGenerator';

const GEO = 'VN';
const TRENDING_HOURS = 24; // GoogleTrendsTrendingHours.oneDay
const MAX_RESULTS = 15;

// Article link keyed by short id, so button customId stays under Discord's 100-char limit.
const articleLinkStore = new Map<string, { title: string; link: string }>();
let articleLinkCounter = 0;

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

          const articles = artRes.data.slice(0, 3);
          const articleEmbeds = articles.map(a =>
            new EmbedBuilder()
              .setColor(0x4285f4)
              .setTitle(a.title.slice(0, 256))
              .setURL(a.link)
              .setAuthor({ name: a.mediaCompany })
              .setImage(a.image || null)
          );

          const scriptRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            articles.map(a => {
              const key = `sw${articleLinkCounter++}`;
              articleLinkStore.set(key, { title: a.title, link: a.link });
              return new ButtonBuilder()
                .setCustomId(`trending_script_${key}`)
                .setLabel(`🎬 Kịch bản: ${a.title.slice(0, 60)}`)
                .setStyle(ButtonStyle.Primary);
            })
          );

          const artReply = await btn.editReply({
            content: `📰 Bài viết liên quan đến **${keyword.keyword}** — bấm nút để tạo kịch bản video từ 1 bài:`,
            embeds: articleEmbeds,
            components: [scriptRow],
          });

          const scriptCollector = artReply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 10 * 60 * 1000,
          });

          scriptCollector.on('collect', async (sBtn: ButtonInteraction) => {
            const key = sBtn.customId.replace('trending_script_', '');
            const target = articleLinkStore.get(key);
            if (!target) {
              await sBtn.reply({ content: '❌ Nút đã hết hạn, bấm lại nút số ở trên để xem bài viết mới.', flags: MessageFlags.Ephemeral });
              return;
            }

            await sBtn.deferReply({ flags: MessageFlags.Ephemeral });
            try {
              const article = await extractArticle(target.link);
              const script = await generateScript(article);

              const scriptEmbed = new EmbedBuilder()
                .setColor(0x43b581)
                .setTitle(article.title.slice(0, 256))
                .setURL(target.link)
                .setDescription(script.slice(0, 4000))
                .setFooter({ text: `Model: ${DEFAULT_SCRIPT_MODEL}` });

              if (article.image) scriptEmbed.setImage(article.image);

              await sBtn.editReply({ embeds: [scriptEmbed] });
            } catch (err: any) {
              console.error('Trending scriptwriter error:', err);
              await sBtn.editReply(`❌ Lỗi tạo kịch bản: ${err.message}`);
            } finally {
              articleLinkStore.delete(key);
            }
          });
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
