// Builds and upserts the single pinned "Staff Guide" embed in the docs channel.
// Called via the /send-docs endpoint. Keep this in sync as features change —
// see STAFF_GUIDE.md in the repo for the maintenance workflow.

import { DOCS_CHANNEL, LOG_CHANNEL } from './config.js';
import { discordRequest } from './discord.js';

export async function sendDocs(env) {
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
