// Type-3 interactions: the review-card buttons. Approve/Schedule open a modal;
// Reject/Retry/Group/Ungroup/Send-Grouped act on the release(s) and re-render the
// card(s). All grouped-release state lives in KV (see releases.js).

import { discordRequest, ephemeral } from '../discord.js';
import { withFooter, withoutFooter } from '../util.js';
import {
  textInputRow, approveRejectGroupRow, ungroupRow, buildPreviewEmbed,
} from '../components.js';
import {
  getRelease, cleanupRelease, getGroupedIds, triggerPublish,
  syncSendGroupedMessage, openGroupedModal,
} from '../releases.js';

export async function handleButton(interaction, env) {
  const customId  = interaction.data.custom_id;
  const channelId = interaction.channel_id;
  const messageId = interaction.message.id;
  const origEmbed = interaction.message.embeds?.[0] ?? {};

  // approve:{releaseId} — open approval modal
  if (customId.startsWith('approve:')) {
    const releaseId = customId.slice(8);
    const release = await getRelease(env, releaseId);
    if (!release) return ephemeral('Release data expired.');

    return Response.json({
      type: 9, // MODAL
      data: {
        title: `Approve ${release.modName} ${release.version}`,
        custom_id: `approve_modal:${releaseId}`,
        components: [
          textInputRow('release_type', 'Type: major / everyone / minor / alpha',
            release.releaseType ?? 'minor'),
          textInputRow('discord_ping', 'Ping Role  (true / false)', 'false'),
          textInputRow('changelog', 'Changelog (Discord only, not CF/MR/GitHub)',
            (release.changelog ?? '').slice(0, 4000), 2),
        ],
      },
    });
  }

  // reject:{releaseId}
  if (customId.startsWith('reject:')) {
    const releaseId = customId.slice(7);
    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      components: [],
      embeds: [withFooter(origEmbed, '❌ Rejected')],
    });
    await cleanupRelease(env, releaseId);
    return Response.json({ type: 6 });
  }

  // retry:{releaseId} — re-trigger publish after failure
  if (customId.startsWith('retry:')) {
    const releaseId = customId.slice(6);
    const release = await getRelease(env, releaseId);
    if (!release) return ephemeral('Release data expired.');

    await triggerPublish(env, release, releaseId);
    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      embeds: [withFooter(origEmbed, '⏳ Retrying publish...')],
      components: [],
    });
    return Response.json({ type: 6 });
  }

  // group:{releaseId}
  if (customId.startsWith('group:')) {
    const releaseId = customId.slice(6);
    await env.RELEASES.put(`grouped:${releaseId}`, JSON.stringify({ channelId, messageId }), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
    const ids = await getGroupedIds(env);
    if (!ids.includes(releaseId)) ids.push(releaseId);
    await env.RELEASES.put('grouped_ids', JSON.stringify(ids), { expirationTtl: 60 * 60 * 24 * 30 });
    const count = ids.length;

    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      components: [ungroupRow(releaseId)],
      embeds: [withFooter(origEmbed, `🔗 Grouped (${count} total)`)],
    });
    await syncSendGroupedMessage(env, count);
    return Response.json({ type: 6 });
  }

  // ungroup:{releaseId}
  if (customId.startsWith('ungroup:')) {
    const releaseId = customId.slice(8);
    await env.RELEASES.delete(`grouped:${releaseId}`);
    const ids = (await getGroupedIds(env)).filter(id => id !== releaseId);
    await env.RELEASES.put('grouped_ids', JSON.stringify(ids), { expirationTtl: 60 * 60 * 24 * 30 });
    const count = ids.length;

    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      components: [approveRejectGroupRow(releaseId)],
      embeds: [withoutFooter(origEmbed)],
    });
    await syncSendGroupedMessage(env, count);
    return Response.json({ type: 6 });
  }

  // ungroup_all
  if (customId === 'ungroup_all') {
    const ids = await getGroupedIds(env);
    await Promise.all(ids.map(async id => {
      const infoStr = await env.RELEASES.get(`grouped:${id}`);
      if (infoStr) {
        const { channelId: cId, messageId: mId } = JSON.parse(infoStr);
        const release = await getRelease(env, id);
        const embed = release ? buildPreviewEmbed(release) : {};
        await discordRequest(env, 'PATCH', `/channels/${cId}/messages/${mId}`, {
          components: [approveRejectGroupRow(id)],
          embeds: [withoutFooter(embed)],
        }).catch(() => {});
      }
      await env.RELEASES.delete(`grouped:${id}`);
    }));
    await env.RELEASES.delete('grouped_ids');
    await discordRequest(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`, null).catch(() => {});
    return Response.json({ type: 6 });
  }

  // reject_grouped
  if (customId === 'reject_grouped') {
    const ids = await getGroupedIds(env);
    await Promise.all(ids.map(async id => {
      const infoStr = await env.RELEASES.get(`grouped:${id}`);
      if (infoStr) {
        const { channelId: cId, messageId: mId } = JSON.parse(infoStr);
        const release = await getRelease(env, id);
        const embed = release ? buildPreviewEmbed(release) : {};
        await discordRequest(env, 'PATCH', `/channels/${cId}/messages/${mId}`, {
          components: [],
          embeds: [withFooter(embed, '❌ Rejected (grouped)')],
        }).catch(() => {});
      }
      await env.RELEASES.delete(`grouped:${id}`);
      await env.RELEASES.delete(`release:${id}`);
    }));
    await env.RELEASES.delete('grouped_ids');
    await discordRequest(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`, null).catch(() => {});
    return Response.json({ type: 6 });
  }

  // send_grouped
  if (customId === 'send_grouped') {
    return openGroupedModal(env);
  }

  // schedule:{releaseId}
  if (customId.startsWith('schedule:')) {
    const releaseId = customId.slice(9);
    const release = await getRelease(env, releaseId);
    if (!release) return ephemeral('Release data expired.');

    return Response.json({
      type: 9,
      data: {
        custom_id: `schedule_modal:${releaseId}`,
        title: `Schedule ${release.modName} ${release.version}`.slice(0, 45),
        components: [
          textInputRow('release_type', 'Type: major / everyone / minor / alpha', release.releaseType ?? 'minor'),
          textInputRow('discord_ping', 'Ping Role  (true / false)', 'false'),
          textInputRow('changelog',    'Changelog', (release.changelog ?? '').slice(0, 4000), 2),
          textInputRow('send_in',      'Send In (e.g. 2h, 12h, 24h)', '24h'),
        ],
      },
    });
  }

  return ephemeral('Unknown action.');
}
