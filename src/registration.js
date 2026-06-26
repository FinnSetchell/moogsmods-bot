// Registers the bot's global application commands with Discord (bulk PUT —
// overwrites the full set). Called via the /register-commands endpoint.
// Admin tools use default_member_permissions '0' (admin-only); the public
// support commands are left open to everyone.

import { DISCORD_API } from './config.js';

export async function registerCommands(env) {
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
