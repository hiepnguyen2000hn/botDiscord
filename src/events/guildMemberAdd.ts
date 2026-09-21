import { GuildMember, EmbedBuilder, TextChannel } from 'discord.js';

module.exports = {
  name: 'guildMemberAdd',
  async execute(member: GuildMember) {
    // Tìm channel tên "general" hoặc "chào-mừng" để gửi tin
    const channel =
      member.guild.channels.cache.find(
        ch => ch.name === 'general' || ch.name === 'chào-mừng' || ch.name === 'welcome'
      ) as TextChannel | undefined;

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('👋 Chào mừng thành viên mới!')
      .setDescription(
        `Xin chào ${member}! Chào mừng bạn đến với **${member.guild.name}** 🎉\nHiện server có **${member.guild.memberCount}** thành viên.`
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  },
};
