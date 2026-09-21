import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  EmbedBuilder,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import playdl from 'play-dl';

async function getYoutubeUrl(input: string): Promise<{ streamUrl: string; title: string; channel: string; duration: string; thumbnail: string | null; pageUrl: string }> {
  // Nếu là Spotify URL → lấy tên bài → search YouTube
  if (input.includes('spotify.com')) {
    if (playdl.is_expired()) await playdl.refreshToken();
    const spotifyData = await playdl.spotify(input);
    if (spotifyData.type !== 'track') throw new Error('Chỉ hỗ trợ Spotify track URL.');
    const sp = spotifyData as any;
    input = `${sp.name} ${sp.artists[0]?.name ?? ''}`;
  }

  // Nếu là YouTube URL → dùng luôn, nếu là text → search
  let youtubeUrl = input;
  if (!input.includes('youtube.com') && !input.includes('youtu.be')) {
    const results = await playdl.search(input, { source: { youtube: 'video' }, limit: 1 });
    if (!results.length) throw new Error('Không tìm thấy bài hát.');
    youtubeUrl = results[0].url;
  } else {
    // Làm sạch URL, chỉ giữ video ID
    const vid = new URL(input).searchParams.get('v');
    if (vid) youtubeUrl = `https://www.youtube.com/watch?v=${vid}`;
  }

  // Lấy thông tin bài qua yt-dlp
  const info = await new Promise<any>((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', youtubeUrl]);
    let data = '';
    proc.stdout.on('data', (chunk) => (data += chunk));
    proc.stderr.on('data', () => {}); // bỏ qua stderr
    proc.on('close', (code) => {
      if (code !== 0 || !data) return reject(new Error('yt-dlp không lấy được thông tin.'));
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse JSON thất bại.')); }
    });
  });

  return {
    streamUrl: youtubeUrl,
    title: info.title ?? 'Unknown',
    channel: info.channel ?? info.uploader ?? 'Unknown',
    duration: info.duration_string ?? 'Unknown',
    thumbnail: info.thumbnail ?? null,
    pageUrl: youtubeUrl,
  };
}

function createYtdlpStream(url: string) {
  const proc = spawn('yt-dlp', [
    '-f', 'bestaudio[ext=webm]/bestaudio/best',
    '-o', '-',
    '--no-playlist',
    '--quiet',
    url,
  ]);
  return proc.stdout;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Phát nhạc từ Spotify, YouTube hoặc tên bài hát')
    .addStringOption(opt =>
      opt.setName('url')
        .setDescription('URL Spotify/YouTube hoặc tên bài hát')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: '❌ Bạn cần vào Voice Channel trước!', flags: 64 });
    }

    const input = interaction.options.getString('url', true);
    await interaction.deferReply();

    try {
      const track = await getYoutubeUrl(input);

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId!,
        adapterCreator: interaction.guild!.voiceAdapterCreator,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      const audioStream = createYtdlpStream(track.streamUrl);
      const resource = createAudioResource(audioStream, { inputType: StreamType.WebmOpus });
      const player = createAudioPlayer();
      connection.subscribe(player);
      player.play(resource);

      player.once(AudioPlayerStatus.Idle, () => connection.destroy());
      player.once('error', (err) => {
        console.error('Player error:', err);
        connection.destroy();
      });

      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle('🎵 Đang phát')
        .setDescription(`**[${track.title}](${track.pageUrl})**`)
        .addFields(
          { name: 'Kênh', value: track.channel, inline: true },
          { name: 'Thời lượng', value: track.duration, inline: true }
        )
        .setThumbnail(track.thumbnail);

      await interaction.editReply({ embeds: [embed] });
    } catch (err: any) {
      console.error('Play error:', err);
      await interaction.editReply(`❌ ${err.message ?? 'Lỗi khi phát nhạc. Thử lại sau.'}`);
    }
  },
};
