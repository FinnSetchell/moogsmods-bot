const DISCORD_API    = 'https://discord.com/api/v10';
const GITHUB_API     = 'https://api.github.com';
const WORKER_URL     = 'https://moogsmods-bot.finndog176.workers.dev';
const LOG_CHANNEL    = '1131312070755893268';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledReleases(env));
  },
  async fetch(request, env, ctx) {
    const { method } = request;
    const { pathname } = new URL(request.url);

    if (method === 'GET' && pathname === '/') {
      return new Response("Moog's Mods Bot is running", { status: 200 });
    }
    if (method === 'POST' && pathname === '/register-commands') {
      if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      return registerCommands(env);
    }
    if (method === 'POST' && pathname === '/send-docs') {
      if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      return sendDocs(env).then(id => new Response(`Docs posted. Message ID: ${id}`, { status: 200 }))
        .catch(err => new Response(`Failed: ${err.message}`, { status: 500 }));
    }
    if (method === 'POST' && pathname === '/release') {
      return handleRelease(request, env).catch(err => {
        console.error('Release handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/published') {
      return handlePublished(request, env).catch(err => {
        console.error('Published handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/verify-alert') {
      if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      return handleVerifyAlert(request, env).catch(err => {
        console.error('Verify-alert handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/audit-alert') {
      if (request.headers.get('X-API-Key') !== env.WORKER_API_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      return handleAuditAlert(request, env).catch(err => {
        console.error('Audit-alert handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/interactions') {
      return handleInteraction(request, env, ctx).catch(err => {
        console.error('Interaction handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

// ─── /release (called from GitHub Actions after build) ───────────────────────

async function handleRelease(request, env) {
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

// ─── /published (called from publish workflow when done) ─────────────────────

async function handlePublished(request, env) {
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

// ─── /interactions (Discord → Worker) ───────────────────────────────────────

async function handleInteraction(request, env, ctx) {
  const { valid, body } = await verifySignature(request, env.DISCORD_PUBLIC_KEY);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const interaction = JSON.parse(body);

  if (interaction.type === 1) return Response.json({ type: 1 }); // PING

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (userId !== env.FINN_USER_ID) {
    return ephemeral('Not permitted.');
  }

  if (interaction.type === 2) return handleCommand(interaction, env);
  if (interaction.type === 3) return handleButton(interaction, env);
  if (interaction.type === 5) return handleModal(interaction, env, ctx);

  return new Response('Unknown interaction type', { status: 400 });
}

// ─── Command handler (context menus / slash commands) ───────────────────────

async function handleCommand(interaction, env) {
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
    const token   = interaction.token;

    // Return deferred response immediately; do the work in background via ctx (not available here)
    // handleCommand doesn't receive ctx — use synchronous approach with waitUntil not possible,
    // so we do it with deferred pattern: return type 5 and follow up via background fetch.
    // We attach ctx via a closure — but handleCommand doesn't have ctx. Use type 4 immediate instead
    // (operation is fast: single PATCH) with a short-circuit: do the PATCH inline then report.
    // Actually we must return immediately. Discord allows 3s. PATCH is fast — do inline.
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
    const token     = interaction.token;

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

  if (interaction.data.name === 'locate') {
    return Response.json({ type: 4, data: { embeds: [{
      title: '📍 Finding Structures In-Game',
      description: [
        'Use `/locate structure <prefix>:<name>` in-game. Start typing the prefix and Minecraft will auto-complete the available structure names.',
        '',
        '**Mod prefixes:**',
        '`mvs:` — Moog\'s Voyager Structures',
        '`mns:` — Moog\'s Nether Structures',
        '`mes:` — Moog\'s End Structures',
        '`mss:` — Moog\'s Soaring Structures',
        '`mmr:` — Moog\'s Mineshafts Reimagined',
        '',
        '**Example:** `/locate structure mvs:barn`',
        '',
        '> Structures may not be nearby if you\'re playing on a world generated before the mod was installed. Try exploring further or creating a new world.',
      ].join('\n'),
      color: 0x1c3a5e,
    }] } });
  }

  if (interaction.data.name === 'configpack') {
    return Response.json({ type: 4, data: { embeds: [{
      title: '⚙️ Config Pack',
      description: [
        'The **config pack** lets you customise structure spawn rates, disable individual structures, change which biomes they appear in, and tweak loot — without modifying the mod itself.',
        '',
        '**How to install:**',
        '1. Download the config pack from CurseForge or Modrinth (listed alongside the mod)',
        '2. Place the `.zip` file (do **not** unzip it) into your world\'s `datapacks` folder:',
        '   - Singleplayer: `<modpack root>/saves/<world name>/datapacks/`',
        '   - Server: `<server root>/world/datapacks/`',
        '3. Run `/reload` in-game or restart your server',
        '4. Edit the JSON files inside the zip to customise settings, then `/reload` again',
        '',
        '> To apply to all worlds, use the [GlobalPacks mod](https://modrinth.com/mod/globalpacks).',
      ].join('\n'),
      color: 0x1c3a5e,
    }] } });
  }

  if (interaction.data.name === 'mclog') {
    return Response.json({ type: 4, data: { embeds: [{
      title: '📋 Sharing Your Log',
      description: [
        'Please upload your log to **mclo.gs** and share the link here so we can help.',
        '',
        '**How to find your log:**',
        '- **Latest log:** `<modpack root>/logs/latest.log`',
        '- **Crash report:** `<modpack root>/crash-reports/` (most recent file)',
        '',
        '**How to upload:**',
        '1. Go to <https://mclo.gs>',
        '2. Paste the full log contents',
        '3. Click **Save** and share the link',
        '',
        '> The log contains important error details we need to diagnose your issue.',
      ].join('\n'),
      color: 0x1c3a5e,
    }] } });
  }

  if (interaction.data.name === 'compatibility') {
    return Response.json({ type: 4, data: { embeds: [{
      title: '🔗 Terrain Mod Compatibility',
      description: [
        'Moog\'s structure mods use **biome tags** to decide where structures spawn, which means they work with most terrain mods out of the box — no patches needed.',
        '',
        'They match both vanilla and modded convention tags (e.g. `#minecraft:is_forest`, `#c:is_mountain`, `#forge:is_swamp`) — the same tags other mods register their biomes under — so structures automatically appear in those biomes.',
        '',
        'If structures aren\'t spawning in a modded biome, that biome likely isn\'t tagged. You can add it manually using the **config pack** — use `/configpack` for instructions.',
      ].join('\n'),
      color: 0x1c3a5e,
    }] } });
  }

  if (interaction.data.name === 'versions') {
    return Response.json({ type: 4, data: { embeds: [{
      title: '🔢 Checking Your Mod Version',
      description: [
        'Check the jar filename in your mods folder — it includes the mod version and Minecraft version.',
        '',
        '**Where to look:**',
        '- `<modpack root>/mods/`',
        '',
        '**Example filename:** `MVS-1.21-5.0.0.jar`',
        'That\'s **MVS version 5.0.0** for **Minecraft 1.21**.',
        '',
        'The Minecraft version in the filename is the **start** of the supported range — a `1.21` build works on **1.21–26.2**, and a `1.20` build works on **1.20–1.20.6**.',
        '',
        'You can also check in-game:',
        '- **Fabric:** open the mods screen (if you have ModMenu installed)',
        '- **Forge/NeoForge:** press `F3+Q` or check the mods button on the main menu',
      ].join('\n'),
      color: 0x1c3a5e,
    }] } });
  }

  if (interaction.data.name === 'datapack') {
    return Response.json({ type: 4, data: { embeds: [{
      title: '📦 Installing a Datapack',
      description: [
        'Place the datapack `.zip` (do **not** unzip) into your world\'s `datapacks` folder.',
        '',
        '**Folder location:**',
        '- **Singleplayer:** `<modpack root>/saves/<world name>/datapacks/`',
        '- **Server:** `<server root>/world/datapacks/`',
        '',
        'Then either run `/reload` in-game or restart your server.',
        '',
        'To confirm it loaded: `/datapack list` — it should appear with a green ✔',
        '',
        '> To apply a datapack to **all worlds**, use the [GlobalPacks mod](https://modrinth.com/mod/globalpacks).',
      ].join('\n'),
      color: 0x1c3a5e,
    }] } });
  }

  return ephemeral('Unknown command.');
}

// ─── Button handler ──────────────────────────────────────────────────────────

async function handleButton(interaction, env) {
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

// ─── Modal handler ───────────────────────────────────────────────────────────

async function handleModal(interaction, env, ctx) {
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

// ─── GitHub dispatch ─────────────────────────────────────────────────────────

async function triggerPublish(env, release, releaseId) {
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

// ─── Grouped-release helpers ─────────────────────────────────────────────────

async function getGroupedIds(env) {
  const data = await env.RELEASES.get('grouped_ids');
  return data ? JSON.parse(data) : [];
}

async function syncSendGroupedMessage(env, count) {
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

// ─── Announcement builder ────────────────────────────────────────────────────

async function sendAnnouncement(env, release, channelOverride = null) {
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

// ─── Preview embed ───────────────────────────────────────────────────────────

function buildPreviewEmbeds(release) {
  const color       = hexColor(release.color || '#c20045');
  const versionsStr = versionRange(release.mcStart, release.mcEnd, release.mcExtra ?? []);
  const isAlpha     = release.releaseType === 'alpha';
  const typeIcon    = isAlpha ? '🧪' : release.releaseType === 'major_everyone' ? '📢' : '🎉';
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
    footer: { text: `→ ${channelLabel(release.releaseType)} | ${release.project ?? ''} | ${releaseTypeLabel(release.releaseType)}` },
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
      { type: 2, style: 3, label: 'Approve',  custom_id: `approve:${releaseId}`,  emoji: { name: '✅' } },
      { type: 2, style: 4, label: 'Reject',   custom_id: `reject:${releaseId}`,   emoji: { id: '1115379522754322583', name: 'no' } },
      { type: 2, style: 2, label: 'Group',    custom_id: `group:${releaseId}`,    emoji: { name: '🔗' } },
      { type: 2, style: 2, label: 'Schedule', custom_id: `schedule:${releaseId}`, emoji: { name: '⏰' } },
    ],
  };
}

function retryRejectRow(releaseId) {
  return {
    type: 1,
    components: [
      { type: 2, style: 1, label: '🔄 Retry Publish', custom_id: `retry:${releaseId}` },
      { type: 2, style: 4, label: 'Reject', custom_id: `reject:${releaseId}`, emoji: { id: '1115379522754322583', name: 'no' } },
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

function textInputRow(customId, label, value, style = 1, required = true) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: customId,
      label,
      style,
      value: value || undefined,
      required,
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
  return env.CHANNEL_ANNOUNCEMENTS; // major + major_everyone
}

function releaseRoleId(env, type) {
  if (type === 'minor') return env.ROLE_MINOR;
  if (type === 'alpha') return env.ROLE_ALPHA;
  return env.ROLE_MAJOR; // major + major_everyone
}

function channelLabel(type) {
  if (type === 'minor') return '#minor-builds';
  if (type === 'alpha') return '#test-builds';
  if (type === 'major_everyone') return '#announcements (@everyone)';
  return '#announcements';
}

function releaseTypeLabel(type) {
  if (type === 'major_everyone') return 'major (@everyone)';
  return type;
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

// ─── Publish-verification alerts ──────────────────────────────────────────────
// Receives structured results from the verification library (release-actions/verify):
//   POST /verify-alert  — one tag, sent by verify.yml at the end of a publish run
//   POST /audit-alert   — many mods/tags, sent by the scheduled audit cron
// The verification logic lives in stdlib Python; this layer is presentation only —
// it renders embeds, picks a severity colour, and routes alpha vs release to the
// right channel. Silent on clean unless the audit requests a heartbeat.

const AUDIT_SEVERITY = {
  pass:    0x57F287, // green
  pending: 0xFEE75C, // yellow
  fail:    0xED4245, // red
  error:   0xE67E22, // orange
};

// Alpha releases route to the alpha-audit channel, everything else to the
// release-audit channel. Both fall back to the mod-log channel if unset, so the
// feature is deployable before dedicated channels exist.
function auditChannel(env, isAlpha) {
  return isAlpha
    ? (env.CHANNEL_AUDIT_ALPHA   || LOG_CHANNEL)
    : (env.CHANNEL_AUDIT_RELEASE || LOG_CHANNEL);
}

function verdictIcon(v) {
  return ({ pass: '✅', pending: '🟡', fail: '❌', error: '⚠️' })[v] || '❔';
}

// Render one verifier result into a per-platform description block with links.
function verifyResultLines(r) {
  const icon = {
    ok: '✅', pass: '✅', incomplete: '🟡', pending: '🟡',
    missing: '❌', wrong_type: '❌', error: '⚠️', skipped: '⚪',
  };
  const mr = r.modrinth || {};
  const cf = r.curseforge || {};

  let mrLine = `${icon[mr.status] || '❔'} **Modrinth:** ${mr.status || 'unknown'}`;
  if (mr.missing_loaders?.length) mrLine += ` — missing ${mr.missing_loaders.join(', ')}`;
  if (mr.missing_mc?.length)      mrLine += ` — missing MC ${mr.missing_mc.join(', ')}`;
  if (mr.error)                   mrLine += ` — ${mr.error}`;
  if (mr.url)                     mrLine += `\n↳ [Modrinth versions](${mr.url})`;

  let cfLine = `${icon[cf.status] || '❔'} **CurseForge:** ${cf.status || 'unknown'}`;
  if (cf.missing?.length) cfLine += ` — missing ${cf.missing.join(', ')}`;
  if (cf.failed?.length)  cfLine += ` — FAILED ${cf.failed.join(', ')}`;
  if (cf.pending?.length) cfLine += ` — pending ${cf.pending.join(', ')}`;
  if (cf.error)           cfLine += ` — ${cf.error}`;
  if (cf.url)             cfLine += `\n↳ [CurseForge files](${cf.url})`;

  return `${mrLine}\n${cfLine}`;
}

// One-tag embed (workflow-time /verify-alert).
function buildVerifyEmbed(p) {
  const label = p.is_alpha ? 'alpha' : 'release';
  const embed = {
    title: `${verdictIcon(p.verdict)} Publish verify — ${p.modName || p.mod} ${p.version}`,
    description: [
      `**Tag:** \`${p.tag || p.version}\`  •  **${label}**`,
      '',
      verifyResultLines(p),
    ].join('\n'),
    color: AUDIT_SEVERITY[p.verdict] ?? AUDIT_SEVERITY.error,
    timestamp: new Date().toISOString(),
  };
  if (p.run_url) embed.url = p.run_url;
  if (p.repo)    embed.footer = { text: p.repo };
  return embed;
}

async function handleVerifyAlert(request, env) {
  const p = await request.json();
  if (!p || !p.mod) return new Response('Bad payload: missing mod', { status: 400 });
  const channel = auditChannel(env, !!p.is_alpha);
  await discordRequest(env, 'POST', `/channels/${channel}/messages`, {
    embeds: [buildVerifyEmbed(p)],
  });
  return new Response('ok', { status: 200 });
}

async function handleAuditAlert(request, env) {
  const p = await request.json();
  const results   = Array.isArray(p.results) ? p.results : [];
  const heartbeat = !!p.heartbeat;

  let posted = 0;
  // Route alpha vs release into their own channels; build each independently.
  for (const isAlpha of [false, true]) {
    const group   = results.filter(r => !!r.is_alpha === isAlpha);
    const failing = group.filter(r => r.verdict === 'fail' || r.verdict === 'error');
    if (!failing.length && !heartbeat) continue;

    const channel = auditChannel(env, isAlpha);
    const label   = isAlpha ? 'Alpha' : 'Release';
    const lead = {
      title: failing.length
        ? `❌ ${label} audit — ${failing.length} issue${failing.length === 1 ? '' : 's'}`
        : `✅ ${label} audit — all clear`,
      description: `Checked **${group.length}** ${label.toLowerCase()} release${group.length === 1 ? '' : 's'} across the registry.`,
      color: failing.length ? AUDIT_SEVERITY.fail : AUDIT_SEVERITY.pass,
      timestamp: new Date().toISOString(),
    };
    if (p.run_url) lead.url = p.run_url;

    const detail = failing.map(r => ({
      title: `${verdictIcon(r.verdict)} ${r.modName || r.mod} ${r.version}`,
      description: [`**Tag:** \`${r.tag || r.version}\``, '', verifyResultLines(r)].join('\n'),
      color: AUDIT_SEVERITY[r.verdict] ?? AUDIT_SEVERITY.error,
    }));

    // Discord caps a message at 10 embeds — lead first, then chunk the details.
    const embeds = [lead, ...detail];
    for (let i = 0; i < embeds.length; i += 10) {
      await discordRequest(env, 'POST', `/channels/${channel}/messages`, {
        embeds: embeds.slice(i, i + 10),
      });
      posted++;
    }
  }
  return new Response(`ok (${posted} message${posted === 1 ? '' : 's'})`, { status: 200 });
}

// ─── Timeout & Purge helpers ──────────────────────────────────────────────────

function parseDuration(str) {
  const s = (str ?? '').trim().toLowerCase();
  if (s === 'none' || s === '0') return 0;
  const match = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d|w)$/);
  if (!match) return null;
  const n    = parseFloat(match[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.round(n * mult[match[2]]);
}

function formatDuration(seconds) {
  if (seconds >= 604800) return `${Math.round(seconds / 604800)}w`;
  if (seconds >= 86400)  return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600)   return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60)     return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

async function timeoutMember(env, guildId, userId, seconds) {
  const MAX_TIMEOUT = 28 * 24 * 3600; // Discord max: 28 days
  const until = new Date(Date.now() + Math.min(seconds, MAX_TIMEOUT) * 1000).toISOString();
  const resp = await discordRequest(env, 'PATCH', `/guilds/${guildId}/members/${userId}`, {
    communication_disabled_until: until,
  });
  return resp;
}

async function purgeUserMessages(env, guildId, userId, seconds) {
  const cutoff = Date.now() - seconds * 1000;

  const channels = await discordRequest(env, 'GET', `/guilds/${guildId}/channels`);
  // Types: 0=text, 5=announcement, 11=public thread, 12=private thread
  const textChannels = channels.filter(c => [0, 5, 11, 12].includes(c.type));

  let totalDeleted = 0;

  for (const channel of textChannels) {
    try {
      let lastId = null;

      while (true) {
        const qs       = `limit=100${lastId ? `&before=${lastId}` : ''}`;
        const messages = await discordRequest(env, 'GET', `/channels/${channel.id}/messages?${qs}`);
        if (!messages || !messages.length) break;

        const toDelete = messages
          .filter(m => m.author.id === userId && new Date(m.timestamp).getTime() >= cutoff)
          .map(m => m.id);

        if (toDelete.length === 1) {
          await discordRequest(env, 'DELETE', `/channels/${channel.id}/messages/${toDelete[0]}`, null).catch(() => {});
          totalDeleted += 1;
        } else if (toDelete.length > 1) {
          await discordRequest(env, 'POST', `/channels/${channel.id}/messages/bulk-delete`, {
            messages: toDelete,
          }).catch(() => {});
          totalDeleted += toDelete.length;
        }

        const oldest = messages[messages.length - 1];
        if (messages.length < 100 || new Date(oldest.timestamp).getTime() < cutoff) break;
        lastId = oldest.id;
      }
    } catch {
      // Skip channels we can't read (permissions, archived threads, etc.)
    }
  }

  return totalDeleted;
}

// ─── Channel lock helper ──────────────────────────────────────────────────────

async function lockChannel(env, channelId, guildId, lock) {
  const SEND_MESSAGES = 1n << 11n; // bit 11 = 2048

  const channel     = await discordRequest(env, 'GET', `/channels/${channelId}`);
  const overwrites  = channel.permission_overwrites ?? [];

  let existing = overwrites.find(o => o.id === guildId);
  let allow = BigInt(existing?.allow ?? '0');
  let deny  = BigInt(existing?.deny  ?? '0');

  if (lock) {
    deny  = deny | SEND_MESSAGES;
    allow = allow & ~SEND_MESSAGES;
  } else {
    deny  = deny & ~SEND_MESSAGES;
  }

  if (allow === 0n && deny === 0n) {
    // Remove the overwrite entirely
    await discordRequest(env, 'DELETE', `/channels/${channelId}/permissions/${guildId}`, null);
  } else {
    await discordRequest(env, 'PUT', `/channels/${channelId}/permissions/${guildId}`, {
      allow: allow.toString(),
      deny:  deny.toString(),
      type:  0,
    });
  }
}

// ─── Scheduled release processor ─────────────────────────────────────────────

async function processScheduledReleases(env) {
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

// ─── Command registration ─────────────────────────────────────────────────────

async function registerCommands(env) {
  const resp = await fetch(
    `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/commands`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        { name: 'Edit Message',    type: 3, default_member_permissions: '0' },
        { name: 'Timeout & Purge', type: 3, default_member_permissions: '0' },
        { name: 'Remove Timeout',  type: 3, default_member_permissions: '0' },
        { name: 'Warn User',       type: 3, default_member_permissions: '0' },
        {
          name: 'announce', type: 1, description: 'Post a custom announcement embed',
          default_member_permissions: '0',
          options: [{ name: 'channel', type: 7, description: 'Channel to post in', required: true }],
        },
        {
          name: 'lock', type: 1, description: 'Lock a channel (prevent @everyone from sending messages)',
          default_member_permissions: '0',
          options: [{ name: 'channel', type: 7, description: 'Channel to lock (defaults to current)', required: false }],
        },
        {
          name: 'unlock', type: 1, description: 'Unlock a previously locked channel',
          default_member_permissions: '0',
          options: [{ name: 'channel', type: 7, description: 'Channel to unlock (defaults to current)', required: false }],
        },
        {
          name: 'slowmode', type: 1, description: 'Set slowmode on a channel',
          default_member_permissions: '0',
          options: [
            { name: 'duration', type: 3, description: 'Duration e.g. 5s 30s 1m 5m or 0 to disable', required: true },
            { name: 'channel',  type: 7, description: 'Channel (defaults to current)', required: false },
          ],
        },
        // ── Public support commands ──────────────────────────────────────────────
        { name: 'locate',       type: 1, description: 'How to find structures in-game using /locate' },
        { name: 'configpack',   type: 1, description: 'How to use the config pack to customise structures' },
        { name: 'mclog',        type: 1, description: 'How to share your log for support' },
        { name: 'versions',     type: 1, description: 'How to check which mod version you have installed' },
        { name: 'datapack',     type: 1, description: 'Where to install a datapack' },
        { name: 'compatibility', type: 1, description: 'How Moog\'s mods handle compatibility with terrain mods' },
      ]),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    return new Response(`Failed: ${resp.status} ${text}`, { status: 500 });
  }
  return new Response('Commands registered.', { status: 200 });
}

// ─── Staff guide docs ────────────────────────────────────────────────────────
// Keep this updated as features are added — see STAFF_GUIDE.md in the repo.

const DOCS_CHANNEL = '1118598313709682769';

async function sendDocs(env) {
  const cr  = env.CHANNEL_REVIEW;
  const ca  = env.CHANNEL_ANNOUNCEMENTS;
  const cmi = env.CHANNEL_MINOR;
  const cal = env.CHANNEL_ALPHA;
  const rm  = env.ROLE_MAJOR;
  const rmi = env.ROLE_MINOR;
  const ral = env.ROLE_ALPHA;

  const embeds = [
    // ── Header ──────────────────────────────────────────────────────────────
    {
      author: { name: "Moog's Mods Bot — Staff Guide" },
      title: '📖 What this bot does',
      description:
        "Automates mod release announcements and provides moderation shortcuts.\n" +
        "All features are **admin-only**. Context menu commands appear under **Apps** when right-clicking a message.",
      color: 0xC20045,
    },

    // ── Release flow ────────────────────────────────────────────────────────
    {
      title: '📦 Release Review Flow',
      description:
        `When a release is built on GitHub, a preview card is posted to <#${cr}>.\n` +
        "Each card shows a full announcement preview with three buttons:\n\n" +
        "**✅ Approve** — opens the confirmation modal before publishing\n" +
        "**❌ Reject** — discards the release card\n" +
        "**🔗 Group** — bundles this card with others (for multi-loader/multi-version releases)\n\n" +
        "After approval the bot triggers the publish workflow on GitHub and updates the card to show the publishing status.",
      color: 0x57F287,
    },

    // ── Approve modal ────────────────────────────────────────────────────────
    {
      title: '✅ Approve Modal',
      description: "Shown when you click **Approve** on a review card. Fields:\n",
      color: 0x57F287,
      fields: [
        {
          name: 'Release Type',
          value:
            `\`major\` → <#${ca}>, pings <@&${rm}>\n` +
            `\`everyone\` → <#${ca}>, pings @everyone + <@&${rm}>\n` +
            `\`minor\` → <#${cmi}>, pings <@&${rmi}>\n` +
            `\`alpha\` → <#${cal}>, pings <@&${ral}>`,
          inline: false,
        },
        {
          name: 'Discord Ping',
          value: '`true` or `false`. Defaults to `false` — change to `true` when you want the role pinged.',
          inline: false,
        },
        {
          name: 'Changelog',
          value: 'Pre-filled from the repository changelog. Edit before sending if needed.',
          inline: false,
        },
      ],
    },

    // ── Grouped releases ─────────────────────────────────────────────────────
    {
      title: '📤 Grouped Releases',
      description:
        "Used when the same mod ships for multiple loaders/MC versions at once.\n\n" +
        `**1.** Click **🔗 Group** on each release card in <#${cr}>\n` +
        "**2.** Once 2+ cards are grouped, a **Send Grouped** button appears\n" +
        "**3.** Fill in the shared mod name, version, MC range, release type, and changelog\n\n" +
        "The ping is automatically set based on release type (`major`/`everyone` → ping on, `minor`/`alpha` → ping off).\n" +
        "Use **Ungroup All** or **Reject All** to cancel.",
      color: 0x5865F2,
    },

    // ── Moderation ────────────────────────────────────────────────────────────
    {
      title: '🚨 Timeout & Purge',
      description:
        "**Right-click any message from the target user → Apps → Timeout & Purge**\n\n" +
        "Opens a modal with three fields:\n\n" +
        "**Timeout Duration** — how long to mute them. Examples: `30m`, `24h`, `7d`, `28d`, or `none` to skip\n" +
        "**Delete Messages From Last** — how far back to sweep. Examples: `1h`, `24h`, `7d`, or `none` to skip\n" +
        "**Reason** — logged to the mod-log channel\n\n" +
        "The bot scans **all text channels** and bulk-deletes the user's messages within the window. " +
        `Everything is logged in <#${LOG_CHANNEL}>.`,
      color: 0xED4245,
    },

    // ── More Moderation ───────────────────────────────────────────────────────
    {
      title: '🛡️ More Moderation Tools',
      description:
        "**Warn User** — Right-click a message → Apps → Warn User. " +
        "Opens a modal to enter a reason. Warns are stored permanently (no expiry), " +
        "the user receives a DM, and the warn count is logged in <#" + LOG_CHANNEL + ">.\n\n" +
        "**Remove Timeout** — Right-click a message → Apps → Remove Timeout. " +
        "Lifts a timeout early. Logged in <#" + LOG_CHANNEL + ">.\n\n" +
        "**Channel Lock** — `/lock [channel]` — Denies @everyone SEND_MESSAGES in the channel.\n" +
        "**Channel Unlock** — `/unlock [channel]` — Removes the lock.\n" +
        "Both default to the current channel if no channel is specified.\n\n" +
        "**Slowmode** — `/slowmode <duration> [channel]` — Sets a per-user cooldown. " +
        "Examples: `5s`, `30s`, `1m`, `0` to disable. Max 6 hours.",
      color: 0xED4245,
    },

    // ── Utilities ─────────────────────────────────────────────────────────────
    {
      title: '✏️ Edit Message',
      description:
        "**Right-click any bot announcement → Apps → Edit Message**\n\n" +
        "Opens a modal pre-filled with the embed description. " +
        "Submit to update the message in-place. " +
        "Useful for correcting typos or updating a changelog after the announcement is sent.",
      color: 0xFEE75C,
    },

    // ── Public support commands ───────────────────────────────────────────────
    {
      title: '💬 Public Support Commands',
      description:
        "Unlike the tools above, these slash commands are **public** — any member can run them, " +
        "and the reply is a help embed visible in the channel. Use them to answer common support " +
        "questions quickly instead of retyping instructions.\n\n" +
        "**`/locate`** — How to find structures in-game with `/locate structure <prefix>:<name>` (lists mod prefixes).\n" +
        "**`/configpack`** — How to install and use the config pack to customise spawn rates, biomes, and loot.\n" +
        "**`/mclog`** — How to find and share a log via mclo.gs for support.\n" +
        "**`/versions`** — How to check which mod version is installed (jar filename / in-game).\n" +
        "**`/datapack`** — Where to install a datapack `.zip` and how to confirm it loaded.\n" +
        "**`/compatibility`** — How Moog's mods use vanilla and modded biome tags for terrain-mod compatibility.",
      color: 0x1c3a5e,
    },

    // ── Scheduled Releases ────────────────────────────────────────────────────
    {
      title: '⏰ Scheduled Releases',
      description:
        "Each release review card now has a **⏰ Schedule** button alongside Approve/Reject/Group.\n\n" +
        "Clicking **Schedule** opens a modal with the same fields as Approve (type, ping, changelog) " +
        "plus a **Send In** field (e.g. `2h`, `12h`, `24h`).\n\n" +
        "The release is stored and the cron job (runs every minute) checks for releases past their " +
        "scheduled time and triggers the publish workflow automatically.\n\n" +
        "The review card updates to show `⏰ Scheduled — publishes in Xh` once scheduled, " +
        "and `✅ Scheduled publish triggered` once the cron fires.",
      color: 0x5865F2,
      footer: {
        text: 'Keep this guide updated as features change — see STAFF_GUIDE.md in the moogsmods-bot repo',
      },
    },
  ];

  const existing = await env.RELEASES.get('docs_message_id');

  if (existing) {
    await discordRequest(env, 'PATCH', `/channels/${DOCS_CHANNEL}/messages/${existing}`, { embeds });
    return existing;
  }

  const msg = await discordRequest(env, 'POST', `/channels/${DOCS_CHANNEL}/messages`, { embeds });
  await env.RELEASES.put('docs_message_id', msg.id);
  return msg.id;
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

async function followUp(env, token, content) {
  await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => {});
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
