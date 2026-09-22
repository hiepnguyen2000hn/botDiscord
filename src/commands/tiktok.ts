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
import { ApifyClient } from 'apify-client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { processVideo } from '../utils/videoProcessor';

const ACTOR_ID = 'clockworks~tiktok-scraper';

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function downloadVideo(tiktokUrl: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use template so yt-dlp writes the actual extension it chooses
    const outTemplate = outPath.replace(/\.mp4$/, '.%(ext)s');
    const proc = spawn('yt-dlp', [
      '--no-playlist', '--quiet', '--impersonate', 'chrome',
      '-f', 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outTemplate, tiktokUrl,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); console.error('[yt-dlp]', d.toString().trim()); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 200)}`));
      // Find the actual downloaded file (yt-dlp may use .webp, .mp4, etc.)
      const base = outPath.replace(/\.[^.]+$/, '');
      const exts = ['.mp4', '.webp', '.jpg', '.jpeg', '.png', '.gif'];
      for (const ext of exts) {
        if (fs.existsSync(base + ext)) return resolve(base + ext);
      }
      // fallback: glob-like search
      const dir = path.dirname(base);
      const stem = path.basename(base);
      try {
        const found = fs.readdirSync(dir).find(f => f.startsWith(stem + '.'));
        if (found) return resolve(path.join(dir, found));
      } catch {}
      reject(new Error('Downloaded file not found after yt-dlp'));
    });
  });
}

async function downloadImage(imageUrl: string, outPath: string): Promise<void> {
  const axios = (await import('axios')).default;
  const res = await axios({ url: imageUrl, method: 'GET', responseType: 'stream', timeout: 30000 });
  const writer = fs.createWriteStream(outPath);
  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// TikTok max: 2,073,600 pixels (1080×1920). Scale to fit within that box.
function resizeImage(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-q:v', '2',
      '-y', outputPath,
    ]);
    proc.stderr.on('data', d => console.log('[ffmpeg resize]', d.toString().trim()));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg resize exit ${code}`)));
  });
}

