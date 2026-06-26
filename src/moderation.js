// Moderation primitives invoked by the context-menu commands and modals:
// timing out a member, bulk-purging their recent messages, and locking a channel.

import { discordRequest } from './discord.js';

// Time a member out for up to Discord's 28-day maximum.
export async function timeoutMember(env, guildId, userId, seconds) {
  const MAX_TIMEOUT = 28 * 24 * 3600; // Discord max: 28 days
  const until = new Date(Date.now() + Math.min(seconds, MAX_TIMEOUT) * 1000).toISOString();
  const resp = await discordRequest(env, 'PATCH', `/guilds/${guildId}/members/${userId}`, {
    communication_disabled_until: until,
  });
  return resp;
}

// Sweep every text channel and delete the user's messages newer than `seconds`.
// Uses bulk-delete where possible; returns the total number deleted.
export async function purgeUserMessages(env, guildId, userId, seconds) {
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

// Lock/unlock a channel by toggling the @everyone (guildId) SEND_MESSAGES overwrite.
// Removes the overwrite entirely when it would otherwise be empty.
export async function lockChannel(env, channelId, guildId, lock) {
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
