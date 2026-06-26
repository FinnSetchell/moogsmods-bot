// Type-5 interactions: modal submissions. Approve/Schedule finalise a release,
// Grouped sends a merged announcement and dispatches each release, and the
// moderation/announce modals do their work in the background (ctx.waitUntil) so
// we can ACK within Discord's 3-second window.

import { DISCORD_API, LOG_CHANNEL } from '../config.js';
import { discordRequest, ephemeral, followUp } from '../discord.js';
import {
  parseDuration, formatDuration, hexColor,
  withFooter, channelLabel, releaseTypeLabel,
} from '../util.js';
import { buildPreviewEmbed } from '../components.js';
import {
  getRelease, cleanupRelease, getGroupedIds, triggerPublish, sendAnnouncement,
} from '../releases.js';
import { timeoutMember, purgeUserMessages } from '../moderation.js';

export async function handleModal(interaction, env, ctx) {
  const customId = interaction.data.custom_id;
  const get = id =>
    interaction.data.components.flatMap(r => r.components).find(c => c.custom_id === id)?.value ?? '';

  // ── Approve modal ──────────────────────────────────────────────────────────
  if (customId.startsWith('approve_modal:')) {
    const releaseId = customId.slice(14);
    const release   = await getRelease(env, releaseId);
    if (!release) return ephemeral('Release data expired.');

    const rawType   = get('release_type').toLowerCase().trim() || release.releaseType || 'minor';
    // 'everyone' is a short alias for 'major_everyone'
    const releaseType = rawType === 'everyone' ? 'major_everyone' : rawType;
    const discordPing = get('discord_ping').trim().toLowerCase() === 'true';
    const changelog   = get('changelog') || release.changelog || '';
    const updated     = { ...release, releaseType, discordPing, changelog };
    await env.RELEASES.put(`release:${releaseId}`, JSON.stringify(updated),
      { expirationTtl: 60 * 60 * 24 * 30 });

    // Dry-run: send to review channel directly, no GitHub dispatch
    if (release.dryRun === true) {
      await sendAnnouncement(env, updated, env.CHANNEL_REVIEW);
      await discordRequest(env, 'PATCH',
        `/channels/${release.reviewChannelId}/messages/${release.reviewMessageId}`, {
          embeds: [withFooter(buildPreviewEmbed(updated),
            `✅ Approved (dry run) — sent to #announcement-review`)],
          components: [],
        }).catch(() => {});
      await cleanupRelease(env, releaseId);
      return ephemeral(`✅ Dry run sent to #announcement-review.`);
    }

    // Update review card to "Publishing..."
    await discordRequest(env, 'PATCH',
      `/channels/${release.reviewChannelId}/messages/${release.reviewMessageId}`, {
        embeds: [withFooter(buildPreviewEmbed(updated),
          `⏳ Publishing — ${releaseTypeLabel(releaseType)} → ${channelLabel(releaseType)}`)],
        components: [],
      }).catch(() => {});

    await triggerPublish(env, updated, releaseId);

    return ephemeral(`⏳ Publishing **${updated.modName} ${updated.version}**...`);
  }

  // ── Grouped send modal ─────────────────────────────────────────────────────
  if (customId === 'grouped_modal') {
    const modName     = get('mod_name');
    const version     = get('version');
    const releaseType = get('release_type').toLowerCase().trim() || 'minor';
    const discordPing = get('discord_ping').trim().toLowerCase() === 'true';
    const changelog   = get('changelog');

    const groupedIds = await getGroupedIds(env);
    if (groupedIds.length === 0) return ephemeral('No grouped releases found in KV.');

    const releases = await Promise.all(groupedIds.map(id => getRelease(env, id)));
    const valid = releases.filter(Boolean);
    if (valid.length === 0) return ephemeral('All release data expired.');

    const firstRelease = valid[0];

    const mcStarts = valid.map(r => r.mcStart).sort();
    const allEnds  = valid.flatMap(r => [r.mcEnd, ...(r.mcExtra ?? [])]).sort();
    const mcStart  = mcStarts[0];
    const mcEnd    = allEnds[allEnds.length - 1];

    const mcVersions = valid.map(r => r.mcVersion).sort();
    const mergedRelease = { ...firstRelease, modName, version, mcStart, mcEnd, releaseType, changelog, mcVersions, discordPing };
    const dryRun = mergedRelease.dryRun === true;

    // Respond to Discord immediately (avoid 3-second timeout), do heavy work in background
    const token = interaction.token;
    ctx.waitUntil((async () => {
      try {
        await sendAnnouncement(env, mergedRelease, dryRun ? env.CHANNEL_REVIEW : null);
      } catch (err) {
        console.error('sendAnnouncement error:', err);
        await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `❌ Announcement failed: ${err.message}` }),
        }).catch(() => {});
        return;
      }

      await Promise.all(
        groupedIds.map(async id => {
          const infoStr = await env.RELEASES.get(`grouped:${id}`);
          const rel = await getRelease(env, id);

          if (rel && !dryRun) {
            // Persist the merged releaseType and mark as grouped so /published skips re-announcing
            const publishRel = { ...rel, releaseType, groupedSend: true };
            await env.RELEASES.put(`release:${id}`, JSON.stringify(publishRel), { expirationTtl: 60 * 60 * 24 * 30 });

            try {
              await triggerPublish(env, publishRel, id);
            } catch (err) {
              console.error(`triggerPublish failed for grouped release ${id}:`, err);
            }

            if (infoStr) {
              const { channelId, messageId } = JSON.parse(infoStr);
              const embed = buildPreviewEmbed(rel);
              await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
                components: [],
                embeds: [withFooter(embed, `⏳ Publishing — grouped as ${modName} ${version}`)],
              }).catch(() => {});
            }
          } else {
            // Dry run or no release data — just mark sent
            if (infoStr) {
              const { channelId, messageId } = JSON.parse(infoStr);
              const embed = rel ? buildPreviewEmbed(rel) : {};
              await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
                components: [],
                embeds: [withFooter(embed, `✅ Sent as grouped (dry run) — ${modName} ${version}`)],
              }).catch(() => {});
            }
            await env.RELEASES.delete(`release:${id}`);
          }

          await env.RELEASES.delete(`grouped:${id}`);
          // release:{id} is kept alive for /published to clean up (unless dry run above deleted it)
        })
      );
      await env.RELEASES.delete('grouped_ids');

      const sendMsgStr = await env.RELEASES.get('grouped_send_msg');
      if (sendMsgStr) {
        const { channelId, messageId } = JSON.parse(sendMsgStr);
        await discordRequest(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`, null).catch(() => {});
        await env.RELEASES.delete('grouped_send_msg');
      }

      await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `✅ Grouped release sent for **${modName} ${version}**!` }),
      }).catch(() => {});
    })());

    // Deferred ephemeral response — Discord shows a loading state immediately
    return Response.json({ type: 5, data: { flags: 64 } });
  }

  // ── Edit message modal ─────────────────────────────────────────────────────
  if (customId.startsWith('edit_modal:')) {
    const parts       = customId.split(':');
    const channelId   = parts[1];
    const messageId   = parts[2];
    const embedIndex  = parseInt(parts[3], 10) || 0;
    const newDesc     = get('description');

    const message = await discordRequest(env, 'GET', `/channels/${channelId}/messages/${messageId}`);
    const embeds  = (message.embeds ?? []).map((e, i) =>
      i === embedIndex ? { ...e, description: newDesc } : e
    );

    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, { embeds });
    return ephemeral('✅ Message updated.');
  }

  // ── Timeout & Purge modal ──────────────────────────────────────────────────
  if (customId.startsWith('purge_modal:')) {
    const [, guildId, userId] = customId.split(':');
    const timeoutStr = get('timeout_duration').trim();
    const deleteStr  = get('delete_period').trim();
    const reason     = get('reason').trim() || 'No reason given';

    const timeoutSecs = parseDuration(timeoutStr);
    const deleteSecs  = parseDuration(deleteStr);

    if (timeoutSecs === null) return ephemeral('Invalid timeout. Use e.g. 1h, 24h, 7d, none.');
    if (deleteSecs  === null) return ephemeral('Invalid delete period. Use e.g. 1h, 24h, 7d, none.');
    if (timeoutSecs === 0 && deleteSecs === 0) return ephemeral('Nothing to do — both timeout and delete are set to none.');

    const token       = interaction.token;
    const actorId     = interaction.member?.user?.id ?? interaction.user?.id;

    ctx.waitUntil((async () => {
      const errors = [];
      let timeoutApplied = false;
      let totalDeleted   = 0;

      if (timeoutSecs > 0) {
        try {
          await timeoutMember(env, guildId, userId, timeoutSecs);
          timeoutApplied = true;
        } catch (err) {
          errors.push(`Timeout failed: ${err.message}`);
        }
      }

      if (deleteSecs > 0) {
        try {
          totalDeleted = await purgeUserMessages(env, guildId, userId, deleteSecs);
        } catch (err) {
          errors.push(`Purge failed: ${err.message}`);
        }
      }

      const timeoutLabel = timeoutSecs > 0 ? formatDuration(timeoutSecs) : 'none';
      const deleteLabel  = deleteSecs  > 0 ? deleteStr                   : 'none';

      // Log to mod-log channel
      await discordRequest(env, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
        embeds: [{
          title: '🚨 Spam Purge',
          description: [
            `**User:** <@${userId}>`,
            `**Reason:** ${reason}`,
            `**Timeout:** ${timeoutLabel}`,
            `**Messages deleted:** ${totalDeleted} (last ${deleteLabel})`,
            `**Action by:** <@${actorId}>`,
            ...(errors.length ? [`**Errors:** ${errors.join(', ')}`] : []),
          ].join('\n'),
          color: 0xFF4444,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});

      const summary = [
        timeoutSecs > 0 ? `⏱ <@${userId}> timed out for **${timeoutLabel}**` : null,
        deleteSecs  > 0 ? `🗑 Deleted **${totalDeleted}** messages (last ${deleteLabel})` : null,
        ...errors.map(e => `⚠️ ${e}`),
      ].filter(Boolean).join('\n');

      await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: summary }),
      }).catch(() => {});
    })());

    return Response.json({ type: 5, data: { flags: 64 } });
  }

  // ── Warn User modal ────────────────────────────────────────────────────────
  if (customId.startsWith('warn_modal:')) {
    const [, guildId, userId] = customId.split(':');
    const reason   = get('reason').trim() || 'No reason given';
    const actorId  = interaction.member?.user?.id ?? interaction.user?.id;

    // Load existing warns
    const existing = await env.RELEASES.get(`warns:${guildId}:${userId}`);
    const warns    = existing ? JSON.parse(existing) : [];
    warns.push({ reason, timestamp: new Date().toISOString(), by: actorId });
    await env.RELEASES.put(`warns:${guildId}:${userId}`, JSON.stringify(warns));

    // Attempt DM
    try {
      const dmChannel = await discordRequest(env, 'POST', '/users/@me/channels', { recipient_id: userId });
      await discordRequest(env, 'POST', `/channels/${dmChannel.id}/messages`, {
        embeds: [{
          title: '⚠️ Warning Issued',
          description: `You have received a warning in Moog's Mods.\n\n**Reason:** ${reason}`,
          color: 0xFEE75C,
          timestamp: new Date().toISOString(),
        }],
      });
    } catch {
      // DMs may be disabled — silently ignore
    }

    // Log
    await discordRequest(env, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
      embeds: [{
        title: '⚠️ User Warned',
        description: [
          `**User:** <@${userId}>`,
          `**Reason:** ${reason}`,
          `**Total warnings:** ${warns.length}`,
          `**Action by:** <@${actorId}>`,
        ].join('\n'),
        color: 0xFEE75C,
        timestamp: new Date().toISOString(),
      }],
    }).catch(() => {});

    return ephemeral(`⚠️ <@${userId}> warned. Total warnings: ${warns.length}`);
  }

  // ── Announce modal ─────────────────────────────────────────────────────────
  if (customId.startsWith('announce_modal:')) {
    const channelId  = customId.slice(15);
    const title      = get('title').trim();
    const content    = get('content').trim();
    const imageUrl   = get('image_url').trim();
    const colorStr   = get('color').trim() || '#C20045';
    const pingRoleId = get('ping_role_id').trim();
    const actorId    = interaction.member?.user?.id ?? interaction.user?.id;
    const token      = interaction.token;

    if (!content) return ephemeral('Content is required.');

    const color  = hexColor(colorStr);
    const embed  = { description: content, color };
    if (title)    embed.title = title;
    if (imageUrl) embed.image = { url: imageUrl };

    const payload = { embeds: [embed] };
    if (pingRoleId) {
      payload.content = `<@&${pingRoleId}>`;
      payload.allowed_mentions = { parse: [], roles: [pingRoleId] };
    }

    ctx.waitUntil((async () => {
      try {
        await discordRequest(env, 'POST', `/channels/${channelId}/messages`, payload);
      } catch (err) {
        await followUp(env, token, `❌ Failed to post announcement: ${err.message}`);
        return;
      }

      await discordRequest(env, 'POST', `/channels/${LOG_CHANNEL}/messages`, {
        embeds: [{
          title: '📣 Custom Announcement Posted',
          description: `**Channel:** <#${channelId}>\n**By:** <@${actorId}>`,
          color: 0xC20045,
          timestamp: new Date().toISOString(),
        }],
      }).catch(() => {});

      await followUp(env, token, `✅ Announcement posted in <#${channelId}>.`);
    })());

    return Response.json({ type: 5, data: { flags: 64 } });
  }

  // ── Schedule modal ─────────────────────────────────────────────────────────
  if (customId.startsWith('schedule_modal:')) {
    const releaseId = customId.slice(15);
    const release   = await getRelease(env, releaseId);
    if (!release) return ephemeral('Release data expired.');

    const rawType    = get('release_type').toLowerCase().trim() || release.releaseType || 'minor';
    const releaseType = rawType === 'everyone' ? 'major_everyone' : rawType;
    const discordPing = get('discord_ping').trim().toLowerCase() === 'true';
    const changelog   = get('changelog') || release.changelog || '';
    const sendInStr   = get('send_in').trim() || '24h';

    const secs = parseDuration(sendInStr);
    if (!secs || secs <= 0) return ephemeral('Invalid delay. Use e.g. `2h`, `12h`, `24h`.');

    const updatedRelease = { ...release, releaseType, discordPing, changelog };
    const scheduledAt    = Date.now() + secs * 1000;

    await env.RELEASES.put(
      `scheduled:${releaseId}`,
      JSON.stringify({ ...updatedRelease, scheduledAt }),
      { expirationTtl: secs + 3600 },
    );

    // Update review card
    await discordRequest(env, 'PATCH',
      `/channels/${release.reviewChannelId}/messages/${release.reviewMessageId}`, {
        embeds: [withFooter(buildPreviewEmbed(updatedRelease),
          `⏰ Scheduled — publishes in ${formatDuration(secs)}`)],
        components: [],
      }).catch(() => {});

    return ephemeral(`⏰ Scheduled for **${formatDuration(secs)}** from now!`);
  }

  return ephemeral('Unknown modal.');
}
