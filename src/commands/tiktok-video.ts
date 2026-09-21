import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  EmbedBuilder,
} from 'discord.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function downloadVideo(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-f', 'best[ext=mp4][filesize<24M]/best[filesize<24M]/best',
      '--no-playlist', '--quiet', '--impersonate', 'chrome',
      '-o', outPath, url,
    ]);
    proc.stderr.on('data', d => console.error('[yt-dlp]', d.toString()));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)));
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tiktok-video')
    .setDescription('Download video TikTok và phát trực tiếp trong Discord')
    .addStringOption(opt =>
      opt.setName('url')
        .setDescription('URL video TikTok')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const url = interaction.options.getString('url', true);

    if (!url.includes('tiktok.com')) {
      return interaction.reply({ content: '❌ Chỉ hỗ trợ URL TikTok!', flags: 64 });
    }

    await interaction.deferReply();
    await interaction.editReply('⏳ Đang download video...');

    const tmpPath = path.join(os.tmpdir(), `tiktok_${Date.now()}.mp4`);

    try {
      await downloadVideo(url, tmpPath);

      const stat = fs.statSync(tmpPath);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

      if (stat.size > 25 * 1024 * 1024) {
        fs.unlinkSync(tmpPath);
        return interaction.editReply('❌ Video quá lớn (>25MB). Discord free giới hạn 25MB.');
      }

      const attachment = new AttachmentBuilder(tmpPath, { name: 'tiktok.mp4' });

      const embed = new EmbedBuilder()
        .setColor(0x010101)
        .setDescription(`🎬 **TikTok Video** • ${sizeMB}MB\n[Xem trên TikTok](${url})`)
        .setFooter({ text: 'Powered by yt-dlp' });

      await interaction.editReply({
        content: '',
        embeds: [embed],
        files: [attachment],
      });

    } catch (err: any) {
      console.error(err);
      await interaction.editReply(`❌ Download thất bại: ${err.message}`);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  },
};
