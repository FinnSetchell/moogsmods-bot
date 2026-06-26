// The release/announcement domain: KV persistence, channel/role routing, the
// public announcement embed, GitHub publish dispatch, grouped-release handling,
// the scheduled-release cron processor, and the /release + /published endpoints.

import { GITHUB_API } from './config.js';
import { discordRequest, ephemeral } from './discord.js';
import {
  buildPreviewEmbeds, buildPreviewEmbed,
  approveRejectGroupRow, retryRejectRow, textInputRow,
} from './components.js';
import { hexColor, versionRange, withFooter, channelLabel } from './util.js';

// ── KV helpers ────────────────────────────────────────────────────────────────

export async function getRelease(env, releaseId) {
  const data = await env.RELEASES.get(`release:${releaseId}`);
  return data ? JSON.parse(data) : null;
}

export async function cleanupRelease(env, releaseId) {
  await Promise.all([
    env.RELEASES.delete(`release:${releaseId}`),
    env.RELEASES.delete(`grouped:${releaseId}`),
  ]);
}

export async function getGroupedIds(env) {
  const data = await env.RELEASES.get('grouped_ids');
  return data ? JSON.parse(data) : [];
}

// ── Channel / role routing (by release type) ──────────────────────────────────

function targetChannelId(env, type) {
  if (type === 'minor') return env.CHANNEL_MINOR;
  if (type === 'alpha') return env.CHANNEL_ALPHA;
  return env.CHANNEL_ANNOUNCEMENTS; // major + major_everyone
}

function releaseRoleId(env, type) {
  if (type === 'minor') return env.ROLE_MINOR;
  if (type === 'alpha') return env.ROLE_ALPHA;
  return env.ROLE_MAJOR; // major + major_everyone
}

// ── GitHub dispatch ───────────────────────────────────────────────────────────

// Fire the repo's publish.yml via workflow_dispatch on the release branch.
export async function triggerPublish(env, release, releaseId) {
  const repo   = release.project ?? release.repo;
  const branch = release.branch;
  const resp = await fetch(
    `${GITHUB_API}/repos/${repo}/actions/workflows/publish.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'moogsmods-bot/1.0',
      },
      body: JSON.stringify({
        ref: branch,
        inputs: {
          releaseId,
          tag:         release.tag,
          releaseType: release.releaseType,
        },
      }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub workflow_dispatch failed (${branch}): ${resp.status} ${text}`);
  }
}

// ── Public announcement ───────────────────────────────────────────────────────

