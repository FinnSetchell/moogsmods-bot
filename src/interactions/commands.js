// Type-2 interactions: context-menu commands (Timeout & Purge, Remove Timeout,
// Warn User, Edit Message) and slash commands (announce, lock/unlock, slowmode),
// plus the public support commands. Most just open a modal; the inline ones
// (Remove Timeout, lock/unlock, slowmode) perform a single fast action.

import { LOG_CHANNEL } from '../config.js';
import { discordRequest, ephemeral } from '../discord.js';
import { parseDuration, formatDuration } from '../util.js';
import { textInputRow } from '../components.js';
import { lockChannel } from '../moderation.js';
import { SUPPORT_EMBEDS } from './support.js';

export async function handleCommand(interaction, env) {
  if (interaction.data.name === 'Timeout & Purge') {
    const messageId  = interaction.data.target_id;
    const message    = interaction.data.resolved?.messages?.[messageId];
    const targetUser = message?.author;
    if (!targetUser) return ephemeral('Could not resolve target user.');

    return Response.json({
      type: 9,
      data: {
        custom_id: `purge_modal:${interaction.guild_id}:${targetUser.id}`,
        title: `Purge: ${targetUser.username}`.slice(0, 45),
        components: [
          textInputRow('timeout_duration', 'Timeout Duration (e.g. 1h 24h 7d none)', '24h'),
          textInputRow('delete_period',    'Delete Messages From Last (e.g. 1h 24h 7d)', '24h'),
          textInputRow('reason',           'Reason', 'Spam / phishing links'),
        ],
      },
    });
  }

  if (interaction.data.name === 'Remove Timeout') {
    const messageId  = interaction.data.target_id;
    const message    = interaction.data.resolved?.messages?.[messageId];
    const targetUser = message?.author;
    if (!targetUser) return ephemeral('Could not resolve target user.');

    const guildId = interaction.guild_id;
    const actorId = interaction.member?.user?.id ?? interaction.user?.id;

    // Removing a timeout is a single fast PATCH, so do it inline within Discord's
    // 3-second interaction window and return the result directly.
    let resultContent;
    try {
      await discordRequest(env, 'PATCH', `/guilds/${guildId}/members/${targetUser.id}`, {
        communication_disabled_until: null,
      });
      resultContent = `✅ Timeout removed for <@${targetUser.id}> by <@${actorId}>.`;
    } catch (err) {
      resultContent = `❌ Failed to remove timeout: ${err.message}`;
    }

    // Log to mod-log channel (fire and forget)
    discordRequest(env, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
      embeds: [{
        title: '🔓 Timeout Removed',
        description: [
          `**User:** <@${targetUser.id}>`,
          `**Action by:** <@${actorId}>`,
        ].join('\n'),
        color: 0x57F287,
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});

    return ephemeral(resultContent);
  }

  if (interaction.data.name === 'Warn User') {
    const messageId  = interaction.data.target_id;
    const message    = interaction.data.resolved?.messages?.[messageId];
    const targetUser = message?.author;
    if (!targetUser) return ephemeral('Could not resolve target user.');

    const guildId = interaction.guild_id;
    return Response.json({
      type: 9,
      data: {
        custom_id: `warn_modal:${guildId}:${targetUser.id}`,
        title: `Warn: ${targetUser.username}`.slice(0, 45),
        components: [
          textInputRow('reason', 'Reason', '', 2),
        ],
      },
    });
  }

  if (interaction.data.name === 'announce') {
    const channelId = interaction.data.options?.find(o => o.name === 'channel')?.value;
    if (!channelId) return ephemeral('No channel provided.');

    return Response.json({
      type: 9,
      data: {
        custom_id: `announce_modal:${channelId}`,
        title: 'Post Custom Announcement',
        components: [
          textInputRow('title',        'Title (optional)',       '',         1, false),
          textInputRow('content',      'Content',               '',         2, true),
          textInputRow('image_url',    'Image URL (optional)',  '',         1, false),
          textInputRow('color',        'Colour (hex)',          '#C20045',  1, false),
          textInputRow('ping_role_id', 'Ping Role ID (optional)', '',       1, false),
        ],
      },
    });
  }

  if (interaction.data.name === 'lock' || interaction.data.name === 'unlock') {
    const isLock    = interaction.data.name === 'lock';
    const channelId = interaction.data.options?.find(o => o.name === 'channel')?.value ?? interaction.channel_id;
    const guildId   = interaction.guild_id;
    const actorId   = interaction.member?.user?.id ?? interaction.user?.id;

    let resultContent;
    try {
      await lockChannel(env, channelId, guildId, isLock);
      resultContent = isLock
        ? `🔒 <#${channelId}> locked by <@${actorId}>.`
        : `🔓 <#${channelId}> unlocked by <@${actorId}>.`;
    } catch (err) {
      resultContent = `❌ Failed: ${err.message}`;
    }

    discordRequest(env, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
      embeds: [{
        title: isLock ? '🔒 Channel Locked' : '🔓 Channel Unlocked',
        description: [`**Channel:** <#${channelId}>`, `**Action by:** <@${actorId}>`].join('\n'),
        color: isLock ? 0xED4245 : 0x57F287,
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});

    return ephemeral(resultContent);
  }

  if (interaction.data.name === 'slowmode') {
    const durationStr = interaction.data.options?.find(o => o.name === 'duration')?.value ?? '0';
    const channelId   = interaction.data.options?.find(o => o.name === 'channel')?.value ?? interaction.channel_id;
    const guildId     = interaction.guild_id;
    const actorId     = interaction.member?.user?.id ?? interaction.user?.id;

    const secs = parseDuration(durationStr);
    if (secs === null) return ephemeral('Invalid duration. Use e.g. `5s`, `30s`, `1m`, `5m`, or `0` to disable.');
    const rateSecs = Math.min(secs, 21600);

    let resultContent;
    try {
      await discordRequest(env, 'PATCH', `/channels/${channelId}`, { rate_limit_per_user: rateSecs });
      resultContent = rateSecs === 0
        ? `✅ Slowmode disabled on <#${channelId}> by <@${actorId}>.`
        : `✅ Slowmode set to **${formatDuration(rateSecs)}** on <#${channelId}> by <@${actorId}>.`;
    } catch (err) {
      resultContent = `❌ Failed: ${err.message}`;
    }

    discordRequest(env, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
      embeds: [{
        title: '🐌 Slowmode Updated',
        description: [
          `**Channel:** <#${channelId}>`,
          `**Slowmode:** ${rateSecs === 0 ? 'disabled' : formatDuration(rateSecs)}`,
          `**Action by:** <@${actorId}>`,
        ].join('\n'),
        color: 0xFEE75C,
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});

    return ephemeral(resultContent);
  }

  if (interaction.data.name === 'Edit Message') {
    const messageId = interaction.data.target_id;
    const channelId = interaction.channel_id;
    const message   = interaction.data.resolved?.messages?.[messageId];

    // Find the first embed that has a meaningful description (skip short CF/MR link embeds)
    const embedIndex = (message?.embeds ?? []).findIndex(e => (e.description ?? '').length > 50);
    const embed      = message?.embeds?.[embedIndex] ?? {};
    const current    = (embed.description ?? '').slice(0, 4000);

    return Response.json({
      type: 9,
      data: {
        custom_id: `edit_modal:${channelId}:${messageId}:${embedIndex < 0 ? 0 : embedIndex}`,
        title: 'Edit Announcement',
        components: [
          textInputRow('description', 'Embed Description', current, 2),
        ],
      },
    });
  }

  // ── Public support commands ───────────────────────────────────────────────
  // Static help replies, visible to everyone in-channel. Content lives in support.js.
  const supportEmbed = SUPPORT_EMBEDS[interaction.data.name];
  if (supportEmbed) {
    return Response.json({ type: 4, data: { embeds: [supportEmbed] } });
  }

  return ephemeral('Unknown command.');
}
