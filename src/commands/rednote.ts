import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from 'discord.js';
import axios from 'axios';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const XHS_HOST = 'xiaohongshu-rednote-data-api2.p.rapidapi.com';

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function xhsHeaders() {
  return {
    'X-RapidAPI-Key': process.env.RAPIDAPI_KEY!,
    'X-RapidAPI-Host': XHS_HOST,
  };
}

async function fetchProfile(idOrUrl: string) {
  const res = await axios.get(`https://${XHS_HOST}/v1/rednote/profiles/profile`, {
    params: { profile_id_or_url: idOrUrl },
    headers: xhsHeaders(),
    timeout: 15000,
  });
  return res.data.data as any;
}

async function fetchVideoPosts(idOrUrl: string, limit: number): Promise<any[]> {
  const videos: any[] = [];
  let cursor: string | undefined;

  while (videos.length < limit) {
    const params: any = { profile_id_or_url: idOrUrl };
    if (cursor) params.cursor = cursor;

    const res = await axios.get(`https://${XHS_HOST}/v1/rednote/profiles/posts`, {
      params,
      headers: xhsHeaders(),
      timeout: 15000,
    });
    const data = res.data.data;
    const notes: any[] = data.notes ?? [];

    for (const n of notes) {
      if (n.type === 'video') {
        videos.push(n);
        if (videos.length >= limit) break;
      }
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    await new Promise(r => setTimeout(r, 800));
  }

  return videos;
}

async function downloadVideoFile(videoUrl: string, outPath: string): Promise<void> {
  const response = await axios({ url: videoUrl, method: 'GET', responseType: 'stream', timeout: 120000 });
  const writer = fs.createWriteStream(outPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function uploadToR2(filePath: string, key: string): Promise<string> {
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: key,
    Body: fs.readFileSync(filePath),
    ContentType: 'video/mp4',
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

async function postToBuffer(channelId: string, text: string, videoUrl: string, token: string) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status } }
        ... on InvalidInputError { message }
        ... on LimitReachedError { message }
        ... on UnexpectedError   { message }
        ... on RestProxyError    { message }
        ... on UnauthorizedError { message }
        ... on NotFoundError     { message }
      }
    }`;
  const res = await axios.post(
    'https://api.buffer.com/graphql',
    {
      query: mutation,
      variables: {
        input: {
          channelId,
          text,
          mode: 'customScheduled',
          dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          schedulingType: 'automatic',
          needsApproval: false,
          assets: [{ video: { url: videoUrl } }],
        },
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const result = res.data?.data?.createPost;
  if (result?.post) return { ok: true, id: result.post.id };
  return { ok: false, msg: result?.message ?? 'Unknown error' };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rednote')
    .setDescription('Crawl RedNote/XHS user → chọn video → upload R2 / reup TikTok')
    .addStringOption(opt =>
      opt.setName('user').setDescription('URL profile hoặc user ID XiaoHongShu').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('limit').setDescription('Số video tối đa cần lấy (mặc định 10, tối đa 25)')
        .setMinValue(1).setMaxValue(25)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const userInput = interaction.options.getString('user', true).trim();
    const limit = interaction.options.getInteger('limit') ?? 10;
    await interaction.deferReply();

    if (!process.env.RAPIDAPI_KEY)
      return interaction.editReply('❌ Chưa cấu hình RAPIDAPI_KEY');

    try {
      await interaction.editReply(`⏳ Đang lấy thông tin **${userInput}** (tối đa ${limit} video)...`);

      const profile = await fetchProfile(userInput);
      await interaction.editReply(`⏳ Đang crawl video posts...`);
      const videoPosts = await fetchVideoPosts(userInput, limit);

      if (!videoPosts.length)
        return interaction.editReply('❌ Không tìm thấy video nào trên profile này');

      const videos = videoPosts.slice(0, 25).map((n: any, i: number) => ({
        index:    i,
        id:       n.id as string,
        url:      `https://www.xiaohongshu.com/explore/${n.id}`,
        videoUrl: (n.video_info_v2?.media?.stream?.h264?.[0]?.master_url ??
                   n.video_info_v2?.media?.stream?.h265?.[0]?.master_url ?? '') as string,
        title:    (n.title ?? n.display_title ?? '').trim(),
        desc:     (n.desc ?? '').trim(),
        cover:    (n.images_list?.[0]?.url_size_large ?? n.video_info_v2?.image?.thumbnail ?? null) as string | null,
        likes:    formatNum(n.likes ?? n.nice_count ?? 0),
        views:    formatNum(n.view_count ?? 0),
        duration: `${n.video_info_v2?.capa?.duration ?? n.video_info_v2?.media?.video?.duration ?? '?'}s`,
      }));

      // ── Profile embed ──────────────────────────────
      const profileEmbed = new EmbedBuilder()
        .setColor(0xff2442)
        .setAuthor({ name: profile.nickname ?? userInput, iconURL: profile.imageb ?? undefined })
        .setThumbnail(profile.imageb ?? null)
        .setTitle(profile.nickname ?? userInput)
        .setDescription(profile.desc || '​')
        .addFields(
          { name: '👥 Followers', value: formatNum(profile.fans ?? 0),      inline: true },
          { name: '❤️ Likes',     value: formatNum(profile.liked ?? 0),     inline: true },
          { name: '📍 Location',  value: profile.ip_location ?? 'N/A',      inline: true },
        );

      // ── Video embeds (first 4) ─────────────────────
      const videoEmbeds = videos.slice(0, 4).map(v =>
        new EmbedBuilder()
          .setColor(0xff2442)
          .setTitle(`#${v.index + 1} ${(v.title || v.desc).slice(0, 80)}`)
          .setURL(v.url)
          .setImage(v.cover)
          .addFields(
            { name: '❤️ Likes',    value: v.likes,    inline: true },
            { name: '▶️ Views',    value: v.views,    inline: true },
            { name: '⏱️ Duration', value: v.duration, inline: true },
          )
      );

      // ── Select menu ────────────────────────────────
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('rednote_pick')
        .setPlaceholder('🎬 Chọn video muốn xử lý...')
        .setMinValues(1)
        .setMaxValues(videos.length)
        .addOptions(videos.map(v => ({
          label:       `#${v.index + 1} ${(v.title || v.desc).slice(0, 50) || 'No title'}`,
          description: `❤️ ${v.likes} • ⏱️ ${v.duration}`,
          value:       String(v.index),
          emoji:       '📷',
        })));

      const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      const profileLinkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(`📕 ${profile.nickname ?? userInput}`)
          .setURL(profile.share_link ?? `https://www.xiaohongshu.com/user/profile/${userInput}`)
          .setStyle(ButtonStyle.Link),
      );

      const reply = await interaction.editReply({
        content: '**Chọn video muốn xử lý rồi nhấn Submit:**',
        embeds: [profileEmbed, ...videoEmbeds],
        components: [selectRow, profileLinkRow],
      });

      // ── Bước 1: user chọn video ────────────────────
      const selCollector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 10 * 60 * 1000,
        max: 1,
      });

      selCollector.on('collect', async (sel: StringSelectMenuInteraction) => {
        await sel.deferUpdate();
        const chosen = sel.values.map(Number).map(i => videos[i]);

        const confirmEmbed = new EmbedBuilder()
          .setColor(0xf9a825)
          .setTitle(`✅ Đã chọn ${chosen.length} video`)
          .setDescription(
            chosen.map((v, i) =>
              `**${i + 1}. #${v.index + 1}**\n` +
              `> ${(v.title || v.desc).slice(0, 150) || '*(no title)*'}\n` +
              `> ❤️ ${v.likes} • ⏱️ ${v.duration}`
            ).join('\n\n')
          )
          .setFooter({ text: 'Caption & hashtag sẽ được dùng khi reup TikTok' });

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('rednote_r2')
            .setLabel('☁️ Upload R2')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('rednote_reup')
            .setLabel('🚀 Upload R2 + Reup TikTok')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('rednote_cancel')
            .setLabel('❌ Huỷ')
            .setStyle(ButtonStyle.Danger),
        );

        await interaction.editReply({ content: '', embeds: [confirmEmbed], components: [actionRow] });

        // ── Bước 2: user nhấn button ──────────────────
        const btnCollector = reply.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 5 * 60 * 1000,
          max: 1,
        });

        btnCollector.on('collect', async (btn: ButtonInteraction) => {
          try {
          if (btn.customId === 'rednote_cancel') {
            await btn.update({ content: '❌ Đã huỷ.', embeds: [], components: [] });
            return;
          }

          const doReup = btn.customId === 'rednote_reup';
          await btn.deferUpdate();
          await interaction.editReply({
            content: `⏳ Đang xử lý **${chosen.length} video**...`,
            embeds: [], components: [],
          });

          const results: string[] = [];

          for (let i = 0; i < chosen.length; i++) {
            const v = chosen[i];
            const tmpPath = path.join(os.tmpdir(), `rednote_${v.id}.mp4`);
            try {
              if (!v.videoUrl)
                throw new Error('Không có URL video trực tiếp');

              await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] ⬇️ Downloading \`${(v.title || v.desc).slice(0, 40)}\`...`);
              await downloadVideoFile(v.videoUrl, tmpPath);

              await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] ☁️ Uploading R2...`);
              const r2Key = `videos/rednote_${v.id}.mp4`;
              const r2Url = await uploadToR2(tmpPath, r2Key);

              let line = `✅ **#${v.index + 1}** → [R2](${r2Url})`;

              if (doReup && process.env.BUFFER_ACCESS_TOKEN) {
                await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] 🚀 Posting Buffer...`);
                const caption = [v.title, v.desc].filter(Boolean).join('\n');
                const bufResult = await postToBuffer(
                  '6a50bc4940483446288e6b62', // TikTok channel ID
                  caption,
                  r2Url,
                  process.env.BUFFER_ACCESS_TOKEN,
                );
                line += bufResult.ok
                  ? ` • 🚀 Buffer OK (${bufResult.id})`
                  : ` • ⚠️ Buffer: ${bufResult.msg}`;
              }

              results.push(line);
            } catch (e: any) {
              results.push(`❌ **#${v.index + 1}** — ${e.message}`);
            } finally {
              if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            }
          }

          const doneEmbed = new EmbedBuilder()
            .setColor(0x43b581)
            .setTitle(`☁️ Hoàn tất — ${chosen.length} video`)
            .setDescription(results.join('\n'));

          await interaction.editReply({ content: '', embeds: [doneEmbed], components: [] });
          } catch (e: any) {
            console.error('[rednote] btn handler error:', e.message);
            try { await interaction.editReply(`❌ Lỗi xử lý: ${e.message}`); } catch {}
          }
        });
      });

    } catch (err: any) {
      console.error('RedNote error:', err);
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
    }
  },
};