// Post the full release announcement (banner + main embed + per-platform download
// embeds) to the type's channel, optionally pinging the matching role. Pass
// channelOverride to redirect (used by dry runs to post into the review channel).
export async function sendAnnouncement(env, release, channelOverride = null) {
  const targetChannel = channelOverride ?? targetChannelId(env, release.releaseType);
  const role          = releaseRoleId(env, release.releaseType);
  const color         = hexColor(release.color || '#c20045');
  const cfSlug        = release.cfSlug ?? 'mns-moogs-nether-structures';
  const mrSlug        = release.mrSlug ?? 'mns-moogs-nether-structures';
  const gridUrl       = `https://www.curseforge.com/minecraft/mc-mods/${cfSlug}`;
  const imageUrls     = release.imageUrls ?? [];
  const versionsStr   = versionRange(release.mcStart, release.mcEnd, release.mcExtra ?? []);
  const isAlpha       = release.releaseType === 'alpha';

  const header = isAlpha
    ? `🧪 **${release.modName} ${release.version}** alpha build is up for testing!`
    : `🎉 **${release.modName} ${release.version}** has been released!`;

  const jarLines = (release.mcVersions && release.mcVersions.length > 1)
    ? release.mcVersions.map(v => `**${release.displayPrefix} ${release.version}-${v} ${release.displaySuffix}**`).join('\n')
    : `**${release.displayPrefix} ${release.version}-${release.mcVersion} ${release.displaySuffix}**`;

  const description = [
    `## ${header}`,
    '',
    jarLines,
    `Versions - ${versionsStr}`,
    '',
    `### 📝 **Changelog:**`,
    release.changelog,
    '',
    `<:curseforge:1132291568305459250> [CurseForge](https://www.curseforge.com/minecraft/mc-mods/${cfSlug}/files) | <:modrinth:1132291566019563550> [Modrinth](https://modrinth.com/mod/${mrSlug}/versions)`,
  ].join('\n');

  const mainEmbed = { description, color, thumbnail: { url: release.thumbnailUrl } };
  if (imageUrls.length > 0) mainEmbed.url = gridUrl;

  const embeds = [
    ...(release.bannerUrl ? [{ image: { url: release.bannerUrl }, color }] : []),
    mainEmbed,
    ...imageUrls.map(u => ({ url: gridUrl, image: { url: u }, color })),
    { description: `<:curseforge:1132291568305459250> [Download from CurseForge](https://www.curseforge.com/minecraft/mc-mods/${cfSlug}/files)`, color: 0xE87C2E },
    { description: `<:modrinth:1132291566019563550> [Download from Modrinth](https://modrinth.com/mod/${mrSlug}/versions)`, color: 0x1BD96A },
  ];

  const payload = { username: "Moog's Mods", avatar_url: release.avatarUrl, embeds };

  if (release.releaseType === 'major_everyone') {
    payload.content = `@everyone <@&${role}>`;
    payload.allowed_mentions = { parse: ['everyone'], roles: [role] };
  } else if (release.discordPing && role) {
    payload.content = `<@&${role}>`;
    payload.allowed_mentions = { parse: [], roles: [role] };
  }

  await discordRequest(env, 'POST', `/channels/${targetChannel}/messages`, payload);
}

// ── Grouped releases ──────────────────────────────────────────────────────────

