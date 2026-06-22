const DISCORD_API = 'https://discord.com/api/v10';

export default {
  async fetch(request, env) {
    const { method } = request;
    const { pathname } = new URL(request.url);

    if (method === 'GET' && pathname === '/') {
      return new Response("Moog's Mods Bot is running", { status: 200 });
    }
    if (method === 'POST' && pathname === '/release') {
      return handleRelease(request, env).catch(err => {
        console.error('Release handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/interactions') {
      return handleInteraction(request, env).catch(err => {
        console.error('Interaction handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

// ─── /release (called from GitHub Actions) ──────────────────────────────────

async function handleRelease(request, env) {
  if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  const release = await request.json();
  const releaseId = crypto.randomUUID();

  await env.RELEASES.put(`release:${releaseId}`, JSON.stringify(release), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  const msg = await discordRequest(env, 'POST', `/channels/${env.CHANNEL_REVIEW}/messages`, {
    embeds: buildPreviewEmbeds(release),
    components: [approveRejectGroupRow(releaseId)],
  });

  return Response.json({ releaseId, messageId: msg.id });
}

// ─── /interactions (Discord → Worker) ───────────────────────────────────────

async function handleInteraction(request, env) {
  const { valid, body } = await verifySignature(request, env.DISCORD_PUBLIC_KEY);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const interaction = JSON.parse(body);

  if (interaction.type === 1) return Response.json({ type: 1 }); // PING

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (userId !== env.FINN_USER_ID) {
    return ephemeral('Not permitted.');
  }

  if (interaction.type === 3) return handleButton(interaction, env);
  if (interaction.type === 5) return handleModal(interaction, env);

  return new Response('Unknown interaction type', { status: 400 });
}

// ─── Button handler ──────────────────────────────────────────────────────────

async function handleButton(interaction, env) {
  const customId = interaction.data.custom_id;
  const channelId = interaction.channel_id;
  const messageId = interaction.message.id;
  const origEmbed = interaction.message.embeds?.[0] ?? {};

  // approve:{releaseId}
  if (customId.startsWith('approve:')) {
    const releaseId = customId.slice(8);
    const release = await getRelease(env, releaseId);
    if (!release) return ephemeral('Release data expired.');

    const dryRun = release.dryRun === true;
    await sendAnnouncement(env, release, dryRun ? env.CHANNEL_REVIEW : null);
    const destination = dryRun ? '#announcement-review (dry run)' : channelLabel(release.releaseType);
    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      components: [],
      embeds: [withFooter(origEmbed, `✅ Approved — sent to ${destination}`)],
    });
    await cleanupRelease(env, releaseId);
    return Response.json({ type: 6 });
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

    // Update this message to show "Grouped ✓ | Ungroup"
    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      components: [ungroupRow(releaseId)],
      embeds: [withFooter(origEmbed, `🔗 Grouped (${count} total)`)],
    });

    // Post/update the "Send Grouped" trigger message when we reach 2+
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
    // Delete the trigger message itself
    await discordRequest(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`, null).catch(() => {});
    return Response.json({ type: 6 });
  }

  // send_grouped
  if (customId === 'send_grouped') {
    return openGroupedModal(env);
  }

  return ephemeral('Unknown action.');
}

// ─── Modal handler ───────────────────────────────────────────────────────────

async function handleModal(interaction, env) {
  if (interaction.data.custom_id !== 'grouped_modal') return ephemeral('Unknown modal.');

  const get = id =>
    interaction.data.components.flatMap(r => r.components).find(c => c.custom_id === id)?.value ?? '';

  const modName     = get('mod_name');
  const version     = get('version');
  const mcRange     = get('mc_range');
  const releaseType = get('release_type').toLowerCase().trim() || 'major';
  const changelog   = get('changelog');

  const groupedIds = await getGroupedIds(env);
  if (groupedIds.length === 0) return ephemeral('No grouped releases found in KV.');

  const firstRelease = await getRelease(env, groupedIds[0]);
  if (!firstRelease) return ephemeral('Release data expired.');

  const [mcStart, mcEnd] = mcRange.includes(' - ')
    ? mcRange.split(' - ').map(s => s.trim())
    : [mcRange.trim(), mcRange.trim()];

  const mcVersions = valid.map(r => r.mcVersion).sort();
  const mergedRelease = { ...firstRelease, modName, version, mcStart, mcEnd, releaseType, changelog, mcVersions };
  const dryRun = mergedRelease.dryRun === true;
  await sendAnnouncement(env, mergedRelease, dryRun ? env.CHANNEL_REVIEW : null);

  // Mark all grouped preview messages as sent and clean up
  await Promise.all(
    groupedIds.map(async id => {
      const infoStr = await env.RELEASES.get(`grouped:${id}`);
      if (infoStr) {
        const { channelId, messageId } = JSON.parse(infoStr);
        const release = await getRelease(env, id);
        const embed = release ? buildPreviewEmbed(release) : {};
        await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
          components: [],
          embeds: [withFooter(embed, `✅ Sent as grouped — ${modName} ${version}`)],
        }).catch(() => {});
      }
      await env.RELEASES.delete(`grouped:${id}`);
      await env.RELEASES.delete(`release:${id}`);
    })
  );
  await env.RELEASES.delete('grouped_ids');

  // Delete the "Send Grouped" trigger message
  const sendMsgStr = await env.RELEASES.get('grouped_send_msg');
  if (sendMsgStr) {
    const { channelId, messageId } = JSON.parse(sendMsgStr);
    await discordRequest(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`, null).catch(() => {});
    await env.RELEASES.delete('grouped_send_msg');
  }

  return Response.json({
    type: 4,
    data: { content: `✅ Grouped release sent for **${modName} ${version}**!`, flags: 64 },
  });
}

// ─── Grouped-release helpers ─────────────────────────────────────────────────

async function getGroupedIds(env) {
  const data = await env.RELEASES.get('grouped_ids');
  return data ? JSON.parse(data) : [];
}

async function syncSendGroupedMessage(env, count) {
  const existing = await env.RELEASES.get('grouped_send_msg');

  if (count < 2) {
    // Delete the trigger message if it exists
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
    // Update existing trigger message
    const { channelId, messageId } = JSON.parse(existing);
    await discordRequest(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
      content: `**${count} releases are grouped and ready to send.**`,
      components,
    }).catch(() => {});
  } else {
    // Post new trigger message
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

async function openGroupedModal(env) {
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
  const first = valid[0];

  return Response.json({
    type: 9,
    data: {
      custom_id: 'grouped_modal',
      title: 'Send Grouped Release',
      components: [
        textInputRow('mod_name',     'Mod Name',                            first.modName),
        textInputRow('version',      'Version',                             first.version),
        textInputRow('mc_range',     'MC Version Range',                    mcRange),
        textInputRow('release_type', 'Release Type (major / minor / alpha)', first.releaseType),
        textInputRow('changelog',    'Changelog', '', 2),
      ],
    },
  });
}

// ─── Announcement builder ────────────────────────────────────────────────────

async function sendAnnouncement(env, release, channelOverride = null) {
  const targetChannel = channelOverride ?? targetChannelId(env, release.releaseType);
  const role          = releaseRoleId(env, release.releaseType);
  const color         = hexColor(release.color ?? '#c20045');
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
    { image: { url: release.bannerUrl }, color },
    mainEmbed,
    ...imageUrls.map(u => ({ url: gridUrl, image: { url: u }, color })),
    { description: `<:curseforge:1132291568305459250> [Download from CurseForge](https://www.curseforge.com/minecraft/mc-mods/${cfSlug}/files)`, color: 0xE87C2E },
    { description: `<:modrinth:1132291566019563550> [Download from Modrinth](https://modrinth.com/mod/${mrSlug}/versions)`, color: 0x1BD96A },
  ];

  const payload = { username: "Moog's Mods", avatar_url: release.avatarUrl, embeds };

  if (release.discordPing && role) {
    payload.content = `<@&${role}>`;
    payload.allowed_mentions = { parse: [], roles: [role] };
  }

  await discordRequest(env, 'POST', `/channels/${targetChannel}/messages`, payload);
}

// ─── Preview embed ───────────────────────────────────────────────────────────

function buildPreviewEmbeds(release) {
  const color       = hexColor(release.color ?? '#c20045');
  const versionsStr = versionRange(release.mcStart, release.mcEnd, release.mcExtra ?? []);
  const isAlpha     = release.releaseType === 'alpha';
  const typeIcon    = isAlpha ? '🧪' : '🎉';
  const imageUrls   = (release.imageUrls ?? []).slice(0, 4);
  const gridUrl     = `https://www.curseforge.com/minecraft/mc-mods/${release.cfSlug ?? 'mns-moogs-nether-structures'}`;

  const main = {
    title: `[PREVIEW] ${release.modName} ${release.version}`,
    description: [
      `${typeIcon} **${release.modName} ${release.version}** — ${versionsStr}`,
      '',
      (release.changelog ?? '').slice(0, 800),
    ].join('\n'),
    color,
    thumbnail: { url: release.thumbnailUrl },
    footer: { text: `→ ${channelLabel(release.releaseType)} | ${release.project ?? ''} | ${release.releaseType}` },
  };

  if (imageUrls.length > 0) {
    main.url = gridUrl;
    main.image = { url: imageUrls[0] };
  }

  return [
    main,
    ...imageUrls.slice(1).map(u => ({ url: gridUrl, image: { url: u }, color })),
  ];
}

function buildPreviewEmbed(release) {
  return buildPreviewEmbeds(release)[0];
}

// ─── Component builders ───────────────────────────────────────────────────────

function approveRejectGroupRow(releaseId) {
  return {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve', custom_id: `approve:${releaseId}`, emoji: { name: '✅' } },
      { type: 2, style: 4, label: 'Reject',  custom_id: `reject:${releaseId}`,  emoji: { id: '1115379522754322583', name: 'no' } },
      { type: 2, style: 2, label: 'Group',   custom_id: `group:${releaseId}`,   emoji: { name: '🔗' } },
    ],
  };
}

function ungroupRow(releaseId) {
  return {
    type: 1,
    components: [
      { type: 2, style: 2, label: '🔗 Grouped ✓', custom_id: `noop:${releaseId}`, disabled: true },
      { type: 2, style: 4, label: 'Ungroup',       custom_id: `ungroup:${releaseId}` },
    ],
  };
}

function textInputRow(customId, label, value, style = 1) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: customId,
      label,
      style,
      value: value || undefined,
      required: true,
    }],
  };
}

// ─── KV helpers ───────────────────────────────────────────────────────────────

async function getRelease(env, releaseId) {
  const data = await env.RELEASES.get(`release:${releaseId}`);
  return data ? JSON.parse(data) : null;
}

async function cleanupRelease(env, releaseId) {
  await Promise.all([
    env.RELEASES.delete(`release:${releaseId}`),
    env.RELEASES.delete(`grouped:${releaseId}`),
  ]);
}

// ─── Channel / role mappings ─────────────────────────────────────────────────

function targetChannelId(env, type) {
  if (type === 'minor') return env.CHANNEL_MINOR;
  if (type === 'alpha') return env.CHANNEL_ALPHA;
  return env.CHANNEL_ANNOUNCEMENTS;
}

function releaseRoleId(env, type) {
  if (type === 'minor') return env.ROLE_MINOR;
  if (type === 'alpha') return env.ROLE_ALPHA;
  return env.ROLE_MAJOR;
}

function channelLabel(type) {
  if (type === 'minor') return '#minor-builds';
  if (type === 'alpha') return '#test-builds';
  return '#announcements';
}

// ─── Discord API ─────────────────────────────────────────────────────────────

async function discordRequest(env, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const resp = await fetch(`${DISCORD_API}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord ${method} ${path} → ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// ─── Signature verification ───────────────────────────────────────────────────

async function verifySignature(request, publicKeyHex) {
  const sig  = request.headers.get('X-Signature-Ed25519');
  const ts   = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();
  if (!sig || !ts) return { valid: false, body };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(sig),
      new TextEncoder().encode(ts + body),
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function ephemeral(content) {
  return Response.json({ type: 4, data: { content, flags: 64 } });
}

function hexColor(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

function versionRange(start, end, extra = []) {
  const base = start === end ? start : `${start} - ${end}`;
  return extra.length > 0 ? `${base}, ${extra.join(', ')}` : base;
}

function withFooter(embed, text) {
  return { ...embed, footer: { text } };
}

function withoutFooter(embed) {
  const { footer, ...rest } = embed;
  return rest;
}