async function uploadToR2(filePath: string, key: string, contentType = 'video/mp4'): Promise<string> {
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
    ContentType: contentType,
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

async function postToBuffer(
  channelId: string,
  text: string,
  mediaUrl: string,
  token: string,
  mediaType: 'video' | 'photo' = 'video',
) {
  const axios = (await import('axios')).default;
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
  const asset = mediaType === 'photo'
    ? { image: { url: mediaUrl } }
    : { video: { url: mediaUrl } };
  const res = await axios.post('https://api.buffer.com/graphql',
    { query: mutation, variables: { input: {
      channelId,
      text,
      mode: 'customScheduled',
      dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      schedulingType: 'automatic',
      needsApproval: false,
      assets: [asset],
    }}},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const result = res.data?.data?.createPost;
  if (result?.post) return { ok: true, id: result.post.id };
  return { ok: false, msg: result?.message ?? 'Unknown error' };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tiktok')
    .setDescription('Crawl TikTok user → chọn video → upload R2 / reup')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Username TikTok').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('limit').setDescription('Số video (mặc định 5, tối đa 10)')
        .setMinValue(1).setMaxValue(10)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const username = interaction.options.getString('username', true).replace('@', '');
    const limit = interaction.options.getInteger('limit') ?? 5;

    try {
      await interaction.deferReply();
    } catch (e: any) {
      // Another bot instance already claimed this interaction
      console.error('[tiktok] deferReply failed (duplicate instance?):', e.code, e.message);
      return;
    }

    if (!process.env.APIFY_API_TOKEN)
      return interaction.editReply('❌ Chưa cấu hình APIFY_API_TOKEN');

    try {
      await interaction.editReply(`⏳ Đang crawl **@${username}**...`);

      const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
      const run = await client.actor(ACTOR_ID).call({
        profiles: [`https://www.tiktok.com/@${username}`],
        resultsPerPage: limit,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      });

      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      if (!items.length)
        return interaction.editReply(`❌ Không tìm thấy **@${username}**`);

      const authorMeta = (items[0] as any).authorMeta ?? {};
      const videos = (items as any[]).slice(0, 10).map((v, i) => {
        // Slideshow = imagePost present, OR videoMeta.duration === 0 (TikTok photo carousel)
        const isSlideshow = !!v.imagePost || v.videoMeta?.duration === 0;
        const coverUrl = v.videoMeta?.coverUrl
          ?? v.imagePost?.images?.[0]?.thumbnailUrl
          ?? v.imagePost?.images?.[0]?.url
          ?? null;
        const duration = v.imagePost
          ? `${v.imagePost.images?.length ?? '?'} ảnh`
          : v.videoMeta?.duration
            ? `${v.videoMeta.duration}s`
            : '?s';
        return {
          index:       i,
          id:          String(v.id),
          url:         v.webVideoUrl ?? `https://www.tiktok.com/@${username}/video/${v.id}`,
          caption:     (v.text ?? '').trim(),
          views:       formatNum(v.playCount ?? 0),
          likes:       formatNum(v.diggCount ?? 0),
          duration,
          cover:       coverUrl,
          isSlideshow,
        };
      });

      // ── Profile embed ──────────────────────────────
      const profileEmbed = new EmbedBuilder()
        .setColor(0x010101)
        .setAuthor({
          name: `@${authorMeta.name ?? username}`,
          iconURL: authorMeta.avatar ?? undefined,
          url: `https://www.tiktok.com/@${username}`,
        })
        .setThumbnail(authorMeta.avatar ?? null)
        .setTitle(authorMeta.nickName ?? username)
        .setDescription(authorMeta.signature || '​')
        .addFields(
          { name: '👥 Followers', value: formatNum(authorMeta.fans ?? 0),  inline: true },
          { name: '❤️ Likes',     value: formatNum(authorMeta.heart ?? 0), inline: true },
          { name: '📹 Videos',    value: formatNum(authorMeta.video ?? 0), inline: true },
        );

      // ── Post embeds ───────────────────────────────
      const videoEmbeds = videos.slice(0, 5).map(v =>
        new EmbedBuilder()
          .setColor(v.isSlideshow ? 0x6e40c9 : 0xfe2c55)
          .setTitle(`${v.isSlideshow ? '🖼️' : '🎬'} #${v.index + 1} ${v.caption.slice(0, 80)}`)
          .setURL(v.url)
          .setImage(v.cover)
          .addFields(
            { name: '▶️ Views',    value: v.views,    inline: true },
            { name: '❤️ Likes',    value: v.likes,    inline: true },
            { name: '⏱️ Duration', value: v.duration, inline: true },
          )
      );

      // ── Select menu ────────────────────────────────
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('pick_videos')
        .setPlaceholder('📱 Chọn post muốn xử lý...')
        .setMinValues(1)
        .setMaxValues(videos.length)
        .addOptions(videos.map(v => ({
          label:       `#${v.index + 1} ${v.caption.slice(0, 50) || 'No caption'}`,
          description: `▶️ ${v.views} • ⏱️ ${v.duration}`,
          value:       String(v.index),
          emoji:       v.isSlideshow ? '🖼️' : '🎬',
        })));

      const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(selectMenu);

      const profileLinkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(`🎵 @${username}`)
          .setURL(`https://www.tiktok.com/@${username}`)
          .setStyle(ButtonStyle.Link),
      );

      const reply = await interaction.editReply({
        content: '**Chọn video muốn xử lý rồi nhấn Submit:**',
        embeds: [profileEmbed, ...videoEmbeds],
        components: [selectRow, profileLinkRow],
      });

      // ── Bước 1: user chọn → show confirm panel ────
      const selCollector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 10 * 60 * 1000,
        max: 1,
      });

      selCollector.on('collect', async (sel: StringSelectMenuInteraction) => {
        await sel.deferUpdate();

        const chosen = sel.values.map(Number).map(i => videos[i]);

        // Confirm embed: hiện caption + hashtag của từng video đã chọn
        const confirmEmbed = new EmbedBuilder()
          .setColor(0xf9a825)
          .setTitle(`✅ Đã chọn ${chosen.length} video`)
          .setDescription(
            chosen.map((v, i) =>
              `**${i + 1}. #${v.index + 1}**\n` +
              `> ${v.caption.slice(0, 150) || '*(no caption)*'}\n` +
              `> ▶️ ${v.views} • ⏱️ ${v.duration}`
            ).join('\n\n')
          )
          .setFooter({ text: 'Caption & hashtag sẽ được dùng khi reup' });

        // Action buttons
        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('submit_r2')
            .setLabel('☁️ Upload R2')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('submit_reup')
            .setLabel('🚀 Upload R2 + Reup TikTok')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('submit_cancel')
            .setLabel('❌ Huỷ')
            .setStyle(ButtonStyle.Danger),
        );

        await interaction.editReply({
          content: '',
          embeds: [confirmEmbed],
          components: [actionRow],
        });

        // ── Bước 2: user nhấn Submit ─────────────────
        const btnCollector = reply.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 5 * 60 * 1000,
          max: 1,
        });

        btnCollector.on('collect', async (btn: ButtonInteraction) => {
          try {
          if (btn.customId === 'submit_cancel') {
            await btn.update({ content: '❌ Đã huỷ.', embeds: [], components: [] });
            return;
          }

          const doReup = btn.customId === 'submit_reup';
          await btn.deferUpdate();
          await interaction.editReply({ content: `⏳ Đang xử lý **${chosen.length} video**...`, embeds: [], components: [] });

          const results: string[] = [];

          for (let i = 0; i < chosen.length; i++) {
            const v = chosen[i];
            const rawPath       = path.join(os.tmpdir(), `tiktok_raw_${v.id}.mp4`);
            const processedPath = path.join(os.tmpdir(), `tiktok_${v.id}.mp4`);
            const coverPath     = path.join(os.tmpdir(), `tiktok_cover_${v.id}.jpg`);
            const coverResized  = path.join(os.tmpdir(), `tiktok_cover_resized_${v.id}.jpg`);
            let actualRawPath   = rawPath;
            try {
              // ── Slideshow/Carousel: dùng cover image thay vì yt-dlp ──
              if (v.isSlideshow) {
                if (!v.cover) throw new Error('Slide post không có cover image');

                await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] 🖼️ Downloading cover image...`);
                await downloadImage(v.cover, coverPath);
                await resizeImage(coverPath, coverResized);

                await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] ☁️ Uploading R2...`);
                const r2Key = `images/tiktok_${v.id}.jpg`;
                const r2Url = await uploadToR2(coverResized, r2Key, 'image/jpeg');

                let line = `🖼️ **#${v.index + 1}** (slide) → [R2](${r2Url})`;

                if (doReup && process.env.BUFFER_ACCESS_TOKEN) {
                  await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] 🚀 Posting Buffer (photo)...`);
                  const bufResult = await postToBuffer(
                    '6a50bc4940483446288e6b62',
                    v.caption,
                    r2Url,
                    process.env.BUFFER_ACCESS_TOKEN,
                    'photo',
                  );
                  line += bufResult.ok
                    ? ` • 🚀 Buffer OK (${bufResult.id})`
                    : ` • ⚠️ Buffer: ${bufResult.msg}`;
                }

                results.push(line);
                continue;
              }

              // ── Video thường ──────────────────────────────────────────
              await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] ⬇️ Downloading \`${v.caption.slice(0, 40)}\`...`);
              actualRawPath = await downloadVideo(v.url, rawPath);

              await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] 🎬 Processing video...`);
              await processVideo(actualRawPath, processedPath);
              if (fs.existsSync(actualRawPath)) fs.unlinkSync(actualRawPath);

              await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] ☁️ Uploading R2...`);
              const r2Key = `videos/tiktok_${v.id}.mp4`;
              const r2Url = await uploadToR2(processedPath, r2Key, 'video/mp4');

              let line = `✅ **#${v.index + 1}** → [R2](${r2Url})`;

              if (doReup && process.env.BUFFER_ACCESS_TOKEN) {
                await interaction.editReply(`⏳ [${i + 1}/${chosen.length}] 🚀 Posting Buffer...`);
                const bufResult = await postToBuffer(
                  '6a50bc4940483446288e6b62',
                  v.caption,
                  r2Url,
                  process.env.BUFFER_ACCESS_TOKEN,
                  'video',
                );
                line += bufResult.ok
                  ? ` • 🚀 Buffer OK (${bufResult.id})`
                  : ` • ⚠️ Buffer: ${bufResult.msg}`;
              }

              results.push(line);
            } catch (e: any) {
              results.push(`❌ **#${v.index + 1}** — ${e.message}`);
            } finally {
              if (fs.existsSync(actualRawPath))  fs.unlinkSync(actualRawPath);
              if (fs.existsSync(rawPath))        fs.unlinkSync(rawPath);
              if (fs.existsSync(processedPath))  fs.unlinkSync(processedPath);
              if (fs.existsSync(coverPath))      fs.unlinkSync(coverPath);
              if (fs.existsSync(coverResized))   fs.unlinkSync(coverResized);
            }
          }

          const doneEmbed = new EmbedBuilder()
            .setColor(0x43b581)
            .setTitle(`☁️ Hoàn tất — ${chosen.length} video`)
            .setDescription(results.join('\n'));

          await interaction.editReply({ content: '', embeds: [doneEmbed], components: [] });
          } catch (e: any) {
            console.error('[tiktok] btn handler error:', e.message);
            try { await interaction.editReply(`❌ Lỗi xử lý: ${e.message}`); } catch {}
          }
        });
      });

    } catch (err: any) {
      console.error('TikTok error:', err);
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
    }
  },
};