// Keep the "Send Grouped (N)" control message in sync with the grouped count:
// create it at 2+, update its label, or delete it when the group drops below 2.
export async function syncSendGroupedMessage(env, count) {
  const existing = await env.RELEASES.get('grouped_send_msg');

  if (count < 2) {
    if (existing) {
      const { channelId, messageId } = JSON.parse(existing);
      await discordRequest(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`, null).catch(() => {});
      await env.RELEASES.delete('grouped_send_msg');
    }
    return;
  }

  const components = [{
    type: 1,
    components: [
      { type: 2, style: 1, label: `📤 Send Grouped (${count})`, custom_id: 'send_grouped' },
      { type: 2, style: 4, label: 'Reject All', custom_id: 'reject_grouped', emoji: { id: '1115379522754322583', name: 'no' } },
      { type: 2, style: 2, label: '🔗 Ungroup All', custom_id: 'ungroup_all' },
    ],
  }];

  if (existing) {
    const { channelId, messageId } = JSON.parse(existing);
    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      content: `**${count} releases are grouped and ready to send.**`,
      components,
    }).catch(() => {});
  } else {
    const msg = await discordRequest(env, 'POST', `/channels/${env.CHANNEL_REVIEW}/messages`, {
      content: `**${count} releases are grouped and ready to send.**`,
      components,
    });
    await env.RELEASES.put('grouped_send_msg', JSON.stringify({
      channelId: env.CHANNEL_REVIEW,
      messageId: msg.id,
    }), { expirationTtl: 60 * 60 * 24 * 30 });
  }
}

// Open the "Send Grouped Release" modal, pre-filling shared fields from the
// currently grouped releases.
export async function openGroupedModal(env) {
  const keys = await getGroupedIds(env);
  if (keys.length < 2) return ephemeral('Need at least 2 grouped releases to send.');

  const releases = await Promise.all(keys.map(id => getRelease(env, id)));
  const valid = releases.filter(Boolean);
  if (valid.length === 0) return ephemeral('All release data expired.');

  const mcStarts   = valid.map(r => r.mcStart).sort();
  const allEnds    = valid.flatMap(r => [r.mcEnd, ...(r.mcExtra ?? [])]).sort();
  const overallEnd = allEnds[allEnds.length - 1];
  const mcRange    = mcStarts[0] === overallEnd
    ? mcStarts[0]
    : `${mcStarts[0]} - ${overallEnd}`;

  const modNames     = [...new Set(valid.map(r => r.modName))];
  const versions     = [...new Set(valid.map(r => r.version))].sort();
  const releaseTypes = [...new Set(valid.map(r => r.releaseType))];
  const modNameFill     = modNames.length === 1 ? modNames[0] : '';
  const versionFill     = versions.join(' / ');
  const releaseTypeFill = releaseTypes.length === 1 ? releaseTypes[0] : 'minor';

  return Response.json({
    type: 9,
    data: {
      custom_id: 'grouped_modal',
      title: 'Send Grouped Release',
      components: [
        textInputRow('mod_name',     'Mod Name',                             modNameFill),
        textInputRow('version',      'Version',                              versionFill),
        textInputRow('release_type', 'Release Type (major / minor / alpha)', releaseTypeFill),
        textInputRow('discord_ping', 'Ping Role (true / false)',             'false'),
        textInputRow('changelog',    'Changelog', '', 2),
      ],
    },
  });
}

// ── Scheduled release processor (runs every minute via the cron trigger) ───────

export async function processScheduledReleases(env) {
  const list = await env.RELEASES.list({ prefix: 'scheduled:' });
  for (const key of list.keys) {
    try {
      const data = await env.RELEASES.get(key.name);
      if (!data) continue;
      const release = JSON.parse(data);
      if (release.scheduledAt <= Date.now()) {
        const releaseId = key.name.slice('scheduled:'.length);
        await triggerPublish(env, release, releaseId);
        await env.RELEASES.delete(key.name);
        // Update review card
        await discordRequest(env, 'PATCH',
          `/channels/${release.reviewChannelId}/messages/${release.reviewMessageId}`, {
            embeds: [withFooter(buildPreviewEmbed(release), '✅ Scheduled publish triggered')],
            components: [],
          }).catch(() => {});
      }
    } catch (err) {
      console.error('processScheduledReleases error for', key.name, err);
    }
  }
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

// POST /release — GitHub Actions posts a built release; we render the review card.
export async function handleRelease(request, env) {
  if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  const release = await request.json();
  const releaseId = crypto.randomUUID();

  const msg = await discordRequest(env, 'POST', `/channels/${env.CHANNEL_REVIEW}/messages`, {
    embeds: buildPreviewEmbeds(release),
    components: [approveRejectGroupRow(releaseId)],
  });

  // Store release data + review message reference so we can edit the card later
  await env.RELEASES.put(`release:${releaseId}`, JSON.stringify({
    ...release,
    reviewChannelId: env.CHANNEL_REVIEW,
    reviewMessageId: msg.id,
  }), { expirationTtl: 60 * 60 * 24 * 30 });

  return Response.json({ releaseId, messageId: msg.id });
}

// POST /published — the publish workflow reports success/failure; we announce or
// surface a retry. Grouped releases already sent their merged announcement.
export async function handlePublished(request, env) {
  if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { releaseId, success, error } = await request.json();
  const release = await getRelease(env, releaseId);
  if (!release) return new Response('Release not found', { status: 404 });

  if (success) {
    // Grouped releases already sent the merged announcement; skip re-announcing per-release
    if (!release.groupedSend) {
      await sendAnnouncement(env, release);
    }
    await discordRequest(env, 'PATCH',
      `/channels/${release.reviewChannelId}/messages/${release.reviewMessageId}`, {
        embeds: [withFooter(buildPreviewEmbed(release),
          `✅ Published — sent to ${channelLabel(release.releaseType)}`)],
        components: [],
      }).catch(() => {});
    await cleanupRelease(env, releaseId);
  } else {
    await discordRequest(env, 'PATCH',
      `/channels/${release.reviewChannelId}/messages/${release.reviewMessageId}`, {
        embeds: [withFooter(buildPreviewEmbed(release),
          `❌ Publish failed${error ? `: ${error}` : ''}`)],
        components: [retryRejectRow(releaseId)],
      }).catch(() => {});
  }

  return new Response('OK', { status: 200 });
}
